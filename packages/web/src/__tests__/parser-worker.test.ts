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
  it("initialises the parser — write succeeds and returns a flush", () => {
    dispatch({ type: "write", data: enc("A") });
    expect(lastFlush().type).toBe("flush");
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

  it("flush contains cursor with required fields", () => {
    dispatch({ type: "write", data: enc("Hi") });
    const { cursor } = lastFlush();
    expect(typeof cursor.row).toBe("number");
    expect(typeof cursor.col).toBe("number");
    expect(typeof cursor.visible).toBe("boolean");
    expect(typeof cursor.style).toBe("string");
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

describe("resize message", () => {
  it("posts a flush immediately after resize", () => {
    dispatch({ type: "resize", cols: 40, rows: 12, scrollback: 200 });
    expect(lastFlush().type).toBe("flush");
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

  it("cursor col stays within new column bounds after resize + write", () => {
    dispatch({ type: "resize", cols: 20, rows: 10, scrollback: 50 });
    sent.length = 0;
    dispatch({ type: "write", data: enc("Hello") });
    expect(lastFlush().cursor.col).toBeLessThanOrEqual(20);
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
