import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GestureConfig } from "../gesture-handler.js";
import { GestureHandler, GestureState } from "../gesture-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): GestureConfig {
  return {
    onScroll: vi.fn(),
    onTap: vi.fn(),
    onDoubleTap: vi.fn(),
    onLongPress: vi.fn(),
    onPinch: vi.fn(),
    onSelectionChange: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// pixelToCell
// ---------------------------------------------------------------------------

describe("GestureHandler.pixelToCell", () => {
  it("converts pixel coordinates to cell coordinates", () => {
    const h = new GestureHandler(8, 16, makeConfig());
    expect(h.pixelToCell(8, 16)).toEqual({ row: 1, col: 1 });
    expect(h.pixelToCell(0, 0)).toEqual({ row: 0, col: 0 });
  });

  it("floors fractional coordinates", () => {
    const h = new GestureHandler(8, 16, makeConfig());
    expect(h.pixelToCell(15, 31)).toEqual({ row: 1, col: 1 });
  });

  it("clamps negative coordinates to zero", () => {
    const h = new GestureHandler(8, 16, makeConfig());
    expect(h.pixelToCell(-5, -10)).toEqual({ row: 0, col: 0 });
  });

  it("returns (0,0) when cell size is zero", () => {
    const h = new GestureHandler(0, 0, makeConfig());
    expect(h.pixelToCell(100, 200)).toEqual({ row: 0, col: 0 });
  });

  it("returns (0,0) when cell width is zero", () => {
    const h = new GestureHandler(0, 16, makeConfig());
    expect(h.pixelToCell(100, 32)).toEqual({ row: 0, col: 0 });
  });

  it("returns (0,0) when cell height is zero", () => {
    const h = new GestureHandler(8, 0, makeConfig());
    expect(h.pixelToCell(100, 200)).toEqual({ row: 0, col: 0 });
  });

  it("returns (0,0) for negative cell sizes", () => {
    const h = new GestureHandler(-8, -16, makeConfig());
    expect(h.pixelToCell(50, 80)).toEqual({ row: 0, col: 0 });
  });

  it("updates after updateCellSize", () => {
    const h = new GestureHandler(8, 16, makeConfig());
    h.updateCellSize(10, 20);
    expect(h.pixelToCell(10, 20)).toEqual({ row: 1, col: 1 });
    expect(h.pixelToCell(8, 16)).toEqual({ row: 0, col: 0 });
  });
});

// ---------------------------------------------------------------------------
// handlePan — scroll accumulation
// ---------------------------------------------------------------------------

describe("GestureHandler.handlePan — scroll", () => {
  let config: GestureConfig;
  let h: GestureHandler;

  beforeEach(() => {
    config = makeConfig();
    h = new GestureHandler(8, 16, config);
  });

  it("scrolls one row when translation reaches one cell height", () => {
    h.handlePan(0, 16, 0, GestureState.ACTIVE);
    expect(config.onScroll).toHaveBeenCalledWith(-1);
  });

  it("scrolls multiple rows for large translation", () => {
    h.handlePan(0, 48, 0, GestureState.ACTIVE);
    expect(config.onScroll).toHaveBeenCalledWith(-3);
  });

  it("does not scroll when translation is less than one cell height", () => {
    h.handlePan(0, 15, 0, GestureState.ACTIVE);
    expect(config.onScroll).not.toHaveBeenCalled();
  });

  it("accumulates sub-row remainder across pan events", () => {
    // 10px each time — each event alone < 16px, but two events = 20px = 1 row
    h.handlePan(0, 10, 0, GestureState.ACTIVE);
    expect(config.onScroll).not.toHaveBeenCalled();
    h.handlePan(0, 10, 0, GestureState.ACTIVE);
    expect(config.onScroll).toHaveBeenCalledWith(-1);
  });

  it("negates scroll direction (drag down = scroll up)", () => {
    h.handlePan(0, 32, 0, GestureState.ACTIVE);
    expect(config.onScroll).toHaveBeenCalledWith(-2);
  });

  it("scrolls in positive direction for negative translation", () => {
    h.handlePan(0, -32, 0, GestureState.ACTIVE);
    expect(config.onScroll).toHaveBeenCalledWith(2);
  });

  it("does nothing for BEGAN state", () => {
    h.handlePan(0, 100, 0, GestureState.BEGAN);
    expect(config.onScroll).not.toHaveBeenCalled();
  });

  it("resets remainder on BEGAN", () => {
    // Accumulate 10px remainder
    h.handlePan(0, 10, 0, GestureState.ACTIVE);
    // BEGAN resets remainder
    h.handlePan(0, 0, 0, GestureState.BEGAN);
    // Subsequent ACTIVE should not inherit old remainder
    h.handlePan(0, 10, 0, GestureState.ACTIVE);
    expect(config.onScroll).not.toHaveBeenCalled();
  });

  it("resets remainder on CANCELLED and stops scrolling", () => {
    h.handlePan(0, 10, 0, GestureState.ACTIVE);
    h.handlePan(0, 0, 0, GestureState.CANCELLED);
    expect(config.onScroll).not.toHaveBeenCalled();
    // Subsequent ACTIVE starts fresh — sub-threshold again
    h.handlePan(0, 10, 0, GestureState.ACTIVE);
    expect(config.onScroll).not.toHaveBeenCalled();
  });

  it("does nothing when cell height is zero", () => {
    const cfg = makeConfig();
    const hZero = new GestureHandler(8, 0, cfg);
    hZero.handlePan(0, 100, 0, GestureState.ACTIVE);
    expect(cfg.onScroll).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handlePan — fling physics
// ---------------------------------------------------------------------------

describe("GestureHandler.handlePan — fling", () => {
  const FLING_DECELERATION = 0.003;

  it("triggers fling on END with sufficient velocity", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    const velocityY = 1.0; // pixels/ms, above 0.5 threshold
    const expectedDistance = (velocityY * velocityY) / (2 * FLING_DECELERATION);
    const expectedRows = Math.round(expectedDistance / 16);
    h.handlePan(0, 0, velocityY, GestureState.END);
    expect(config.onScroll).toHaveBeenCalledWith(-expectedRows);
  });

  it("does not fling when velocity is below threshold", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handlePan(0, 0, 0.3, GestureState.END);
    expect(config.onScroll).not.toHaveBeenCalled();
  });

  it("does not fling when velocity is exactly at threshold (0.5)", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handlePan(0, 0, 0.5, GestureState.END);
    expect(config.onScroll).not.toHaveBeenCalled();
  });

  it("flings in the correct direction for negative velocity", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    const velocityY = -1.0;
    const expectedDistance = (velocityY * velocityY) / (2 * FLING_DECELERATION);
    const expectedRows = -Math.round(expectedDistance / 16);
    h.handlePan(0, 0, velocityY, GestureState.END);
    expect(config.onScroll).toHaveBeenCalledWith(-expectedRows);
  });

  it("resets scroll remainder on END", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    // Accumulate sub-row remainder
    h.handlePan(0, 10, 0, GestureState.ACTIVE);
    // END with below-threshold velocity: onScroll should NOT be called
    h.handlePan(0, 0, 0.1, GestureState.END);
    expect(config.onScroll).not.toHaveBeenCalled();
    // A fresh ACTIVE should start with no remainder
    h.handlePan(0, 10, 0, GestureState.ACTIVE);
    expect(config.onScroll).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleTap
// ---------------------------------------------------------------------------

describe("GestureHandler.handleTap", () => {
  it("calls onTap with correct cell coordinates", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handleTap(24, 32);
    expect(config.onTap).toHaveBeenCalledWith(2, 3);
  });

  it("clears an active selection instead of calling onTap", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handleLongPress(0, 0);
    expect(h.isSelectionActive).toBe(true);
    vi.mocked(config.onTap).mockClear();
    vi.mocked(config.onSelectionChange).mockClear();

    h.handleTap(24, 32);
    expect(config.onTap).not.toHaveBeenCalled();
    expect(config.onSelectionChange).toHaveBeenCalledWith(null);
    expect(h.isSelectionActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleDoubleTap
// ---------------------------------------------------------------------------

describe("GestureHandler.handleDoubleTap", () => {
  it("calls onDoubleTap with correct cell coordinates", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handleDoubleTap(16, 48);
    expect(config.onDoubleTap).toHaveBeenCalledWith(3, 2);
  });
});

// ---------------------------------------------------------------------------
// handleLongPress
// ---------------------------------------------------------------------------

describe("GestureHandler.handleLongPress", () => {
  it("calls onLongPress with correct cell coordinates", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handleLongPress(24, 32);
    expect(config.onLongPress).toHaveBeenCalledWith(2, 3);
  });

  it("activates selection mode", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    expect(h.isSelectionActive).toBe(false);
    h.handleLongPress(0, 0);
    expect(h.isSelectionActive).toBe(true);
  });

  it("initializes selection at the long-press cell", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handleLongPress(24, 32); // cell (2, 3)
    expect(config.onSelectionChange).toHaveBeenCalledWith({
      startRow: 2,
      startCol: 3,
      endRow: 2,
      endCol: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// extendSelection
// ---------------------------------------------------------------------------

describe("GestureHandler.extendSelection", () => {
  it("extends selection from anchor to current position", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handleLongPress(0, 0); // anchor at (0, 0)
    vi.mocked(config.onSelectionChange).mockClear();

    h.extendSelection(24, 32); // current at cell (2, 3)
    expect(config.onSelectionChange).toHaveBeenCalledWith({
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 3,
    });
  });

  it("does nothing when selection is not active", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.extendSelection(24, 32);
    expect(config.onSelectionChange).not.toHaveBeenCalled();
  });

  it("uses anchor set by long-press, not current position", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handleLongPress(16, 16); // anchor at cell (1, 2)
    vi.mocked(config.onSelectionChange).mockClear();

    h.extendSelection(80, 80); // extends to cell (5, 10)
    expect(config.onSelectionChange).toHaveBeenCalledWith({
      startRow: 1,
      startCol: 2,
      endRow: 5,
      endCol: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// clearSelection
// ---------------------------------------------------------------------------

describe("GestureHandler.clearSelection", () => {
  it("clears an active selection", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handleLongPress(0, 0);
    expect(h.isSelectionActive).toBe(true);
    vi.mocked(config.onSelectionChange).mockClear();

    h.clearSelection();
    expect(h.isSelectionActive).toBe(false);
    expect(config.onSelectionChange).toHaveBeenCalledWith(null);
  });

  it("is safe to call when no selection is active", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    expect(() => h.clearSelection()).not.toThrow();
    expect(config.onSelectionChange).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// handlePinch
// ---------------------------------------------------------------------------

describe("GestureHandler.handlePinch", () => {
  it("calls onPinch for ACTIVE state", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handlePinch(1.5, GestureState.ACTIVE);
    expect(config.onPinch).toHaveBeenCalledWith(1.5);
  });

  it("calls onPinch for END state", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handlePinch(0.8, GestureState.END);
    expect(config.onPinch).toHaveBeenCalledWith(0.8);
  });

  it("does not call onPinch for BEGAN state", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handlePinch(1.5, GestureState.BEGAN);
    expect(config.onPinch).not.toHaveBeenCalled();
  });

  it("does not call onPinch for CANCELLED state", () => {
    const config = makeConfig();
    const h = new GestureHandler(8, 16, config);
    h.handlePinch(1.5, GestureState.CANCELLED);
    expect(config.onPinch).not.toHaveBeenCalled();
  });
});
