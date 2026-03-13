import type { Theme } from "@react-term/core";
import type { PaneLayout, TerminalHandle, TerminalPaneHandle } from "@react-term/react";
import { Terminal, TerminalPane } from "@react-term/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

const DARK_THEME: Partial<Theme> = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
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
    disconnected: "Local echo",
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
      wsRef.current = null;
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

    // Try WebSocket connection
    connectWs();

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
      for (const ch of str) {
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
      }
    },
    [executeCommand],
  );

  return (
    <div
      style={{
        width: "100vw",
        height: "100dvh",
        position: "relative",
        background: theme.background,
        overflow: "hidden",
      }}
    >
      <HUD isDark={isDark} onToggleTheme={toggleTheme} fps={fps} status={connStatus} />
      <Terminal
        ref={termRef}
        autoFit
        fontSize={14}
        fontFamily="'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace"
        theme={theme}
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
        { type: "single", id: "tl" },
        { type: "single", id: "tr" },
      ],
      sizes: [0.5, 0.5],
    },
    {
      type: "horizontal",
      children: [
        { type: "single", id: "bl" },
        { type: "single", id: "br" },
      ],
      sizes: [0.5, 0.5],
    },
  ],
  sizes: [0.5, 0.5],
};

function SplitPaneDemo({ theme, onBack }: { theme: Partial<Theme>; onBack: () => void }) {
  const paneRef = useRef<TerminalPaneHandle>(null);
  const lineBuffers = useRef<Record<string, string>>({});

  const handleData = useCallback((paneId: string, data: Uint8Array) => {
    const term = paneRef.current?.getTerminal(paneId);
    if (!term) return;

    if (!lineBuffers.current[paneId]) lineBuffers.current[paneId] = "";

    const str = new TextDecoder().decode(data);
    for (const ch of str) {
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
    }
  }, []);

  useEffect(() => {
    // Write welcome text to each pane
    const ids = paneRef.current?.getPaneIds() ?? [];
    for (const id of ids) {
      const term = paneRef.current?.getTerminal(id);
      if (term) {
        term.write(`\x1b[1;36m[${id}]\x1b[0m 2x2 Split Pane Demo\r\n`);
        term.write(`\x1b[1;36m[${id}]\x1b[0m ${PROMPT}`);
      }
    }
  }, []);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        position: "relative",
        background: theme.background,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 10,
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            background: "#333",
            color: "#eee",
            border: "none",
            borderRadius: 4,
            padding: "4px 12px",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "inherit",
          }}
        >
          Back to Single
        </button>
      </div>
      <TerminalPane
        ref={paneRef}
        layout={SPLIT_LAYOUT}
        theme={theme}
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
  const [view, setView] = useState<"single" | "split">("single");
  const [isDark, _setIsDark] = useState(true);
  const theme = useMemo(() => (isDark ? DARK_THEME : LIGHT_THEME), [isDark]);

  // Keyboard shortcut: Ctrl+Shift+D toggles split view
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault();
        setView((v) => (v === "single" ? "split" : "single"));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (view === "split") {
    return <SplitPaneDemo theme={theme} onBack={() => setView("single")} />;
  }

  return <App />;
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<Root />);
}
