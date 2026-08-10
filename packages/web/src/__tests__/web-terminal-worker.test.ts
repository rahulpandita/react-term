// @vitest-environment jsdom
/**
 * WebTerminal worker-mode unit tests.
 *
 * Tests cover the useWorker:true code path: WorkerBridge lifecycle, onFlush
 * mode propagation, alt-buffer switching on flush, worker error fallback, and
 * write() forwarding.
 *
 * A MockWorker is installed before importing WebTerminal so that WorkerBridge
 * interacts with the mock instead of a real Web Worker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebTerminal } from "../web-terminal.js";

// ---------------------------------------------------------------------------
// MockWorker — captures the most recently created instance.
// ---------------------------------------------------------------------------

class MockWorker {
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

  simulateMessage(data: unknown): void {
    const handlers = this.listeners.get("message");
    if (handlers) {
      for (const h of handlers) h({ data } as MessageEvent);
    }
  }

  simulateError(message: string): void {
    const handlers = this.listeners.get("error");
    if (handlers) {
      for (const h of handlers) h({ message } as ErrorEvent);
    }
  }
}

let mockWorkerInstance: MockWorker;

vi.stubGlobal("Worker", function MockWorkerConstructor() {
  mockWorkerInstance = new MockWorker();
  return mockWorkerInstance as unknown as Worker;
} as unknown as typeof Worker);

// Stub URL as a proper constructor (WorkerBridge does `new URL(path, base)`).
// Also attach static methods used by RenderBridge.
class MockURL {
  href: string;
  constructor(path: string, base?: string | URL) {
    this.href = `${base ?? ""}${path}`;
  }
  toString(): string {
    return this.href;
  }
  static createObjectURL = vi.fn(() => "blob:mock");
  static revokeObjectURL = vi.fn();
}
vi.stubGlobal("URL", MockURL);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_MODES = {
  applicationCursorKeys: false,
  bracketedPasteMode: false,
  mouseProtocol: "none" as const,
  mouseEncoding: "default" as const,
  sendFocusEvents: false,
  kittyFlags: 0,
  syncedOutput: false,
};

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
    measureText: vi.fn(() => ({
      width: 8,
      fontBoundingBoxAscent: 12,
      fontBoundingBoxDescent: 4,
    })),
  };
}

/** Build a WebTerminal in worker mode with a mocked canvas context. */
function makeWorkerTerminal(
  container: HTMLElement,
  extra: ConstructorParameters<typeof WebTerminal>[1] = {},
) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    createMock2DContext() as unknown as CanvasRenderingContext2D,
  );
  return new WebTerminal(container, {
    useWorker: true,
    renderer: "canvas2d",
    renderMode: "main",
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebTerminal — worker mode", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  // ---- Worker startup -------------------------------------------------------

  describe("startup", () => {
    it("creates a Worker when useWorker is true", () => {
      const t = makeWorkerTerminal(container);
      expect(mockWorkerInstance).toBeDefined();
      t.dispose();
    });

    it("sends an init message with correct dimensions to the worker", () => {
      const t = makeWorkerTerminal(container, { cols: 100, rows: 30 });
      const initCalls = mockWorkerInstance.postMessage.mock.calls.filter(
        (c) => c[0]?.type === "init",
      );
      expect(initCalls.length).toBe(1);
      expect(initCalls[0][0]).toMatchObject({ type: "init", cols: 100, rows: 30 });
      t.dispose();
    });
  });

  // ---- write() forwarding ---------------------------------------------------

  describe("write()", () => {
    it("forwards write() as a worker message, not directly to the VT parser", () => {
      const t = makeWorkerTerminal(container);
      mockWorkerInstance.postMessage.mockClear();

      t.write("Hello");

      const writeCalls = mockWorkerInstance.postMessage.mock.calls.filter(
        (c) => c[0]?.type === "write",
      );
      expect(writeCalls.length).toBe(1);
      t.dispose();
    });

    it("does not mutate the grid synchronously on write (parsing is off-thread)", () => {
      const t = makeWorkerTerminal(container, { cols: 20, rows: 5 });
      const colBefore = t.activeCursor.col;

      // In worker mode no parser is on the main thread, so the cursor should
      // not move synchronously when write() is called.
      t.write("ABC");
      expect(t.activeCursor.col).toBe(colBefore);
      t.dispose();
    });
  });

  // ---- onFlush — mode propagation ------------------------------------------

  describe("onFlush — mode propagation", () => {
    it("applies applicationCursorKeys=true from flush to the input handler", () => {
      const t = makeWorkerTerminal(container);
      expect(t.getParserModes().applicationCursorKeys).toBe(false);

      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block", wrapPending: false },
        isAlternate: false,
        bytesProcessed: 10,
        modes: { ...DEFAULT_MODES, applicationCursorKeys: true },
      });

      expect(t.getParserModes().applicationCursorKeys).toBe(true);
      t.dispose();
    });

    it("applies bracketedPasteMode=true from flush", () => {
      const t = makeWorkerTerminal(container);

      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block", wrapPending: false },
        isAlternate: false,
        bytesProcessed: 5,
        modes: { ...DEFAULT_MODES, bracketedPasteMode: true },
      });

      expect(t.getParserModes().bracketedPasteMode).toBe(true);
      t.dispose();
    });

    it("applies sendFocusEvents=true from flush", () => {
      const t = makeWorkerTerminal(container);

      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block", wrapPending: false },
        isAlternate: false,
        bytesProcessed: 5,
        modes: { ...DEFAULT_MODES, sendFocusEvents: true },
      });

      expect(t.getParserModes().sendFocusEvents).toBe(true);
      t.dispose();
    });

    it("applies mouseProtocol from flush", () => {
      const t = makeWorkerTerminal(container);

      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block", wrapPending: false },
        isAlternate: false,
        bytesProcessed: 5,
        modes: { ...DEFAULT_MODES, mouseProtocol: "x10" as const },
      });

      expect(t.getParserModes().mouseProtocol).toBe("x10");
      t.dispose();
    });

    it("flush with null modes does not throw", () => {
      const t = makeWorkerTerminal(container);

      expect(() => {
        mockWorkerInstance.simulateMessage({
          type: "flush",
          cursor: { row: 0, col: 0, visible: true, style: "block", wrapPending: false },
          isAlternate: false,
          bytesProcessed: 0,
          modes: null,
        });
      }).not.toThrow();
      t.dispose();
    });
  });

  // ---- onFlush — alt-buffer switching ---------------------------------------

  describe("onFlush — alternate buffer switching", () => {
    it("switches to alternate buffer when flush sets isAlternate=true", () => {
      const t = makeWorkerTerminal(container);
      expect(t.isAlternateBuffer).toBe(false);

      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block", wrapPending: false },
        isAlternate: true,
        bytesProcessed: 10,
        modes: DEFAULT_MODES,
      });

      expect(t.isAlternateBuffer).toBe(true);
      t.dispose();
    });

    it("switches back to normal buffer when flush sets isAlternate=false", () => {
      const t = makeWorkerTerminal(container);

      // Switch to alt first
      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block", wrapPending: false },
        isAlternate: true,
        bytesProcessed: 10,
        modes: DEFAULT_MODES,
      });
      expect(t.isAlternateBuffer).toBe(true);

      // Switch back to normal
      mockWorkerInstance.simulateMessage({
        type: "flush",
        cursor: { row: 0, col: 0, visible: true, style: "block", wrapPending: false },
        isAlternate: false,
        bytesProcessed: 10,
        modes: DEFAULT_MODES,
      });
      expect(t.isAlternateBuffer).toBe(false);
      t.dispose();
    });

    it("normal→alt→normal does not throw even on repeated switches", () => {
      const t = makeWorkerTerminal(container);

      const flush = (alt: boolean) =>
        mockWorkerInstance.simulateMessage({
          type: "flush",
          cursor: { row: 0, col: 0, visible: true, style: "block", wrapPending: false },
          isAlternate: alt,
          bytesProcessed: 1,
          modes: DEFAULT_MODES,
        });

      expect(() => {
        for (let i = 0; i < 5; i++) {
          flush(true);
          flush(false);
        }
      }).not.toThrow();
      t.dispose();
    });
  });

  // ---- Worker error handling ------------------------------------------------

  describe("worker error handling", () => {
    it("falls back to main-thread parser on worker error message", () => {
      const t = makeWorkerTerminal(container, { cols: 20, rows: 5 });

      // Trigger worker error — this should activate the fallback parser
      mockWorkerInstance.simulateMessage({ type: "error", message: "worker crashed" });

      // After fallback the terminal should parse writes synchronously
      // (the VTParser is on the main thread now, so the cursor advances).
      t.write("Hi");
      expect(t.activeCursor.col).toBe(2);
      t.dispose();
    });

    it("falls back to main-thread parser on worker runtime error", () => {
      const t = makeWorkerTerminal(container, { cols: 20, rows: 5 });

      mockWorkerInstance.simulateError("runtime crash");

      t.write("AB");
      expect(t.activeCursor.col).toBe(2);
      t.dispose();
    });
  });

  // ---- resize() -------------------------------------------------------------

  describe("resize()", () => {
    it("sends a resize message to the worker", () => {
      const t = makeWorkerTerminal(container, { cols: 80, rows: 24 });
      mockWorkerInstance.postMessage.mockClear();

      t.resize(120, 40);

      const resizeCalls = mockWorkerInstance.postMessage.mock.calls.filter(
        (c) => c[0]?.type === "resize",
      );
      expect(resizeCalls.length).toBe(1);
      expect(resizeCalls[0][0]).toMatchObject({ type: "resize", cols: 120, rows: 40 });
      t.dispose();
    });
  });

  // ---- dispose() ------------------------------------------------------------

  describe("dispose()", () => {
    it("terminates the worker on dispose", () => {
      const t = makeWorkerTerminal(container);
      t.dispose();
      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
    });

    it("is safe to call dispose() multiple times", () => {
      const t = makeWorkerTerminal(container);
      expect(() => {
        t.dispose();
        t.dispose();
      }).not.toThrow();
    });
  });
});
