/**
 * Mux WebSocket client — connects to the PTY mux server,
 * demuxes binary frames by pane index, dispatches to callbacks.
 */

export interface MuxCallbacks {
  onData: (paneIndex: number, data: Uint8Array) => void;
  onReady: (paneNames: string[]) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

export class MuxClient {
  private ws: WebSocket | null = null;
  private callbacks: MuxCallbacks;

  constructor(callbacks: MuxCallbacks) {
    this.callbacks = callbacks;
  }

  connect(cols: number, rows: number, paneCount?: number) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.callbacks.onConnect();
      this.ws?.send(JSON.stringify({ type: "start", cols, rows, paneCount }));
    };

    this.ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data);
        if (msg.type === "ready") {
          this.callbacks.onReady(msg.panes);
        }
      } else {
        // Binary: [paneIndex (1 byte)] + [data]
        const buf = new Uint8Array(ev.data as ArrayBuffer);
        const paneIndex = buf[0];
        // Copy into an owned buffer so the worker bridge can transfer
        // (subarray keeps byteOffset=1 which defeats zero-copy transfer)
        const data = buf.slice(1);
        this.callbacks.onData(paneIndex, data);
      }
    };

    this.ws.onclose = () => {
      this.callbacks.onDisconnect();
    };

    this.ws.onerror = () => {
      this.callbacks.onDisconnect();
    };
  }

  private encoder = new TextEncoder();

  sendInput(paneIndex: number, data: string | Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const encoded = typeof data === "string" ? this.encoder.encode(data) : data;
    const frame = new Uint8Array(1 + encoded.length);
    frame[0] = paneIndex;
    frame.set(encoded, 1);
    this.ws.send(frame);
  }

  resize(paneIndex: number, cols: number, rows: number) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "resize", pane: paneIndex, cols, rows }));
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
  }
}
