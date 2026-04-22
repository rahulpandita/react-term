import type { CursorState, Theme } from "@next_term/core";
import { DEFAULT_THEME } from "@next_term/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canUseOffscreenCanvas, RenderBridge } from "../render-bridge.js";

// ---------------------------------------------------------------------------
// Mock Worker
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

function createMockWorkerClass() {
  return function MockWorkerConstructor() {
    mockWorkerInstance = new MockWorker();
    return mockWorkerInstance as unknown as Worker;
  } as unknown as typeof Worker;
}

vi.stubGlobal("Worker", createMockWorkerClass());

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
// Mock HTMLCanvasElement with transferControlToOffscreen
// ---------------------------------------------------------------------------

class MockOffscreenCanvas {
  width = 100;
  height = 100;
}

function createMockCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 100,
    height: 100,
    style: { display: "", width: "", height: "" },
    transferControlToOffscreen: vi.fn(() => new MockOffscreenCanvas()),
    getContext: vi.fn(() => null),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLCanvasElement;
  return canvas;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultOptions() {
  return {
    fontSize: 14,
    fontFamily: "monospace",
    theme: { ...DEFAULT_THEME } as Theme,
    devicePixelRatio: 1,
  };
}

function makeSharedBuffer(): SharedArrayBuffer {
  // Allocate enough space for a small 10x5 grid:
  // cellBytes + dirtyBytes + rgbBytes + cursorBytes
  const CELL_SIZE = 2;
  const cols = 10;
  const rows = 5;
  const cellBytes = cols * rows * CELL_SIZE * 4;
  const dirtyBytes = rows * 4;
  const rgbBytes = 512 * 4;
  const cursorBytes = 4 * 4;
  return new SharedArrayBuffer(cellBytes + dirtyBytes + rgbBytes + cursorBytes);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RenderBridge", () => {
  let canvas: HTMLCanvasElement;
  let bridge: RenderBridge;

  beforeEach(() => {
    canvas = createMockCanvas();
    bridge = new RenderBridge(canvas, defaultOptions());
  });

  afterEach(() => {
    bridge.dispose();
  });

  // ---- Creation -----------------------------------------------------------

  it("can be created without throwing", () => {
    expect(bridge).toBeDefined();
  });

  // ---- start --------------------------------------------------------------

  it("sends an init message when started", () => {
    const sab = makeSharedBuffer();
    bridge.start(sab, 10, 5);

    expect(canvas.transferControlToOffscreen).toHaveBeenCalled();
    expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "init",
        cols: 10,
        rows: 5,
        sharedBuffer: sab,
        fontSize: 14,
        fontFamily: "monospace",
      }),
      expect.any(Array), // transferables
    );
  });

  it("defaults the renderer field to webgl2", () => {
    bridge.start(makeSharedBuffer(), 10, 5);
    const initCall = mockWorkerInstance.postMessage.mock.calls.find((c) => c[0]?.type === "init");
    expect(initCall?.[0].renderer).toBe("webgl2");
  });

  it("forwards renderer: canvas2d when configured", () => {
    bridge.dispose();
    bridge = new RenderBridge(canvas, { ...defaultOptions(), renderer: "canvas2d" });
    bridge.start(makeSharedBuffer(), 10, 5);

    const initCall = mockWorkerInstance.postMessage.mock.calls.find((c) => c[0]?.type === "init");
    expect(initCall?.[0].renderer).toBe("canvas2d");
  });

  it("transfers the OffscreenCanvas in the init message", () => {
    const sab = makeSharedBuffer();
    bridge.start(sab, 10, 5);

    const calls = mockWorkerInstance.postMessage.mock.calls;
    const initCall = calls.find((c) => c[0]?.type === "init");
    expect(initCall).toBeDefined();

    // Second argument is transferables array containing the OffscreenCanvas
    const transferables = initCall?.[1];
    expect(Array.isArray(transferables)).toBe(true);
    expect(transferables.length).toBe(1);
    expect(transferables[0]).toBeInstanceOf(MockOffscreenCanvas);
  });

  // ---- updateCursor -------------------------------------------------------

  it("sends an update message for cursor changes", () => {
    bridge.start(makeSharedBuffer(), 10, 5);
    mockWorkerInstance.postMessage.mockClear();

    const cursor: CursorState = { row: 3, col: 7, visible: true, style: "bar", wrapPending: false };
    bridge.updateCursor(cursor);

    expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "update",
        cursor: { row: 3, col: 7, visible: true, style: "bar" },
      }),
    );
  });

  // ---- updateSelection ----------------------------------------------------

  it("sends an update message with selection", () => {
    bridge.start(makeSharedBuffer(), 10, 5);
    mockWorkerInstance.postMessage.mockClear();

    bridge.updateSelection({ startRow: 0, startCol: 2, endRow: 1, endCol: 5 });

    expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "update",
        selection: { startRow: 0, startCol: 2, endRow: 1, endCol: 5 },
      }),
    );
  });

  it("sends null selection to clear it", () => {
    bridge.start(makeSharedBuffer(), 10, 5);
    mockWorkerInstance.postMessage.mockClear();

    bridge.updateSelection(null);

    expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "update",
        selection: null,
      }),
    );
  });

  // ---- resize -------------------------------------------------------------

  it("sends a resize message", () => {
    const sab1 = makeSharedBuffer();
    bridge.start(sab1, 10, 5);
    mockWorkerInstance.postMessage.mockClear();

    const sab2 = makeSharedBuffer();
    bridge.resize(20, 10, sab2);

    expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "resize",
        cols: 20,
        rows: 10,
        sharedBuffer: sab2,
      }),
    );
  });

  // ---- setTheme -----------------------------------------------------------

  it("sends a theme message", () => {
    bridge.start(makeSharedBuffer(), 10, 5);
    mockWorkerInstance.postMessage.mockClear();

    const newTheme = { ...DEFAULT_THEME, background: "#000000" };
    bridge.setTheme(newTheme);

    expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "theme",
        theme: newTheme,
      }),
    );
  });

  // ---- setFont ------------------------------------------------------------

  it("sends a font message", () => {
    bridge.start(makeSharedBuffer(), 10, 5);
    mockWorkerInstance.postMessage.mockClear();

    bridge.setFont(16, "Courier New");

    expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "font",
        fontSize: 16,
        fontFamily: "Courier New",
      }),
    );
  });

  // ---- setSyncedOutput -----------------------------------------------------

  it("sends syncedOutput message to the worker", () => {
    bridge.start(makeSharedBuffer(), 10, 5);
    bridge.setSyncedOutput(true);

    const calls = mockWorkerInstance.postMessage.mock.calls.filter(
      (c) => c[0]?.type === "syncedOutput",
    );
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toEqual({ type: "syncedOutput", enabled: true });
  });

  it("sends syncedOutput=false to resume the render loop", () => {
    bridge.start(makeSharedBuffer(), 10, 5);
    bridge.setSyncedOutput(true);
    bridge.setSyncedOutput(false);

    const calls = mockWorkerInstance.postMessage.mock.calls.filter(
      (c) => c[0]?.type === "syncedOutput",
    );
    expect(calls.length).toBe(2);
    expect(calls[1][0]).toEqual({ type: "syncedOutput", enabled: false });
  });

  // ---- dispose ------------------------------------------------------------

  it("sends a dispose message and terminates the worker", () => {
    bridge.start(makeSharedBuffer(), 10, 5);
    bridge.dispose();

    const disposeCalls = mockWorkerInstance.postMessage.mock.calls.filter(
      (c) => c[0]?.type === "dispose",
    );
    expect(disposeCalls.length).toBe(1);
    expect(mockWorkerInstance.terminate).toHaveBeenCalled();
  });

  it("does not send messages after dispose", () => {
    bridge.start(makeSharedBuffer(), 10, 5);
    bridge.dispose();
    mockWorkerInstance.postMessage.mockClear();

    bridge.updateCursor({ row: 0, col: 0, visible: true, style: "block", wrapPending: false });
    bridge.updateSelection(null);
    bridge.resize(80, 24, makeSharedBuffer());
    bridge.setTheme(DEFAULT_THEME);
    bridge.setFont(14, "monospace");
    bridge.setSyncedOutput(true);

    expect(mockWorkerInstance.postMessage).not.toHaveBeenCalled();
  });

  // ---- FPS callback -------------------------------------------------------

  it("calls onFps when the worker reports frame rate", () => {
    const fpsSpy = vi.fn();
    bridge = new RenderBridge(canvas, { ...defaultOptions(), onFps: fpsSpy });
    bridge.start(makeSharedBuffer(), 10, 5);

    mockWorkerInstance.simulateMessage({ type: "frame", fps: 60 });
    expect(fpsSpy).toHaveBeenCalledWith(60);
  });

  // ---- Error callback -----------------------------------------------------

  it("calls onError when the worker reports an error message", () => {
    const errorSpy = vi.fn();
    bridge = new RenderBridge(canvas, { ...defaultOptions(), onError: errorSpy });
    bridge.start(makeSharedBuffer(), 10, 5);

    mockWorkerInstance.simulateMessage({ type: "error", message: "GL failed" });
    expect(errorSpy).toHaveBeenCalledWith("GL failed");
  });

  it("calls onError on worker runtime error", () => {
    const errorSpy = vi.fn();
    bridge = new RenderBridge(canvas, { ...defaultOptions(), onError: errorSpy });
    bridge.start(makeSharedBuffer(), 10, 5);

    mockWorkerInstance.simulateError("runtime crash");
    expect(errorSpy).toHaveBeenCalledWith("Render worker error: runtime crash");
  });
});

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

describe("canUseOffscreenCanvas", () => {
  it("returns a boolean", () => {
    const result = canUseOffscreenCanvas();
    expect(typeof result).toBe("boolean");
  });

  it("returns false when OffscreenCanvas is not defined", () => {
    const original = globalThis.OffscreenCanvas;
    // @ts-expect-error - testing undefined
    delete globalThis.OffscreenCanvas;

    expect(canUseOffscreenCanvas()).toBe(false);

    // Restore
    if (original) {
      globalThis.OffscreenCanvas = original;
    }
  });
});
