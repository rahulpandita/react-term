import { useCallback, useEffect, useRef, useState } from "react";
import { BenchmarkRunner } from "./components/BenchmarkRunner.js";
import { ResultsTable } from "./components/ResultsTable.js";
import type { BenchmarkConfig, BenchmarkResult, TerminalType } from "./types.js";
import { WS_URL } from "./types.js";

const ALL_TERMINALS: TerminalType[] = ["react-term", "xterm", "ghostty"];

declare global {
  interface Window {
    __lastBenchmarkResult?: BenchmarkResult;
    __allBenchmarkResults?: BenchmarkResult[];
  }
}

export function App() {
  const [scenarios, setScenarios] = useState<string[]>([]);
  const [selectedTerminal, setSelectedTerminal] = useState<TerminalType | "all">("react-term");
  const [selectedScenario, setSelectedScenario] = useState<string | "all">("");
  const [runs, setRuns] = useState(5);
  const [status, setStatus] = useState<"idle" | "running" | "complete">("idle");
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState<BenchmarkResult[]>([]);
  const [config, setConfig] = useState<BenchmarkConfig | null>(null);
  const queueRef = useRef<BenchmarkConfig[]>([]);
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

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `benchmark-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>E2E Terminal Benchmark</h1>

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
            <option value="ghostty">ghostty</option>
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
          onClick={startBenchmark}
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

        {results.length > 0 && (
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
          Benchmark complete — {results.length} results
        </div>
      )}

      <div style={{ marginBottom: 24 }}>
        <BenchmarkRunner
          config={config}
          onResult={handleResult}
          onProgress={setProgress}
          onComplete={handleRunComplete}
        />
      </div>

      <ResultsTable results={results} />
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
