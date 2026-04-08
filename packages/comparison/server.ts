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

// Workload definitions — commands that produce heavy, varied terminal output
// All workloads produce continuous output — heavy enough to stress rendering,
// throttled enough to not overwhelm the system at 16+ panes.
const WORKLOADS = [
  {
    name: "hex-dump",
    cmd: shell,
    args: [] as string[],
    init: "while true; do head -c 4096 /dev/urandom | xxd; done\n",
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
    init: 'while true; do for i in $(seq 1 2000); do printf "\\033[38;5;$((i % 256));48;5;$((RANDOM % 256))m%02x" $((RANDOM % 256)); if [ $((i % 80)) -eq 0 ]; then echo; fi; done; done\n',
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
    init: "while true; do head -c 4096 /dev/urandom | xxd; done\n",
  },
];

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected");
  const ptys: IPty[] = [];

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
      const cols = data.cols ?? 120;
      const rows = data.rows ?? 30;
      const paneCount = data.paneCount ?? WORKLOADS.length;

      // Spawn PTYs — cycle workloads if paneCount > WORKLOADS.length
      for (let i = 0; i < paneCount; i++) {
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

          // Forward PTY output as [paneIndex (1 byte)] + [data]
          pty.onData((output: string) => {
            if (ws.readyState !== ws.OPEN) return;
            const outBuf = Buffer.from(output, "utf-8");
            const frame = Buffer.allocUnsafe(1 + outBuf.length);
            frame[0] = i;
            outBuf.copy(frame, 1);
            try {
              ws.send(frame);
            } catch {}
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
          ptys[idx].resize(data.cols, data.rows);
        } catch {}
      }
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected — killing PTYs");
    for (const pty of ptys) {
      try {
        pty.kill();
      } catch {}
    }
    ptys.length = 0;
  });
});

console.log(`Mux PTY server running on ws://localhost:${PORT}`);
