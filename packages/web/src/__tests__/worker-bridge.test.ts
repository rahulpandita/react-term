import type { CursorState } from "@next_term/core";
import { CELL_SIZE, CellGrid } from "@next_term/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerBridge } from "../worker-bridge.js";

const DEFAULT_MODES = {
  applicationCursorKeys: false,
  bracketedPasteMode: false,
  mouseProtocol: "none",
  mouseEncoding: "default",
  sendFocusEvents: false,
  kittyFlags: 0,
  syncedOutput: false,
};

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
    bridge = new WorkerBridge(grid, makeGrid(), cursor, flushSpy, errorSpy);
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
      modes: DEFAULT_MODES,
    });

    expect(cursor.row).toBe(5);
    expect(cursor.col).toBe(10);
    expect(cursor.visible).toBe(false);
    expect(cursor.style).toBe("underline");
    expect(flushSpy).toHaveBeenCalledWith(false, DEFAULT_MODES);
  });

  it("calls onFlush with isAlternate=true when worker signals alternate buffer", () => {
    bridge.start(80, 24, 1000);

    mockWorkerInstance.simulateMessage({
      type: "flush",
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      isAlternate: true,
      bytesProcessed: 0,
      modes: DEFAULT_MODES,
    });

    expect(flushSpy).toHaveBeenCalledWith(true, DEFAULT_MODES);
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

    it("pauses when pending bytes exceed HIGH_WATERMARK (2MB)", () => {
      bridge.start(80, 24, 1000);

      // Send a chunk large enough to exceed the watermark.
      const bigChunk = new Uint8Array(2 * 1024 * 1024);
      bridge.write(bigChunk);

      expect(bridge.isPaused).toBe(true);
    });

    it("buffers writes while paused", () => {
      bridge.start(80, 24, 1000);

      // Exceed watermark.
      const bigChunk = new Uint8Array(2 * 1024 * 1024);
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
      const bigChunk = new Uint8Array(2 * 1024 * 1024);
      bridge.write(bigChunk);
      expect(bridge.isPaused).toBe(true);

      // Buffer a small write.
      bridge.write(new Uint8Array([65, 66, 67]));

      // Worker flushes most of the bytes.
      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block" },
        isAlternate: false,
        bytesProcessed: 2 * 1024 * 1024, // flush all of the big chunk
        modes: DEFAULT_MODES,
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

      const bigChunk = new Uint8Array(2 * 1024 * 1024);
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

  // ---- non-SAB applyFlush (cell-data transfer) ----------------------------

  describe("non-SAB applyFlush", () => {
    /**
     * Build a small flush message carrying transferred cell and dirty-row data.
     * `dirtyMask[r]` = 1 means logical row r is dirty.
     */
    function buildFlushMsg(
      cols: number,
      rows: number,
      cellValues: Record<number, number>, // index → Uint32 value
      dirtyMask: number[],
      rowOffset = 0,
    ) {
      const cellData = new Uint32Array(cols * rows * CELL_SIZE);
      for (const [idx, val] of Object.entries(cellValues)) {
        cellData[Number(idx)] = val;
      }
      const dirtyRows = new Int32Array(rows);
      for (let r = 0; r < rows; r++) dirtyRows[r] = dirtyMask[r] ?? 0;
      return {
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block" },
        isAlternate: false,
        bytesProcessed: 10,
        modes: DEFAULT_MODES,
        cellData: cellData.buffer,
        dirtyRows: dirtyRows.buffer,
        rowOffset,
      };
    }

    it("copies dirty rows from transferred cellData into the main-thread grid", () => {
      const cols = 2,
        rows = 2;
      const testGrid = new CellGrid(cols, rows);
      const testCursor = makeCursor();
      const b = new WorkerBridge(testGrid, new CellGrid(cols, rows), testCursor, vi.fn());
      b.start(cols, rows, 100);

      // Place codepoint 'A' (0x41) at physical (row=0, col=0).
      // word 0 = codepoint | (fg << 23); word 1 = 0 (bg=0).
      const msg = buildFlushMsg(cols, rows, { 0: 0x41 | (7 << 23) }, [1, 0]);
      mockWorkerInstance.simulateMessage(msg);

      expect(testGrid.getCodepoint(0, 0)).toBe(0x41);
      b.dispose();
    });

    it("skips non-dirty rows — their content remains unchanged", () => {
      const cols = 2,
        rows = 2;
      const testGrid = new CellGrid(cols, rows);
      // Write 'Z' into logical row 1 before the flush.
      testGrid.setCell(1, 0, 0x5a, 7, 0, 0); // 'Z'
      testGrid.clearDirty(1);

      const testCursor = makeCursor();
      const b = new WorkerBridge(testGrid, new CellGrid(cols, rows), testCursor, vi.fn());
      b.start(cols, rows, 100);

      // Send a message where only row 0 is dirty; the cellData for row 1 is
      // all-zeroes (would overwrite 'Z' if incorrectly applied).
      const msg = buildFlushMsg(cols, rows, { 0: 0x42 | (7 << 23) }, [1, 0]);
      mockWorkerInstance.simulateMessage(msg);

      // Row 0 updated ('B').
      expect(testGrid.getCodepoint(0, 0)).toBe(0x42);
      // Row 1 untouched ('Z' still there).
      expect(testGrid.getCodepoint(1, 0)).toBe(0x5a);
      b.dispose();
    });

    it("marks only the flushed dirty rows as dirty on the grid", () => {
      const cols = 2,
        rows = 2;
      const testGrid = new CellGrid(cols, rows);
      testGrid.clearDirty(0);
      testGrid.clearDirty(1);

      const b = new WorkerBridge(testGrid, new CellGrid(cols, rows), makeCursor(), vi.fn());
      b.start(cols, rows, 100);

      const msg = buildFlushMsg(cols, rows, {}, [1, 0]); // only row 0 dirty
      mockWorkerInstance.simulateMessage(msg);

      expect(testGrid.isDirty(0)).toBe(true);
      expect(testGrid.isDirty(1)).toBe(false);
      b.dispose();
    });

    it("syncs rowOffset to the grid's rowOffsetData", () => {
      const cols = 2,
        rows = 2;
      const testGrid = new CellGrid(cols, rows);
      const b = new WorkerBridge(testGrid, new CellGrid(cols, rows), makeCursor(), vi.fn());
      b.start(cols, rows, 100);

      const msg = buildFlushMsg(cols, rows, {}, [0, 0], /* rowOffset= */ 1);
      mockWorkerInstance.simulateMessage(msg);

      expect(testGrid.rowOffsetData[0]).toBe(1);
      b.dispose();
    });

    it("updates cursor fields from the flush message", () => {
      const cols = 2,
        rows = 2;
      const testGrid = new CellGrid(cols, rows);
      const testCursor = makeCursor();
      const b = new WorkerBridge(testGrid, new CellGrid(cols, rows), testCursor, vi.fn());
      b.start(cols, rows, 100);

      const cellData = new Uint32Array(cols * rows * CELL_SIZE);
      const dirtyRows = new Int32Array(rows);
      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 5, col: 12, visible: false, style: "bar" },
        isAlternate: true,
        bytesProcessed: 3,
        cellData: cellData.buffer,
        dirtyRows: dirtyRows.buffer,
        rowOffset: 0,
      });

      expect(testCursor.row).toBe(5);
      expect(testCursor.col).toBe(12);
      expect(testCursor.visible).toBe(false);
      expect(testCursor.style).toBe("bar");
      b.dispose();
    });
  });

  // ---- updateGrid ---------------------------------------------------------

  describe("updateGrid", () => {
    it("flush after updateGrid updates the new grid, not the old one", () => {
      const cols = 2,
        rows = 2;
      const oldGrid = new CellGrid(cols, rows);
      const newGrid = new CellGrid(cols, rows);
      const testCursor = makeCursor();
      const b = new WorkerBridge(oldGrid, new CellGrid(cols, rows), testCursor, vi.fn());
      b.start(cols, rows, 100);

      b.updateGrid(newGrid, new CellGrid(cols, rows), testCursor);

      const cellData = new Uint32Array(cols * rows * CELL_SIZE);
      cellData[0] = 0x43 | (7 << 23); // 'C' at row 0, col 0
      const dirtyRows = new Int32Array(rows);
      dirtyRows[0] = 1;

      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block" },
        isAlternate: false,
        bytesProcessed: 0,
        cellData: cellData.buffer,
        dirtyRows: dirtyRows.buffer,
        rowOffset: 0,
      });

      // New grid receives the data.
      expect(newGrid.getCodepoint(0, 0)).toBe(0x43);
      // Old grid unchanged — still holds space (0x20).
      expect(oldGrid.getCodepoint(0, 0)).toBe(0x20);
      b.dispose();
    });
  });

  // ---- Flush modes with kittyFlags and syncedOutput (#149) ----------------

  describe("flush modes with kittyFlags and syncedOutput", () => {
    it("passes kittyFlags from flush modes to onFlush callback", () => {
      bridge.start(80, 24, 1000);

      const modesWithKitty = {
        ...DEFAULT_MODES,
        kittyFlags: 3,
      };

      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block" },
        isAlternate: false,
        bytesProcessed: 10,
        modes: modesWithKitty,
      });

      expect(flushSpy).toHaveBeenCalledWith(false, modesWithKitty);
    });

    it("passes syncedOutput from flush modes to onFlush callback", () => {
      bridge.start(80, 24, 1000);

      const modesWithSync = {
        ...DEFAULT_MODES,
        syncedOutput: true,
      };

      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block" },
        isAlternate: false,
        bytesProcessed: 10,
        modes: modesWithSync,
      });

      expect(flushSpy).toHaveBeenCalledWith(false, modesWithSync);
    });
  });

  // ---- Guard conditions ---------------------------------------------------

  describe("guard conditions", () => {
    it("write after dispose is a no-op and does not throw", () => {
      bridge.start(80, 24, 1000);
      bridge.dispose();
      expect(() => bridge.write(new Uint8Array([0x41]))).not.toThrow();
    });

    it("resize after dispose is a no-op and does not throw", () => {
      bridge.start(80, 24, 1000);
      bridge.dispose();
      expect(() => bridge.resize(100, 40, 2000)).not.toThrow();
    });

    it("start after dispose is a no-op and does not throw", () => {
      bridge.start(80, 24, 1000);
      bridge.dispose();
      expect(() => bridge.start(80, 24, 1000)).not.toThrow();
    });
  });
});
