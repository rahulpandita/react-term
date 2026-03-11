import { WebSocketServer } from 'ws';
import { spawn } from 'node-pty';
import { execSync } from 'child_process';

// Find a working shell
function findShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  for (const sh of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    try {
      execSync(`test -x ${sh}`, { stdio: 'ignore' });
      return sh;
    } catch {}
  }
  return '/bin/sh';
}

const shell = findShell();
console.log(`Using shell: ${shell}`);

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws) => {
  console.log('Client connected');
  let pty: ReturnType<typeof spawn>;

  try {
    pty = spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || '/tmp',
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });
  } catch (err) {
    console.error('Failed to spawn PTY:', err);
    ws.send(`\r\n\x1b[1;31mFailed to spawn shell: ${err}\x1b[0m\r\n`);
    ws.close();
    return;
  }

  pty.onData((data: string) => {
    try { ws.send(data); } catch {}
  });

  ws.on('message', (msg: Buffer) => {
    const str = msg.toString();
    if (str.startsWith('\x1b[8;')) {
      const match = str.match(/\x1b\[8;(\d+);(\d+)t/);
      if (match) {
        try { pty.resize(parseInt(match[2]), parseInt(match[1])); } catch {}
        return;
      }
    }
    pty.write(str);
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    try { pty.kill(); } catch {}
  });

  pty.onExit(() => {
    try { ws.close(); } catch {}
  });
});

console.log('PTY WebSocket server running on ws://localhost:8080');
