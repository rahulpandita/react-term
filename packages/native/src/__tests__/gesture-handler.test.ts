import { describe, expect, it, vi } from "vitest";
import type { GestureConfig } from "../input/GestureHandler.js";
import { GestureHandler, GestureState } from "../input/GestureHandler.js";

function createHandler(overrides: Partial<GestureConfig> = {}) {
  const config: GestureConfig = {
    onScroll: vi.fn(),
    onTap: vi.fn(),
    onDoubleTap: vi.fn(),
    onLongPress: vi.fn(),
    onPinch: vi.fn(),
    onSelectionChange: vi.fn(),
    ...overrides,
  };
  const handler = new GestureHandler(10, 20, config);
  return { handler, config };
}

describe("GestureHandler", () => {
  // -----------------------------------------------------------------------
  // pixelToCell
  // -----------------------------------------------------------------------

  describe("pixelToCell", () => {
    it("converts pixel coordinates to cell coordinates", () => {
      const { handler } = createHandler();
      expect(handler.pixelToCell(25, 45)).toEqual({ row: 2, col: 2 });
    });

    it("rounds down to nearest cell", () => {
      const { handler } = createHandler();
      // 9px / 10 cellWidth = 0.9 → col 0
      // 19px / 20 cellHeight = 0.95 → row 0
      expect(handler.pixelToCell(9, 19)).toEqual({ row: 0, col: 0 });
    });

    it("clamps negative coordinates to zero", () => {
      const { handler } = createHandler();
      expect(handler.pixelToCell(-5, -10)).toEqual({ row: 0, col: 0 });
    });

    it("handles zero-size cells gracefully", () => {
      const { handler } = createHandler();
      handler.updateCellSize(0, 0);
      expect(handler.pixelToCell(100, 100)).toEqual({ row: 0, col: 0 });
    });

    it("updates after updateCellSize", () => {
      const { handler } = createHandler();
      handler.updateCellSize(8, 16);
      // 24 / 8 = 3, 48 / 16 = 3
      expect(handler.pixelToCell(24, 48)).toEqual({ row: 3, col: 3 });
    });
  });

  // -----------------------------------------------------------------------
  // Tap
  // -----------------------------------------------------------------------

  describe("handleTap", () => {
    it("calls onTap with correct cell coordinates", () => {
      const { handler, config } = createHandler();
      handler.handleTap(15, 25);
      expect(config.onTap).toHaveBeenCalledWith(1, 1);
    });

    it("clears selection if active", () => {
      const { handler, config } = createHandler();
      // Enter selection mode via long press
      handler.handleLongPress(10, 20);
      expect(config.onSelectionChange).toHaveBeenCalled();

      (config.onSelectionChange as ReturnType<typeof vi.fn>).mockClear();

      // Tap clears selection
      handler.handleTap(15, 25);
      expect(config.onSelectionChange).toHaveBeenCalledWith(null);
      // onTap should NOT be called when clearing selection
      expect(config.onTap).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Double-tap
  // -----------------------------------------------------------------------

  describe("handleDoubleTap", () => {
    it("calls onDoubleTap with cell coordinates", () => {
      const { handler, config } = createHandler();
      handler.handleDoubleTap(30, 40);
      expect(config.onDoubleTap).toHaveBeenCalledWith(2, 3);
    });
  });

  // -----------------------------------------------------------------------
  // Long press (selection)
  // -----------------------------------------------------------------------

  describe("handleLongPress", () => {
    it("calls onLongPress and starts selection", () => {
      const { handler, config } = createHandler();
      handler.handleLongPress(15, 25);

      expect(config.onLongPress).toHaveBeenCalledWith(1, 1);
      expect(config.onSelectionChange).toHaveBeenCalledWith({
        startRow: 1,
        startCol: 1,
        endRow: 1,
        endCol: 1,
      });
      expect(handler.isSelectionActive).toBe(true);
    });

    it("extendSelection updates the selection range", () => {
      const { handler, config } = createHandler();
      handler.handleLongPress(10, 20);
      (config.onSelectionChange as ReturnType<typeof vi.fn>).mockClear();

      handler.extendSelection(50, 60);
      expect(config.onSelectionChange).toHaveBeenCalledWith({
        startRow: 1,
        startCol: 1,
        endRow: 3,
        endCol: 5,
      });
    });

    it("clearSelection clears selection state", () => {
      const { handler, config } = createHandler();
      handler.handleLongPress(10, 20);
      (config.onSelectionChange as ReturnType<typeof vi.fn>).mockClear();

      handler.clearSelection();
      expect(handler.isSelectionActive).toBe(false);
      expect(config.onSelectionChange).toHaveBeenCalledWith(null);
    });
  });

  // -----------------------------------------------------------------------
  // Pan / Scroll
  // -----------------------------------------------------------------------

  describe("handlePan", () => {
    it("scrolls by row deltas during active state", () => {
      const { handler, config } = createHandler();
      // cellHeight = 20, so 40px translation = 2 rows
      handler.handlePan(0, 0, 0, GestureState.BEGAN);
      handler.handlePan(0, 40, 0, GestureState.ACTIVE);
      // Dragging down means scrolling up (negative delta)
      expect(config.onScroll).toHaveBeenCalledWith(-2);
    });

    it("does not scroll for sub-row translations", () => {
      const { handler, config } = createHandler();
      handler.handlePan(0, 0, 0, GestureState.BEGAN);
      handler.handlePan(0, 10, 0, GestureState.ACTIVE);
      // 10px / 20 cellHeight = 0 full rows
      expect(config.onScroll).not.toHaveBeenCalled();
    });

    it("applies fling on END with sufficient velocity", () => {
      const { handler, config } = createHandler();
      handler.handlePan(0, 0, 0, GestureState.BEGAN);
      // velocityY = 2 px/ms (fast swipe down)
      handler.handlePan(0, 0, 2, GestureState.END);
      // Should call onScroll with negative value (scrolling up)
      expect(config.onScroll).toHaveBeenCalled();
      const flingDelta = (config.onScroll as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(flingDelta).toBeLessThan(0); // scrolling up
    });

    it("does not fling with low velocity", () => {
      const { handler, config } = createHandler();
      handler.handlePan(0, 0, 0, GestureState.BEGAN);
      handler.handlePan(0, 0, 0.1, GestureState.END);
      expect(config.onScroll).not.toHaveBeenCalled();
    });

    it("resets remainder on CANCELLED", () => {
      const { handler, config } = createHandler();
      handler.handlePan(0, 0, 0, GestureState.BEGAN);
      handler.handlePan(0, 10, 0, GestureState.ACTIVE); // builds remainder
      handler.handlePan(0, 0, 0, GestureState.CANCELLED);
      // Now a fresh gesture should start with no remainder
      handler.handlePan(0, 0, 0, GestureState.BEGAN);
      handler.handlePan(0, 10, 0, GestureState.ACTIVE);
      expect(config.onScroll).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Pinch
  // -----------------------------------------------------------------------

  describe("handlePinch", () => {
    it("calls onPinch during ACTIVE state", () => {
      const { handler, config } = createHandler();
      handler.handlePinch(1.5, GestureState.ACTIVE);
      expect(config.onPinch).toHaveBeenCalledWith(1.5);
    });

    it("calls onPinch on END state", () => {
      const { handler, config } = createHandler();
      handler.handlePinch(0.8, GestureState.END);
      expect(config.onPinch).toHaveBeenCalledWith(0.8);
    });

    it("does not call onPinch on BEGAN or CANCELLED", () => {
      const { handler, config } = createHandler();
      handler.handlePinch(1.2, GestureState.BEGAN);
      handler.handlePinch(1.3, GestureState.CANCELLED);
      expect(config.onPinch).not.toHaveBeenCalled();
    });
  });
});
