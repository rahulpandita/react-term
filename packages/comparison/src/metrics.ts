/**
 * Live metrics tracker — measures FPS, frame times, throughput, long tasks,
 * and event loop latency. Renders a live overlay panel.
 */

export interface LiveMetrics {
  fps: number;
  frameTimeP50: number;
  frameTimeP95: number;
  frameTimeP99: number;
  totalBytes: number;
  throughputMBs: number;
  longTasks: number;
  eventLoopLatencyMs: number;
  memoryMB: number | null;
  elapsed: number;
}

export class MetricsTracker {
  private frameTimes: number[] = [];
  private lastFrameTime = 0;
  private rafId = 0;
  private totalBytes = 0;
  private startTime = 0;
  private longTaskCount = 0;
  private perfObserver: PerformanceObserver | null = null;
  private loopLatencies: number[] = [];
  private loopProbeId = 0;
  private panel: HTMLElement;
  private updateInterval = 0;
  private paneLabels: string[] = [];
  private paneByteCounts: number[] = [];

  constructor(
    container: HTMLElement,
    private terminalName: string,
  ) {
    this.panel = document.createElement("div");
    this.panel.className = "metrics-panel";
    container.appendChild(this.panel);
  }

  start(paneLabels: string[]) {
    this.paneLabels = paneLabels;
    this.paneByteCounts = new Array(paneLabels.length).fill(0);
    this.startTime = performance.now();
    this.frameTimes = [];
    this.totalBytes = 0;
    this.longTaskCount = 0;
    this.loopLatencies = [];

    // Frame time tracking via rAF
    this.lastFrameTime = performance.now();
    const trackFrame = () => {
      const now = performance.now();
      this.frameTimes.push(now - this.lastFrameTime);
      if (this.frameTimes.length > 300) this.frameTimes.shift();
      this.lastFrameTime = now;
      this.rafId = requestAnimationFrame(trackFrame);
    };
    this.rafId = requestAnimationFrame(trackFrame);

    // Long task observer
    try {
      this.perfObserver = new PerformanceObserver((list) => {
        this.longTaskCount += list.getEntries().length;
      });
      this.perfObserver.observe({ type: "longtask", buffered: false });
    } catch {}

    // Event loop latency probe
    const probeLoop = () => {
      const t0 = performance.now();
      this.loopProbeId = window.setTimeout(() => {
        this.loopLatencies.push(performance.now() - t0);
        if (this.loopLatencies.length > 100) this.loopLatencies.shift();
        probeLoop();
      }, 0);
    };
    probeLoop();

    // UI update every 250ms
    this.updateInterval = window.setInterval(() => this.render(), 250);
    this.render();
  }

  recordBytes(byteCount: number, paneIndex?: number) {
    this.totalBytes += byteCount;
    if (paneIndex !== undefined && paneIndex < this.paneByteCounts.length) {
      this.paneByteCounts[paneIndex] += byteCount;
    }
  }

  stop() {
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.loopProbeId);
    clearInterval(this.updateInterval);
    this.perfObserver?.disconnect();
    this.render(); // final render
  }

  private getMetrics(): LiveMetrics {
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const elapsed = (performance.now() - this.startTime) / 1000;

    const loopSorted = [...this.loopLatencies].sort((a, b) => a - b);

    return {
      fps: this.frameTimes.length > 0 ? 1000 / median(sorted) : 0,
      frameTimeP50: percentile(sorted, 0.5),
      frameTimeP95: percentile(sorted, 0.95),
      frameTimeP99: percentile(sorted, 0.99),
      totalBytes: this.totalBytes,
      throughputMBs: elapsed > 0 ? this.totalBytes / elapsed / 1e6 : 0,
      longTasks: this.longTaskCount,
      eventLoopLatencyMs: loopSorted.length > 0 ? median(loopSorted) : 0,
      memoryMB: null,
      elapsed,
    };
  }

  private render() {
    const m = this.getMetrics();

    // Per-pane byte breakdown
    let paneRows = "";
    for (let i = 0; i < this.paneLabels.length; i++) {
      const kb = (this.paneByteCounts[i] / 1024).toFixed(0);
      paneRows += `<tr><td class="pane-label">${i}: ${this.paneLabels[i]}</td><td>${kb} KB</td></tr>`;
    }

    this.panel.innerHTML = `
      <div class="metrics-title">${this.terminalName}</div>
      <table class="metrics-table">
        <tr><td>FPS</td><td class="${m.fps < 30 ? "warn" : "good"}">${m.fps.toFixed(1)}</td></tr>
        <tr><td>Frame p50</td><td>${m.frameTimeP50.toFixed(1)} ms</td></tr>
        <tr><td>Frame p95</td><td class="${m.frameTimeP95 > 33 ? "warn" : ""}">${m.frameTimeP95.toFixed(1)} ms</td></tr>
        <tr><td>Frame p99</td><td class="${m.frameTimeP99 > 50 ? "warn" : ""}">${m.frameTimeP99.toFixed(1)} ms</td></tr>
        <tr class="sep"><td>Throughput</td><td>${m.throughputMBs.toFixed(2)} MB/s</td></tr>
        <tr><td>Total data</td><td>${(m.totalBytes / 1024 / 1024).toFixed(2)} MB</td></tr>
        <tr><td>Long tasks</td><td class="${m.longTasks > 10 ? "warn" : ""}">${m.longTasks}</td></tr>
        <tr><td>Loop latency</td><td class="${m.eventLoopLatencyMs > 10 ? "warn" : ""}">${m.eventLoopLatencyMs.toFixed(1)} ms</td></tr>
        <tr><td>Elapsed</td><td>${m.elapsed.toFixed(1)}s</td></tr>
      </table>
      <div class="metrics-subtitle">Per-pane bytes</div>
      <table class="metrics-table pane-table">${paneRows}</table>
    `;
  }
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)];
}
