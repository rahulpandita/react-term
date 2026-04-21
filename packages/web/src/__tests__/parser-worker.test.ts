// @vitest-environment jsdom
/**
 * Unit tests for the parser-worker entry point.
 *
 * The worker module registers a `message` event listener on `self` at import
 * time.  In jsdom `self === window`, so we dispatch MessageEvents on `window`
 * to exercise the worker's message handler and spy on `postMessage` to
 * observe outbound flush/error messages.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorMessage, FlushMessage } from "../parser-worker.js";

// ── Global stubs (must be installed before the module is imported) ──────────

const sent: { data: unknown; transfer?: Transferable[] }[] = [];

vi.stubGlobal(
  "postMessage",
  vi.fn((data: unknown, transfer?: Transferable[]) => {
    sent.push({ data, transfer });
  }),
);
vi.stubGlobal("close", vi.fn());

// ── Import the worker module (registers the `message` listener on `self`) ───

beforeAll(async () => {
  await import("../parser-worker.js");
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function dispatch(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

function enc(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

function lastSent(): unknown {
  return sent[sent.length - 1]?.data;
}

function lastFlush(): FlushMessage {
  const msg = lastSent();
  if (!msg || (msg as FlushMessage).type !== "flush") {
    throw new Error(`Expected flush message, got: ${JSON.stringify(msg)}`);
  }
  return msg as FlushMessage;
}

/**
 * Read the codepoint stored at a logical cell position from a transferred
 * cellData ArrayBuffer.
 *
 * Cell layout (matches cell-grid.ts): 4 × uint32 per cell; the codepoint
 * occupies the low 21 bits of word 0.  The grid uses a circular row buffer
 * rotated by `rowOffset` (from the flush message; 0 on a freshly initialised
 * terminal).
 */
function getCellCodepoint(
  cellData: ArrayBuffer,
  cols: number,
  row: number,
  col: number,
  rowOffset: number,
  rows: number,
): number {
  const CELL_SIZE = 4;
  const physRow = (row + rowOffset) % rows;
  const uint32 = new Uint32Array(cellData);
  return uint32[(physRow * cols + col) * CELL_SIZE] & 0x1fffff;
}

// ── Per-test setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  sent.length = 0;
  // Dispose any prior state (close() is stubbed so no real effect)
  dispatch({ type: "dispose" });
  sent.length = 0;
  // Fresh non-SAB init
  dispatch({ type: "init", cols: 80, rows: 24, scrollback: 100 });
  sent.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("init message", () => {
  it("initialises the parser — cursor is at origin before any write", () => {
    // 'A' placed at col 0 → cursor advances to col 1; row stays at 0
    dispatch({ type: "write", data: enc("A") });
    const flush = lastFlush();
    expect(flush.cursor.row).toBe(0);
    expect(flush.cursor.col).toBe(1);
    expect(flush.isAlternate).toBe(false);
    expect(flush.bytesProcessed).toBe(1);
  });

  it("SAB mode: flush omits cell-data transferables", () => {
    sent.length = 0;
    const sab = new SharedArrayBuffer(1024);
    dispatch({ type: "init", cols: 40, rows: 10, scrollback: 50, sharedBuffer: sab });
    sent.length = 0;
    dispatch({ type: "write", data: enc("X") });
    const flush = lastFlush();
    expect(flush.cellData).toBeUndefined();
    expect(flush.dirtyRows).toBeUndefined();
    expect(flush.rowOffset).toBeUndefined();
  });
});

describe("write message", () => {
  it("reports correct bytesProcessed", () => {
    dispatch({ type: "write", data: enc("Hello") });
    expect(lastFlush().bytesProcessed).toBe(5);
  });

  it("flush cursor reflects actual position after two printable chars", () => {
    dispatch({ type: "write", data: enc("Hi") });
    const { cursor } = lastFlush();
    expect(cursor.row).toBe(0);
    expect(cursor.col).toBe(2);
    expect(cursor.visible).toBe(true);
    expect(cursor.style).toBe("block");
  });

  it("non-SAB flush includes cellData, dirtyRows, and rowOffset", () => {
    dispatch({ type: "write", data: enc("Z") });
    const flush = lastFlush();
    expect(flush.cellData).toBeInstanceOf(ArrayBuffer);
    expect(flush.dirtyRows).toBeInstanceOf(ArrayBuffer);
    expect(typeof flush.rowOffset).toBe("number");
  });

  it("non-SAB flush transfers cellData as Transferable", () => {
    dispatch({ type: "write", data: enc("T") });
    const { transfer } = sent[sent.length - 1];
    expect(Array.isArray(transfer)).toBe(true);
    expect((transfer as ArrayBuffer[]).length).toBeGreaterThan(0);
  });

  it("cellData encodes the characters written to the terminal grid", () => {
    dispatch({ type: "write", data: enc("Hi") });
    const { cellData, rowOffset } = lastFlush();
    expect(cellData).toBeInstanceOf(ArrayBuffer);
    expect(typeof rowOffset).toBe("number");
    expect(getCellCodepoint(cellData as ArrayBuffer, 80, 0, 0, rowOffset as number, 24)).toBe(
      "H".charCodeAt(0),
    );
    expect(getCellCodepoint(cellData as ArrayBuffer, 80, 0, 1, rowOffset as number, 24)).toBe(
      "i".charCodeAt(0),
    );
  });

  it("dirtyRows buffer length matches the terminal row count", () => {
    // Int32Array: 4 bytes per element; 24 rows → 96 bytes
    dispatch({ type: "write", data: enc("X") });
    const { dirtyRows } = lastFlush();
    expect(dirtyRows).toBeInstanceOf(ArrayBuffer);
    expect((dirtyRows as ArrayBuffer).byteLength).toBe(24 * 4);
  });

  it("cursor.col advances after printable ASCII characters", () => {
    dispatch({ type: "write", data: enc("AB") });
    expect(lastFlush().cursor.col).toBe(2);
  });

  it("isAlternate is false on the main buffer", () => {
    dispatch({ type: "write", data: enc("A") });
    expect(lastFlush().isAlternate).toBe(false);
  });

  it("isAlternate becomes true after switching to alt screen (DECSET 1049)", () => {
    // ESC [ ? 1049 h — switch to alternate screen
    const altOn = new Uint8Array([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]);
    dispatch({ type: "write", data: altOn.buffer });
    expect(lastFlush().isAlternate).toBe(true);
  });

  it("posts error when write arrives before init", () => {
    dispatch({ type: "dispose" });
    sent.length = 0;
    dispatch({ type: "write", data: enc("X") });
    const msg = lastSent() as ErrorMessage;
    expect(msg.type).toBe("error");
    expect(typeof msg.message).toBe("string");
    expect(msg.message.length).toBeGreaterThan(0);
  });
});

describe("flush modes (#149)", () => {
  it("flush includes kittyFlags=0 and syncedOutput=false by default", () => {
    dispatch({ type: "write", data: enc("A") });
    const flush = lastFlush();
    expect(flush.modes.kittyFlags).toBe(0);
    expect(flush.modes.syncedOutput).toBe(false);
  });

  it("flush includes kittyFlags after CSI = 1 u", () => {
    // CSI = 1 u enables kitty disambiguate flag
    dispatch({ type: "write", data: enc("\x1b[=1u") });
    const flush = lastFlush();
    expect(flush.modes.kittyFlags).toBe(1);
  });

  it("flush includes kittyFlags=3 after CSI = 3 u", () => {
    dispatch({ type: "write", data: enc("\x1b[=3u") });
    const flush = lastFlush();
    expect(flush.modes.kittyFlags).toBe(3);
  });

  it("flush includes syncedOutput=true after DECSET 2026", () => {
    dispatch({ type: "write", data: enc("\x1b[?2026h") });
    const flush = lastFlush();
    expect(flush.modes.syncedOutput).toBe(true);
  });

  it("flush includes syncedOutput=false after DECRST 2026", () => {
    dispatch({ type: "write", data: enc("\x1b[?2026h") }); // enable
    dispatch({ type: "write", data: enc("\x1b[?2026l") }); // disable
    const flush = lastFlush();
    expect(flush.modes.syncedOutput).toBe(false);
  });

  it("flush includes all 7 mode fields", () => {
    dispatch({ type: "write", data: enc("A") });
    const { modes } = lastFlush();
    expect(modes).toHaveProperty("applicationCursorKeys");
    expect(modes).toHaveProperty("bracketedPasteMode");
    expect(modes).toHaveProperty("mouseProtocol");
    expect(modes).toHaveProperty("mouseEncoding");
    expect(modes).toHaveProperty("sendFocusEvents");
    expect(modes).toHaveProperty("kittyFlags");
    expect(modes).toHaveProperty("syncedOutput");
  });
});

describe("resize message", () => {
  it("resize flush resets cursor to (0, 0) with new dimensions", () => {
    // Advance the cursor first so we can confirm resize resets it
    dispatch({ type: "write", data: enc("ABCDE") });
    sent.length = 0;
    dispatch({ type: "resize", cols: 40, rows: 12, scrollback: 200 });
    const flush = lastFlush();
    expect(flush.cursor.row).toBe(0);
    expect(flush.cursor.col).toBe(0);
  });

  it("resize flush has bytesProcessed = 0", () => {
    dispatch({ type: "resize", cols: 40, rows: 12, scrollback: 200 });
    expect(lastFlush().bytesProcessed).toBe(0);
  });

  it("non-SAB resize flush includes transferable cell data", () => {
    dispatch({ type: "resize", cols: 40, rows: 12, scrollback: 100 });
    const flush = lastFlush();
    expect(flush.cellData).toBeInstanceOf(ArrayBuffer);
    expect(flush.dirtyRows).toBeInstanceOf(ArrayBuffer);
  });

  it("cursor col is clamped within new column bounds after overflow write", () => {
    // Resize to 10 cols then write 25 printable chars — wraps multiple times
    const newCols = 10;
    dispatch({ type: "resize", cols: newCols, rows: 10, scrollback: 50 });
    sent.length = 0;
    dispatch({ type: "write", data: enc("ABCDEFGHIJKLMNOPQRSTUVWXY") });
    const col = lastFlush().cursor.col;
    expect(col).toBeGreaterThanOrEqual(0);
    expect(col).toBeLessThanOrEqual(newCols - 1);
  });
});

describe("dispose message", () => {
  it("calls self.close()", () => {
    const closeSpy = vi.fn();
    vi.stubGlobal("close", closeSpy);
    dispatch({ type: "dispose" });
    expect(closeSpy).toHaveBeenCalledOnce();
    vi.stubGlobal("close", vi.fn());
  });

  it("write after dispose posts an error message", () => {
    dispatch({ type: "dispose" });
    sent.length = 0;
    dispatch({ type: "write", data: enc("X") });
    const msg = lastSent() as ErrorMessage;
    expect(msg.type).toBe("error");
  });

  it("dispose is idempotent — second dispose does not throw", () => {
    dispatch({ type: "dispose" });
    sent.length = 0;
    expect(() => dispatch({ type: "dispose" })).not.toThrow();
  });
});

// ─── Multi-channel mode (pool worker) ──────────────────────────────────────

describe("multi-channel mode", () => {
  function lastFlushFor(channelId: string): FlushMessage | undefined {
    for (let i = sent.length - 1; i >= 0; i--) {
      const msg = sent[i].data as FlushMessage;
      if (msg?.type === "flush" && msg.channelId === channelId) return msg;
    }
    return undefined;
  }

  it("init with channelId creates an isolated parser per channel", () => {
    sent.length = 0;
    dispatch({ type: "init", channelId: "a", cols: 80, rows: 24, scrollback: 100 });
    dispatch({ type: "init", channelId: "b", cols: 80, rows: 24, scrollback: 100 });

    dispatch({ type: "write", channelId: "a", data: enc("A") });
    const flushA = lastFlushFor("a");
    expect(flushA?.channelId).toBe("a");
    expect(flushA?.cursor.col).toBe(1);

    // Channel 'b' cursor was not moved by the write to 'a'.
    dispatch({ type: "write", channelId: "b", data: enc("") });
    const flushB = lastFlushFor("b");
    expect(flushB?.channelId).toBe("b");
    expect(flushB?.cursor.col).toBe(0);
  });

  it("write to unknown channelId posts an error tagged with channelId", () => {
    sent.length = 0;
    dispatch({ type: "write", channelId: "ghost", data: enc("X") });
    const msg = lastSent() as ErrorMessage;
    expect(msg.type).toBe("error");
    expect(msg.channelId).toBe("ghost");
  });

  it("dispose with channelId removes that channel but does NOT close the worker", () => {
    const closeSpy = vi.fn();
    vi.stubGlobal("close", closeSpy);

    dispatch({ type: "init", channelId: "c1", cols: 80, rows: 24, scrollback: 100 });
    dispatch({ type: "init", channelId: "c2", cols: 80, rows: 24, scrollback: 100 });
    dispatch({ type: "dispose", channelId: "c1" });

    expect(closeSpy).not.toHaveBeenCalled();

    // c2 still works
    sent.length = 0;
    dispatch({ type: "write", channelId: "c2", data: enc("X") });
    const flush = lastFlushFor("c2");
    expect(flush?.channelId).toBe("c2");

    // c1 is gone
    sent.length = 0;
    dispatch({ type: "write", channelId: "c1", data: enc("X") });
    const err = lastSent() as ErrorMessage;
    expect(err.type).toBe("error");
    expect(err.channelId).toBe("c1");
  });

  it("echoes init generation onto every outbound flush for that channel", () => {
    sent.length = 0;
    dispatch({
      type: "init",
      channelId: "g1",
      generation: 7,
      cols: 80,
      rows: 24,
      scrollback: 100,
    });

    dispatch({ type: "write", channelId: "g1", generation: 7, data: enc("X") });
    const flush = lastFlushFor("g1");
    expect(flush).toBeDefined();
    expect(flush?.generation).toBe(7);
  });

  it("re-init with a new generation invalidates stale writes", () => {
    sent.length = 0;
    dispatch({
      type: "init",
      channelId: "g2",
      generation: 1,
      cols: 80,
      rows: 24,
      scrollback: 100,
    });
    // Client re-acquired (new generation). Old writes are now stale.
    dispatch({
      type: "init",
      channelId: "g2",
      generation: 2,
      cols: 80,
      rows: 24,
      scrollback: 100,
    });

    sent.length = 0;
    // A stale write from the OLD generation arrives late — must be dropped.
    dispatch({ type: "write", channelId: "g2", generation: 1, data: enc("A") });
    const staleFlush = lastFlushFor("g2");
    expect(staleFlush).toBeUndefined();

    // A write with the CURRENT generation produces a flush tagged with
    // the current generation.
    dispatch({ type: "write", channelId: "g2", generation: 2, data: enc("B") });
    const currentFlush = lastFlushFor("g2");
    expect(currentFlush?.generation).toBe(2);
  });
});
