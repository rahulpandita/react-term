import { Terminal } from "@next_term/react";
import {
  type ComponentType,
  type ForwardRefExoticComponent,
  type RefAttributes,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useMetrics } from "../hooks/useMetrics.js";
import type { BenchmarkConfig, BenchmarkResult, TerminalApi, TerminalType } from "../types.js";
import { WS_URL } from "../types.js";
import { GhosttyTerminal } from "./GhosttyTerminal.js";
import { XtermTerminal } from "./XtermTerminal.js";

type TerminalComponent = ForwardRefExoticComponent<
  { cols: number; rows: number } & RefAttributes<TerminalApi>
>;

const TERMINAL_COMPONENTS: Record<
  TerminalType,
  TerminalComponent | ComponentType<{ cols: number; rows: number; ref: React.Ref<TerminalApi> }>
> = {
  "react-term": Terminal as unknown as TerminalComponent,
  xterm: XtermTerminal,
  ghostty: GhosttyTerminal,
};

interface Props {
  config: BenchmarkConfig | null;
  onResult: (result: BenchmarkResult) => void;
  onProgress: (msg: string) => void;
  onComplete: () => void;
}

export function BenchmarkRunner({ config, onResult, onProgress, onComplete }: Props) {
  const [activeTerminal, setActiveTerminal] = useState<TerminalType | null>(null);
  const [currentRun, setCurrentRun] = useState(0);
  const termRef = useRef<TerminalApi>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);
  const { startTracking, recordWrite, recordDone, waitForIdle, stopTracking } = useMetrics();

  const runSingle = useCallback(
    async (terminal: TerminalType, scenario: string, run: number): Promise<BenchmarkResult> => {
      // Mount terminal
      setActiveTerminal(terminal);
      setCurrentRun(run);

      // Wait for terminal to mount and initialize
      await new Promise((r) => setTimeout(r, 500));

      await startTracking();

      return new Promise<BenchmarkResult>((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("Benchmark timed out after 120s"));
        }, 120_000);

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "start", scenario }));
        };

        ws.onmessage = async (event) => {
          if (event.data instanceof ArrayBuffer) {
            // Record byte count from ArrayBuffer directly — avoid allocating
            // Uint8Array just for byteLength
            const buf = event.data as ArrayBuffer;
            recordWrite(buf.byteLength);
            termRef.current?.write(new Uint8Array(buf));
          } else {
            // JSON control message
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
              recordDone(msg.serverElapsedMs);
              const metrics = await waitForIdle();
              clearTimeout(timeout);
              ws.close();
              wsRef.current = null;
              stopTracking();

              resolve({
                terminal,
                scenario,
                run,
                metrics,
                timestamp: Date.now(),
              });
            }
          }
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          stopTracking();
          reject(new Error("WebSocket connection failed"));
        };
      });
    },
    [startTracking, recordWrite, recordDone, waitForIdle, stopTracking],
  );

  useEffect(() => {
    if (!config || runningRef.current) return;
    runningRef.current = true;
    cancelledRef.current = false;

    const run = async () => {
      const { terminal, scenario, runs } = config;

      for (let i = 1; i <= runs; i++) {
        if (cancelledRef.current) break;
        onProgress(`Running ${terminal} / ${scenario} (${i}/${runs})...`);
        try {
          const result = await runSingle(terminal, scenario, i);
          onResult(result);
        } catch (err) {
          onProgress(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Unmount terminal between runs to release resources
        setActiveTerminal(null);
        // Allow time for WebGL context / Worker teardown and GC
        await new Promise((r) => setTimeout(r, 500));
      }

      // Cooldown between configs — let browser fully reclaim resources
      await new Promise((r) => setTimeout(r, 1000));
      runningRef.current = false;
      onComplete();
    };

    run();

    return () => {
      // Cleanup on unmount or config change while running
      cancelledRef.current = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      stopTracking();
    };
  }, [config, onResult, onProgress, onComplete, runSingle, stopTracking]);

  const Component = activeTerminal ? TERMINAL_COMPONENTS[activeTerminal] : null;

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
      {Component ? (
        <Component
          ref={termRef}
          cols={120}
          rows={36}
          {...(activeTerminal === "react-term"
            ? {
                useWorker: true,
                renderMode: "auto" as const,
                renderer: "auto" as const,
                style: { width: "100%", height: "100%" },
              }
            : {})}
        />
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "#666",
          }}
        >
          {config ? `Preparing run ${currentRun}...` : "Select a benchmark to run"}
        </div>
      )}
    </div>
  );
}
