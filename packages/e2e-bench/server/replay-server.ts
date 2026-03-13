import { WebSocketServer, type WebSocket } from 'ws';
import { scenarios } from '@react-term/bench/src/generators/index.js';

const PORT = 8081;
const CHUNK_SIZE = 64 * 1024; // 64KB

// Pre-generate all payloads on startup
const payloadMap = new Map<string, Uint8Array>();

console.log('Pre-generating payloads...');
for (const scenario of scenarios) {
  payloadMap.set(scenario.name, scenario.data);
  console.log(`  ${scenario.name}: ${(scenario.data.byteLength / 1e6).toFixed(2)} MB`);
}
console.log(`${payloadMap.size} scenarios loaded.`);

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

wss.on('connection', (ws: WebSocket) => {
  console.log('Benchmark client connected');

  ws.on('message', (raw: Buffer) => {
    let msg: { type: string; scenario?: string };
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Record<string, unknown>).type !== 'string') return;
      msg = parsed as { type: string; scenario?: string };
    } catch {
      return;
    }

    if (msg.type === 'list') {
      const names = Array.from(payloadMap.keys());
      ws.send(JSON.stringify({ type: 'scenarios', names }));
      return;
    }

    if (msg.type === 'start' && typeof msg.scenario === 'string') {
      const data = payloadMap.get(msg.scenario);
      if (!data) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown scenario' }));
        return;
      }

      const totalBytes = data.byteLength;
      ws.send(JSON.stringify({ type: 'started', scenario: msg.scenario, totalBytes }));

      const startTime = performance.now();

      // Send in 64KB chunks as fast as backpressure allows
      let offset = 0;
      const sendNextChunk = () => {
        while (offset < totalBytes) {
          const end = Math.min(offset + CHUNK_SIZE, totalBytes);
          const chunk = data.subarray(offset, end);
          offset = end;

          // Check backpressure
          if (ws.bufferedAmount > CHUNK_SIZE * 4) {
            setTimeout(sendNextChunk, 1);
            return;
          }

          ws.send(chunk);
        }

        // All chunks sent
        const serverElapsedMs = performance.now() - startTime;
        ws.send(JSON.stringify({
          type: 'done',
          scenario: msg.scenario,
          totalBytes,
          serverElapsedMs,
        }));
        console.log(`  ${msg.scenario}: sent ${(totalBytes / 1e6).toFixed(2)} MB in ${serverElapsedMs.toFixed(1)}ms`);
      };

      sendNextChunk();
    }
  });

  ws.on('close', () => {
    console.log('Benchmark client disconnected');
  });
});

console.log(`Replay server running on ws://localhost:${PORT}`);
