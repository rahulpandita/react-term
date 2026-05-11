// @vitest-environment jsdom
/**
 * Integration test for the React <Terminal> imperative handle's
 * serialize()/hydrate() passthrough. Uses React without JSX so the file
 * can stay .test.ts (the repo's vitest glob doesn't match .tsx).
 */

import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal, type TerminalHandle } from "../Terminal.js";

// Canvas 2D context mock — WebTerminal's renderer needs it under jsdom.
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
    measureText: vi.fn((_t: string) => ({
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

// React 19 scheduler needs IS_REACT_ACT_ENVIRONMENT to silence warnings.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("<Terminal> ref: serialize/hydrate integration", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      createMock2DContext() as unknown as CanvasRenderingContext2D,
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("exposes serialize() / hydrate() on the ref and round-trips state", () => {
    const ref = createRef<TerminalHandle>();
    act(() => {
      root.render(
        createElement(Terminal, {
          ref,
          cols: 20,
          rows: 4,
          useWorker: false,
          renderer: "canvas2d",
          renderMode: "main",
        }),
      );
    });

    const handle = ref.current;
    expect(handle).not.toBeNull();
    expect(typeof handle?.serialize).toBe("function");
    expect(typeof handle?.hydrate).toBe("function");
    expect(typeof handle?.setParserModes).toBe("function");

    handle?.write("Snapshot me");
    const state = handle?.serialize?.();
    expect(state?.cols).toBe(20);
    expect(state?.rows).toBe(4);
    expect(state?.cursor.col).toBe(11);
  });

  it("serialize() throws when called on a mounted-then-unmounted ref", () => {
    const ref = createRef<TerminalHandle>();
    act(() => {
      root.render(
        createElement(Terminal, {
          ref,
          cols: 10,
          rows: 3,
          useWorker: false,
          renderer: "canvas2d",
          renderMode: "main",
        }),
      );
    });
    const handle = ref.current;
    act(() => root.unmount());
    expect(() => handle?.serialize?.()).toThrow(/before terminal is mounted|after dispose/);
  });

  it("initialState prop restores cursor + grid before first paint", () => {
    // Build a snapshot on a throwaway terminal...
    const sourceRef = createRef<TerminalHandle>();
    act(() => {
      root.render(
        createElement(Terminal, {
          ref: sourceRef,
          cols: 15,
          rows: 3,
          useWorker: false,
          renderer: "canvas2d",
          renderMode: "main",
        }),
      );
    });
    sourceRef.current?.write("Hello React");
    const snapshot = sourceRef.current?.serialize?.();
    expect(snapshot).toBeDefined();

    // ...then remount with initialState; the new terminal must show the text.
    const targetRef = createRef<TerminalHandle>();
    act(() => {
      root.render(
        createElement(Terminal, {
          ref: targetRef,
          cols: 15,
          rows: 3,
          useWorker: false,
          renderer: "canvas2d",
          renderMode: "main",
          initialState: snapshot,
        }),
      );
    });

    const rows = targetRef.current?.getRowTexts?.();
    expect(rows?.[0]?.trim()).toBe("Hello React");
  });
});
