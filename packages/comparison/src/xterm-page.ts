/**
 * xterm.js comparison page — 8 muxed terminal panes with live metrics.
 */

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { $ } from "./dom.js";
import { MetricsTracker } from "./metrics.js";
import { MuxClient } from "./mux-client.js";
import { XTERM_THEME } from "./theme.js";
import "./style.css";

// Pane count from ?panes=N query param, default 8
const PANE_COUNT = parseInt(new URLSearchParams(location.search).get("panes") ?? "8", 10);
const GRID_COLS = PANE_COUNT <= 4 ? 2 : PANE_COUNT <= 9 ? 3 : 4;
const GRID_ROWS = Math.ceil(PANE_COUNT / GRID_COLS);

// Build DOM
const grid = $("grid");
grid.style.setProperty("--grid-cols", String(GRID_COLS));
grid.style.setProperty("--grid-rows", String(GRID_ROWS));
const terminals: Terminal[] = [];
const fitAddons: FitAddon[] = [];

for (let i = 0; i < PANE_COUNT; i++) {
  const pane = document.createElement("div");
  pane.className = "pane";

  const label = document.createElement("div");
  label.className = "pane-label";
  label.id = `label-${i}`;
  label.textContent = `pane ${i}`;
  pane.appendChild(label);

  const termDiv = document.createElement("div");
  termDiv.style.width = "100%";
  termDiv.style.height = "100%";
  pane.appendChild(termDiv);

  grid.appendChild(pane);

  const fit = new FitAddon();
  const term = new Terminal({
    fontSize: 13,
    fontFamily: "monospace",
    theme: XTERM_THEME,
    allowProposedApi: true,
    scrollback: 1000,
  });
  term.loadAddon(fit);
  term.open(termDiv);

  // Defer fit to allow layout to settle
  requestAnimationFrame(() => {
    try {
      fit.fit();
    } catch {}
  });

  terminals.push(term);
  fitAddons.push(fit);
}

// Metrics
const metricsContainer = $("metrics");
const metrics = new MetricsTracker(metricsContainer, "xterm.js");

// Status bar
const statusDot = $("status-dot");
const statusText = $("status-text");

// Mux client
const client = new MuxClient({
  onData(paneIndex, data) {
    if (paneIndex < terminals.length) {
      // xterm.js write accepts string or Uint8Array
      terminals[paneIndex].write(data);
      metrics.recordBytes(data.byteLength, paneIndex);
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

// Wire input from each terminal to the mux
for (let i = 0; i < PANE_COUNT; i++) {
  terminals[i].onData((data) => {
    client.sendInput(i, data);
  });
}

// Resize observer
const resizeObserver = new ResizeObserver(() => {
  for (let i = 0; i < PANE_COUNT; i++) {
    try {
      fitAddons[i].fit();
      const term = terminals[i];
      client.resize(i, term.cols, term.rows);
    } catch {}
  }
});
resizeObserver.observe(grid);

// Get initial terminal size and connect
requestAnimationFrame(() => {
  // Fit first to get proper dimensions
  for (const fit of fitAddons) {
    try {
      fit.fit();
    } catch {}
  }
  const cols = terminals[0]?.cols ?? 80;
  const rows = terminals[0]?.rows ?? 24;
  client.connect(cols, rows, PANE_COUNT);
});
