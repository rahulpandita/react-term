/**
 * Jank Demo — A/B toggle between react-term and xterm.js with 4 panes
 * of simulated heavy terminal output + a visual jank meter.
 *
 * Uses synthetic data that LOOKS like real terminal output (hex dumps,
 * colored ls, log streams, SGR color tests) but floods at a rate high
 * enough to stress xterm's main-thread parser.
 */

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { SharedWebGLContext, WebTerminal } from "@next_term/web";
import { $ } from "./dom.js";
import { CATPPUCCIN_MOCHA, XTERM_THEME } from "./theme.js";
import "./jank-demo.css";

// ---- Config ----
const PANE_COUNT = 4;
const CHUNK_SIZE = 128 * 1024; // 128 KB per write per pane
const WRITE_INTERVAL = 2; // ms between writes

// ---- Synthetic data generators (look realistic, parse-heavy) ----
const encoder = new TextEncoder();

function generateHexDump(size: number): Uint8Array {
  const lines: string[] = [];
  let total = 0;
  let addr = 0;
  while (total < size) {
    const hex = Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 256)
        .toString(16)
        .padStart(2, "0"),
    );
    const ascii = hex.map((h) => {
      const c = parseInt(h, 16);
      return c >= 32 && c < 127 ? String.fromCharCode(c) : ".";
    });
    const line = `\x1b[33m${addr.toString(16).padStart(8, "0")}\x1b[0m: ${hex.slice(0, 8).join(" ")}  ${hex.slice(8).join(" ")}  \x1b[36m${ascii.join("")}\x1b[0m\r\n`;
    lines.push(line);
    total += line.length;
    addr += 16;
  }
  return encoder.encode(lines.join(""));
}

function generateColorLs(size: number): Uint8Array {
  const lines: string[] = [];
  let total = 0;
  const perms = ["drwxr-xr-x", "-rw-r--r--", "-rwxr-xr-x", "lrwxrwxrwx"];
  const colors = ["\x1b[1;34m", "\x1b[0m", "\x1b[1;32m", "\x1b[1;36m"];
  const names = [
    "src",
    "index.ts",
    "package.json",
    "node_modules",
    "dist",
    "README.md",
    "tsconfig.json",
    "vite.config.ts",
    ".gitignore",
    "LICENSE",
    "lib",
    "test",
    "build.sh",
    "Makefile",
    "docs",
    "assets",
    "public",
    "server.ts",
  ];
  let i = 0;
  while (total < size) {
    const p = perms[i % perms.length];
    const c = colors[i % colors.length];
    const n = names[i % names.length];
    const sz = Math.floor(Math.random() * 100000);
    const line = `${p}  1 user  staff  ${String(sz).padStart(6)} Jan ${(i % 28) + 1} 14:${String(i % 60).padStart(2, "0")} ${c}${n}\x1b[0m\r\n`;
    lines.push(line);
    total += line.length;
    i++;
  }
  return encoder.encode(lines.join(""));
}

function generateLogStream(size: number): Uint8Array {
  const lines: string[] = [];
  let total = 0;
  const levels = [
    ["\x1b[32m", "INFO "],
    ["\x1b[33m", "WARN "],
    ["\x1b[31m", "ERROR"],
    ["\x1b[36m", "DEBUG"],
  ];
  const msgs = [
    "Processing request from 192.168.1.42",
    "Cache hit for key usr:session:8f3a2b",
    "Connection pool: 23/50 active",
    "Query completed in 3.2ms rows=847",
    "WebSocket upgrade from /api/stream",
    "Rate limit exceeded for client_id=7291",
    "TLS handshake completed cipher=AES-256",
    "Metrics flush: cpu=23% mem=1.2GB gc=4ms",
    "Background job batch_export started id=4821",
    "Health check OK latency_p99=12ms",
  ];
  let i = 0;
  while (total < size) {
    const [color, level] = levels[i % levels.length];
    const msg = msgs[i % msgs.length];
    const ts = `2026-04-07 21:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(i % 1000).padStart(3, "0")}`;
    const line = `\x1b[90m${ts}\x1b[0m ${color}${level}\x1b[0m \x1b[37m${msg}\x1b[0m\r\n`;
    lines.push(line);
    total += line.length;
    i++;
  }
  return encoder.encode(lines.join(""));
}

function generateColorGrid(size: number): Uint8Array {
  const lines: string[] = [];
  let total = 0;
  let i = 0;
  while (total < size) {
    let line = "";
    for (let c = 0; c < 80; c++) {
      const fg = 16 + ((i + c * 3) % 216);
      const bg = 16 + ((i * 7 + c * 13) % 216);
      line += `\x1b[38;5;${fg};48;5;${bg}m${String.fromCharCode(33 + ((i + c) % 94))}`;
    }
    line += "\x1b[0m\r\n";
    lines.push(line);
    total += line.length;
    i++;
  }
  return encoder.encode(lines.join(""));
}

// Pre-generate data for each pane
const PANE_DATA = [
  generateHexDump(4 * 1024 * 1024),
  generateLogStream(4 * 1024 * 1024),
  generateColorLs(4 * 1024 * 1024),
  generateColorGrid(4 * 1024 * 1024),
];
const PANE_LABELS = ["hex-dump", "log-stream", "color-ls", "color-grid"];
const paneOffsets = [0, 0, 0, 0];

// ---- State ----
type Engine = "react-term" | "xterm";
let currentEngine: Engine = "react-term";
let sharedCtx: SharedWebGLContext | null = null;
let rtTerminals: WebTerminal[] = [];
let rtContainers: HTMLElement[] = [];
let xtTerminals: XTerminal[] = [];
let xtFits: FitAddon[] = [];
let floodTimer: number | null = null;
let totalBytes = 0;
let floodStartTime = 0;

// Metrics
let frameTimes: number[] = [];
let lastFrameTime = 0;
let droppedFrames = 0;
let longTaskCount = 0;
let perfObserver: PerformanceObserver | null = null;
const LATENCY_HISTORY: number[] = [];
const LATENCY_MAX = 200;
let _latencyProbeTimer = 0;

// ---- DOM ----
const container = $("terminal-container");
const ball = $("ball");
const canvas = $("latency-graph") as HTMLCanvasElement;
const ctx2d = canvas.getContext("2d");
if (!ctx2d) throw new Error("Failed to get 2d context");
const btnRt = $("btn-rt");
const btnXt = $("btn-xt");
const btnStart = $("btn-start");
const btnStop = $("btn-stop");
const statEngine = $("stat-engine");
const statFps = $("stat-fps");
const statBytes = $("stat-bytes");
const statDropped = $("stat-dropped");
const statLong = $("stat-long");
const statThroughput = $("stat-throughput");
const latencyValue = $("latency-value");

// ---- Ball animation ----
let ballX = 0;
let ballDir = 1;
function animateBall() {
  const maxX = ball.parentElement?.clientWidth - 20;
  ballX += 3 * ballDir;
  if (ballX >= maxX) {
    ballX = maxX;
    ballDir = -1;
  } else if (ballX <= 0) {
    ballX = 0;
    ballDir = 1;
  }
  ball.style.transform = `translateX(${ballX}px)`;
}

// ---- Latency graph ----
function drawLatencyGraph() {
  const dpr = window.devicePixelRatio;
  const w = canvas.parentElement?.clientWidth;
  canvas.width = w * dpr;
  canvas.height = 80 * dpr;
  ctx2d.scale(dpr, dpr);
  const h = 80;
  const maxMs = 100;

  ctx2d.fillStyle = "#11111b";
  ctx2d.fillRect(0, 0, w, h);
  ctx2d.strokeStyle = "#313244";
  ctx2d.lineWidth = 1;
  ctx2d.fillStyle = "#6c7086";
  ctx2d.font = "9px monospace";
  for (const ms of [16, 33, 50]) {
    const y = h - (ms / maxMs) * h;
    ctx2d.beginPath();
    ctx2d.moveTo(0, y);
    ctx2d.lineTo(w, y);
    ctx2d.stroke();
    ctx2d.fillText(`${ms}ms`, 2, y - 2);
  }

  const barW = w / LATENCY_MAX;
  for (let i = 0; i < LATENCY_HISTORY.length; i++) {
    const ms = LATENCY_HISTORY[i];
    const barH = Math.min((ms / maxMs) * h, h);
    ctx2d.fillStyle = ms < 8 ? "#a6e3a1" : ms < 16 ? "#f9e2af" : ms < 33 ? "#fab387" : "#f38ba8";
    ctx2d.fillRect(i * barW, h - barH, Math.max(barW - 1, 1), barH);
  }
}

// ---- rAF loop ----
function frameLoop() {
  const now = performance.now();
  if (lastFrameTime > 0) {
    const dt = now - lastFrameTime;
    frameTimes.push(dt);
    if (frameTimes.length > 120) frameTimes.shift();
    if (dt > 33) droppedFrames++;
  }
  lastFrameTime = now;
  animateBall();
  drawLatencyGraph();

  if (frameTimes.length % 10 === 0 && frameTimes.length > 0) {
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    const fps = 1000 / avg;

    statFps.textContent = fps.toFixed(1);
    statFps.className = `stat-value ${fps >= 100 ? "good" : fps >= 50 ? "warn" : "bad"}`;

    const elapsed = (performance.now() - floodStartTime) / 1000;
    const throughput = elapsed > 0 ? totalBytes / elapsed / 1e6 : 0;
    statThroughput.textContent = `${throughput.toFixed(1)} MB/s`;
    statBytes.textContent = `${(totalBytes / 1024 / 1024).toFixed(1)} MB`;

    statDropped.textContent = String(droppedFrames);
    statDropped.className = `stat-value ${droppedFrames === 0 ? "good" : droppedFrames < 10 ? "warn" : "bad"}`;

    statLong.textContent = String(longTaskCount);
    statLong.className = `stat-value ${longTaskCount === 0 ? "good" : "bad"}`;

    const last = LATENCY_HISTORY[LATENCY_HISTORY.length - 1] ?? 0;
    latencyValue.textContent = `${last.toFixed(1)} ms`;
    latencyValue.style.color = last < 8 ? "#a6e3a1" : last < 16 ? "#f9e2af" : "#f38ba8";
  }
  requestAnimationFrame(frameLoop);
}

// ---- Latency probe ----
function probeLatency() {
  const t0 = performance.now();
  _latencyProbeTimer = window.setTimeout(() => {
    LATENCY_HISTORY.push(performance.now() - t0);
    if (LATENCY_HISTORY.length > LATENCY_MAX) LATENCY_HISTORY.shift();
    probeLatency();
  }, 0);
}

// ---- Terminal management ----
function destroyTerminals() {
  for (const t of rtTerminals) {
    try {
      t.dispose();
    } catch {}
  }
  rtTerminals = [];
  rtContainers = [];
  if (sharedCtx) {
    sharedCtx.stopRenderLoop();
    sharedCtx.dispose();
    sharedCtx = null;
  }
  for (const t of xtTerminals) {
    try {
      t.dispose();
    } catch {}
  }
  xtTerminals = [];
  xtFits = [];
}

function buildGrid(): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "terminal-grid";
  grid.style.setProperty("--grid-cols", "2");
  grid.style.setProperty("--grid-rows", "2");
  grid.style.position = "relative";
  grid.style.width = "100%";
  grid.style.height = "100%";
  return grid;
}

function createReactTerm() {
  destroyTerminals();
  container.innerHTML = "";
  const grid = buildGrid();
  container.appendChild(grid);

  sharedCtx = new SharedWebGLContext({
    fontSize: 13,
    fontFamily: "monospace",
    theme: CATPPUCCIN_MOCHA,
  });
  const sc = sharedCtx.getCanvas();
  sc.style.cssText =
    "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1";
  grid.appendChild(sc);

  rtContainers = [];
  rtTerminals = [];
  for (let i = 0; i < PANE_COUNT; i++) {
    const pane = document.createElement("div");
    pane.className = "pane";
    const label = document.createElement("div");
    label.className = "pane-label";
    label.textContent = `${i}: ${PANE_LABELS[i]}`;
    label.style.zIndex = "2";
    pane.appendChild(label);
    const c = document.createElement("div");
    c.style.width = "100%";
    c.style.height = "100%";
    pane.appendChild(c);
    grid.appendChild(pane);
    rtContainers.push(c);
  }

  sharedCtx.init();
  for (let i = 0; i < PANE_COUNT; i++) {
    rtTerminals.push(
      new WebTerminal(rtContainers[i], {
        fontSize: 13,
        fontFamily: "monospace",
        theme: CATPPUCCIN_MOCHA,
        scrollback: 500,
        useWorker: true,
        sharedContext: sharedCtx,
        paneId: `pane-${i}`,
      }),
    );
  }

  requestAnimationFrame(() => {
    syncRtViewports();
    for (const t of rtTerminals) {
      try {
        t.fit();
      } catch {}
    }
  });
  sharedCtx.startRenderLoop();
}

function syncRtViewports() {
  if (!sharedCtx || rtContainers.length === 0) return;
  const grid = rtContainers[0].parentElement?.parentElement;
  if (!grid) return;
  const rect = grid.getBoundingClientRect();
  sharedCtx.syncCanvasSize(rect.width, rect.height);
  for (let i = 0; i < PANE_COUNT; i++) {
    const r = rtContainers[i].getBoundingClientRect();
    sharedCtx.setViewport(`pane-${i}`, r.left - rect.left, r.top - rect.top, r.width, r.height);
  }
}

function createXterm() {
  destroyTerminals();
  container.innerHTML = "";
  const grid = buildGrid();
  container.appendChild(grid);

  xtTerminals = [];
  xtFits = [];
  for (let i = 0; i < PANE_COUNT; i++) {
    const pane = document.createElement("div");
    pane.className = "pane";
    const label = document.createElement("div");
    label.className = "pane-label";
    label.textContent = `${i}: ${PANE_LABELS[i]}`;
    pane.appendChild(label);
    const d = document.createElement("div");
    d.style.width = "100%";
    d.style.height = "100%";
    pane.appendChild(d);
    grid.appendChild(pane);

    const fit = new FitAddon();
    const term = new XTerminal({
      fontSize: 13,
      fontFamily: "monospace",
      theme: XTERM_THEME,
      scrollback: 500,
    });
    term.loadAddon(fit);
    term.open(d);
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {}
    });
    xtTerminals.push(term);
    xtFits.push(fit);
  }
}

// ---- Flood: write synthetic data to all 4 panes ----
function startFlood() {
  paneOffsets.fill(0);
  totalBytes = 0;
  floodStartTime = performance.now();
  droppedFrames = 0;
  longTaskCount = 0;
  frameTimes = [];
  LATENCY_HISTORY.length = 0;

  btnStart.setAttribute("disabled", "");
  btnStop.removeAttribute("disabled");

  floodTimer = window.setInterval(() => {
    for (let p = 0; p < PANE_COUNT; p++) {
      const data = PANE_DATA[p];
      const end = Math.min(paneOffsets[p] + CHUNK_SIZE, data.length);
      const chunk = data.subarray(paneOffsets[p], end);

      if (currentEngine === "react-term" && p < rtTerminals.length) {
        rtTerminals[p].write(chunk);
      } else if (currentEngine === "xterm" && p < xtTerminals.length) {
        xtTerminals[p].write(chunk);
      }

      totalBytes += chunk.byteLength;
      paneOffsets[p] = end >= data.length ? 0 : end;
    }
  }, WRITE_INTERVAL);
}

function stopFlood() {
  if (floodTimer !== null) {
    clearInterval(floodTimer);
    floodTimer = null;
  }
  btnStart.removeAttribute("disabled");
  btnStop.setAttribute("disabled", "");
}

// ---- Engine toggle ----
function switchEngine(engine: Engine) {
  if (engine === currentEngine) return;
  currentEngine = engine;
  btnRt.classList.toggle("active", engine === "react-term");
  btnXt.classList.toggle("active", engine === "xterm");
  statEngine.textContent = engine;

  const wasFlooding = floodTimer !== null;
  stopFlood();

  if (engine === "react-term") createReactTerm();
  else createXterm();

  if (wasFlooding) setTimeout(startFlood, 300);
}

// ---- Resize ----
new ResizeObserver(() => {
  syncRtViewports();
  for (const t of rtTerminals) {
    try {
      t.fit();
    } catch {}
  }
  for (const f of xtFits) {
    try {
      f.fit();
    } catch {}
  }
}).observe(container);

// ---- Events ----
btnRt.addEventListener("click", () => switchEngine("react-term"));
btnXt.addEventListener("click", () => switchEngine("xterm"));
btnStart.addEventListener("click", () => {
  startFlood();
});
btnStop.addEventListener("click", stopFlood);

// ---- Long task observer ----
try {
  perfObserver = new PerformanceObserver((list) => {
    longTaskCount += list.getEntries().length;
  });
  perfObserver.observe({ type: "longtask", buffered: false });
} catch {}

// ---- Init ----
createReactTerm();
probeLatency();
requestAnimationFrame(frameLoop);
