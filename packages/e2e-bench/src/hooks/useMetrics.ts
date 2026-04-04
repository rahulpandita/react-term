import { useCallback, useRef } from "react";
import { medianOf } from "../stats.js";
import type { BenchmarkMetrics } from "../types.js";

interface MetricsState {
  active: boolean;
  settled: boolean;
  startTime: number;
  rafId: number | null;
  longTaskCount: number;
  longTaskDurationMs: number;
  observer: PerformanceObserver | null;
  memoryBefore: number | null;
  idleFrameCount: number;
  lastWriteTime: number;
  totalBytes: number;
  serverSendMs: number;
  resolveIdle: ((metrics: BenchmarkMetrics) => void) | null;
  frameTimes: number[];
  dataEndTime: number;
  /** Captured at idle detection, before async memory measurement */
  idleDetectedTime: number;
}

const IDLE_FRAME_THRESHOLD = 3;
const IDLE_WRITE_GAP_MS = 50;

async function measureMemory(): Promise<number | null> {
  try {
    if ("measureUserAgentSpecificMemory" in performance) {
      const result = await (
        performance as unknown as {
          measureUserAgentSpecificMemory(): Promise<{ bytes: number }>;
        }
      ).measureUserAgentSpecificMemory();
      return result.bytes;
    }
  } catch {
    // Not available or not in COOP/COEP context
  }
  return null;
}

export function useMetrics() {
  const stateRef = useRef<MetricsState>({
    active: false,
    settled: false,
    startTime: 0,
    rafId: null,
    longTaskCount: 0,
    longTaskDurationMs: 0,
    observer: null,
    memoryBefore: null,
    idleFrameCount: 0,
    lastWriteTime: 0,
    totalBytes: 0,
    serverSendMs: 0,
    resolveIdle: null,
    frameTimes: [],
    dataEndTime: 0,
    idleDetectedTime: 0,
  });

  const startTracking = useCallback(async (): Promise<void> => {
    const s = stateRef.current;
    s.memoryBefore = await measureMemory();
    s.active = true;
    s.settled = false;
    s.startTime = 0;
    s.longTaskCount = 0;
    s.longTaskDurationMs = 0;
    s.idleFrameCount = 0;
    s.lastWriteTime = 0;
    s.totalBytes = 0;
    s.serverSendMs = 0;
    s.resolveIdle = null;
    s.frameTimes = [];
    s.dataEndTime = 0;
    s.idleDetectedTime = 0;

    try {
      s.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          s.longTaskCount++;
          s.longTaskDurationMs += entry.duration;
        }
      });
      s.observer.observe({ type: "longtask", buffered: false });
    } catch {
      // longtask not supported in all browsers
    }
  }, []);

  const recordWrite = useCallback((byteLength: number) => {
    const s = stateRef.current;
    if (!s.active) return;
    if (s.startTime === 0) {
      s.startTime = performance.now();
      const onFrame = (timestamp: number) => {
        if (!s.active) return;
        s.frameTimes.push(timestamp);

        const now = performance.now();
        const timeSinceWrite = now - s.lastWriteTime;
        if (s.serverSendMs > 0 && timeSinceWrite > IDLE_WRITE_GAP_MS) {
          s.idleFrameCount++;
          if (s.idleFrameCount >= IDLE_FRAME_THRESHOLD && s.resolveIdle) {
            s.idleDetectedTime = now;
            s.active = false;
            settle(s);
            return;
          }
        } else {
          s.idleFrameCount = 0;
        }

        s.rafId = requestAnimationFrame(onFrame);
      };
      s.rafId = requestAnimationFrame(onFrame);
    }
    s.lastWriteTime = performance.now();
    s.totalBytes += byteLength;
  }, []);

  const recordDone = useCallback((serverElapsedMs: number) => {
    const s = stateRef.current;
    s.serverSendMs = serverElapsedMs;
    s.dataEndTime = performance.now();
  }, []);

  const waitForIdle = useCallback((): Promise<BenchmarkMetrics> => {
    const s = stateRef.current;
    if (!s.active) {
      return settle(s);
    }
    return new Promise((resolve) => {
      s.resolveIdle = resolve;
    });
  }, []);

  const stopTracking = useCallback(() => {
    const s = stateRef.current;
    s.active = false;
    if (s.rafId !== null) {
      cancelAnimationFrame(s.rafId);
      s.rafId = null;
    }
    if (s.observer) {
      s.observer.disconnect();
      s.observer = null;
    }
  }, []);

  return { startTracking, recordWrite, recordDone, waitForIdle, stopTracking };
}

/** Idempotent — safe to call from both the rAF path and waitForIdle. */
async function settle(s: MetricsState): Promise<BenchmarkMetrics> {
  if (s.settled) {
    return buildMetrics(s, null);
  }
  s.settled = true;

  if (s.rafId !== null) {
    cancelAnimationFrame(s.rafId);
    s.rafId = null;
  }
  if (s.observer) {
    s.observer.disconnect();
    s.observer = null;
  }

  const memoryAfter = await measureMemory();
  const metrics = buildMetrics(s, memoryAfter);

  if (s.resolveIdle) {
    s.resolveIdle(metrics);
    s.resolveIdle = null;
  }

  return metrics;
}

function computeFrameTimeStats(frameTimes: number[]): { p50: number; p99: number } {
  if (frameTimes.length < 2) {
    return { p50: 0, p99: 0 };
  }

  const deltas: number[] = [];
  for (let i = 1; i < frameTimes.length; i++) {
    deltas.push(frameTimes[i] - frameTimes[i - 1]);
  }

  const sorted = [...deltas].sort((a, b) => a - b);
  const p99 = sorted[Math.min(Math.floor(sorted.length * 0.99), sorted.length - 1)];

  return { p50: medianOf(sorted), p99 };
}

function buildMetrics(s: MetricsState, memoryAfter: number | null): BenchmarkMetrics {
  const idleTime = s.idleDetectedTime || performance.now();
  const totalTimeMs = idleTime - s.startTime;
  const frameStats = computeFrameTimeStats(s.frameTimes);
  const timeToIdleMs = s.dataEndTime > 0 ? idleTime - s.dataEndTime : 0;

  return {
    totalTimeMs,
    frameTimeP50: frameStats.p50,
    frameTimeP99: frameStats.p99,
    timeToIdleMs,
    longTaskCount: s.longTaskCount,
    longTaskDurationMs: s.longTaskDurationMs,
    memoryBeforeBytes: s.memoryBefore,
    memoryAfterBytes: memoryAfter,
    throughputMBps: totalTimeMs > 0 ? ((s.totalBytes / totalTimeMs) * 1000) / 1e6 : 0,
    serverSendMs: s.serverSendMs,
    totalBytes: s.totalBytes,
  };
}
