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

import { DEFAULT_THEME, extractText } from "@next_term/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputHandler } from "../input-handler.js";
import { Canvas2DRenderer } from "../renderer.js";
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
    it("stores written ASCII characters in the active grid", () => {
      const t = make(container);
      t.write("Hello");
      expect(extractText(t.activeGrid, 0, 0, 0, 4)).toBe("Hello");
      expect(t.activeCursor.col).toBe(5);
      t.dispose();
    });

    it("advances the cursor after writing a Uint8Array", () => {
      const t = make(container);
      const bytes = new TextEncoder().encode("World"); // 5 chars
      t.write(bytes);
      expect(t.activeCursor.col).toBe(5);
      t.dispose();
    });

    it("advances the cursor after writing ASCII text", () => {
      const t = make(container);
      t.write("ABC");
      expect(t.activeCursor.col).toBe(3);
      t.dispose();
    });

    it("is a no-op after dispose — cursor does not advance", () => {
      const t = make(container);
      t.write("XYZ");
      const colBefore = t.activeCursor.col; // 3
      t.dispose();
      t.write("more");
      expect(t.activeCursor.col).toBe(colBefore); // still 3
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

    it("is a no-op after dispose — dimensions remain unchanged", () => {
      const t = make(container);
      t.dispose();
      t.resize(100, 30);
      expect(t.cols).toBe(80); // unchanged
      expect(t.rows).toBe(24); // unchanged
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
    it("passes the merged theme to the renderer (partial override)", () => {
      const spy = vi.spyOn(Canvas2DRenderer.prototype, "setTheme");
      const t = make(container);
      t.setTheme({ foreground: "#aabbcc" });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ foreground: "#aabbcc" }));
      t.dispose();
    });

    it("passes full DEFAULT_THEME to the renderer when given an empty object", () => {
      const spy = vi.spyOn(Canvas2DRenderer.prototype, "setTheme");
      const t = make(container);
      t.setTheme({});
      expect(spy).toHaveBeenCalledWith(DEFAULT_THEME);
      t.dispose();
    });

    it("passes the overridden key to the renderer while keeping other defaults", () => {
      const spy = vi.spyOn(Canvas2DRenderer.prototype, "setTheme");
      const t = make(container, { theme: DEFAULT_THEME });
      const custom = { ...DEFAULT_THEME, foreground: "#ffffff" };
      t.setTheme(custom);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ foreground: "#ffffff" }));
      t.dispose();
    });
  });

  // ---- setFont() ---------------------------------------------------------

  describe("setFont()", () => {
    it("applies the new font to the renderer", () => {
      const spy = vi.spyOn(Canvas2DRenderer.prototype, "setFont");
      const t = make(container);
      t.setFont(18, "Courier New");
      expect(spy).toHaveBeenCalledWith(18, "Courier New", undefined, undefined);
      t.dispose();
    });
  });

  // ---- ensureFont (web font loading) --------------------------------------

  describe("web font loading", () => {
    // Save whatever document.fonts is (may be undefined in jsdom)
    const savedDescriptor =
      Object.getOwnPropertyDescriptor(Document.prototype, "fonts") ??
      Object.getOwnPropertyDescriptor(document, "fonts");

    afterEach(() => {
      // Restore by deleting the instance override — falls back to prototype
      try {
        Object.defineProperty(document, "fonts", {
          value: savedDescriptor?.value,
          writable: true,
          configurable: true,
        });
      } catch {
        // Ignore if we can't restore
      }
    });

    it("calls document.fonts.load when font is not available", () => {
      const loadSpy = vi.fn().mockResolvedValue([]);
      const checkSpy = vi.fn().mockReturnValue(false);
      Object.defineProperty(document, "fonts", {
        value: { load: loadSpy, check: checkSpy },
        configurable: true,
      });

      const t = make(container, { fontFamily: "'Fira Code', monospace" });
      expect(loadSpy).toHaveBeenCalled();
      expect(loadSpy.mock.calls[0][0]).toContain("Fira Code");
      t.dispose();
    });

    it("skips loading for generic-only font families", () => {
      const loadSpy = vi.fn().mockResolvedValue([]);
      const checkSpy = vi.fn().mockReturnValue(true);
      Object.defineProperty(document, "fonts", {
        value: { load: loadSpy, check: checkSpy },
        configurable: true,
      });

      const t = make(container, { fontFamily: "monospace" });
      expect(loadSpy).not.toHaveBeenCalled();
      t.dispose();
    });

    it("skips loading when font is already available", () => {
      const loadSpy = vi.fn().mockResolvedValue([]);
      const checkSpy = vi.fn().mockReturnValue(true);
      Object.defineProperty(document, "fonts", {
        value: { load: loadSpy, check: checkSpy },
        configurable: true,
      });

      const t = make(container, { fontFamily: "'Menlo', monospace" });
      expect(loadSpy).not.toHaveBeenCalled();
      t.dispose();
    });

    it("loads multiple non-generic fonts from a fallback list", () => {
      const loadSpy = vi.fn().mockResolvedValue([]);
      const checkSpy = vi.fn().mockReturnValue(false);
      Object.defineProperty(document, "fonts", {
        value: { load: loadSpy, check: checkSpy },
        configurable: true,
      });

      const t = make(container, {
        fontFamily: "  'Fira Code' , 'JetBrains Mono' , monospace ",
      });
      // Should load both non-generic fonts, not monospace
      const loadedFonts = loadSpy.mock.calls.map((c: string[]) => c[0]);
      expect(loadedFonts.some((f: string) => f.includes("Fira Code"))).toBe(true);
      expect(loadedFonts.some((f: string) => f.includes("JetBrains Mono"))).toBe(true);
      expect(loadedFonts.every((f: string) => !f.includes("monospace"))).toBe(true);
      t.dispose();
    });

    it("handles unquoted font names in fallback list", () => {
      const loadSpy = vi.fn().mockResolvedValue([]);
      const checkSpy = vi.fn().mockReturnValue(false);
      Object.defineProperty(document, "fonts", {
        value: { load: loadSpy, check: checkSpy },
        configurable: true,
      });

      const t = make(container, { fontFamily: "Cascadia Code, monospace" });
      expect(loadSpy).toHaveBeenCalled();
      expect(loadSpy.mock.calls[0][0]).toContain("Cascadia Code");
      t.dispose();
    });

    it("re-applies font after async load completes", async () => {
      let resolveLoad: () => void;
      const loadPromise = new Promise<void>((r) => {
        resolveLoad = r;
      });
      const loadSpy = vi.fn().mockReturnValue(loadPromise);
      let fontAvailable = false;
      const checkSpy = vi.fn().mockImplementation(() => fontAvailable);
      Object.defineProperty(document, "fonts", {
        value: { load: loadSpy, check: checkSpy },
        configurable: true,
      });

      const setFontSpy = vi.spyOn(Canvas2DRenderer.prototype, "setFont");
      const t = make(container, { fontFamily: "'Fira Code', monospace" });
      const initialCalls = setFontSpy.mock.calls.length;

      // Simulate font becoming available
      fontAvailable = true;
      resolveLoad?.();
      await loadPromise;
      await new Promise((r) => setTimeout(r, 0));

      expect(setFontSpy.mock.calls.length).toBeGreaterThan(initialCalls);
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
    it("onData callback fires when the user types into the terminal", () => {
      const cb = vi.fn();
      const t = make(container);
      t.onData(cb);
      // The InputHandler creates a hidden textarea inside the container.
      // Simulating an input event on it exercises the full wiring path.
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      expect(ta).not.toBeNull();
      ta.value = "hi";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      expect(cb).toHaveBeenCalledWith(new TextEncoder().encode("hi"));
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

    it("is idempotent — canvas remains absent after a second dispose call", () => {
      const t = make(container);
      t.dispose();
      expect(container.querySelector("canvas")).toBeNull();
      t.dispose(); // second call must not re-add or throw
      expect(container.querySelector("canvas")).toBeNull();
    });
  });

  // ---- Synchronized output (mode 2026) -----------------------------------

  describe("synchronized output (mode 2026)", () => {
    it("stops the render loop when ?2026h is received", () => {
      patchCanvas();
      const t = make(container);
      const stopSpy = vi.spyOn(Canvas2DRenderer.prototype, "stopRenderLoop");
      t.write("\x1b[?2026h");
      expect(stopSpy).toHaveBeenCalledTimes(1);
      t.dispose();
    });

    it("restarts the render loop when ?2026l is received", () => {
      patchCanvas();
      const t = make(container);
      const startSpy = vi.spyOn(Canvas2DRenderer.prototype, "startRenderLoop");
      t.write("\x1b[?2026h");
      startSpy.mockClear();
      t.write("\x1b[?2026l");
      expect(startSpy).toHaveBeenCalledTimes(1);
      t.dispose();
    });

    it("calls render() immediately when sync output ends (frame flush)", () => {
      patchCanvas();
      const t = make(container);
      const renderSpy = vi.spyOn(Canvas2DRenderer.prototype, "render");
      t.write("\x1b[?2026h");
      renderSpy.mockClear();
      t.write("\x1b[?2026l");
      expect(renderSpy).toHaveBeenCalledTimes(1);
      t.dispose();
    });

    it("does not stop/start the loop when mode is already off", () => {
      patchCanvas();
      const t = make(container);
      const stopSpy = vi.spyOn(Canvas2DRenderer.prototype, "stopRenderLoop");
      // Sending ?2026l without activating first must not call stop
      t.write("\x1b[?2026l");
      expect(stopSpy).not.toHaveBeenCalled();
      t.dispose();
    });
  });

  describe("scrollback viewport", () => {
    /** Create a 3-row terminal — easy to overflow into scrollback. */
    function make3(extra: ConstructorParameters<typeof WebTerminal>[1] = {}) {
      return make(container, { rows: 3, scrollback: 100, ...extra });
    }

    /** Write N lines ("LINE1\n", "LINE2\n", …) to push content into scrollback. */
    function writeLines(term: WebTerminal, count: number): void {
      for (let i = 1; i <= count; i++) {
        term.write(`LINE${i}\n`);
      }
    }

    it("pushes rows into scrollback when content overflows the terminal height", () => {
      const term = make3();
      writeLines(term, 5);
      // 5 lines into a 3-row terminal — rows 1 & 2 should have scrolled off
      const bs = (term as unknown as Record<string, { scrollback: unknown[] }>).bufferSet;
      expect(bs.scrollback.length).toBeGreaterThan(0);
      term.dispose();
    });

    it("scrollViewport increases viewportOffset (scrolls toward older content)", () => {
      const term = make3();
      writeLines(term, 5);
      (term as unknown as Record<string, (n: number) => void>).scrollViewport(1);
      expect((term as unknown as Record<string, number>).viewportOffset).toBe(1);
      term.dispose();
    });

    it("scrollViewport clamps to maximum scrollback length", () => {
      const term = make3();
      writeLines(term, 5);
      const bs = (term as unknown as Record<string, { scrollback: unknown[] }>).bufferSet;
      const maxOffset = bs.scrollback.length;
      // Request more than available — should stop at max
      (term as unknown as Record<string, (n: number) => void>).scrollViewport(maxOffset + 1000);
      expect((term as unknown as Record<string, number>).viewportOffset).toBe(maxOffset);
      term.dispose();
    });

    it("scrollViewport with delta 0 leaves viewportOffset unchanged", () => {
      const term = make3();
      writeLines(term, 5);
      (term as unknown as Record<string, (n: number) => void>).scrollViewport(1);
      (term as unknown as Record<string, (n: number) => void>).scrollViewport(0);
      expect((term as unknown as Record<string, number>).viewportOffset).toBe(1);
      term.dispose();
    });

    it("buildDisplayGrid is created when scrolled back", () => {
      const term = make3();
      writeLines(term, 5);
      expect((term as unknown as Record<string, null>).displayGrid).toBeNull();
      (term as unknown as Record<string, (n: number) => void>).scrollViewport(1);
      expect((term as unknown as Record<string, unknown>).displayGrid).not.toBeNull();
      term.dispose();
    });

    it("buildDisplayGrid content comes from scrollback at correct offset", () => {
      const term = make3();
      // Write exactly 4 lines: LINE1..4 into a 3-row terminal.
      // Scrolling analysis:
      //   After LINE3\n: LINE1 pushed to scrollback; live = [LINE2, LINE3, blank]
      //   After LINE4\n: LINE2 pushed to scrollback; live = [LINE3, LINE4, blank]
      // scrollback = [LINE1, LINE2]; scrollViewport(2) → viewportTop = 0
      //   → displayGrid row 0 = scrollback[0] = LINE1
      term.write("LINE1\n");
      term.write("LINE2\n");
      term.write("LINE3\n");
      term.write("LINE4\n");
      // Scroll back all the way to see LINE1 in display row 0
      (term as unknown as Record<string, (n: number) => void>).scrollViewport(2);
      const dg = (term as unknown as Record<string, import("@next_term/core").CellGrid>)
        .displayGrid;
      expect(dg).not.toBeNull();
      // Row 0 of the display grid should contain LINE1
      const row0 = extractText(dg, 0, 0, 0, 4);
      expect(row0).toBe("LINE1");
      term.dispose();
    });

    it("snapToBottom resets viewportOffset to 0 and clears displayGrid", () => {
      const term = make3();
      writeLines(term, 5);
      (term as unknown as Record<string, (n: number) => void>).scrollViewport(2);
      expect((term as unknown as Record<string, number>).viewportOffset).toBe(2);
      (term as unknown as Record<string, () => void>).snapToBottom();
      expect((term as unknown as Record<string, number>).viewportOffset).toBe(0);
      expect((term as unknown as Record<string, null>).displayGrid).toBeNull();
      term.dispose();
    });

    it("writing new data snaps the viewport back to live view", () => {
      const term = make3();
      writeLines(term, 5);
      (term as unknown as Record<string, (n: number) => void>).scrollViewport(2);
      expect((term as unknown as Record<string, number>).viewportOffset).toBe(2);
      // write() calls snapToBottom() internally
      term.write("X");
      expect((term as unknown as Record<string, number>).viewportOffset).toBe(0);
      term.dispose();
    });

    it("negative scrollViewport delta moves toward live view", () => {
      const term = make3();
      writeLines(term, 5);
      (term as unknown as Record<string, (n: number) => void>).scrollViewport(2);
      expect((term as unknown as Record<string, number>).viewportOffset).toBe(2);
      (term as unknown as Record<string, (n: number) => void>).scrollViewport(-1);
      expect((term as unknown as Record<string, number>).viewportOffset).toBe(1);
      term.dispose();
    });

    it("scrolling below 0 clamps viewportOffset to 0", () => {
      const term = make3();
      writeLines(term, 5);
      (term as unknown as Record<string, (n: number) => void>).scrollViewport(1);
      (term as unknown as Record<string, (n: number) => void>).scrollViewport(-100);
      expect((term as unknown as Record<string, number>).viewportOffset).toBe(0);
      term.dispose();
    });
  });

  // ---- Parser mode sync --------------------------------------------------

  describe("parser mode sync", () => {
    it("DECSET 1 (application cursor keys) syncs to InputHandler after write()", () => {
      const t = make(container);
      const spy = vi.spyOn(InputHandler.prototype, "setApplicationCursorKeys");

      t.write("\x1b[?1h"); // DECSET ?1 — enable application cursor mode
      expect(spy).toHaveBeenCalledWith(true);
      t.dispose();
    });

    it("DECRST 1 (application cursor keys off) syncs to InputHandler after write()", () => {
      const t = make(container);
      // Enable then disable
      t.write("\x1b[?1h");
      const spy = vi.spyOn(InputHandler.prototype, "setApplicationCursorKeys");
      t.write("\x1b[?1l"); // DECRST ?1 — disable application cursor mode
      expect(spy).toHaveBeenCalledWith(false);
      t.dispose();
    });

    it("DECSET 2004 (bracketed paste mode) syncs to InputHandler after write()", () => {
      const t = make(container);
      const spy = vi.spyOn(InputHandler.prototype, "setBracketedPasteMode");

      t.write("\x1b[?2004h");
      expect(spy).toHaveBeenCalledWith(true);
      t.dispose();
    });

    it("DECRST 2004 (bracketed paste mode off) syncs to InputHandler after write()", () => {
      const t = make(container);
      t.write("\x1b[?2004h");
      const spy = vi.spyOn(InputHandler.prototype, "setBracketedPasteMode");
      t.write("\x1b[?2004l");
      expect(spy).toHaveBeenCalledWith(false);
      t.dispose();
    });

    it("DECSET 1000 (VT200 mouse) syncs mouse protocol to InputHandler", () => {
      const t = make(container);
      const spy = vi.spyOn(InputHandler.prototype, "setMouseProtocol");

      t.write("\x1b[?1000h");
      expect(spy).toHaveBeenCalledWith("vt200");
      t.dispose();
    });

    it("DECRST 1000 (VT200 mouse off) resets mouse protocol to none", () => {
      const t = make(container);
      t.write("\x1b[?1000h");
      const spy = vi.spyOn(InputHandler.prototype, "setMouseProtocol");
      t.write("\x1b[?1000l");
      expect(spy).toHaveBeenCalledWith("none");
      t.dispose();
    });

    it("DECSET 1004 (focus events) syncs to InputHandler after write()", () => {
      const t = make(container);
      const spy = vi.spyOn(InputHandler.prototype, "setSendFocusEvents");

      t.write("\x1b[?1004h");
      expect(spy).toHaveBeenCalledWith(true);
      t.dispose();
    });

    it("DECSET 1049 (alternate buffer) re-attaches renderer to new grid", () => {
      const t = make(container);
      // Spy on attach *after* initial construction so we only see the re-attach
      const attachSpy = vi.spyOn(Canvas2DRenderer.prototype, "attach");
      attachSpy.mockClear();

      t.write("\x1b[?1049h"); // enter alternate screen
      expect(attachSpy).toHaveBeenCalledTimes(1);
      t.dispose();
    });

    it("DECRST 1049 (exit alternate buffer) re-attaches renderer to normal grid", () => {
      const t = make(container);
      t.write("\x1b[?1049h"); // enter alternate screen
      const attachSpy = vi.spyOn(Canvas2DRenderer.prototype, "attach");
      attachSpy.mockClear();

      t.write("\x1b[?1049l"); // exit alternate screen
      expect(attachSpy).toHaveBeenCalledTimes(1);
      t.dispose();
    });

    it("CSI = 1 u (kitty flag 1 set) syncs kittyFlags to InputHandler after write()", () => {
      const t = make(container);
      const spy = vi.spyOn(InputHandler.prototype, "setKittyFlags");

      t.write("\x1b[=1u"); // CSI = 1 u — set kitty disambiguate flag
      expect(spy).toHaveBeenCalledWith(1);
      t.dispose();
    });

    it("CSI = 3 u (kitty flags 1+2 set) syncs combined kittyFlags to InputHandler", () => {
      const t = make(container);
      const spy = vi.spyOn(InputHandler.prototype, "setKittyFlags");

      t.write("\x1b[=3u"); // CSI = 3 u — set flags 1|2
      expect(spy).toHaveBeenCalledWith(3);
      t.dispose();
    });

    it("CSI = 0 u (clear all kitty flags) syncs zero to InputHandler", () => {
      const t = make(container);
      t.write("\x1b[=1u"); // set flag first
      const spy = vi.spyOn(InputHandler.prototype, "setKittyFlags");

      t.write("\x1b[=0u"); // clear all flags
      expect(spy).toHaveBeenCalledWith(0);
      t.dispose();
    });

    it("CSI > 1 u (push kitty flags) does not corrupt InputHandler flags", () => {
      const t = make(container);
      t.write("\x1b[=1u"); // set flag 1
      const spy = vi.spyOn(InputHandler.prototype, "setKittyFlags");

      t.write("\x1b[>2u"); // push flags=2 onto the stack
      // After push, active kittyFlags should be 2 (the pushed value)
      expect(spy).toHaveBeenCalledWith(2);
      t.dispose();
    });

    it("CSI < u (pop kitty flags) restores prior InputHandler flags", () => {
      const t = make(container);
      t.write("\x1b[=1u"); // set flag 1
      t.write("\x1b[>2u"); // push flags=2
      const spy = vi.spyOn(InputHandler.prototype, "setKittyFlags");

      t.write("\x1b[<u"); // pop — should restore flag 1
      expect(spy).toHaveBeenCalledWith(1);
      t.dispose();
    });
  });

  // ---- Resize cap ---------------------------------------------------------

  describe("resize cap", () => {
    it("clamps cols to MAX_COLS (500)", () => {
      const cb = vi.fn();
      const t = make(container, { onResize: cb });
      t.resize(1000, 24);
      expect(cb).toHaveBeenCalledWith({ cols: 500, rows: 24 });
      expect(t.cols).toBe(500);
      t.dispose();
    });

    it("clamps rows to MAX_ROWS (500)", () => {
      const cb = vi.fn();
      const t = make(container, { onResize: cb });
      t.resize(80, 1000);
      expect(cb).toHaveBeenCalledWith({ cols: 80, rows: 500 });
      expect(t.rows).toBe(500);
      t.dispose();
    });

    it("constructor clamps initial cols/rows", () => {
      const t = make(container, { cols: 1000, rows: 1000 });
      expect(t.cols).toBe(500);
      expect(t.rows).toBe(500);
      t.dispose();
    });

    it("normal resize within limits works", () => {
      const cb = vi.fn();
      const t = make(container, { onResize: cb });
      t.resize(100, 50);
      expect(cb).toHaveBeenCalledWith({ cols: 100, rows: 50 });
      expect(t.cols).toBe(100);
      expect(t.rows).toBe(50);
      t.dispose();
    });
  });

  // ---- Shared context integration -----------------------------------------

  describe("shared context mode", () => {
    // Lazy import to avoid pulling in WebGL code at top level
    let SharedWebGLContext: typeof import("../shared-context.js").SharedWebGLContext;

    beforeEach(async () => {
      const mod = await import("../shared-context.js");
      SharedWebGLContext = mod.SharedWebGLContext;
    });

    it("creates terminal with sharedContext option without throwing", () => {
      const ctx = new SharedWebGLContext();
      expect(() => {
        const t = make(container, { sharedContext: ctx, paneId: "pane-1" });
        t.dispose();
      }).not.toThrow();
      ctx.dispose();
    });

    it("registers with shared context on creation", () => {
      const ctx = new SharedWebGLContext();
      const t = make(container, { sharedContext: ctx, paneId: "pane-a" });
      expect(ctx.getTerminalIds()).toContain("pane-a");
      t.dispose();
      ctx.dispose();
    });

    it("unregisters from shared context on dispose", () => {
      const ctx = new SharedWebGLContext();
      const t = make(container, { sharedContext: ctx, paneId: "pane-b" });
      expect(ctx.getTerminalIds()).toContain("pane-b");
      t.dispose();
      expect(ctx.getTerminalIds()).not.toContain("pane-b");
      ctx.dispose();
    });

    it("does not create its own WebGL renderer in shared mode", () => {
      const ctx = new SharedWebGLContext();
      const t = make(container, { sharedContext: ctx, paneId: "pane-c" });
      // getCellSize() should still work — it delegates to the shared context
      const size = t.getCellSize();
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
      t.dispose();
      ctx.dispose();
    });
  });

  // ---- Resize content preservation ---------------------------------------

  describe("resize content preservation", () => {
    it("preserves content when growing rows", () => {
      const t = make(container, { cols: 10, rows: 3 });
      t.write("ABC\r\nDEF\r\nGHI");
      t.resize(10, 5); // grow from 3 to 5 rows
      const grid = t.activeGrid;
      // Original rows should still be at rows 0-2
      expect(extractText(grid, 0, 0, 0, 3).trim()).toBe("ABC");
      expect(extractText(grid, 1, 0, 1, 3).trim()).toBe("DEF");
      expect(extractText(grid, 2, 0, 2, 3).trim()).toBe("GHI");
      t.dispose();
    });

    it("preserves content when growing columns", () => {
      const t = make(container, { cols: 10, rows: 3 });
      t.write("HELLO");
      t.resize(20, 3); // grow cols from 10 to 20
      const grid = t.activeGrid;
      expect(extractText(grid, 0, 0, 0, 5).trim()).toBe("HELLO");
      t.dispose();
    });

    it("preserves most recent rows when shrinking rows with cursor in range", () => {
      // 5-row terminal, write 3 lines (cursor ends at row 2, within new size)
      const t = make(container, { cols: 10, rows: 5 });
      t.write("AAA\r\nBBB\r\nCCC");
      t.resize(10, 4); // shrink to 4 rows — cursor row 2 < 4, no shift needed
      const grid = t.activeGrid;
      expect(extractText(grid, 0, 0, 0, 3).trim()).toBe("AAA");
      expect(extractText(grid, 1, 0, 1, 3).trim()).toBe("BBB");
      expect(extractText(grid, 2, 0, 2, 3).trim()).toBe("CCC");
      t.dispose();
    });

    it("shifts content up to keep cursor visible when shrinking rows", () => {
      // 5-row terminal — write content to fill all 5 rows (cursor lands at row 4)
      const t = make(container, { cols: 10, rows: 5 });
      t.write("ROW0\r\nROW1\r\nROW2\r\nROW3\r\nROW4");
      const cursorBefore = t.activeCursor;
      expect(cursorBefore.row).toBe(4); // cursor is at last row
      // Shrink to 3 rows — cursor row 4 >= 3, so srcStartRow = 4 - 3 + 1 = 2
      t.resize(10, 3);
      const grid = t.activeGrid;
      // Rows 2,3,4 of old grid should be at rows 0,1,2 of new grid
      expect(extractText(grid, 0, 0, 0, 4).trim()).toBe("ROW2");
      expect(extractText(grid, 1, 0, 1, 4).trim()).toBe("ROW3");
      expect(extractText(grid, 2, 0, 2, 4).trim()).toBe("ROW4");
      // Cursor should have moved to row 2 (4 - srcStartRow(2) = 2)
      expect(t.activeCursor.row).toBe(2);
      t.dispose();
    });

    it("cursor column is clamped when shrinking columns", () => {
      const t = make(container, { cols: 20, rows: 5 });
      // Position cursor at column 15
      t.write("\x1b[1;16H"); // CUP row=1,col=16 (1-indexed → row=0, col=15)
      expect(t.activeCursor.col).toBe(15);
      t.resize(10, 5); // shrink cols to 10 — cursor col 15 should clamp to 9
      expect(t.activeCursor.col).toBe(9);
      t.dispose();
    });

    it("resize is idempotent — same dimensions do not change cursor or content", () => {
      const t = make(container, { cols: 10, rows: 5 });
      t.write("TEST");
      const cursorBefore = { ...t.activeCursor };
      t.resize(10, 5); // same dimensions
      expect(t.activeCursor.row).toBe(cursorBefore.row);
      expect(t.activeCursor.col).toBe(cursorBefore.col);
      expect(extractText(t.activeGrid, 0, 0, 0, 4).trim()).toBe("TEST");
      t.dispose();
    });
  });
});
