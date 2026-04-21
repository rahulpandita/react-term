/**
 * react-term comparison page — 8 muxed terminal panes with live metrics.
 * Supports 3 modes via URL hash:
 *   #shared   — SharedWebGLContext + Workers (default, best architecture)
 *   #independent — Independent WebGL per pane, no worker
 *   #worker   — Independent WebGL per pane, with worker
 */

import { SharedWebGLContext, WebTerminal } from "@next_term/web";
import { $ } from "./dom.js";
import { MetricsTracker } from "./metrics.js";
import { MuxClient } from "./mux-client.js";
import { CATPPUCCIN_MOCHA } from "./theme.js";
import "./style.css";

// Pane count from ?panes=N query param, default 8
const PANE_COUNT = parseInt(new URLSearchParams(location.search).get("panes") ?? "8", 10);

// Compute grid layout: cols x rows
const GRID_COLS = PANE_COUNT <= 4 ? 2 : PANE_COUNT <= 9 ? 3 : 4;
const GRID_ROWS = Math.ceil(PANE_COUNT / GRID_COLS);

// Parse mode from URL hash
type Mode = "shared" | "independent" | "worker";
const hash = location.hash.replace("#", "");
const mode: Mode = hash === "independent" || hash === "worker" ? hash : "shared";

// Update header and status bar
const headerTitle = document.querySelector(".header h1");
if (headerTitle) {
  headerTitle.textContent = `react-term — ${PANE_COUNT} Panes (${mode === "shared" ? "SharedWebGL + Workers" : mode === "worker" ? "Per-pane WebGL + Workers" : "Per-pane WebGL, no Workers"})`;
}

// Build DOM
const gridEl = $("grid");
gridEl.style.setProperty("--grid-cols", String(GRID_COLS));
gridEl.style.setProperty("--grid-rows", String(GRID_ROWS));
const paneContainers: HTMLElement[] = [];

// Set up SharedWebGLContext if using shared mode
let sharedCtx: SharedWebGLContext | null = null;
if (mode === "shared") {
  sharedCtx = new SharedWebGLContext({
    fontSize: 13,
    fontFamily: "monospace",
    theme: CATPPUCCIN_MOCHA,
  });
  const sharedCanvas = sharedCtx.getCanvas();
  sharedCanvas.style.position = "absolute";
  sharedCanvas.style.top = "0";
  sharedCanvas.style.left = "0";
  sharedCanvas.style.width = "100%";
  sharedCanvas.style.height = "100%";
  sharedCanvas.style.pointerEvents = "none";
  sharedCanvas.style.zIndex = "1";
  gridEl.style.position = "relative";
  gridEl.appendChild(sharedCanvas);
}

// Build pane DOM
for (let i = 0; i < PANE_COUNT; i++) {
  const pane = document.createElement("div");
  pane.className = "pane";

  const label = document.createElement("div");
  label.className = "pane-label";
  label.id = `label-${i}`;
  label.textContent = `pane ${i}`;
  label.style.zIndex = "2";
  pane.appendChild(label);

  const termContainer = document.createElement("div");
  termContainer.style.width = "100%";
  termContainer.style.height = "100%";
  pane.appendChild(termContainer);

  gridEl.appendChild(pane);
  paneContainers.push(termContainer);
}

// Initialize shared context if applicable
if (sharedCtx) {
  sharedCtx.init();
}

// Create terminals
const terminals: WebTerminal[] = [];
for (let i = 0; i < PANE_COUNT; i++) {
  const paneId = `pane-${i}`;
  const opts: ConstructorParameters<typeof WebTerminal>[1] = {
    fontSize: 13,
    fontFamily: "monospace",
    theme: CATPPUCCIN_MOCHA,
    scrollback: 1000,
    useWorker: mode === "shared" || mode === "worker",
    renderMode: "main",
    renderer: "auto",
  };

  if (sharedCtx) {
    opts.sharedContext = sharedCtx;
    opts.paneId = paneId;
  }

  terminals.push(new WebTerminal(paneContainers[i], opts));
}

// Sync viewports for shared context mode
function syncViewports() {
  if (!sharedCtx) return;
  const gridRect = gridEl.getBoundingClientRect();
  sharedCtx.syncCanvasSize(gridRect.width, gridRect.height);

  for (let i = 0; i < PANE_COUNT; i++) {
    const rect = paneContainers[i].getBoundingClientRect();
    sharedCtx.setViewport(
      `pane-${i}`,
      rect.left - gridRect.left,
      rect.top - gridRect.top,
      rect.width,
      rect.height,
    );
  }
}

if (sharedCtx) {
  sharedCtx.startRenderLoop();
}

// Metrics
const metricsContainer = $("metrics");
const metrics = new MetricsTracker(metricsContainer, `react-term (${mode})`);

// Status bar
const statusDot = $("status-dot");
const statusText = $("status-text");
$("status-mode").textContent = `${PANE_COUNT} panes · react-term (${mode})`;

// Mux client
const client = new MuxClient({
  onData(paneIndex, data) {
    if (paneIndex < terminals.length) {
      const len = data.byteLength; // capture before write() transfers the buffer
      terminals[paneIndex].write(data);
      metrics.recordBytes(len, paneIndex);
    }
  },
  onReady(paneNames) {
    for (let i = 0; i < paneNames.length && i < PANE_COUNT; i++) {
      $(`label-${i}`).textContent = `${i}: ${paneNames[i]}`;
    }
    metrics.start(paneNames);
  },
  onConnect() {
    statusDot.className = "dot connected";
    statusText.textContent = "Connected";
  },
  onDisconnect() {
    statusDot.className = "dot disconnected";
    statusText.textContent = "Disconnected";
    metrics.stop();
  },
});

// Wire input
for (let i = 0; i < PANE_COUNT; i++) {
  const idx = i;
  terminals[idx].onData((data: Uint8Array) => {
    client.sendInput(idx, data);
  });
}

// Resize observer
const resizeObserver = new ResizeObserver(() => {
  syncViewports();
  for (let i = 0; i < PANE_COUNT; i++) {
    try {
      terminals[i].fit();
      client.resize(i, terminals[i].cols, terminals[i].rows);
    } catch {}
  }
});
resizeObserver.observe(gridEl);

// Initial sync + connect
requestAnimationFrame(() => {
  syncViewports();
  for (const term of terminals) {
    try {
      term.fit();
    } catch {}
  }
  const cols = terminals[0]?.cols ?? 80;
  const rows = terminals[0]?.rows ?? 24;
  client.connect(cols, rows, PANE_COUNT);
});
