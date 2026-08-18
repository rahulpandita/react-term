import type { Theme } from "@next_term/core";
import type { PaneLayout, TerminalHandle, TerminalPaneHandle } from "@next_term/react";
import { Terminal, TerminalPane } from "@next_term/react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

const DARK_THEME: Partial<Theme> = {
  background: "#04070a",
  foreground: "#c9ffd8",
  cursor: "#00ff41",
  cursorAccent: "#04070a",
  selectionBackground: "#0d3a1c",
  black: "#04070a",
  red: "#ff6b6b",
  green: "#00ff41",
  yellow: "#d7ff5f",
  blue: "#5fd7ff",
  magenta: "#d787ff",
  cyan: "#35d96b",
  white: "#c9ffd8",
  brightBlack: "#4e8a63",
  brightRed: "#ff8f8f",
  brightGreen: "#78ff99",
  brightYellow: "#edff9a",
  brightBlue: "#9ae7ff",
  brightMagenta: "#e7b5ff",
  brightCyan: "#7fffa5",
  brightWhite: "#effff3",
};

const LIGHT_THEME: Partial<Theme> = {
  background: "#ffffff",
  foreground: "#1e1e1e",
  cursor: "#1e1e1e",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  black: "#000000",
  red: "#cd3131",
  green: "#008000",
  yellow: "#795e26",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

// ---------------------------------------------------------------------------
// Local echo mini-shell
// ---------------------------------------------------------------------------

type WriteFunc = (data: string) => void;

const WELCOME_BANNER = [
  "",
  "\x1b[1;36m  ____                 _     _____                   \x1b[0m",
  "\x1b[1;36m |  _ \\ ___  __ _  ___| |_  |_   _|__ _ __ _ __ ___  \x1b[0m",
  "\x1b[1;36m | |_) / _ \\/ _` |/ __| __|   | |/ _ \\ '__| '_ ` _ \\ \x1b[0m",
  "\x1b[1;36m |  _ <  __/ (_| | (__| |_    | |  __/ |  | | | | | |\x1b[0m",
  "\x1b[1;36m |_| \\_\\___|\\__,_|\\___|\\__|   |_|\\___|_|  |_| |_| |_|\x1b[0m",
  "",
  "\x1b[90m  High-performance terminal emulator for React\x1b[0m",
  "\x1b[90m  Canvas 2D rendering | TypeScript | Zero dependencies\x1b[0m",
  "",
  "  Type \x1b[1;33mhelp\x1b[0m for available commands.",
  "",
].join("\r\n");

const HELP_TEXT = [
  "",
  "\x1b[1;4mAvailable commands:\x1b[0m",
  "",
  "  \x1b[1;33mhelp\x1b[0m        Show this help message",
  "  \x1b[1;33mclear\x1b[0m       Clear the terminal screen",
  "  \x1b[1;33mecho\x1b[0m \x1b[90m<text>\x1b[0m  Echo text back",
  "  \x1b[1;33mcolors\x1b[0m      Show color palette test",
  "  \x1b[1;33mtheme\x1b[0m \x1b[90m<dark|light>\x1b[0m  Switch theme",
  "  \x1b[1;33mbenchmark\x1b[0m   Flood 10,000 lines of colored text",
  "",
].join("\r\n");

function showColors(write: WriteFunc) {
  write("\r\n\x1b[1;4m16 ANSI colors:\x1b[0m\r\n");
  for (let i = 0; i < 8; i++) write(`\x1b[4${i}m    \x1b[0m`);
  write("\r\n");
  for (let i = 0; i < 8; i++) write(`\x1b[10${i}m    \x1b[0m`);
  write("\r\n\r\n");

  write("\x1b[1;4m256 colors:\x1b[0m\r\n");
  for (let i = 0; i < 256; i++) {
    write(`\x1b[48;5;${i}m  \x1b[0m`);
    if ((i + 1) % 32 === 0) write("\r\n");
  }
  write("\r\n");

  write("\x1b[1;4mRGB gradient:\x1b[0m\r\n");
  for (let i = 0; i < 80; i++) {
    const r = Math.floor((255 * i) / 80);
    const g = Math.floor((255 * (80 - i)) / 80);
    const b = 128;
    write(`\x1b[48;2;${r};${g};${b}m \x1b[0m`);
  }
  write("\r\n\r\n");

  write("\x1b[1;4mText styles:\x1b[0m\r\n");
  write(
    "  \x1b[1mBold\x1b[0m  \x1b[2mDim\x1b[0m  \x1b[3mItalic\x1b[0m  \x1b[4mUnderline\x1b[0m  \x1b[7mInverse\x1b[0m  \x1b[9mStrikethrough\x1b[0m\r\n",
  );
  write("\r\n");
}

function runBenchmark(write: WriteFunc) {
  write("\r\n\x1b[1;33mBenchmark:\x1b[0m Writing 10,000 lines of colored text...\r\n");
  const start = performance.now();
  const colors = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96];
  const lines: string[] = [];
  for (let i = 0; i < 10000; i++) {
    const color = colors[i % colors.length];
    lines.push(
      `\x1b[${color}m[${String(i).padStart(5, "0")}] The quick brown fox jumps over the lazy dog | ABCDEFghijklmnop 1234567890\x1b[0m`,
    );
  }
  write(lines.join("\r\n"));
  const elapsed = performance.now() - start;
  write(
    `\r\n\r\n\x1b[1;32mDone!\x1b[0m 10,000 lines written in \x1b[1m${elapsed.toFixed(1)}ms\x1b[0m\r\n\r\n`,
  );
}

const PROMPT = "\x1b[1;33m$ \x1b[0m";
const INSTALL_COMMAND = "npm install @next_term/react@next";

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

type ConnectionStatus = "disconnected" | "connecting" | "connected";

function StatusIndicator({ status }: { status: ConnectionStatus }) {
  const colors: Record<ConnectionStatus, string> = {
    disconnected: "#666",
    connecting: "#e5e510",
    connected: "#0dbc79",
  };
  const labels: Record<ConnectionStatus, string> = {
    disconnected: "Interactive local shell",
    connecting: "Connecting...",
    connected: "PTY connected",
  };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        color: "#aaa",
      }}
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: colors[status],
          boxShadow: status === "connected" ? `0 0 6px ${colors[status]}` : "none",
        }}
      />
      {labels[status]}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FPS Counter
// ---------------------------------------------------------------------------

function useFps() {
  const [fps, setFps] = useState(0);

  useEffect(() => {
    let frameCount = 0;
    let lastTime = performance.now();
    let rafId: number;

    const tick = () => {
      frameCount++;
      const now = performance.now();
      if (now - lastTime >= 1000) {
        setFps(Math.round((frameCount * 1000) / (now - lastTime)));
        frameCount = 0;
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return fps;
}

function useParallax(target: { current: HTMLElement | null }) {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const element = target.current;
    if (!element) return;

    const update = () => {
      element.style.setProperty("--scroll-y", `${window.scrollY}px`);
    };

    update();
    window.addEventListener("scroll", update, { passive: true });

    return () => {
      window.removeEventListener("scroll", update);
    };
  }, [target]);
}

// ---------------------------------------------------------------------------
// Scroll-linked chapter progress
// ---------------------------------------------------------------------------

/**
 * JS fallback for browsers without CSS scroll-driven animations (Safari, Firefox).
 * Writes a 0..1 scroll progress (`--p`) and a fade weight (`--vis`) onto every
 * `[data-chapter]`. Browsers with `animation-timeline` handle this on the
 * compositor instead and skip this entirely.
 */
function useChapterProgress(root: { current: HTMLElement | null }) {
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    if (CSS.supports("animation-timeline: view()")) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const chapters = Array.from(host.querySelectorAll<HTMLElement>("[data-chapter]"));
    if (chapters.length === 0) return;

    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

    const update = () => {
      const viewport = window.innerHeight;

      for (const chapter of chapters) {
        const rect = chapter.getBoundingClientRect();
        const travel = rect.height - viewport;
        const progress = travel > 0 ? clamp01(-rect.top / travel) : 0.5;
        // Fade in over the first slice, out over the last, so pinned stages
        // hand off to each other instead of popping.
        const vis = Math.min(clamp01(progress / 0.18), clamp01((1 - progress) / 0.14));

        chapter.style.setProperty("--p", progress.toFixed(4));
        chapter.style.setProperty("--vis", vis.toFixed(4));
      }
    };

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);

    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [root]);
}

// ---------------------------------------------------------------------------
// Chapter stage visuals
// ---------------------------------------------------------------------------

const ids = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

/** Illustrative output using real package and source names from this repository. */
const FLOOD_LINES = [
  { esc: "\\e[32m", text: "✓ core/src/cell-grid.ts", meta: "shared" },
  { esc: "\\e[32m", text: "✓ core/src/parser/index.ts", meta: "parsed" },
  { esc: "\\e[2m", text: "· web/src/webgl-renderer.ts", meta: "batched" },
  { esc: "\\e[32m", text: "✓ web/src/parser-worker.ts", meta: "worker" },
  { esc: "\\e[33m", text: "! react/src/Terminal.tsx", meta: "render" },
  { esc: "\\e[32m", text: "✓ web/src/shared-context.ts", meta: "shared" },
  { esc: "\\e[2m", text: "· web/src/parser-pool.ts", meta: "pooled" },
  { esc: "\\e[32m", text: "✓ core/src/buffer.ts", meta: "ready" },
  { esc: "\\e[32m", text: "✓ web/src/web-terminal.ts", meta: "ready" },
  { esc: "\\e[2m", text: "· demo/src/main.tsx", meta: "live" },
];

const THREAD_CHIPS = [
  { id: "main", name: "main thread", state: "idle", load: 4 },
  { id: "parser-a", name: "parser worker", state: "busy", load: 91 },
  { id: "parser-b", name: "parser worker", state: "busy", load: 87 },
  { id: "renderer", name: "render worker", state: "busy", load: 78 },
];

/** The four 32-bit words in the current CellGrid layout. */
const CELL_WORDS = [
  { id: "w0", label: "word 0", bits: "0000 0000 0110 0001", note: "codepoint" },
  { id: "w1", label: "word 1", bits: "0000 0111 0000 0001", note: "fg · bg · flags" },
  { id: "w2", label: "word 2", bits: "0000 0000 0000 0000", note: "foreground RGB" },
  { id: "w3", label: "word 3", bits: "0000 0000 0000 0000", note: "background RGB" },
];

const GRID_GLYPHS = "npm run build ▍react-term ✓ 2 draw calls SharedArrayBuffer atomics";
const CELL_IDS = ids("cell", 130);
const ATLAS_GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789{}[]()<>/\\|=+-*&^%$#@!?;:,.~`'\"→←↑↓█▓▒░▍✓✗";
const PANE_IDS = Array.from({ length: 7 }, (_, i) => String(i + 1).padStart(2, "0"));

const PANE_CONTENT = [
  {
    cmd: "pnpm dev",
    lines: ["VITE v6.4.1  ready", "➜  localhost:5173", "", "watching for changes"],
  },
  {
    cmd: "pnpm test",
    lines: [
      "✓ cell-grid  38 passed",
      "✓ vt-parser  91 passed",
      "✓ buffer     24 passed",
      "",
      "153 passed (1.9s)",
    ],
  },
  {
    cmd: "git log --oneline",
    lines: [
      "8f750d4 scroll chapters",
      "030aa6b pages showcase",
      "1c4e9a2 webgl2 atlas",
      "b77f001 sab cell grid",
    ],
  },
  {
    cmd: "htop",
    lines: [
      "cpu ▓▓▓▓▓░░░░░  48%",
      "mem ▓▓▓▓▓▓▓░░░  71%",
      "",
      "node       412MB",
      "vite       188MB",
    ],
  },
  {
    cmd: "tail -f server.log",
    lines: [
      "GET  /api/session  200",
      "POST /api/pty      201",
      "GET  /assets/*     304",
      "GET  /api/health   200",
    ],
  },
  {
    cmd: "tsc --watch",
    lines: ["Starting compilation…", "", "Found 0 errors.", "Watching for changes."],
  },
  { cmd: "ssh build-01", lines: ["Linux build-01 6.8.0", "load average: 2.14", "", "$ make -j16"] },
];

function ThreadLanesVisual() {
  return (
    <div className="stage-art stage-threads" aria-hidden="true">
      <div className="slab slab-flood" data-depth="back">
        <div className="slab-bar">
          <i />
          <i />
          <i />
          <strong>npm run build</strong>
        </div>
        <div className="flood">
          {FLOOD_LINES.map((line) => (
            <p className="flood-line" key={line.text}>
              <span className="flood-esc">{line.esc}</span>
              <span className="flood-text">{line.text}</span>
              {line.meta ? <span className="flood-meta">{line.meta}</span> : null}
            </p>
          ))}
        </div>
        <div className="flood-fade" />
      </div>

      <div className="thread-chips" data-depth="front">
        {THREAD_CHIPS.map((chip) => (
          <div className={`thread-chip thread-chip-${chip.state}`} key={chip.id}>
            <span className="chip-dot" />
            <span className="chip-name">{chip.name}</span>
            <span className="chip-load">{chip.load}%</span>
            <span className="chip-meter" style={{ "--load": `${chip.load}%` } as CSSProperties} />
          </div>
        ))}
      </div>
    </div>
  );
}

function CellGridVisual() {
  return (
    <div className="stage-art stage-cells" aria-hidden="true">
      <div className="slab slab-grid" data-depth="back">
        <div className="slab-bar">
          <i />
          <i />
          <i />
          <strong>SharedArrayBuffer · 130 cells</strong>
        </div>
        <div className="cell-grid">
          {CELL_IDS.map((id, index) => {
            const glyph = GRID_GLYPHS[index % GRID_GLYPHS.length];
            const hot = index % 9 === 3;
            return (
              <span className={hot ? "cell cell-hot" : "cell"} key={id}>
                {glyph === " " ? "" : glyph}
              </span>
            );
          })}
        </div>
      </div>

      <div className="cell-words" data-depth="front">
        <span className="words-caption">1 cell = 8 bytes</span>
        {CELL_WORDS.map((word) => (
          <div className="word" key={word.id}>
            <span className="word-label">{word.label}</span>
            <code className="word-bits">{word.bits}</code>
            <span className="word-note">{word.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DrawCallVisual() {
  return (
    <div className="stage-art stage-draw" aria-hidden="true">
      <div className="slab slab-atlas" data-depth="back">
        <div className="slab-bar">
          <i />
          <i />
          <i />
          <strong>glyph atlas · GPU texture</strong>
        </div>
        <div className="atlas">
          {[...ATLAS_GLYPHS].map((glyph, index) => (
            <span
              className={index % 11 === 0 ? "atlas-cell atlas-cell-hot" : "atlas-cell"}
              key={`${glyph}-${index === 0 ? "a" : glyph.charCodeAt(0) + index}`}
            >
              {glyph}
            </span>
          ))}
        </div>
      </div>

      <div className="draw-readout" data-depth="front">
        <div className="draw-figure draw-figure-before">
          <span className="draw-count">1,920</span>
          <span className="draw-label">draws · one per glyph</span>
        </div>
        <span className="draw-rule" />
        <div className="draw-figure draw-figure-after">
          <span className="draw-count">2</span>
          <span className="draw-label">draws · instanced</span>
        </div>
      </div>
    </div>
  );
}

function PaneRailVisual() {
  return (
    <div className="stage-rail" aria-hidden="true">
      <div className="rail">
        {PANE_IDS.map((paneId, index) => {
          const content = PANE_CONTENT[index % PANE_CONTENT.length];
          return (
            <article className="rail-pane" key={paneId}>
              <header className="slab-bar">
                <i />
                <i />
                <i />
                <strong>pane {paneId}</strong>
              </header>
              <div className="rail-body">
                <p className="rail-cmd">
                  <span className="rail-prompt">$</span> {content.cmd}
                </p>
                {content.lines.map((line, lineIndex) => (
                  <p
                    className={line.startsWith("✓") ? "rail-line rail-line-ok" : "rail-line"}
                    key={`${paneId}-${lineIndex === 0 ? "first" : line || `blank${lineIndex}`}`}
                  >
                    {line || "\u00a0"}
                  </p>
                ))}
                <p className="rail-line rail-caret">
                  <span className="rail-prompt">$</span> <i className="caret" />
                </p>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The live xterm.js comparison, embedded as its own chapter. The stress test
 * is a real page, so it is only mounted once the chapter is near the viewport
 * — otherwise it would sit offscreen burning the main thread it exists to
 * measure.
 */
function BenchmarkVisual({ src }: { src: string }) {
  const holder = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const node = holder.current;
    if (!node || !active || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.every((entry) => !entry.isIntersecting)) setActive(false);
      },
      { rootMargin: "-15% 0px" },
    );
    observer.observe(node);

    return () => observer.disconnect();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const benchmarkOrigin = new URL(src, location.href).origin;
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== benchmarkOrigin || event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const message = event.data;
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "react-term:page-scroll" ||
        !("deltaY" in message) ||
        typeof message.deltaY !== "number" ||
        !Number.isFinite(message.deltaY)
      ) {
        return;
      }
      window.scrollBy({ top: message.deltaY, behavior: "auto" });
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [active, src]);

  return (
    <div className="stage-art stage-bench" ref={holder}>
      <div className="slab slab-bench" data-depth="back">
        <div className="slab-bar">
          <i />
          <i />
          <i />
          <strong>stress test · react-term vs xterm.js</strong>
        </div>
        <div className="bench-frame">
          {active ? (
            <>
              <iframe
                ref={iframeRef}
                className="bench-iframe"
                src={src}
                title="Rendering stress test"
              />
              <button className="bench-release" type="button" onClick={() => setActive(false)}>
                Pause benchmark
              </button>
            </>
          ) : (
            <div className="bench-gate">
              <div className="bench-preview" aria-hidden="true">
                <span>react-term</span>
                <strong>60.0 FPS</strong>
                <span>long tasks</span>
                <strong>0</strong>
              </div>
              <p>
                The live test is paused until you activate it, so this chapter never captures
                scrolling unexpectedly or consumes resources offscreen.
              </p>
              <button className="bench-activate" type="button" onClick={() => setActive(true)}>
                Activate live benchmark
              </button>
              <a className="bench-mobile-launch" href={src}>
                Open benchmark <span aria-hidden="true">→</span>
              </a>
            </div>
          )}
        </div>
      </div>

      <a className="bench-launch" data-depth="front" href={src}>
        Open full screen <span aria-hidden="true">→</span>
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Floating HUD
// ---------------------------------------------------------------------------

function HUD({
  isDark,
  onToggleTheme,
  fps,
  status,
}: {
  isDark: boolean;
  onToggleTheme: () => void;
  fps: number;
  status: ConnectionStatus;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 6,
        zIndex: 10,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        userSelect: "none",
      }}
    >
      <StatusIndicator status={status} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          color: "#aaa",
        }}
      >
        <span>Canvas 2D</span>
        <span style={{ color: fps >= 55 ? "#0dbc79" : fps >= 30 ? "#e5e510" : "#cd3131" }}>
          {fps} FPS
        </span>
        <button
          type="button"
          onClick={onToggleTheme}
          style={{
            background: isDark ? "#333" : "#ddd",
            color: isDark ? "#eee" : "#222",
            border: "none",
            borderRadius: 4,
            padding: "2px 8px",
            cursor: "pointer",
            fontSize: 11,
            fontFamily: "inherit",
          }}
        >
          {isDark ? "Light" : "Dark"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const termRef = useRef<TerminalHandle>(null);
  const [isDark, setIsDark] = useState(true);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const lineBufferRef = useRef("");
  const modeRef = useRef<"local" | "pty">("local");
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const _themeCallbackRef = useRef<((dark: boolean) => void) | null>(null);
  const fps = useFps();

  const theme = useMemo(() => (isDark ? DARK_THEME : LIGHT_THEME), [isDark]);

  // Register theme callback for the local echo `theme` command
  const toggleTheme = useCallback(() => setIsDark((prev) => !prev), []);

  // WebSocket connection
  const connectWs = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;

    setConnStatus("connecting");
    const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnStatus("connected");
      modeRef.current = "pty";
      lineBufferRef.current = "";
      // Clear and let PTY take over
      termRef.current?.write("\x1b[2J\x1b[H");
    };

    ws.onmessage = (ev) => {
      termRef.current?.write(ev.data as string);
    };

    ws.onclose = () => {
      // Only clear the ref if it still points to this socket — a newer
      // connection may have replaced it while this one was CLOSING.
      if (wsRef.current === ws) wsRef.current = null;
      if (modeRef.current === "pty") {
        // Was connected, now disconnected — show message and fall back
        modeRef.current = "local";
        setConnStatus("disconnected");
        termRef.current?.write("\r\n\x1b[1;31mDisconnected from PTY server.\x1b[0m\r\n");
        termRef.current?.write(
          "\x1b[90mFalling back to local echo mode. Reconnecting in 3s...\x1b[0m\r\n",
        );
        termRef.current?.write(PROMPT);
        // Attempt reconnection
        reconnectTimerRef.current = setTimeout(() => {
          connectWs();
        }, 3000);
      } else {
        setConnStatus("disconnected");
      }
    };

    ws.onerror = (event) => {
      console.error("WebSocket error:", event.type);
    };
  }, []);

  // Attempt initial connection on mount
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    // Show welcome banner immediately (local echo)
    term.write(WELCOME_BANNER);
    term.write(PROMPT);

    // GitHub Pages is static, so only probe for the optional PTY server in local development.
    if (import.meta.env.DEV) {
      connectWs();
    }

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        modeRef.current = "local"; // prevent reconnection message on unmount
        wsRef.current.close();
      }
    };
  }, [
    // Try WebSocket connection
    connectWs,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle resize
  const handleResize = useCallback((size: { cols: number; rows: number }) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(`\x1b[8;${size.rows};${size.cols}t`);
    }
  }, []);

  const executeCommand = useCallback((cmd: string, term: TerminalHandle) => {
    const write = (s: string) => term.write(s);
    const parts = cmd.split(/\s+/);
    const command = parts[0]?.toLowerCase() ?? "";

    switch (command) {
      case "":
        break;
      case "help":
        write(HELP_TEXT);
        break;
      case "clear":
        write("\x1b[2J\x1b[H");
        break;
      case "echo":
        write(`${parts.slice(1).join(" ")}\r\n`);
        break;
      case "colors":
        showColors(write);
        break;
      case "theme": {
        const arg = parts[1]?.toLowerCase();
        if (arg === "dark") {
          setIsDark(true);
          write("\x1b[90mSwitched to dark theme\x1b[0m\r\n");
        } else if (arg === "light") {
          setIsDark(false);
          write("\x1b[90mSwitched to light theme\x1b[0m\r\n");
        } else {
          write("Usage: theme <dark|light>\r\n");
        }
        break;
      }
      case "benchmark":
        runBenchmark(write);
        break;
      default:
        write(`\x1b[31mCommand not found:\x1b[0m ${command}\r\n`);
        break;
    }
    write(PROMPT);
  }, []);

  // Handle user input
  const handleData = useCallback(
    (data: Uint8Array) => {
      const ws = wsRef.current;
      const term = termRef.current;
      if (!term) return;

      // PTY mode: forward everything to server
      if (modeRef.current === "pty" && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextDecoder().decode(data));
        return;
      }

      // Local echo mode: mini shell
      const str = new TextDecoder().decode(data);
      let i = 0;
      while (i < str.length) {
        const ch = str[i];

        // Skip escape sequences (CSI, SS3, etc.) so arrow keys and
        // other special keys don't leak bracket characters into input.
        if (ch === "\x1b") {
          i++;
          if (i < str.length && str[i] === "[") {
            // CSI sequence: consume until final byte (0x40–0x7E)
            i++;
            while (i < str.length && str.charCodeAt(i) < 0x40) i++;
            if (i < str.length) i++; // skip final byte
          } else if (i < str.length && str[i] === "O") {
            // SS3 sequence (e.g. \x1bOA): skip next byte
            i += 2;
          } else {
            // Bare ESC or unrecognised — skip one byte
            if (i < str.length) i++;
          }
          continue;
        }

        if (ch === "\r") {
          const cmd = lineBufferRef.current.trim();
          lineBufferRef.current = "";
          term.write("\r\n");
          executeCommand(cmd, term);
        } else if (ch === "\x7f" || ch === "\b") {
          if (lineBufferRef.current.length > 0) {
            lineBufferRef.current = lineBufferRef.current.slice(0, -1);
            term.write("\b \b");
          }
        } else if (ch === "\x03") {
          // Ctrl+C
          lineBufferRef.current = "";
          term.write(`^C\r\n${PROMPT}`);
        } else if (ch === "\x0c") {
          // Ctrl+L
          term.write(`\x1b[2J\x1b[H${PROMPT}`);
          // keep lineBuffer as-is so user can continue typing
          term.write(lineBufferRef.current);
        } else if (ch >= " ") {
          lineBufferRef.current += ch;
          term.write(ch);
        }
        i++;
      }
    },
    [executeCommand],
  );

  return (
    <div className="terminal-surface" style={{ background: theme.background }}>
      <HUD isDark={isDark} onToggleTheme={toggleTheme} fps={fps} status={connStatus} />
      <Terminal
        ref={termRef}
        autoFit
        fontSize={14}
        fontFamily="'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace"
        theme={theme}
        scrollInputMode="page"
        onData={handleData}
        onResize={handleResize}
        renderMode="main"
        renderer="canvas2d"
        useWorker={false}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Split-pane demo
// ---------------------------------------------------------------------------

const SPLIT_LAYOUT: PaneLayout = {
  type: "vertical",
  children: [
    {
      type: "horizontal",
      children: [
        { type: "single", id: "hex-dump" },
        { type: "single", id: "log-stream" },
      ],
      sizes: [0.5, 0.5],
    },
    {
      type: "horizontal",
      children: [
        { type: "single", id: "color-ls" },
        { type: "single", id: "color-grid" },
      ],
      sizes: [0.5, 0.5],
    },
  ],
  sizes: [0.5, 0.5],
};

const PANE_TITLES: Record<string, string> = {
  "hex-dump": "binary inspection",
  "log-stream": "service logs",
  "color-ls": "workspace files",
  "color-grid": "ANSI palette",
};

function paneDemoLine(paneId: string, tick: number) {
  switch (paneId) {
    case "hex-dump": {
      const address = (tick * 16).toString(16).padStart(8, "0");
      const bytes = Array.from({ length: 16 }, (_, index) =>
        ((tick * 29 + index * 17) % 256).toString(16).padStart(2, "0"),
      );
      return `\x1b[33m${address}\x1b[0m  ${bytes.slice(0, 8).join(" ")}  ${bytes.slice(8).join(" ")}\r\n`;
    }
    case "log-stream": {
      const levels = [
        ["\x1b[32m", "INFO "],
        ["\x1b[36m", "DEBUG"],
        ["\x1b[33m", "WARN "],
      ];
      const messages = [
        "worker flush completed rows=24",
        "shared context frame committed",
        "parser queue drained in 1.8ms",
        "viewport resize cols=92 rows=28",
      ];
      const [color, level] = levels[tick % levels.length];
      return `\x1b[90m21:${String(tick % 60).padStart(2, "0")}:${String((tick * 7) % 60).padStart(2, "0")}\x1b[0m ${color}${level}\x1b[0m ${messages[tick % messages.length]}\r\n`;
    }
    case "color-ls": {
      const files = ["src/", "package.json", "renderer.ts", "worker-bridge.ts", "README.md"];
      const colors = ["\x1b[1;34m", "\x1b[0m", "\x1b[1;32m", "\x1b[1;36m"];
      const file = files[tick % files.length];
      return `${tick % 3 === 0 ? "drwxr-xr-x" : "-rw-r--r--"}  1 dev  staff  ${String(1024 + tick * 137).padStart(6)} ${colors[tick % colors.length]}${file}\x1b[0m\r\n`;
    }
    default: {
      let line = "";
      for (let column = 0; column < 28; column++) {
        const color = 16 + ((tick * 11 + column * 7) % 216);
        line += `\x1b[48;5;${color}m  \x1b[0m`;
      }
      return `${line}\r\n`;
    }
  }
}

function SplitPaneDemo({ theme }: { theme: Partial<Theme> }) {
  const paneRef = useRef<TerminalPaneHandle>(null);
  const lineBuffers = useRef<Record<string, string>>({});

  const handleData = useCallback((paneId: string, data: Uint8Array) => {
    const term = paneRef.current?.getTerminal(paneId);
    if (!term) return;

    if (!lineBuffers.current[paneId]) lineBuffers.current[paneId] = "";

    const str = new TextDecoder().decode(data);
    let i = 0;
    while (i < str.length) {
      const ch = str[i];

      // Skip escape sequences (arrow keys, etc.)
      if (ch === "\x1b") {
        i++;
        if (i < str.length && str[i] === "[") {
          i++;
          while (i < str.length && str.charCodeAt(i) < 0x40) i++;
          if (i < str.length) i++;
        } else if (i < str.length && str[i] === "O") {
          i += 2;
        } else {
          if (i < str.length) i++;
        }
        continue;
      }

      if (ch === "\r") {
        const cmd = lineBuffers.current[paneId].trim();
        lineBuffers.current[paneId] = "";
        term.write("\r\n");
        if (cmd === "clear") {
          term.write("\x1b[2J\x1b[H");
        } else if (cmd) {
          term.write(`\x1b[90mecho:\x1b[0m ${cmd}\r\n`);
        }
        term.write(`\x1b[1;36m[${paneId}]\x1b[0m ${PROMPT}`);
      } else if (ch === "\x7f" || ch === "\b") {
        if (lineBuffers.current[paneId].length > 0) {
          lineBuffers.current[paneId] = lineBuffers.current[paneId].slice(0, -1);
          term.write("\b \b");
        }
      } else if (ch >= " ") {
        lineBuffers.current[paneId] += ch;
        term.write(ch);
      }
      i++;
    }
  }, []);

  useEffect(() => {
    let tick = 0;
    let streamTimer: ReturnType<typeof setInterval> | null = null;
    const frame = requestAnimationFrame(() => {
      const ids = paneRef.current?.getPaneIds() ?? [];
      for (const id of ids) {
        const term = paneRef.current?.getTerminal(id);
        term?.write(`\x1b[1;36m${id}\x1b[0m \x1b[90m— ${PANE_TITLES[id]}\x1b[0m\r\n\r\n`);
      }

      streamTimer = setInterval(() => {
        for (const id of ids) {
          paneRef.current?.getTerminal(id)?.write(paneDemoLine(id, tick));
        }
        tick++;
      }, 75);
    });

    return () => {
      cancelAnimationFrame(frame);
      if (streamTimer) clearInterval(streamTimer);
    };
  }, []);

  return (
    <div className="terminal-surface" style={{ background: theme.background }}>
      <TerminalPane
        ref={paneRef}
        layout={SPLIT_LAYOUT}
        theme={theme}
        scrollInputMode="page"
        fontSize={14}
        fontFamily="'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace"
        onData={handleData}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root with view toggle
// ---------------------------------------------------------------------------

function Root() {
  const showcaseRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const comparisonUrl = import.meta.env.DEV
    ? `${location.protocol}//${location.hostname}:5180/jank-demo.html`
    : `${import.meta.env.BASE_URL}comparison/jank-demo.html`;

  const copyInstallCommand = useCallback(async () => {
    await navigator.clipboard.writeText(INSTALL_COMMAND);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, []);

  useParallax(showcaseRef);
  useChapterProgress(showcaseRef);

  return (
    <div className="showcase" ref={showcaseRef}>
      <header className="site-header">
        <a className="wordmark" href="./" aria-label="react-term home">
          react-term<span aria-hidden="true">_</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#features">Features</a>
          <a href="https://github.com/rahulpandita/react-term/wiki">Docs</a>
          <a className="github-link" href="https://github.com/rahulpandita/react-term">
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">The terminal belongs off the main thread.</h1>
            <p>
              A modern terminal emulator for React and React Native, built around shared memory,
              worker-native parsing, and renderers that scale from one pane to thirty-two.
            </p>
            <div className="hero-actions">
              <a className="primary-action" href="https://github.com/rahulpandita/react-term">
                Explore the source <span aria-hidden="true">↗</span>
              </a>
            </div>
            <div className="runtime-note">
              <span className="live-dot" aria-hidden="true" />
              Live in your browser. Type <code>help</code> to begin.
            </div>
          </div>

          <div className="terminal-frame">
            <div className="terminal-chrome" aria-hidden="true">
              <span />
              <span />
              <span />
              <strong>react-term — local shell</strong>
            </div>
            <App />
          </div>
        </section>

        <section className="chapters" aria-label="How react-term works">
          <section className="chapter" data-chapter aria-labelledby="chapter-threads">
            <div className="chapter-stage">
              <div className="chapter-copy">
                <p className="chapter-index">Parse</p>
                <h2 id="chapter-threads">Keep bursty output away from your UI thread.</h2>
                <p>
                  With SharedArrayBuffer available, escape sequences are parsed in workers. React,
                  input, and layout stay responsive while terminal output is processed off-thread.
                </p>
              </div>
              <ThreadLanesVisual />
            </div>
          </section>

          <section className="chapter" data-chapter aria-labelledby="chapter-memory">
            <div className="chapter-stage">
              <div className="chapter-copy">
                <p className="chapter-index">Share</p>
                <h2 id="chapter-memory">One cell grid shared without per-line copies.</h2>
                <p>
                  Each cell uses four 32-bit words inside a SharedArrayBuffer. On the isolated fast
                  path, workers publish dirty rows through Atomics instead of serializing each line.
                </p>
              </div>
              <CellGridVisual />
            </div>
          </section>

          <section className="chapter" data-chapter aria-labelledby="chapter-render">
            <div className="chapter-stage">
              <div className="chapter-copy">
                <p className="chapter-index">Render</p>
                <h2 id="chapter-render">The terminal grid in two primary draw calls.</h2>
                <p>
                  WebGL2 batches backgrounds and glyphs into two instanced passes; cursor,
                  selection, and highlights are separate overlays. Canvas 2D preserves output where
                  needed.
                </p>
              </div>
              <DrawCallVisual />
            </div>
          </section>

          <section className="chapter chapter-wide" data-chapter aria-labelledby="chapter-panes">
            <div className="chapter-stage chapter-stage-rail">
              <div className="chapter-copy">
                <p className="chapter-index">Scale</p>
                <h2 id="chapter-panes">Thirty-two panes on one graphics context.</h2>
                <p>
                  Panes share a single context and atlas instead of each claiming their own. Split
                  the workspace as far as the task needs.
                </p>
              </div>
              <PaneRailVisual />
            </div>
          </section>

          <section className="chapter chapter-live" data-chapter aria-labelledby="chapter-live">
            <div className="chapter-stage">
              <div className="chapter-copy">
                <p className="chapter-index">Operate</p>
                <h2 id="chapter-live">Four real terminals. One shared rendering surface.</h2>
                <p>
                  This is the actual <code>TerminalPane</code> component streaming four workloads.
                  Trackpad and touch scrolling stay with the page; drag a terminal scrollbar to
                  inspect that pane's history.
                </p>
              </div>
              <section
                className="live-panes-frame"
                aria-label="Live four-pane terminal demonstration"
              >
                <div className="slab-bar" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <strong>TerminalPane · live output</strong>
                </div>
                <SplitPaneDemo theme={DARK_THEME} />
              </section>
            </div>
          </section>

          <section className="chapter chapter-bench" data-chapter aria-labelledby="chapter-bench">
            <div className="chapter-stage chapter-stage-bench">
              <div className="chapter-copy">
                <p className="chapter-index">Prove</p>
                <h2 id="chapter-bench">Compare responsiveness under the same synthetic flood.</h2>
                <p>
                  Toggle between react-term and xterm.js, then inspect frame rate, event-loop
                  latency, dropped frames, and long tasks. Results depend on your browser and GPU.
                </p>
              </div>
              <BenchmarkVisual src={comparisonUrl} />
            </div>
          </section>
        </section>

        <section className="install-band" aria-labelledby="install-title">
          <div>
            <h2 id="install-title">Install the React package</h2>
            <a href="https://www.npmjs.com/package/@next_term/react">
              View <code>@next_term/react</code> on npm <span aria-hidden="true">↗</span>
            </a>
          </div>
          <div className="install-command">
            <code>{INSTALL_COMMAND}</code>
            <button type="button" onClick={copyInstallCommand} aria-live="polite">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </section>

        <section className="feature-band" id="features" aria-label="Project capabilities">
          <article>
            <strong>Zero-copy cells</strong>
            <span>SharedArrayBuffer + Atomics</span>
          </article>
          <article>
            <strong>2 draw calls</strong>
            <span>WebGL2 instanced rendering</span>
          </article>
          <article>
            <strong>32 panes</strong>
            <span>One shared graphics context</span>
          </article>
          <article>
            <strong>Universal fallback</strong>
            <span>Canvas 2D when needed</span>
          </article>
        </section>
      </main>

      <footer>
        <span>MIT licensed. Built for the terminal workloads React apps deserve.</span>
        <a href="https://github.com/rahulpandita/react-term/wiki/Getting-Started">
          Read the getting started guide <span aria-hidden="true">→</span>
        </a>
      </footer>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<Root />);
}
