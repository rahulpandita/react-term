// @vitest-environment jsdom
/**
 * WebTerminal unit tests.
 *
 * Tests cover constructor option defaults, write/resize behaviour, callbacks,
 * and lifecycle on the main-thread (non-worker) code path.
 *
 * jsdom does not implement canvas context; we patch getContext to return a
 * minimal mock so renderer.attach() does not throw.
 */

import { DEFAULT_THEME } from "@react-term/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebTerminal } from "../web-terminal.js";

// ---------------------------------------------------------------------------
// Canvas 2D context mock
// ---------------------------------------------------------------------------

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

// Stub Worker (not available in Node / jsdom)
vi.stubGlobal("Worker", function MockWorker() {
  return {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
} as unknown as typeof Worker);

// Stub URL.createObjectURL used by WorkerBridge / RenderBridge
vi.stubGlobal("URL", {
  createObjectURL: vi.fn(() => "blob:mock"),
  revokeObjectURL: vi.fn(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Patch HTMLCanvasElement.prototype.getContext to return a mock 2D context.
 * Returns the spy so individual tests can assert on it if needed.
 */
function patchCanvas() {
  const ctx = createMock2DContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  return ctx;
}

/** Create a WebTerminal on the main-thread code path (no worker, canvas2d). */
function make(container: HTMLElement, extra: ConstructorParameters<typeof WebTerminal>[1] = {}) {
  return new WebTerminal(container, {
    useWorker: false,
    renderer: "canvas2d",
    renderMode: "main",
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebTerminal", () => {
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

  // ---- Default options ---------------------------------------------------

  describe("default options", () => {
    it("defaults to 80 cols and 24 rows", () => {
      const t = make(container);
      expect(t.cols).toBe(80);
      expect(t.rows).toBe(24);
      t.dispose();
    });

    it("accepts custom cols and rows", () => {
      const t = make(container, { cols: 120, rows: 40 });
      expect(t.cols).toBe(120);
      expect(t.rows).toBe(40);
      t.dispose();
    });
  });

  // ---- Getters -----------------------------------------------------------

  describe("element getter", () => {
    it("returns the container element passed to the constructor", () => {
      const t = make(container);
      expect(t.element).toBe(container);
      t.dispose();
    });
  });

  describe("activeGrid getter", () => {
    it("returns a CellGrid with the configured dimensions", () => {
      const t = make(container, { cols: 60, rows: 20 });
      expect(t.activeGrid.cols).toBe(60);
      expect(t.activeGrid.rows).toBe(20);
      t.dispose();
    });
  });

  describe("activeCursor getter", () => {
    it("returns a cursor at (0, 0) initially", () => {
      const t = make(container);
      expect(t.activeCursor.row).toBe(0);
      expect(t.activeCursor.col).toBe(0);
      t.dispose();
    });
  });

  // ---- write() -----------------------------------------------------------

  describe("write()", () => {
    it("does not throw when writing a string", () => {
      const t = make(container);
      expect(() => t.write("Hello")).not.toThrow();
      t.dispose();
    });

    it("does not throw when writing a Uint8Array", () => {
      const t = make(container);
      const bytes = new TextEncoder().encode("World");
      expect(() => t.write(bytes)).not.toThrow();
      t.dispose();
    });

    it("advances the cursor after writing ASCII text", () => {
      const t = make(container);
      t.write("ABC");
      expect(t.activeCursor.col).toBe(3);
      t.dispose();
    });

    it("is a no-op after dispose", () => {
      const t = make(container);
      t.dispose();
      // Should not throw even after disposal
      expect(() => t.write("test")).not.toThrow();
    });
  });

  // ---- resize() ----------------------------------------------------------

  describe("resize()", () => {
    it("updates cols and rows", () => {
      const t = make(container);
      t.resize(100, 30);
      expect(t.cols).toBe(100);
      expect(t.rows).toBe(30);
      t.dispose();
    });

    it("triggers the onResize callback", () => {
      const cb = vi.fn();
      const t = make(container, { onResize: cb });
      t.resize(132, 50);
      expect(cb).toHaveBeenCalledWith({ cols: 132, rows: 50 });
      t.dispose();
    });

    it("ignores invalid values (cols < 2)", () => {
      const t = make(container);
      t.resize(1, 24); // cols must be >= 2
      expect(t.cols).toBe(80); // unchanged
      t.dispose();
    });

    it("ignores invalid values (rows < 1)", () => {
      const t = make(container);
      t.resize(80, 0); // rows must be >= 1
      expect(t.rows).toBe(24); // unchanged
      t.dispose();
    });

    it("ignores non-finite values", () => {
      const t = make(container);
      t.resize(Number.NaN, 24);
      expect(t.cols).toBe(80); // unchanged
      t.dispose();
    });

    it("is a no-op after dispose", () => {
      const t = make(container);
      t.dispose();
      expect(() => t.resize(100, 30)).not.toThrow();
    });
  });

  // ---- onTitleChange callback --------------------------------------------

  describe("onTitleChange callback", () => {
    it("fires when an OSC 2 title sequence is received", () => {
      const cb = vi.fn();
      const t = make(container, { onTitleChange: cb });
      t.write("\x1b]2;My Terminal Title\x07");
      expect(cb).toHaveBeenCalledWith("My Terminal Title");
      t.dispose();
    });

    it("can be set via constructor option", () => {
      const cb = vi.fn();
      const t = make(container, { onTitleChange: cb });
      t.write("\x1b]0;Another Title\x07");
      expect(cb).toHaveBeenCalledWith("Another Title");
      t.dispose();
    });
  });

  // ---- setTheme() --------------------------------------------------------

  describe("setTheme()", () => {
    it("does not throw when applying a partial theme", () => {
      const t = make(container);
      expect(() => t.setTheme({ foreground: "#aabbcc" })).not.toThrow();
      t.dispose();
    });

    it("does not throw when applying an empty theme (all defaults)", () => {
      const t = make(container);
      expect(() => t.setTheme({})).not.toThrow();
      t.dispose();
    });

    it("merges partial theme with defaults (full theme has all keys)", () => {
      const t = make(container, { theme: DEFAULT_THEME });
      // setTheme should not throw even with a complete theme object
      expect(() => t.setTheme({ ...DEFAULT_THEME, foreground: "#ffffff" })).not.toThrow();
      t.dispose();
    });
  });

  // ---- setFont() ---------------------------------------------------------

  describe("setFont()", () => {
    it("does not throw", () => {
      const t = make(container);
      expect(() => t.setFont(16, "monospace")).not.toThrow();
      t.dispose();
    });
  });

  // ---- getCellSize() -----------------------------------------------------

  describe("getCellSize()", () => {
    it("returns positive width and height", () => {
      const t = make(container);
      const { width, height } = t.getCellSize();
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      t.dispose();
    });
  });

  // ---- onData / onResize registration ------------------------------------

  describe("callback registration", () => {
    it("onData registers a data callback", () => {
      const t = make(container);
      const cb = vi.fn();
      // Should not throw
      expect(() => t.onData(cb)).not.toThrow();
      t.dispose();
    });

    it("onResize registers a resize callback", () => {
      const t = make(container);
      const cb = vi.fn();
      t.onResize(cb);
      t.resize(90, 25);
      expect(cb).toHaveBeenCalledWith({ cols: 90, rows: 25 });
      t.dispose();
    });
  });

  // ---- loadAddon() -------------------------------------------------------

  describe("loadAddon()", () => {
    it("calls activate on the addon with the terminal", () => {
      const t = make(container);
      const addon = { activate: vi.fn(), dispose: vi.fn() };
      t.loadAddon(addon);
      expect(addon.activate).toHaveBeenCalledWith(t);
      t.dispose();
    });

    it("calls dispose on addon when terminal is disposed", () => {
      const t = make(container);
      const addon = { activate: vi.fn(), dispose: vi.fn() };
      t.loadAddon(addon);
      t.dispose();
      expect(addon.dispose).toHaveBeenCalled();
    });
  });

  // ---- dispose() ---------------------------------------------------------

  describe("dispose()", () => {
    it("removes the canvas from the container", () => {
      const t = make(container);
      expect(container.querySelector("canvas")).not.toBeNull();
      t.dispose();
      expect(container.querySelector("canvas")).toBeNull();
    });

    it("is idempotent — can be called twice without throwing", () => {
      const t = make(container);
      expect(() => {
        t.dispose();
        t.dispose();
      }).not.toThrow();
    });
  });
});
