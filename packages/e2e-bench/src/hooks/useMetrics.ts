import { useCallback, useRef } from "react";
import type { BenchmarkMetrics } from "../types.js";

interface MetricsState {
  active: boolean;
  settled: boolean;
  startTime: number;
  frameCount: number;
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
  frameTimestamps: number[]; // for refresh rate detection
  estimatedRefreshHz: number;
}

const IDLE_FRAME_THRESHOLD = 3; // 3 frames with no write activity = idle
const IDLE_WRITE_GAP_MS = 50; // consider idle if no write for 50ms

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
    frameCount: 0,
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
    frameTimestamps: [],
    estimatedRefreshHz: 60,
  });

  const startTracking = useCallback(async (): Promise<void> => {
    const s = stateRef.current;
    s.memoryBefore = await measureMemory();
    s.active = true;
    s.settled = false;
    s.startTime = 0; // set on first data
    s.frameCount = 0;
    s.longTaskCount = 0;
    s.longTaskDurationMs = 0;
    s.idleFrameCount = 0;
    s.lastWriteTime = 0;
    s.totalBytes = 0;
    s.serverSendMs = 0;
    s.resolveIdle = null;
    s.frameTimestamps = [];
    s.estimatedRefreshHz = 60;

    // Long task observer
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
      // Start rAF counting
      const countFrame = () => {
        if (!s.active) return;
        s.frameCount++;

        // Track frame timestamps for refresh rate estimation
        const now = performance.now();
        if (s.frameTimestamps.length < 10) {
          s.frameTimestamps.push(now);
          if (s.frameTimestamps.length === 10) {
            const intervals: number[] = [];
            for (let i = 1; i < s.frameTimestamps.length; i++) {
              intervals.push(s.frameTimestamps[i] - s.frameTimestamps[i - 1]);
            }
            const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
            if (avgInterval > 0) {
              s.estimatedRefreshHz = 1000 / avgInterval;
            }
          }
        }

        // Check for idle: if enough time since last write and we've received done signal
        const timeSinceWrite = now - s.lastWriteTime;
        if (s.serverSendMs > 0 && timeSinceWrite > IDLE_WRITE_GAP_MS) {
          s.idleFrameCount++;
          if (s.idleFrameCount >= IDLE_FRAME_THRESHOLD && s.resolveIdle) {
            s.active = false;
            settle(s);
            return;
          }
        } else {
          s.idleFrameCount = 0;
        }

        s.rafId = requestAnimationFrame(countFrame);
      };
      s.rafId = requestAnimationFrame(countFrame);
    }
    s.lastWriteTime = performance.now();
    s.totalBytes += byteLength;
  }, []);

  const recordDone = useCallback((serverElapsedMs: number) => {
    stateRef.current.serverSendMs = serverElapsedMs;
  }, []);

  const waitForIdle = useCallback((): Promise<BenchmarkMetrics> => {
    const s = stateRef.current;
    // If already idle or not active, settle and return metrics directly
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
    // Already settled — return current metrics without re-measuring
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

function buildMetrics(s: MetricsState, memoryAfter: number | null): BenchmarkMetrics {
  const totalTimeMs = performance.now() - s.startTime;
  const elapsedSec = totalTimeMs / 1000;
  const expectedFrames = Math.floor(elapsedSec * s.estimatedRefreshHz);

  return {
    totalTimeMs,
    avgFps: elapsedSec > 0 ? s.frameCount / elapsedSec : 0,
    droppedFrames: Math.max(0, expectedFrames - s.frameCount),
    longTaskCount: s.longTaskCount,
    longTaskDurationMs: s.longTaskDurationMs,
    memoryBeforeBytes: s.memoryBefore,
    memoryAfterBytes: memoryAfter,
    throughputMBps: totalTimeMs > 0 ? ((s.totalBytes / totalTimeMs) * 1000) / 1e6 : 0,
    serverSendMs: s.serverSendMs,
    totalBytes: s.totalBytes,
    estimatedRefreshHz: s.estimatedRefreshHz,
  };
}
