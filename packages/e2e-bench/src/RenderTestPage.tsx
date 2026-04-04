import type { TerminalHandle, TerminalPaneHandle } from "@next_term/react";
import { Terminal, TerminalPane } from "@next_term/react";
import { useEffect, useRef, useState } from "react";

// Expose refs on window for Playwright to call
declare global {
  interface Window {
    __termRef?: TerminalHandle | null;
    __paneRef?: TerminalPaneHandle | null;
    __renderTestReady?: boolean;
  }
}

export function RenderTestPage() {
  const [mode, setMode] = useState<"single" | "multi" | "canvas2d">("single");
  const termRef = useRef<TerminalHandle>(null);
  const paneRef = useRef<TerminalPaneHandle>(null);

  // Expose refs for Playwright after React renders
  useEffect(() => {
    window.__termRef = termRef.current;
    window.__paneRef = paneRef.current;
    window.__renderTestReady = true;
    return () => {
      window.__termRef = null;
      window.__paneRef = null;
      window.__renderTestReady = false;
    };
  });

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 8 }}>
        <button type="button" data-testid="mode-single" onClick={() => setMode("single")}>
          Single
        </button>
        <button type="button" data-testid="mode-multi" onClick={() => setMode("multi")}>
          Multi-Pane
        </button>
        <button type="button" data-testid="mode-canvas2d" onClick={() => setMode("canvas2d")}>
          Canvas2D
        </button>
      </div>

      <div data-testid="terminal-container" style={{ width: 800, height: 400 }}>
        {mode === "single" && (
          <Terminal
            ref={termRef}
            cols={80}
            rows={24}
            fontSize={14}
            renderer="auto"
            renderMode="main"
            useWorker={false}
            style={{ width: "100%", height: "100%" }}
          />
        )}
        {mode === "multi" && (
          <TerminalPane
            ref={paneRef}
            layout={{
              type: "horizontal",
              children: [
                { type: "single", id: "left" },
                { type: "single", id: "right" },
              ],
            }}
            fontSize={14}
            style={{ width: "100%", height: "100%" }}
          />
        )}
        {mode === "canvas2d" && (
          <Terminal
            ref={termRef}
            cols={80}
            rows={24}
            fontSize={14}
            renderer="canvas2d"
            renderMode="main"
            useWorker={false}
            style={{ width: "100%", height: "100%" }}
          />
        )}
      </div>
    </div>
  );
}
