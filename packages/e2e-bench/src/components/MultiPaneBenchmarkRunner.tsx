import type { PaneLayout, TerminalPaneHandle } from "@next_term/react";
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
import { XtermTerminal } from "./XtermTerminal.js";

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function buildLayout(paneCount: number): PaneLayout {
  if (paneCount === 1) {
    return { type: "single", id: "pane-0" };
  }
  if (paneCount === 2) {
    return {
      type: "horizontal",
      children: [
        { type: "single", id: "pane-0" },
        { type: "single", id: "pane-1" },
      ],
    };
  }
  // For 4+ panes: split into two vertical columns
  const half = Math.ceil(paneCount / 2);
  const left: PaneLayout[] = [];
  const right: PaneLayout[] = [];
  for (let i = 0; i < paneCount; i++) {
    const leaf: PaneLayout = { type: "single", id: `pane-${i}` };
    if (i < half) left.push(leaf);
    else right.push(leaf);
  }
  return {
    type: "horizontal",
    children: [
      { type: "vertical", children: left },
      { type: "vertical", children: right },
    ],
  };
}

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

export function MultiPaneBenchmarkRunner({ config, onResult, onProgress, onComplete }: Props) {
  const [activeTerminal, setActiveTerminal] = useState<MultiPaneConfig | null>(null);
  const [currentRun, setCurrentRun] = useState(0);
  const paneRef = useRef<TerminalPaneHandle>(null);
  const xtermRefs = useRef<Map<number, TerminalApi>>(new Map());
  const wsRefs = useRef<WebSocket[]>([]);
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);
  const { startTracking, recordWrite, recordDone, waitForIdle, stopTracking } = useMetrics();

  const cleanupWebSockets = useCallback(() => {
    for (const ws of wsRefs.current) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    wsRefs.current = [];
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
        let completedPanes = 0;
        let totalServerMs = 0;
        let settled = false;

        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          stillRunning = false;
          cleanupWebSockets();
          reject(new Error("Multi-pane benchmark timed out after 180s"));
        }, 180_000);

        for (let i = 0; i < paneCount; i++) {
          const ws = new WebSocket(WS_URL);
          ws.binaryType = "arraybuffer";
          wsRefs.current.push(ws);

          ws.onopen = () => {
            ws.send(JSON.stringify({ type: "start", scenario }));
          };

          ws.onmessage = async (event) => {
            if (settled) return;
            if (event.data instanceof ArrayBuffer) {
              const buf = event.data as ArrayBuffer;
              recordWrite(buf.byteLength);

              const data = new Uint8Array(buf);
              if (terminal === "react-term") {
                paneRef.current?.getTerminal(`pane-${i}`)?.write(data);
              } else {
                xtermRefs.current.get(i)?.write(data);
              }
            } else {
              let msg: { type?: string; serverElapsedMs?: number; totalBytes?: number };
              try {
                msg = JSON.parse(event.data as string);
              } catch {
                return;
              }
              if (
                msg?.type === "done" &&
                typeof msg.serverElapsedMs === "number" &&
                typeof msg.totalBytes === "number"
              ) {
                completedPanes++;
                totalServerMs = Math.max(totalServerMs, msg.serverElapsedMs);

                if (completedPanes === paneCount) {
                  settled = true;
                  recordDone(totalServerMs);
                  const metrics = await waitForIdle();
                  stillRunning = false;
                  clearTimeout(timeout);
                  cleanupWebSockets();
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
            }
          };

          ws.onerror = () => {
            if (settled) return;
            settled = true;
            stillRunning = false;
            clearTimeout(timeout);
            cleanupWebSockets();
            stopTracking();
            reject(new Error(`WebSocket connection failed for pane ${i}`));
          };
        }
      });
    },
    [startTracking, recordWrite, recordDone, waitForIdle, stopTracking, cleanupWebSockets],
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
          `Running ${config.terminal} / ${config.scenario} (${config.paneCount} panes, run ${i}/${runs})...`,
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
      cleanupWebSockets();
      stopTracking();
    };
  }, [config, onResult, onProgress, onComplete, runSingle, stopTracking, cleanupWebSockets]);

  // Render react-term multi-pane
  if (activeTerminal?.terminal === "react-term") {
    const layout = buildLayout(activeTerminal.paneCount);
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
        <TerminalPane ref={paneRef} layout={layout} style={{ width: "100%", height: "100%" }} />
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
      {config
        ? `Preparing multi-pane run ${currentRun}...`
        : "Select a multi-pane benchmark to run"}
    </div>
  );
}
