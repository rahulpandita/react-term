import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BenchmarkRunner } from "./components/BenchmarkRunner.js";
import { MultiPaneBenchmarkRunner } from "./components/MultiPaneBenchmarkRunner.js";
import { ResultsTable } from "./components/ResultsTable.js";
import type {
  BenchmarkConfig,
  BenchmarkResult,
  MultiPaneConfig,
  MultiPaneResult,
  TerminalType,
} from "./types.js";
import { WS_URL } from "./types.js";

const ALL_TERMINALS: TerminalType[] = ["react-term", "xterm", "ghostty"];

type BenchMode = "single" | "multi-pane";

const PANE_COUNTS = [2, 4, 8, 16, 32] as const;

declare global {
  interface Window {
    __lastBenchmarkResult?: BenchmarkResult;
    __allBenchmarkResults?: BenchmarkResult[];
    __lastMultiPaneResult?: MultiPaneResult;
    __allMultiPaneResults?: MultiPaneResult[];
  }
}

export function App() {
  const [mode, setMode] = useState<BenchMode>(() => {
    const urlMode = new URLSearchParams(window.location.search).get("mode");
    return urlMode === "multi-pane" ? "multi-pane" : "single";
  });
  const [scenarios, setScenarios] = useState<string[]>([]);
  const [selectedTerminal, setSelectedTerminal] = useState<TerminalType | "all">("react-term");
  const [selectedScenario, setSelectedScenario] = useState<string | "all">("");
  const [runs, setRuns] = useState(5);
  const [paneCount, setPaneCount] = useState<number>(2);
  const [status, setStatus] = useState<"idle" | "running" | "complete">("idle");
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState<BenchmarkResult[]>([]);
  const [multiPaneResults, setMultiPaneResults] = useState<MultiPaneResult[]>([]);
  const [config, setConfig] = useState<BenchmarkConfig | null>(null);
  const [multiPaneConfig, setMultiPaneConfig] = useState<MultiPaneConfig | null>(null);
  const queueRef = useRef<BenchmarkConfig[]>([]);
  const multiPaneQueueRef = useRef<MultiPaneConfig[]>([]);
  const queueIndexRef = useRef(0);

  // Fetch scenario list from server
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type: "list" }));
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg?.type === "scenarios" && Array.isArray(msg.names)) {
          setScenarios(msg.names);
          if (msg.names.length > 0) setSelectedScenario(msg.names[0]);
        }
      } catch {
        /* malformed message */
      }
      ws.close();
    };
    ws.onerror = () => {
      setProgress("Cannot connect to replay server on port 8081. Start it with: pnpm server");
    };
  }, []);

  const handleResult = useCallback((result: BenchmarkResult) => {
    window.__lastBenchmarkResult = result;
    setResults((prev) => {
      const next = [...prev, result];
      window.__allBenchmarkResults = next;
      return next;
    });
  }, []);

  const handleMultiPaneResult = useCallback((result: MultiPaneResult) => {
    window.__lastMultiPaneResult = result;
    setMultiPaneResults((prev) => {
      const next = [...prev, result];
      window.__allMultiPaneResults = next;
      return next;
    });
  }, []);

  const handleRunComplete = useCallback(() => {
    // Advance to next config in queue
    queueIndexRef.current++;
    if (queueIndexRef.current < queueRef.current.length) {
      setConfig(queueRef.current[queueIndexRef.current]);
    } else {
      setStatus("complete");
      setProgress("");
      setConfig(null);
    }
  }, []);

  const handleMultiPaneRunComplete = useCallback(() => {
    queueIndexRef.current++;
    if (queueIndexRef.current < multiPaneQueueRef.current.length) {
      setMultiPaneConfig(multiPaneQueueRef.current[queueIndexRef.current]);
    } else {
      setStatus("complete");
      setProgress("");
      setMultiPaneConfig(null);
    }
  }, []);

  const startBenchmark = () => {
    const terminals: TerminalType[] =
      selectedTerminal === "all" ? ALL_TERMINALS : [selectedTerminal];
    const scenarioNames = selectedScenario === "all" ? scenarios : [selectedScenario];

    const queue: BenchmarkConfig[] = [];
    for (const terminal of terminals) {
      for (const scenario of scenarioNames) {
        queue.push({ terminal, scenario, runs });
      }
    }

    queueRef.current = queue;
    queueIndexRef.current = 0;
    setResults([]);
    setStatus("running");
    setConfig(queue[0]);
  };

  const startMultiPaneBenchmark = () => {
    const terminals: TerminalType[] =
      selectedTerminal === "all"
        ? (["react-term", "xterm"] as TerminalType[])
        : [selectedTerminal as TerminalType];
    const scenarioNames = selectedScenario === "all" ? scenarios : [selectedScenario];

    const queue: MultiPaneConfig[] = [];
    for (const terminal of terminals) {
      for (const scenario of scenarioNames) {
        queue.push({ terminal, scenario, paneCount, runs });
      }
    }

    multiPaneQueueRef.current = queue;
    queueIndexRef.current = 0;
    setMultiPaneResults([]);
    setStatus("running");
    setMultiPaneConfig(queue[0]);
  };

  const exportJson = () => {
    const data = mode === "single" ? results : multiPaneResults;
    const prefix = mode === "single" ? "benchmark" : "multi-pane-benchmark";
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${prefix}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const currentResults = mode === "single" ? results : multiPaneResults;
  const resultCount = currentResults.length;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>E2E Terminal Benchmark</h1>

      {/* Mode toggle */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => setMode("single")}
          disabled={status === "running"}
          data-testid="mode-single"
          style={{
            padding: "6px 16px",
            background: mode === "single" ? "#4CAF50" : "#2a2a3e",
            color: "white",
            border: "1px solid #444",
            borderRadius: 4,
            cursor: status === "running" ? "not-allowed" : "pointer",
            fontSize: 13,
          }}
        >
          Single Pane
        </button>
        <button
          type="button"
          onClick={() => setMode("multi-pane")}
          disabled={status === "running"}
          data-testid="mode-multi-pane"
          style={{
            padding: "6px 16px",
            background: mode === "multi-pane" ? "#4CAF50" : "#2a2a3e",
            color: "white",
            border: "1px solid #444",
            borderRadius: 4,
            cursor: status === "running" ? "not-allowed" : "pointer",
            fontSize: 13,
          }}
        >
          Multi-Pane
        </button>
      </div>

      <div
        style={{
          display: "flex",
          gap: 16,
          marginBottom: 24,
          flexWrap: "wrap",
          alignItems: "flex-end",
        }}
      >
        <label style={labelStyle}>
          Terminal
          <select
            value={selectedTerminal}
            onChange={(e) => setSelectedTerminal(e.target.value as TerminalType | "all")}
            disabled={status === "running"}
            style={selectStyle}
          >
            <option value="react-term">react-term</option>
            <option value="xterm">xterm</option>
            {mode === "single" && <option value="ghostty">ghostty</option>}
            <option value="all">All</option>
          </select>
        </label>

        <label style={labelStyle}>
          Payload
          <select
            value={selectedScenario}
            onChange={(e) => setSelectedScenario(e.target.value)}
            disabled={status === "running"}
            style={selectStyle}
          >
            {scenarios.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value="all">All</option>
          </select>
        </label>

        {mode === "multi-pane" && (
          <label style={labelStyle}>
            Panes
            <select
              value={paneCount}
              onChange={(e) => setPaneCount(parseInt(e.target.value, 10))}
              disabled={status === "running"}
              style={selectStyle}
              data-testid="pane-count"
            >
              {PANE_COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}

        <label style={labelStyle}>
          Runs
          <input
            type="number"
            min={1}
            max={50}
            value={runs}
            onChange={(e) => setRuns(Math.max(1, parseInt(e.target.value, 10) || 1))}
            disabled={status === "running"}
            style={{ ...selectStyle, width: 80 }}
          />
        </label>

        <button
          type="button"
          onClick={mode === "single" ? startBenchmark : startMultiPaneBenchmark}
          disabled={status === "running" || scenarios.length === 0}
          style={{
            padding: "8px 20px",
            background: status === "running" ? "#555" : "#4CAF50",
            color: "white",
            border: "none",
            borderRadius: 4,
            cursor: status === "running" ? "not-allowed" : "pointer",
            fontSize: 14,
          }}
        >
          {status === "running" ? "Running..." : "Start Benchmark"}
        </button>

        {resultCount > 0 && (
          <button
            type="button"
            onClick={exportJson}
            style={{
              padding: "8px 20px",
              background: "#2196F3",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Export JSON
          </button>
        )}
      </div>

      {progress && (
        <div
          data-testid="status"
          data-value={status}
          style={{
            padding: "8px 16px",
            marginBottom: 16,
            background: "#2a2a3e",
            borderRadius: 4,
            fontSize: 14,
          }}
        >
          {progress}
        </div>
      )}

      {status === "complete" && !progress && (
        <div
          data-testid="status"
          data-value="complete"
          style={{
            padding: "8px 16px",
            marginBottom: 16,
            background: "#1b5e20",
            borderRadius: 4,
            fontSize: 14,
          }}
        >
          Benchmark complete — {resultCount} results
        </div>
      )}

      <div style={{ marginBottom: 24 }}>
        {mode === "single" ? (
          <BenchmarkRunner
            config={config}
            onResult={handleResult}
            onProgress={setProgress}
            onComplete={handleRunComplete}
          />
        ) : (
          <MultiPaneBenchmarkRunner
            config={multiPaneConfig}
            onResult={handleMultiPaneResult}
            onProgress={setProgress}
            onComplete={handleMultiPaneRunComplete}
          />
        )}
      </div>

      {mode === "single" && <ResultsTable results={results} />}
      {mode === "multi-pane" && <MultiPaneResultsTable results={multiPaneResults} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MultiPaneResultsTable
// ---------------------------------------------------------------------------

function MultiPaneResultsTable({ results }: { results: MultiPaneResult[] }) {
  if (results.length === 0) {
    return <div style={{ color: "#666", padding: 16 }}>No multi-pane results yet.</div>;
  }

  const fmt = (n: number, d = 1) => n.toFixed(d);

  const tdStyle: React.CSSProperties = {
    padding: "6px 12px",
    borderBottom: "1px solid #333",
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "#2a2a3e" }}>
            {[
              "Terminal",
              "Scenario",
              "Panes",
              "Run",
              "Time (ms)",
              "MB/s",
              "Frame p50",
              "Frame p90",
              "Frame p99",
              "Idle (ms)",
              "setTimeout Avg",
              "setTimeout Max",
            ].map((h) => (
              <th
                key={h}
                style={{ padding: "8px 12px", textAlign: "left", borderBottom: "1px solid #444" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => (
            <tr
              key={`${r.terminal}-${r.scenario}-${r.paneCount}-${r.run}`}
              style={{ background: i % 2 === 0 ? "#1e1e30" : "#22223a" }}
            >
              <td style={tdStyle}>{r.terminal}</td>
              <td style={tdStyle}>{r.scenario}</td>
              <td style={tdStyle}>{r.paneCount}</td>
              <td style={tdStyle}>{r.run}</td>
              <td style={tdStyle}>{fmt(r.metrics.totalTimeMs)}</td>
              <td style={tdStyle}>{fmt(r.metrics.throughputMBps, 2)}</td>
              <td style={tdStyle}>{fmt(r.metrics.frameTimeP50)}</td>
              <td style={tdStyle}>{fmt(r.metrics.frameTimeP90)}</td>
              <td style={tdStyle}>{fmt(r.metrics.frameTimeP99)}</td>
              <td style={tdStyle}>{fmt(r.metrics.timeToIdleMs)}</td>
              <td style={tdStyle}>{fmt(r.responsiveness.avgSetTimeoutDelay, 2)}</td>
              <td style={tdStyle}>{fmt(r.responsiveness.maxSetTimeoutDelay, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 13,
  color: "#aaa",
};

const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  background: "#2a2a3e",
  color: "#e0e0e0",
  border: "1px solid #444",
  borderRadius: 4,
  fontSize: 14,
};
