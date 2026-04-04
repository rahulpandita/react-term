import type { TerminalHandle } from "@next_term/react";

export type TerminalType = "react-term" | "xterm" | "ghostty";

export interface BenchmarkConfig {
  terminal: TerminalType;
  scenario: string;
  runs: number;
}

export interface BenchmarkMetrics {
  totalTimeMs: number;
  avgFps: number;
  droppedFrames: number;
  longTaskCount: number;
  longTaskDurationMs: number;
  memoryBeforeBytes: number | null;
  memoryAfterBytes: number | null;
  throughputMBps: number;
  serverSendMs: number;
  totalBytes: number;
  estimatedRefreshHz: number;
}

export interface BenchmarkResult {
  terminal: TerminalType;
  scenario: string;
  run: number;
  metrics: BenchmarkMetrics;
  timestamp: number;
}

export interface MultiPaneConfig {
  terminal: TerminalType;
  scenario: string;
  paneCount: number;
  runs: number;
}

export interface MultiPaneResponsiveness {
  avgSetTimeoutDelay: number;
  maxSetTimeoutDelay: number;
  samples: number;
}

export interface MultiPaneResult {
  terminal: TerminalType;
  scenario: string;
  paneCount: number;
  run: number;
  metrics: BenchmarkMetrics;
  responsiveness: MultiPaneResponsiveness;
  timestamp: number;
}

export type TerminalApi = Pick<TerminalHandle, "write" | "resize">;

export const WS_PORT = 8081;
export const WS_URL = `ws://${typeof window !== "undefined" ? window.location.hostname : "localhost"}:${WS_PORT}`;
