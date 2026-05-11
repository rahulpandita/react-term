// @vitest-environment jsdom
/**
 * serialize() / hydrate() / initialState — roundtrip the main-thread state
 * of a WebTerminal (grid, cursor, scrollback, parser modes, active buffer)
 * across a fresh terminal instance.
 *
 * Worker and offscreen render paths are covered elsewhere; these tests use
 * the main-thread canvas2d path where grid data is deterministic.
 */

import { CELL_SIZE, extractText, type TerminalState } from "@next_term/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebTerminal } from "../web-terminal.js";

function createMock2DContext() {
  return {
    font: "",
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    strokeRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    measureText: vi.fn((_text: string) => ({
      width: 8,
      fontBoundingBoxAscent: 12,
      fontBoundingBoxDescent: 4,
    })),
  };
}

vi.stubGlobal("Worker", function MockWorker() {
  return {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
} as unknown as typeof Worker);

vi.stubGlobal("URL", {
  createObjectURL: vi.fn(() => "blob:mock"),
  revokeObjectURL: vi.fn(),
});

function patchCanvas() {
  const ctx = createMock2DContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
}

function make(container: HTMLElement, extra: ConstructorParameters<typeof WebTerminal>[1] = {}) {
  return new WebTerminal(container, {
    useWorker: false,
    renderer: "canvas2d",
    renderMode: "main",
    ...extra,
  });
}

describe("WebTerminal serialize/hydrate", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    patchCanvas();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  describe("serialize()", () => {
    it("captures the current grid contents, cursor, and dimensions", () => {
      const t = make(container, { cols: 20, rows: 5 });
      t.write("Hello World");
      const state = t.serialize();

      expect(state.version).toBe(1);
      expect(state.cols).toBe(20);
      expect(state.rows).toBe(5);
      expect(state.cells).toBeInstanceOf(Uint32Array);
      expect(state.cells.length).toBe(5 * 20 * 4);
      expect(state.wrapFlags.length).toBe(5);
      expect(state.cursor.row).toBe(0);
      expect(state.cursor.col).toBe(11);
      expect(state.isAlternate).toBe(false);

      t.dispose();
    });

    it("captures scrollback rows that spill off-screen", () => {
      const t = make(container, { cols: 10, rows: 2, scrollback: 100 });
      for (let i = 0; i < 5; i++) t.write(`L${i}\r\n`);
      const state = t.serialize();
      expect(state.scrollback.rows.length).toBeGreaterThanOrEqual(3);
      t.dispose();
    });
  });

  describe("hydrate()", () => {
    it("restores grid text and cursor into a fresh terminal with matching dimensions", () => {
      const source = make(container, { cols: 20, rows: 5 });
      source.write("Hello World");
      const state = source.serialize();
      source.dispose();

      const fresh = document.createElement("div");
      document.body.appendChild(fresh);
      const target = make(fresh, { cols: 20, rows: 5 });
      target.hydrate(state);

      expect(extractText(target.activeGrid, 0, 0, 0, 10)).toBe("Hello World");
      expect(target.activeCursor.col).toBe(11);
      fresh.remove();
      target.dispose();
    });

    it("no-ops with a warning when dimensions do not match", () => {
      const source = make(container, { cols: 20, rows: 5 });
      source.write("xxx");
      const state = source.serialize();
      source.dispose();

      const fresh = document.createElement("div");
      document.body.appendChild(fresh);
      const target = make(fresh, { cols: 40, rows: 10 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      target.hydrate(state);
      expect(warn).toHaveBeenCalledOnce();
      // Target grid is still blank — hydrate bailed out.
      expect(extractText(target.activeGrid, 0, 0, 0, 39).trim()).toBe("");
      fresh.remove();
      target.dispose();
    });
  });

  describe("initialState constructor option", () => {
    it("restores grid and cursor before the first frame", () => {
      const source = make(container, { cols: 15, rows: 4 });
      source.write("Greetings");
      const state = source.serialize();
      source.dispose();

      const fresh = document.createElement("div");
      document.body.appendChild(fresh);
      const target = make(fresh, { cols: 15, rows: 4, initialState: state });

      expect(extractText(target.activeGrid, 0, 0, 0, 8)).toBe("Greetings");
      expect(target.activeCursor.col).toBe(9);
      fresh.remove();
      target.dispose();
    });

    it("restores parser modes from the snapshot", () => {
      const source = make(container);
      source.setParserModes({
        applicationCursorKeys: true,
        bracketedPasteMode: true,
        mouseProtocol: "vt200",
        mouseEncoding: "sgr",
        sendFocusEvents: true,
      });
      const state = source.serialize();
      source.dispose();

      const fresh = document.createElement("div");
      document.body.appendChild(fresh);
      const target = make(fresh, { initialState: state });

      const modes = target.getParserModes();
      expect(modes.applicationCursorKeys).toBe(true);
      expect(modes.bracketedPasteMode).toBe(true);
      expect(modes.mouseProtocol).toBe("vt200");
      expect(modes.mouseEncoding).toBe("sgr");
      expect(modes.sendFocusEvents).toBe(true);

      fresh.remove();
      target.dispose();
    });

    it("restores scrollback lines", () => {
      const source = make(container, { cols: 10, rows: 2, scrollback: 100 });
      for (let i = 0; i < 5; i++) source.write(`L${i}\r\n`);
      const state = source.serialize();
      const sourceSbLen = state.scrollback.rows.length;
      source.dispose();

      const fresh = document.createElement("div");
      document.body.appendChild(fresh);
      const target = make(fresh, { cols: 10, rows: 2, scrollback: 100, initialState: state });

      expect(target.serialize().scrollback.rows.length).toBe(sourceSbLen);

      fresh.remove();
      target.dispose();
    });
  });

  describe("setParserModes()", () => {
    it("updates all five mode fields on the input handler", () => {
      const t = make(container);
      t.setParserModes({
        applicationCursorKeys: true,
        bracketedPasteMode: true,
        mouseProtocol: "any",
        mouseEncoding: "sgr",
        sendFocusEvents: true,
      });
      const modes = t.getParserModes();
      expect(modes).toEqual({
        applicationCursorKeys: true,
        bracketedPasteMode: true,
        mouseProtocol: "any",
        mouseEncoding: "sgr",
        sendFocusEvents: true,
      });
      t.dispose();
    });
  });

  // ---- Edge cases --------------------------------------------------------

  describe("structural validation", () => {
    function makeValidState(cols: number, rows: number): TerminalState {
      return {
        version: 1,
        cols,
        rows,
        cells: new Uint32Array(rows * cols * CELL_SIZE),
        wrapFlags: new Int32Array(rows),
        cursor: { row: 0, col: 0, visible: true, style: "block" },
        scrollback: { rows: [], wrap: [], compact: [] },
        parserModes: {
          applicationCursorKeys: false,
          bracketedPasteMode: false,
          mouseProtocol: "none",
          mouseEncoding: "default",
          sendFocusEvents: false,
        },
        isAlternate: false,
      };
    }

    it("rejects an unknown version", () => {
      const t = make(container, { cols: 10, rows: 3 });
      const bad = { ...makeValidState(10, 3), version: 2 as unknown as 1 };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      t.hydrate(bad);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toMatch(/unsupported version/);
      t.dispose();
    });

    it("rejects a snapshot with wrong cells length", () => {
      const t = make(container, { cols: 10, rows: 3 });
      const bad: TerminalState = { ...makeValidState(10, 3), cells: new Uint32Array(5) };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      t.hydrate(bad);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toMatch(/malformed/);
      t.dispose();
    });

    it("rejects a snapshot with desynced scrollback arrays", () => {
      const t = make(container, { cols: 10, rows: 3 });
      const bad: TerminalState = {
        ...makeValidState(10, 3),
        scrollback: {
          rows: [new Uint32Array(10 * CELL_SIZE)],
          wrap: [],
          compact: [false],
        },
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      t.hydrate(bad);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toMatch(/scrollback arrays out of sync/);
      t.dispose();
    });

    it("rejects an invalid version at construction (leaves fresh BufferSet intact)", () => {
      const bad = { ...makeValidState(10, 3), version: 99 as unknown as 1 };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const t = make(container, { cols: 10, rows: 3, initialState: bad });
      expect(warn).toHaveBeenCalled();
      // Grid stayed blank; cursor at origin.
      expect(t.activeCursor.row).toBe(0);
      expect(t.activeCursor.col).toBe(0);
      t.dispose();
    });
  });

  describe("scrollback integrity", () => {
    it("deep-copies scrollback rows so mutation of the source grid doesn't corrupt the snapshot", () => {
      // Fill scrollback to capacity, snapshot, then scroll more rows so
      // BufferSet's borrowRowBuffer() would recycle the evicted row.
      const t = make(container, { cols: 10, rows: 2, scrollback: 3 });
      for (let i = 0; i < 5; i++) t.write(`A${i}\r\n`);
      const state = t.serialize();
      const rowsAtSnapshot = state.scrollback.rows.map((r) => new Uint32Array(r));
      // More writes → scroll → evict and recycle
      for (let i = 0; i < 5; i++) t.write(`Z${i}\r\n`);
      // Snapshot rows must not have been overwritten by the recycled buffer.
      for (let i = 0; i < state.scrollback.rows.length; i++) {
        expect(state.scrollback.rows[i]).toEqual(rowsAtSnapshot[i]);
      }
      t.dispose();
    });
  });

  describe("hydrate() viewport reset", () => {
    it("snaps viewport to live after hydrating a scrolled-back terminal", () => {
      const t = make(container, { cols: 10, rows: 2, scrollback: 100 });
      for (let i = 0; i < 10; i++) t.write(`L${i}\r\n`);
      (t as unknown as { scrollViewport: (n: number) => void }).scrollViewport(5);
      expect(t.scrollOffset).toBe(5);

      const other = make(container, { cols: 10, rows: 2, scrollback: 100 });
      other.write("fresh");
      t.hydrate(other.serialize());
      expect(t.scrollOffset).toBe(0);
      other.dispose();
      t.dispose();
    });
  });

  describe("alt-buffer roundtrip", () => {
    it("preserves isAlternate across hydrate", () => {
      const source = make(container, { cols: 10, rows: 3 });
      source.write("\x1b[?1049h"); // enter alt buffer (DECSET 1049)
      source.write("alt");
      expect(source.isAlternateBuffer).toBe(true);
      const state = source.serialize();
      expect(state.isAlternate).toBe(true);
      source.dispose();

      const fresh = document.createElement("div");
      document.body.appendChild(fresh);
      const target = make(fresh, { cols: 10, rows: 3, initialState: state });
      expect(target.isAlternateBuffer).toBe(true);
      expect(extractText(target.activeGrid, 0, 0, 0, 2)).toBe("alt");
      fresh.remove();
      target.dispose();
    });
  });

  describe("write-after-hydrate", () => {
    it("continues writing where the snapshot left off", () => {
      const source = make(container, { cols: 20, rows: 3 });
      source.write("Hello ");
      const state = source.serialize();
      source.dispose();

      const fresh = document.createElement("div");
      document.body.appendChild(fresh);
      const target = make(fresh, { cols: 20, rows: 3, initialState: state });
      target.write("World");
      expect(extractText(target.activeGrid, 0, 0, 0, 10)).toBe("Hello World");
      fresh.remove();
      target.dispose();
    });
  });

  describe("worker-mode hydrate routes cells through worker", () => {
    function makeWorkerMocks() {
      const postedMessages: Array<{ msg: unknown; transferables: unknown[] }> = [];
      // NOTE: do NOT convert to an arrow function — `new` requires a real
      // constructor and arrow functions throw "is not a constructor".
      // biome-ignore lint/complexity/useArrowFunction: Worker mock needs constructor semantics
      const MockWorker = function () {
        return {
          postMessage: (msg: unknown, transfer?: unknown[]) => {
            postedMessages.push({ msg, transferables: transfer ?? [] });
          },
          terminate: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
        };
      } as unknown as typeof Worker;
      // WorkerBridge.start uses `new URL("./parser-worker.js", import.meta.url)`.
      // The file-level URL stub is an object, not a constructor — patch it to
      // a class so the new-expression doesn't throw for these worker tests.
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
      return { postedMessages, MockWorker };
    }

    it("posts a seed message containing cellData + wrapFlags on post-construction hydrate", () => {
      const { postedMessages, MockWorker } = makeWorkerMocks();
      vi.stubGlobal("Worker", MockWorker);

      // Source (non-worker) to produce a snapshot.
      const source = make(container, { cols: 10, rows: 3 });
      source.write("abc");
      const state = source.serialize();
      source.dispose();

      const fresh = document.createElement("div");
      document.body.appendChild(fresh);
      const target = new WebTerminal(fresh, {
        useWorker: true,
        renderer: "canvas2d",
        renderMode: "main",
        cols: 10,
        rows: 3,
      });
      target.hydrate(state);

      const seedCalls = postedMessages.filter((m) => (m.msg as { type?: string }).type === "seed");
      expect(seedCalls.length).toBe(1);
      const seedMsg = seedCalls[0].msg as { cellData?: ArrayBuffer; wrapFlags?: ArrayBuffer };
      expect(seedMsg.cellData).toBeInstanceOf(ArrayBuffer);
      expect(seedMsg.wrapFlags).toBeInstanceOf(ArrayBuffer);
      expect(seedCalls[0].transferables).toHaveLength(2);

      fresh.remove();
      target.dispose();
    });

    it("initialState path posts seed WITHOUT cellData (cells already in SAB before worker start)", () => {
      const { postedMessages, MockWorker } = makeWorkerMocks();
      vi.stubGlobal("Worker", MockWorker);

      const source = make(container, { cols: 10, rows: 3 });
      source.write("xyz");
      const state = source.serialize();
      source.dispose();

      const fresh = document.createElement("div");
      document.body.appendChild(fresh);
      const target = new WebTerminal(fresh, {
        useWorker: true,
        renderer: "canvas2d",
        renderMode: "main",
        cols: 10,
        rows: 3,
        initialState: state,
      });

      const seedCalls = postedMessages.filter((m) => (m.msg as { type?: string }).type === "seed");
      expect(seedCalls.length).toBe(1);
      const seedMsg = seedCalls[0].msg as { cellData?: ArrayBuffer };
      expect(seedMsg.cellData).toBeUndefined();
      expect(seedCalls[0].transferables).toEqual([]);

      fresh.remove();
      target.dispose();
    });
  });

  describe("scrollback truncation to smaller maxScrollback", () => {
    it("keeps only the most recent rows when target maxScrollback < snapshot", () => {
      const source = make(container, { cols: 10, rows: 2, scrollback: 100 });
      for (let i = 0; i < 20; i++) source.write(`L${i}\r\n`);
      const state = source.serialize();
      expect(state.scrollback.rows.length).toBeGreaterThanOrEqual(15);
      source.dispose();

      const fresh = document.createElement("div");
      document.body.appendChild(fresh);
      // Target has much smaller scrollback budget.
      const target = make(fresh, { cols: 10, rows: 2, scrollback: 5, initialState: state });
      const restoredState = target.serialize();
      expect(restoredState.scrollback.rows.length).toBe(5);

      fresh.remove();
      target.dispose();
    });
  });

  describe("wide-char roundtrip", () => {
    it("preserves East Asian double-width glyphs across hydrate", () => {
      const source = make(container, { cols: 20, rows: 3 });
      // CJK characters are double-width; the parser places a spacer cell
      // after each so cursor arithmetic accounts for the width.
      source.write("漢字TEST");
      const state = source.serialize();
      source.dispose();

      const fresh = document.createElement("div");
      document.body.appendChild(fresh);
      const target = make(fresh, { cols: 20, rows: 3, initialState: state });
      // Row 0 should still read as the same text (extractText skips spacer cells).
      expect(extractText(target.activeGrid, 0, 0, 0, 10)).toBe("漢字TEST");
      fresh.remove();
      target.dispose();
    });
  });

  describe("disposed guards", () => {
    it("serialize() throws after dispose()", () => {
      const t = make(container);
      t.write("x");
      t.dispose();
      expect(() => t.serialize()).toThrow(/after dispose/);
    });

    it("hydrate() is a no-op after dispose()", () => {
      const source = make(container, { cols: 10, rows: 2 });
      source.write("hi");
      const state = source.serialize();

      const t = make(container, { cols: 10, rows: 2 });
      t.dispose();
      expect(() => t.hydrate(state)).not.toThrow();
      source.dispose();
    });
  });
});
