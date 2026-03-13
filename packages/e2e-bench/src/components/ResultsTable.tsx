import type React from "react";
import { memo, useMemo, useState } from "react";
import type { BenchmarkResult } from "../types.js";

interface Props {
  results: BenchmarkResult[];
}

type SortKey = keyof BenchmarkResult["metrics"] | "terminal" | "scenario" | "run";

export const ResultsTable = memo(function ResultsTable({ results }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("totalTimeMs");
  const [sortAsc, setSortAsc] = useState(true);

  const sorted = useMemo(() => {
    if (results.length === 0) return results;
    return [...results].sort((a, b) => {
      let va: number | string;
      let vb: number | string;

      if (sortKey === "terminal" || sortKey === "scenario") {
        va = a[sortKey];
        vb = b[sortKey];
      } else if (sortKey === "run") {
        va = a.run;
        vb = b.run;
      } else {
        va = a.metrics[sortKey] ?? 0;
        vb = b.metrics[sortKey] ?? 0;
      }

      if (typeof va === "string" && typeof vb === "string") {
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return sortAsc ? (va as number) - (vb as number) : (vb as number) - (va as number);
    });
  }, [results, sortKey, sortAsc]);

  if (sorted.length === 0) {
    return <div style={{ color: "#666", padding: 16 }}>No results yet.</div>;
  }

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const th = (label: string, key: SortKey) => (
    <th
      onClick={() => handleSort(key)}
      style={{
        cursor: "pointer",
        padding: "8px 12px",
        textAlign: "left",
        borderBottom: "1px solid #444",
        userSelect: "none",
      }}
    >
      {label} {sortKey === key ? (sortAsc ? "\u25b2" : "\u25bc") : ""}
    </th>
  );

  const fmt = (n: number, decimals = 1) => n.toFixed(decimals);
  const fmtMB = (n: number) => (n / 1e6).toFixed(2);

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "#2a2a3e" }}>
            {th("Terminal", "terminal")}
            {th("Scenario", "scenario")}
            {th("Run", "run")}
            {th("Time (ms)", "totalTimeMs")}
            {th("Avg FPS", "avgFps")}
            {th("Dropped", "droppedFrames")}
            {th("Long Tasks", "longTaskCount")}
            {th("LT Duration", "longTaskDurationMs")}
            {th("MB/s", "throughputMBps")}
            {th("Server (ms)", "serverSendMs")}
            {th("Bytes", "totalBytes")}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr
              key={`${r.terminal}-${r.scenario}-${r.run}`}
              style={{ background: i % 2 === 0 ? "#1e1e30" : "#22223a" }}
            >
              <td style={tdStyle}>{r.terminal}</td>
              <td style={tdStyle}>{r.scenario}</td>
              <td style={tdStyle}>{r.run}</td>
              <td style={tdStyle}>{fmt(r.metrics.totalTimeMs)}</td>
              <td style={tdStyle}>{fmt(r.metrics.avgFps)}</td>
              <td style={tdStyle}>{r.metrics.droppedFrames}</td>
              <td style={tdStyle}>{r.metrics.longTaskCount}</td>
              <td style={tdStyle}>{fmt(r.metrics.longTaskDurationMs)}</td>
              <td style={tdStyle}>{fmt(r.metrics.throughputMBps, 2)}</td>
              <td style={tdStyle}>{fmt(r.metrics.serverSendMs)}</td>
              <td style={tdStyle}>{fmtMB(r.metrics.totalBytes)} MB</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

const tdStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderBottom: "1px solid #333",
};
