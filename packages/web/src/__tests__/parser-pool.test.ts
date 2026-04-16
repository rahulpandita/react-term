import type { CursorState } from "@next_term/core";
import { CellGrid } from "@next_term/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParserPool } from "../parser-pool.js";
import type { FlushMessage } from "../parser-worker.js";

const DEFAULT_MODES: FlushMessage["modes"] = {
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

interface Mock {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  simulateMessage(data: unknown): void;
  simulateError(message: string): void;
  initCalls(): { channelId?: string }[];
  writeCalls(): { channelId?: string; data?: ArrayBuffer }[];
  disposeCalls(): { channelId?: string }[];
}

const createdWorkers: Mock[] = [];

function makeMockWorker(): Mock {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const postMessage = vi.fn();
  const terminate = vi.fn();
  const mock: Mock = {
    postMessage,
    terminate,
    simulateMessage(data) {
      for (const h of listeners.get("message") ?? []) h({ data } as MessageEvent);
    },
    simulateError(message) {
      for (const h of listeners.get("error") ?? []) h({ message } as ErrorEvent);
    },
    initCalls() {
      return postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "init");
    },
    writeCalls() {
      return postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "write");
    },
    disposeCalls() {
      return postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "dispose");
    },
  };

  // Attach listener tracking to the returned proxy object that ParserPool sees.
  (
    mock as Mock & { addEventListener: (t: string, h: (e: Event) => void) => void }
  ).addEventListener = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)?.add(handler);
  };
  (
    mock as Mock & { removeEventListener: (t: string, h: (e: Event) => void) => void }
  ).removeEventListener = (type, handler) => {
    listeners.get(type)?.delete(handler);
  };

  return mock;
}

vi.stubGlobal("Worker", function MockWorkerCtor() {
  const m = makeMockWorker();
  createdWorkers.push(m);
  return m;
} as unknown as typeof Worker);

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

function makeCursor(): CursorState {
  return { row: 0, col: 0, visible: true, style: "block", wrapPending: false };
}

function makeGrids() {
  return { grid: new CellGrid(80, 24), altGrid: new CellGrid(80, 24) };
}

beforeEach(() => {
  createdWorkers.length = 0;
});

afterEach(() => {
  createdWorkers.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ParserPool", () => {
  it("spawns the requested number of workers", () => {
    const pool = new ParserPool(4);
    expect(createdWorkers.length).toBe(4);
    expect(pool.workerCount).toBe(4);
    pool.dispose();
  });

  it("clamps workerCount to at least 1", () => {
    const pool = new ParserPool(0);
    expect(createdWorkers.length).toBe(1);
    pool.dispose();
  });

  it("acquireChannel + start assigns channels round-robin to least-loaded worker", () => {
    const pool = new ParserPool(2);
    const { grid, altGrid } = makeGrids();

    pool.acquireChannel("a", grid, altGrid, makeCursor(), () => {}).start(80, 24, 100);
    pool.acquireChannel("b", grid, altGrid, makeCursor(), () => {}).start(80, 24, 100);
    pool.acquireChannel("c", grid, altGrid, makeCursor(), () => {}).start(80, 24, 100);

    const w0Ids = createdWorkers[0].initCalls().map((m) => m.channelId);
    const w1Ids = createdWorkers[1].initCalls().map((m) => m.channelId);

    expect(w0Ids).toEqual(["a", "c"]);
    expect(w1Ids).toEqual(["b"]);

    pool.dispose();
  });

  it("releaseChannel frees the worker for reuse by next acquire", () => {
    const pool = new ParserPool(2);
    const { grid, altGrid } = makeGrids();

    pool.acquireChannel("a", grid, altGrid, makeCursor(), () => {}).start(80, 24, 100);
    pool.acquireChannel("b", grid, altGrid, makeCursor(), () => {}).start(80, 24, 100);
    pool.releaseChannel("a");
    pool.acquireChannel("c", grid, altGrid, makeCursor(), () => {}).start(80, 24, 100);

    // c should land on worker 0 (it has 0 channels after releasing 'a')
    const w0Ids = createdWorkers[0].initCalls().map((m) => m.channelId);
    expect(w0Ids).toContain("c");

    pool.dispose();
  });

  it("routes flush messages to the correct channel by channelId", () => {
    const pool = new ParserPool(2);
    const { grid, altGrid } = makeGrids();
    const flushA = vi.fn();
    const flushB = vi.fn();

    pool.acquireChannel("a", grid, altGrid, makeCursor(), flushA).start(80, 24, 100);
    pool.acquireChannel("b", grid, altGrid, makeCursor(), flushB).start(80, 24, 100);

    createdWorkers[1].simulateMessage({
      type: "flush",
      channelId: "b",
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      isAlternate: false,
      bytesProcessed: 5,
      modes: DEFAULT_MODES,
    });

    expect(flushB).toHaveBeenCalled();
    expect(flushA).not.toHaveBeenCalled();

    pool.dispose();
  });

  it("drops stale flushes from the previous worker after channelId reuse", () => {
    // Scenario: channel "a" acquired on worker 0, released, re-acquired on
    // worker 1. A late flush from worker 0 must not be applied to the new
    // channel on worker 1.
    const pool = new ParserPool(2);
    const { grid, altGrid } = makeGrids();
    const flushA1 = vi.fn();
    const flushA2 = vi.fn();

    // Fill worker 0 so next acquire lands on worker 0 first, then fill both.
    pool.acquireChannel("a", grid, altGrid, makeCursor(), flushA1).start(80, 24, 100);
    // Release, then acquire a "filler" to shift balance so new "a" lands on worker 1.
    pool.releaseChannel("a");
    pool.acquireChannel("filler", grid, altGrid, makeCursor(), () => {}).start(80, 24, 100);
    // Now acquire "a" again — should go to worker 0 (count 0) or worker 1 (count 1);
    // either way, we just need to know which one.
    pool.acquireChannel("a", grid, altGrid, makeCursor(), flushA2).start(80, 24, 100);

    // Determine which worker the new "a" is on by inspecting init calls.
    const newAOnWorker = createdWorkers[0]
      .initCalls()
      .some(
        (m) =>
          m.channelId === "a" &&
          createdWorkers[0].initCalls().filter((x) => x.channelId === "a").length >= 2,
      )
      ? 0
      : 1;
    const staleWorker = newAOnWorker === 0 ? 1 : 0;

    // Simulate a stale flush arriving from the OTHER worker.
    createdWorkers[staleWorker].simulateMessage({
      type: "flush",
      channelId: "a",
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      isAlternate: false,
      bytesProcessed: 5,
      modes: DEFAULT_MODES,
    });

    // Stale flush must be dropped — flushA2 (the new channel) was NOT called.
    expect(flushA2).not.toHaveBeenCalled();
    pool.dispose();
  });

  it("drops late flushes for released channels", () => {
    const pool = new ParserPool(1);
    const { grid, altGrid } = makeGrids();
    const flushA = vi.fn();

    pool.acquireChannel("a", grid, altGrid, makeCursor(), flushA).start(80, 24, 100);
    pool.releaseChannel("a");

    createdWorkers[0].simulateMessage({
      type: "flush",
      channelId: "a",
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      isAlternate: false,
      bytesProcessed: 5,
      modes: DEFAULT_MODES,
    });

    expect(flushA).not.toHaveBeenCalled();
    pool.dispose();
  });

  it("marks crashed workers dead and skips them on next assignment", () => {
    const pool = new ParserPool(2);
    const { grid, altGrid } = makeGrids();
    const errorA = vi.fn();

    pool.acquireChannel("a", grid, altGrid, makeCursor(), () => {}, errorA).start(80, 24, 100);
    createdWorkers[0].simulateError("boom");
    expect(errorA).toHaveBeenCalled();

    // Worker 0 is dead; next acquire must land on worker 1.
    pool.acquireChannel("b", grid, altGrid, makeCursor(), () => {}).start(80, 24, 100);

    const w1Ids = createdWorkers[1].initCalls().map((m) => m.channelId);
    expect(w1Ids).toContain("b");
    pool.dispose();
  });

  it("acquireChannel throws on duplicate channelId", () => {
    const pool = new ParserPool(1);
    const { grid, altGrid } = makeGrids();
    pool.acquireChannel("a", grid, altGrid, makeCursor(), () => {});
    expect(() => pool.acquireChannel("a", grid, altGrid, makeCursor(), () => {})).toThrow(
      /already in use/,
    );
    pool.dispose();
  });

  it("decrements worker pending bytes even for flushes on released channels", () => {
    // Regression: previously, releasing a channel with bytes in flight left
    // those bytes in workerPendingBytes forever. When enough flushes were
    // dropped (because their channel was gone), the worker stayed paused
    // and ALL surviving channels queued writes into an unbounded queue.
    const pool = new ParserPool(1);
    const { grid, altGrid } = makeGrids();
    const a = pool.acquireChannel("a", grid, altGrid, makeCursor(), () => {});
    const b = pool.acquireChannel("b", grid, altGrid, makeCursor(), () => {});
    a.start(80, 24, 100);
    b.start(80, 24, 100);

    // 'a' sends 3 MB — crosses HIGH_WATERMARK, both pause.
    a.write(new Uint8Array(3 * 1024 * 1024));
    expect(a.isPaused).toBe(true);
    expect(b.isPaused).toBe(true);

    // Release 'a' WITHOUT first draining its pending bytes.
    pool.releaseChannel("a");

    // The flush for a's 3 MB arrives AFTER release. Even though channel 'a'
    // is gone, the pool must reconcile the pending bytes or b stays paused.
    createdWorkers[0].simulateMessage({
      type: "flush",
      channelId: "a",
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      isAlternate: false,
      bytesProcessed: 3 * 1024 * 1024,
      modes: DEFAULT_MODES,
    });

    // b should now be unpaused — the worker has no in-flight bytes.
    expect(b.isPaused).toBe(false);
    pool.dispose();
  });

  it("worker crash terminates the worker, resets flow control, and unpauses channels", () => {
    const pool = new ParserPool(2);
    const { grid, altGrid } = makeGrids();
    const errorA = vi.fn();

    const a = pool.acquireChannel("a", grid, altGrid, makeCursor(), () => {}, errorA);
    a.start(80, 24, 100);

    // Saturate worker 0.
    a.write(new Uint8Array(3 * 1024 * 1024));
    expect(a.isPaused).toBe(true);

    // Worker 0 crashes.
    createdWorkers[0].simulateError("OOM");

    // Error forwarded to channel.
    expect(errorA).toHaveBeenCalled();
    // Channel is no longer paused so it doesn't keep queueing.
    expect(a.isPaused).toBe(false);
    // Dead worker was terminated.
    expect(createdWorkers[0].terminate).toHaveBeenCalled();
    pool.dispose();
  });

  it("worker-tagged generation is echoed through init → flush (integration)", () => {
    // Integration test: no manual generation injection. We read the
    // generation the pool sent on init, and echo THAT value back on flush —
    // exactly what the real worker does. This is the test that would have
    // caught the prior cosmetic fix where the worker never echoed generation.
    const pool = new ParserPool(1);
    const { grid, altGrid } = makeGrids();
    const flushOld = vi.fn();
    const flushNew = vi.fn();

    const c1 = pool.acquireChannel("a", grid, altGrid, makeCursor(), flushOld);
    c1.start(80, 24, 100);
    const gen1 = (createdWorkers[0].initCalls()[0] as { generation?: number }).generation;
    expect(typeof gen1).toBe("number");

    pool.releaseChannel("a");
    const c2 = pool.acquireChannel("a", grid, altGrid, makeCursor(), flushNew);
    c2.start(80, 24, 100);
    const gen2 = (createdWorkers[0].initCalls()[1] as { generation?: number }).generation;
    expect(gen2).not.toBe(gen1);

    // Late flush for generation 1 (the prior lifecycle) — must not reach
    // the new channel even though the channelId matches.
    createdWorkers[0].simulateMessage({
      type: "flush",
      channelId: "a",
      generation: gen1,
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      isAlternate: false,
      bytesProcessed: 5,
      modes: DEFAULT_MODES,
    });
    expect(flushNew).not.toHaveBeenCalled();

    // Flush with current generation is delivered.
    createdWorkers[0].simulateMessage({
      type: "flush",
      channelId: "a",
      generation: gen2,
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      isAlternate: false,
      bytesProcessed: 5,
      modes: DEFAULT_MODES,
    });
    expect(flushNew).toHaveBeenCalledTimes(1);

    pool.dispose();
  });

  it("tagged generation rejects stale flushes after channelId reuse", () => {
    // Simulate a real-world reuse: acquire "a", release "a", acquire "a"
    // again. A late flush from the first lifecycle must NOT reach the
    // second channel's handler.
    const pool = new ParserPool(1);
    const { grid, altGrid } = makeGrids();
    const flush1 = vi.fn();
    const flush2 = vi.fn();

    pool.acquireChannel("a", grid, altGrid, makeCursor(), flush1).start(80, 24, 100);
    pool.releaseChannel("a");
    pool.acquireChannel("a", grid, altGrid, makeCursor(), flush2).start(80, 24, 100);

    // A stale flush from generation 1 arrives. The new channel is gen 2.
    createdWorkers[0].simulateMessage({
      type: "flush",
      channelId: "a",
      generation: 1,
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      isAlternate: false,
      bytesProcessed: 5,
      modes: DEFAULT_MODES,
    });

    // The new channel (gen 2) is untouched by the stale flush.
    expect(flush2).not.toHaveBeenCalled();
    pool.dispose();
  });

  it("throws from acquireChannel when all workers are dead", () => {
    const pool = new ParserPool(1);
    const { grid, altGrid } = makeGrids();

    createdWorkers[0].simulateError("boom");

    expect(() => pool.acquireChannel("a", grid, altGrid, makeCursor(), () => {})).toThrow(
      /no live workers/,
    );

    pool.dispose();
  });

  it("dispose() terminates all workers", () => {
    const pool = new ParserPool(3);
    pool.dispose();
    for (const w of createdWorkers) {
      expect(w.terminate).toHaveBeenCalled();
    }
  });

  it("dispose() prevents further acquireChannel calls", () => {
    const pool = new ParserPool(2);
    pool.dispose();
    const { grid, altGrid } = makeGrids();
    expect(() => pool.acquireChannel("a", grid, altGrid, makeCursor(), () => {})).toThrow(
      /disposed/,
    );
  });
});

describe("ParserChannel", () => {
  it("start() sends init tagged with channelId", () => {
    const pool = new ParserPool(1);
    const { grid, altGrid } = makeGrids();
    const channel = pool.acquireChannel("c1", grid, altGrid, makeCursor(), () => {});
    channel.start(80, 24, 100);

    const init = createdWorkers[0].initCalls()[0];
    expect(init).toMatchObject({ type: "init", channelId: "c1", cols: 80, rows: 24 });
    pool.dispose();
  });

  it("write() sends message tagged with channelId", () => {
    const pool = new ParserPool(1);
    const { grid, altGrid } = makeGrids();
    const channel = pool.acquireChannel("c1", grid, altGrid, makeCursor(), () => {});
    channel.start(80, 24, 100);
    channel.write(new Uint8Array([1, 2, 3]));

    const writes = createdWorkers[0].writeCalls();
    expect(writes).toHaveLength(1);
    expect(writes[0].channelId).toBe("c1");
    pool.dispose();
  });

  it("pauses ALL channels on a worker once its pending bytes cross HIGH_WATERMARK", () => {
    // Flow control is per-worker, not per-channel. When one channel on a
    // worker pushes the worker over HIGH_WATERMARK, every channel on that
    // worker pauses together (prevents 8× queue inflation).
    const pool = new ParserPool(1);
    const { grid, altGrid } = makeGrids();
    const a = pool.acquireChannel("a", grid, altGrid, makeCursor(), () => {});
    const b = pool.acquireChannel("b", grid, altGrid, makeCursor(), () => {});
    a.start(80, 24, 100);
    b.start(80, 24, 100);

    expect(a.isPaused).toBe(false);
    expect(b.isPaused).toBe(false);

    // Channel a dumps 3 MB — crosses the 2 MB HIGH_WATERMARK for the worker.
    a.write(new Uint8Array(3 * 1024 * 1024));

    // Both channels on this worker are now paused — not just the one that sent.
    expect(a.isPaused).toBe(true);
    expect(b.isPaused).toBe(true);

    // A flush draining the worker below LOW_WATERMARK unpauses both.
    createdWorkers[0].simulateMessage({
      type: "flush",
      channelId: "a",
      cursor: { row: 0, col: 0, visible: true, style: "block" },
      isAlternate: false,
      bytesProcessed: 3 * 1024 * 1024,
      modes: DEFAULT_MODES,
    });

    expect(a.isPaused).toBe(false);
    expect(b.isPaused).toBe(false);

    pool.dispose();
  });

  it("writeQueue overflow invokes onError (no silent byte drop)", () => {
    // With no flushes coming back, once pendingBytes crosses HIGH_WATERMARK
    // the channel pauses and subsequent writes land in writeQueue. Past the
    // 16 MB cap, the channel surfaces an error and disposes itself — the
    // consumer (WebTerminal) then falls back to main-thread parsing.
    // Silently dropping bytes mid-escape corrupts the VT parser, so the
    // cap must surface rather than drop.
    const pool = new ParserPool(1);
    const { grid, altGrid } = makeGrids();
    const onError = vi.fn();
    const channel = pool.acquireChannel("c1", grid, altGrid, makeCursor(), () => {}, onError);
    channel.start(80, 24, 100);

    // 3 MB crosses the 2 MB HIGH_WATERMARK — channel is now paused.
    channel.write(new Uint8Array(3 * 1024 * 1024));
    expect(channel.isPaused).toBe(true);

    // Queue 15 MB more (total queued 15 MB, under the 16 MB cap).
    for (let i = 0; i < 15; i++) channel.write(new Uint8Array(1024 * 1024));
    expect(onError).not.toHaveBeenCalled();

    // The next 2 MB write would push the queue over 16 MB — surface error.
    channel.write(new Uint8Array(2 * 1024 * 1024));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("queue exceeded"));

    pool.dispose();
  });

  it("releaseChannel sends a scoped dispose (does NOT terminate the worker)", () => {
    const pool = new ParserPool(1);
    const { grid, altGrid } = makeGrids();
    pool.acquireChannel("c1", grid, altGrid, makeCursor(), () => {}).start(80, 24, 100);
    pool.releaseChannel("c1");

    const disposes = createdWorkers[0].disposeCalls();
    expect(disposes).toHaveLength(1);
    expect(disposes[0].channelId).toBe("c1");
    expect(createdWorkers[0].terminate).not.toHaveBeenCalled();
    pool.dispose();
  });
});
