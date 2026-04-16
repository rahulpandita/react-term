/**
 * Mux PTY Server — spawns 8 PTY processes with different workloads and
 * multiplexes their output over a single WebSocket per client.
 *
 * Protocol:
 *   Client → Server:  JSON  { type: "start", cols: number, rows: number }
 *   Server → Client:  Binary frames: [paneIndex (1 byte)] + [pty data]
 *   Server → Client:  JSON  { type: "ready", panes: string[] }
 *
 *   Client → Server:  Binary frames: [paneIndex (1 byte)] + [input data]
 *   Client → Server:  JSON  { type: "resize", pane: number, cols: number, rows: number }
 */

import { WebSocketServer, type WebSocket } from "ws";
import { spawn, type IPty } from "node-pty";
import { execSync } from "child_process";

const PORT = 8090;

// Coalesce PTY output over this interval before sending a WebSocket frame.
// Reduces per-chunk ws.send() overhead dramatically.
const COALESCE_MS = 4; // ~quarter frame at 60fps

function findShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  for (const sh of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    try {
      execSync(`test -x ${sh}`, { stdio: "ignore" });
      return sh;
    } catch {}
  }
  return "/bin/sh";
}

const shell = findShell();

// Workload definitions — commands that produce heavy, varied terminal output.
// Designed to saturate the rendering pipeline without shell overhead.
const WORKLOADS = [
  {
    name: "hex-dump",
    cmd: shell,
    args: [] as string[],
    init: "cat /dev/urandom | xxd\n",
  },
  {
    name: "log-stream",
    cmd: shell,
    args: [],
    init:
      process.platform === "darwin"
        ? "log stream --level info 2>/dev/null\n"
        : "journalctl -f 2>/dev/null || while true; do dmesg; done\n",
  },
  {
    name: "tree-color",
    cmd: shell,
    args: [],
    init: "while true; do ls -laRG /usr 2>/dev/null; done\n",
  },
  {
    name: "color-sgr",
    cmd: shell,
    args: [],
    // Single awk process — no per-iteration fork overhead
    init: `awk 'BEGIN{srand();while(1){for(i=0;i<80;i++){printf "\\033[38;5;%d;48;5;%dm%02x",int(rand()*256),int(rand()*256),int(rand()*256)}print "\\033[0m"}}'\n`,
  },
  {
    name: "find-deep",
    cmd: shell,
    args: [],
    init: "while true; do find /usr -type f 2>/dev/null; done\n",
  },
  {
    name: "ps-loop",
    cmd: shell,
    args: [],
    init: "while true; do ps auxww; done\n",
  },
  {
    name: "sysctl-dump",
    cmd: shell,
    args: [],
    init: "while true; do sysctl -a 2>/dev/null; done\n",
  },
  {
    name: "hex-dump-2",
    cmd: shell,
    args: [],
    init: "cat /dev/urandom | xxd\n",
  },
];

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected");
  const ptys: IPty[] = [];

  // Per-pane coalescing buffers
  const pendingChunks: Buffer[][] = [];
  const pendingBytes: number[] = [];
  const flushTimers: (ReturnType<typeof setTimeout> | null)[] = [];

  function flushPane(paneIdx: number) {
    flushTimers[paneIdx] = null;
    const chunks = pendingChunks[paneIdx];
    const totalLen = pendingBytes[paneIdx];
    if (totalLen === 0 || ws.readyState !== ws.OPEN) {
      chunks.length = 0;
      pendingBytes[paneIdx] = 0;
      return;
    }

    // Build a single frame: [paneIndex (1 byte)] + [coalesced data]
    const frame = Buffer.allocUnsafe(1 + totalLen);
    frame[0] = paneIdx;
    let offset = 1;
    for (const chunk of chunks) {
      chunk.copy(frame, offset);
      offset += chunk.length;
    }
    chunks.length = 0;
    pendingBytes[paneIdx] = 0;

    try {
      ws.send(frame);
    } catch {}
  }

  ws.on("message", (msg: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) {
      // Binary: [paneIndex (1 byte)] + [input data]
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg as ArrayBuffer);
      const paneIdx = buf[0];
      if (paneIdx < ptys.length) {
        ptys[paneIdx].write(buf.subarray(1).toString());
      }
      return;
    }

    // JSON control message
    const data = JSON.parse(msg.toString());

    if (data.type === "start") {
      if (ptys.length > 0) return; // prevent duplicate start
      const cols = Math.max(2, Math.min(data.cols ?? 120, 500));
      const rows = Math.max(1, Math.min(data.rows ?? 30, 500));
      const paneCount = Math.min(data.paneCount ?? WORKLOADS.length, 32);

      // Spawn PTYs — cycle workloads if paneCount > WORKLOADS.length
      for (let i = 0; i < paneCount; i++) {
        pendingChunks.push([]);
        pendingBytes.push(0);
        flushTimers.push(null);

        const wl = WORKLOADS[i % WORKLOADS.length];
        try {
          const pty = spawn(wl.cmd, wl.args, {
            name: "xterm-256color",
            cols,
            rows,
            cwd: process.env.HOME || "/tmp",
            env: {
              ...process.env,
              TERM: "xterm-256color",
            } as Record<string, string>,
          });

          ptys.push(pty);

          // Coalesce PTY output before sending
          const paneIdx = i;
          pty.onData((output: string) => {
            if (ws.readyState !== ws.OPEN) return;
            const buf = Buffer.from(output, "utf-8");
            pendingChunks[paneIdx].push(buf);
            pendingBytes[paneIdx] += buf.length;

            // Schedule a flush if one isn't pending
            if (flushTimers[paneIdx] === null) {
              flushTimers[paneIdx] = setTimeout(flushPane, COALESCE_MS, paneIdx);
            }
          });

          pty.onExit(() => {
            console.log(`Pane ${i} (${wl.name}) exited`);
          });

          // Send init command after a short delay for shell to be ready
          if (wl.init) {
            setTimeout(() => {
              try {
                pty.write(wl.init);
              } catch {}
            }, 300 + i * 100);
          }
        } catch (err) {
          console.error(`Failed to spawn pane ${i} (${wl.name}):`, err);
        }
      }

      // Tell client panes are ready
      const paneNames = Array.from({ length: paneCount }, (_, i) => WORKLOADS[i % WORKLOADS.length].name);
      ws.send(
        JSON.stringify({
          type: "ready",
          panes: paneNames,
        }),
      );
    } else if (data.type === "resize") {
      const idx = data.pane;
      if (idx >= 0 && idx < ptys.length) {
        try {
          ptys[idx].resize(
            Math.max(2, Math.min(data.cols ?? 80, 500)),
            Math.max(1, Math.min(data.rows ?? 24, 500)),
          );
        } catch {}
      }
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected — killing PTYs");
    for (let i = 0; i < flushTimers.length; i++) {
      if (flushTimers[i] !== null) clearTimeout(flushTimers[i]!);
    }
    for (const pty of ptys) {
      try {
        pty.kill();
      } catch {}
    }
    ptys.length = 0;
  });
});

console.log(`Mux PTY server running on ws://localhost:${PORT}`);
