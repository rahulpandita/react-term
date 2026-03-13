import type { CursorState } from "@react-term/core";
import { CellGrid } from "@react-term/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerBridge } from "../worker-bridge.js";

// ---------------------------------------------------------------------------
// Mock Worker
// ---------------------------------------------------------------------------

class MockWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private listeners = new Map<string, Set<(event: Event) => void>>();
  postMessage = vi.fn();
  terminate = vi.fn();

  addEventListener(type: string, handler: (event: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(handler);
  }

  removeEventListener(type: string, handler: (event: Event) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  /** Simulate a message from the worker. */
  simulateMessage(data: unknown): void {
    const handlers = this.listeners.get("message");
    if (handlers) {
      for (const h of handlers) {
        h({ data } as MessageEvent);
      }
    }
  }

  /** Simulate an error from the worker. */
  simulateError(message: string): void {
    const handlers = this.listeners.get("error");
    if (handlers) {
      for (const h of handlers) {
        h({ message } as ErrorEvent);
      }
    }
  }
}

let mockWorkerInstance: MockWorker;

// Stub `new Worker(...)` — vitest runs in Node so there is no real Worker.
function createMockWorkerClass() {
  return function MockWorkerConstructor() {
    mockWorkerInstance = new MockWorker();
    // Return mock so WorkerBridge interacts with our mock.
    return mockWorkerInstance as unknown as Worker;
  } as unknown as typeof Worker;
}

vi.stubGlobal("Worker", createMockWorkerClass());

// Stub URL so `new URL(...)` works in Node.
vi.stubGlobal(
  "URL",
  class {
    href: string;
    constructor(path: string, base?: string | URL) {
      this.href = `${base ?? ""}${path}`;
    }
    toString(): string {
      return this.href;
    }
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGrid(): CellGrid {
  return new CellGrid(80, 24);
}

function makeCursor(): CursorState {
  return { row: 0, col: 0, visible: true, style: "block", wrapPending: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkerBridge", () => {
  let grid: CellGrid;
  let cursor: CursorState;
  let flushSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.fn>;
  let bridge: WorkerBridge;

  beforeEach(() => {
    grid = makeGrid();
    cursor = makeCursor();
    flushSpy = vi.fn();
    errorSpy = vi.fn();
    bridge = new WorkerBridge(grid, cursor, flushSpy, errorSpy);
  });

  afterEach(() => {
    bridge.dispose();
  });

  // ---- Creation & start ---------------------------------------------------

  it("can be created without throwing", () => {
    expect(bridge).toBeDefined();
  });

  it("sends an init message when started", () => {
    bridge.start(80, 24, 1000);
    expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "init", cols: 80, rows: 24, scrollback: 1000 }),
    );
  });

  // ---- write --------------------------------------------------------------

  it("sends a write message to the worker", () => {
    bridge.start(80, 24, 1000);
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    bridge.write(data);

    // The second call should be the write (first is init).
    const writeCalls = mockWorkerInstance.postMessage.mock.calls.filter(
      (c) => c[0]?.type === "write",
    );
    expect(writeCalls.length).toBe(1);
    expect(writeCalls[0][0].type).toBe("write");
  });

  // ---- resize -------------------------------------------------------------

  it("sends a resize message to the worker", () => {
    bridge.start(80, 24, 1000);
    bridge.resize(120, 40, 2000);

    const resizeCalls = mockWorkerInstance.postMessage.mock.calls.filter(
      (c) => c[0]?.type === "resize",
    );
    expect(resizeCalls.length).toBe(1);
    expect(resizeCalls[0][0]).toEqual(
      expect.objectContaining({ type: "resize", cols: 120, rows: 40, scrollback: 2000 }),
    );
  });

  // ---- dispose ------------------------------------------------------------

  it("sends a dispose message and terminates the worker", () => {
    bridge.start(80, 24, 1000);
    bridge.dispose();

    const disposeCalls = mockWorkerInstance.postMessage.mock.calls.filter(
      (c) => c[0]?.type === "dispose",
    );
    expect(disposeCalls.length).toBe(1);
    expect(mockWorkerInstance.terminate).toHaveBeenCalled();
  });

  // ---- flush handling -----------------------------------------------------

  it("updates cursor on flush message", () => {
    bridge.start(80, 24, 1000);

    // Simulate the worker sending a flush.
    mockWorkerInstance.simulateMessage({
      type: "flush",
      cursor: { row: 5, col: 10, visible: false, style: "underline" },
      isAlternate: false,
      bytesProcessed: 100,
    });

    expect(cursor.row).toBe(5);
    expect(cursor.col).toBe(10);
    expect(cursor.visible).toBe(false);
    expect(cursor.style).toBe("underline");
    expect(flushSpy).toHaveBeenCalledWith(false);
  });

  it("calls onFlush with isAlternate=true when worker signals alternate buffer", () => {
    bridge.start(80, 24, 1000);

    mockWorkerInstance.simulateMessage({
      type: "flush",
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      isAlternate: true,
      bytesProcessed: 0,
    });

    expect(flushSpy).toHaveBeenCalledWith(true);
  });

  // ---- error handling -----------------------------------------------------

  it("invokes onError when the worker posts an error message", () => {
    bridge.start(80, 24, 1000);

    mockWorkerInstance.simulateMessage({ type: "error", message: "boom" });
    expect(errorSpy).toHaveBeenCalledWith("boom");
  });

  it("invokes onError on worker runtime error", () => {
    bridge.start(80, 24, 1000);

    mockWorkerInstance.simulateError("runtime boom");
    expect(errorSpy).toHaveBeenCalledWith("Worker error: runtime boom");
  });

  // ---- Flow control -------------------------------------------------------

  describe("flow control", () => {
    it("starts unpaused", () => {
      bridge.start(80, 24, 1000);
      expect(bridge.isPaused).toBe(false);
      expect(bridge.pendingByteCount).toBe(0);
    });

    it("pauses when pending bytes exceed HIGH_WATERMARK (500KB)", () => {
      bridge.start(80, 24, 1000);

      // Send a chunk large enough to exceed the watermark.
      const bigChunk = new Uint8Array(500 * 1024);
      bridge.write(bigChunk);

      expect(bridge.isPaused).toBe(true);
    });

    it("buffers writes while paused", () => {
      bridge.start(80, 24, 1000);

      // Exceed watermark.
      const bigChunk = new Uint8Array(500 * 1024);
      bridge.write(bigChunk);
      expect(bridge.isPaused).toBe(true);

      // Further writes should be buffered, not sent.
      const callsBefore = mockWorkerInstance.postMessage.mock.calls.filter(
        (c) => c[0]?.type === "write",
      ).length;

      bridge.write(new Uint8Array([1, 2, 3]));

      const callsAfter = mockWorkerInstance.postMessage.mock.calls.filter(
        (c) => c[0]?.type === "write",
      ).length;

      expect(callsAfter).toBe(callsBefore); // no new write sent
    });

    it("resumes and drains the queue when pending bytes drop below LOW_WATERMARK", () => {
      bridge.start(80, 24, 1000);

      // Exceed watermark.
      const bigChunk = new Uint8Array(500 * 1024);
      bridge.write(bigChunk);
      expect(bridge.isPaused).toBe(true);

      // Buffer a small write.
      bridge.write(new Uint8Array([65, 66, 67]));

      // Worker flushes most of the bytes.
      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block" },
        isAlternate: false,
        bytesProcessed: 500 * 1024, // flush all of the big chunk
      });

      // Should be unpaused now and the queued write should have been sent.
      expect(bridge.isPaused).toBe(false);

      const writeCalls = mockWorkerInstance.postMessage.mock.calls.filter(
        (c) => c[0]?.type === "write",
      );
      // Initial big write + drained small write = 2
      expect(writeCalls.length).toBe(2);
    });

    it("resize resets flow control state", () => {
      bridge.start(80, 24, 1000);

      const bigChunk = new Uint8Array(500 * 1024);
      bridge.write(bigChunk);
      expect(bridge.isPaused).toBe(true);

      bridge.resize(120, 40, 2000);
      expect(bridge.isPaused).toBe(false);
      expect(bridge.pendingByteCount).toBe(0);
    });
  });

  // ---- Message serialization ----------------------------------------------

  describe("message serialization", () => {
    it("transfers the write data ArrayBuffer", () => {
      bridge.start(80, 24, 1000);

      const data = new Uint8Array([0x41, 0x42]);
      bridge.write(data);

      const writeCalls = mockWorkerInstance.postMessage.mock.calls.filter(
        (c) => c[0]?.type === "write",
      );
      expect(writeCalls.length).toBe(1);

      // The second argument to postMessage should be the transferables array.
      const transferables = writeCalls[0][1];
      expect(Array.isArray(transferables)).toBe(true);
      expect(transferables.length).toBe(1);
      expect(transferables[0]).toBeInstanceOf(ArrayBuffer);
    });

    it("init message includes cols, rows, scrollback", () => {
      bridge.start(100, 50, 5000);

      const initCall = mockWorkerInstance.postMessage.mock.calls.find((c) => c[0]?.type === "init");
      expect(initCall).toBeDefined();
      expect(initCall?.[0]).toEqual(
        expect.objectContaining({ type: "init", cols: 100, rows: 50, scrollback: 5000 }),
      );
    });
  });
});
