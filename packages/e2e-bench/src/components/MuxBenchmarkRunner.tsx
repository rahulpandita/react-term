import type { TerminalPaneHandle } from "@next_term/react";
import { TerminalPane } from "@next_term/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMetrics } from "../hooks/useMetrics.js";
import type {
  MultiPaneConfig,
  MultiPaneResponsiveness,
  MultiPaneResult,
  TerminalApi,
} from "../types.js";
import { WS_URL } from "../types.js";
import { buildLayout } from "./build-layout.js";
import { XtermTerminal } from "./XtermTerminal.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  config: MultiPaneConfig | null;
  onResult: (result: MultiPaneResult) => void;
  onProgress: (msg: string) => void;
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MuxBenchmarkRunner({ config, onResult, onProgress, onComplete }: Props) {
  const [activeTerminal, setActiveTerminal] = useState<MultiPaneConfig | null>(null);
  const [currentRun, setCurrentRun] = useState(0);
  const paneRef = useRef<TerminalPaneHandle>(null);
  const xtermRefs = useRef<Map<number, TerminalApi>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);
  const { startTracking, recordWrite, recordDone, waitForIdle, stopTracking } = useMetrics();

  const cleanupWebSocket = useCallback(() => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }
  }, []);

  const runSingle = useCallback(
    async (cfg: MultiPaneConfig, run: number): Promise<MultiPaneResult> => {
      setActiveTerminal(cfg);
      setCurrentRun(run);

      // Wait for terminals to mount
      await new Promise((r) => setTimeout(r, 800));

      await startTracking();

      // Responsiveness measurement via setTimeout(0) probing
      const delays: number[] = [];
      let stillRunning = true;

      function measureResponsiveness() {
        const t0 = performance.now();
        setTimeout(() => {
          delays.push(performance.now() - t0);
          if (stillRunning) measureResponsiveness();
        }, 0);
      }
      measureResponsiveness();

      return new Promise<MultiPaneResult>((resolve, reject) => {
        const { terminal, scenario, paneCount } = cfg;
        let settled = false;

        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          stillRunning = false;
          cleanupWebSocket();
          reject(new Error("Mux benchmark timed out after 180s"));
        }, 180_000);

        // Single WebSocket — mux mode
        const ws = new WebSocket(WS_URL);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "start-mux", scenario, paneCount }));
        };

        ws.onmessage = async (event) => {
          if (settled) return;

          if (event.data instanceof ArrayBuffer) {
            const buf = event.data as ArrayBuffer;
            if (buf.byteLength < 2) return;

            // First 2 bytes: LE pane index
            const header = new DataView(buf);
            const paneIndex = header.getUint16(0, true);
            // slice() (not a view) so the worker bridge can transfer the
            // owned ArrayBuffer — a view at offset 2 defeats zero-copy.
            const payload = new Uint8Array(buf).slice(2);

            const len = payload.byteLength; // capture before write() may transfer the buffer
            if (terminal === "react-term") {
              paneRef.current?.getTerminal(`pane-${paneIndex}`)?.write(payload);
            } else {
              xtermRefs.current.get(paneIndex)?.write(payload);
            }
            recordWrite(len);
          } else {
            let msg: { type?: string; serverElapsedMs?: number; totalBytes?: number };
            try {
              msg = JSON.parse(event.data as string);
            } catch {
              return;
            }

            if (
              msg?.type === "done-mux" &&
              typeof msg.serverElapsedMs === "number" &&
              typeof msg.totalBytes === "number"
            ) {
              settled = true;
              recordDone(msg.serverElapsedMs);
              const metrics = await waitForIdle();
              stillRunning = false;
              clearTimeout(timeout);
              cleanupWebSocket();
              stopTracking();

              const maxDelay = delays.reduce((a, b) => Math.max(a, b), 0);
              const responsiveness: MultiPaneResponsiveness = {
                avgSetTimeoutDelay:
                  delays.length > 0 ? delays.reduce((a, b) => a + b, 0) / delays.length : 0,
                maxSetTimeoutDelay: maxDelay,
                samples: delays.length,
              };

              resolve({
                terminal,
                scenario,
                paneCount,
                run,
                metrics,
                responsiveness,
                timestamp: Date.now(),
              });
            }
          }
        };

        ws.onerror = () => {
          if (settled) return;
          settled = true;
          stillRunning = false;
          clearTimeout(timeout);
          cleanupWebSocket();
          stopTracking();
          reject(new Error("Mux WebSocket connection failed"));
        };
      });
    },
    [startTracking, recordWrite, recordDone, waitForIdle, stopTracking, cleanupWebSocket],
  );

  useEffect(() => {
    if (!config || runningRef.current) return;
    runningRef.current = true;
    cancelledRef.current = false;

    const run = async () => {
      const { runs } = config;

      for (let i = 1; i <= runs; i++) {
        if (cancelledRef.current) break;
        onProgress(
          `Mux: ${config.terminal} / ${config.scenario} (${config.paneCount} panes, run ${i}/${runs})...`,
        );
        try {
          const result = await runSingle(config, i);
          onResult(result);
        } catch (err) {
          onProgress(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Unmount terminals between runs
        setActiveTerminal(null);
        await new Promise((r) => setTimeout(r, 500));
      }

      await new Promise((r) => setTimeout(r, 1000));
      runningRef.current = false;
      onComplete();
    };

    run();

    return () => {
      cancelledRef.current = true;
      cleanupWebSocket();
      stopTracking();
    };
  }, [config, onResult, onProgress, onComplete, runSingle, stopTracking, cleanupWebSocket]);

  // Render react-term multi-pane
  if (activeTerminal?.terminal === "react-term") {
    const layout = buildLayout(activeTerminal.paneCount);
    // Size the pool to match the pane count up to the default cap (4).
    const parserWorkers = Math.min(activeTerminal.paneCount, 4);
    return (
      <div
        style={{
          width: "100%",
          height: 400,
          border: "1px solid #333",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <TerminalPane
          ref={paneRef}
          layout={layout}
          parserWorkers={parserWorkers}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    );
  }

  // Render xterm multi-pane (CSS grid)
  if (activeTerminal?.terminal === "xterm") {
    const count = activeTerminal.paneCount;
    const gridCols = count <= 2 ? count : 2;
    const gridRows = Math.ceil(count / gridCols);
    return (
      <div
        style={{
          width: "100%",
          height: 400,
          border: "1px solid #333",
          borderRadius: 4,
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
          gridTemplateRows: `repeat(${gridRows}, 1fr)`,
          gap: 1,
        }}
      >
        {Array.from({ length: count }, (_, i) => {
          const paneId = `xterm-pane-${i}`;
          return (
            <div key={paneId} style={{ overflow: "hidden", position: "relative" }}>
              <XtermTerminal
                ref={(handle) => {
                  if (handle) xtermRefs.current.set(i, handle);
                  else xtermRefs.current.delete(i);
                }}
                cols={Math.floor(120 / gridCols)}
                rows={Math.floor(36 / gridRows)}
              />
            </div>
          );
        })}
      </div>
    );
  }

  // Idle state
  return (
    <div
      style={{
        width: "100%",
        height: 400,
        border: "1px solid #333",
        borderRadius: 4,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#666",
      }}
    >
      {config ? `Preparing mux run ${currentRun}...` : "Select a mux benchmark to run"}
    </div>
  );
}
