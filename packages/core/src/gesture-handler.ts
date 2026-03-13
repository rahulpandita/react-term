/**
 * Platform-agnostic touch gesture handling for terminal emulators.
 *
 * Pure-logic handler with zero platform dependencies — translates
 * gesture coordinates and states into terminal actions. Used by
 * both @react-term/web (DOM touch events) and @react-term/native
 * (React Native gesture handler).
 */

import type { SelectionRange } from "./cell-grid.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export enum GestureState {
  BEGAN = "began",
  ACTIVE = "active",
  END = "end",
  CANCELLED = "cancelled",
}

export interface GestureConfig {
  onScroll: (deltaRows: number) => void;
  onTap: (row: number, col: number) => void;
  onDoubleTap: (row: number, col: number) => void;
  onLongPress: (row: number, col: number) => void;
  onPinch: (scale: number) => void;
  onSelectionChange: (selection: SelectionRange | null) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Deceleration factor for fling physics (pixels/ms^2). */
const FLING_DECELERATION = 0.003;

/** Minimum velocity (pixels/ms) to trigger a fling. */
const FLING_MIN_VELOCITY = 0.5;

// ---------------------------------------------------------------------------
// GestureHandler
// ---------------------------------------------------------------------------

export class GestureHandler {
  private cellWidth: number;
  private cellHeight: number;
  private config: GestureConfig;

  /** Accumulated sub-row scroll remainder for smooth scrolling. */
  private scrollRemainder = 0;

  /** Whether a long-press selection is active. */
  private selectionActive = false;
  private selectionAnchor: { row: number; col: number } | null = null;

  constructor(cellWidth: number, cellHeight: number, config: GestureConfig) {
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.config = config;
  }

  // -----------------------------------------------------------------------
  // Cell size
  // -----------------------------------------------------------------------

  updateCellSize(width: number, height: number): void {
    this.cellWidth = width;
    this.cellHeight = height;
  }

  // -----------------------------------------------------------------------
  // Coordinate conversion
  // -----------------------------------------------------------------------

  /**
   * Convert pixel coordinates to cell coordinates.
   * Clamps to non-negative values (caller is responsible for upper bounds).
   */
  pixelToCell(x: number, y: number): { row: number; col: number } {
    if (this.cellWidth <= 0 || this.cellHeight <= 0) {
      return { row: 0, col: 0 };
    }
    return {
      row: Math.max(0, Math.floor(y / this.cellHeight)),
      col: Math.max(0, Math.floor(x / this.cellWidth)),
    };
  }

  // -----------------------------------------------------------------------
  // Pan / Scroll
  // -----------------------------------------------------------------------

  /**
   * Handle a pan gesture. Translation values are cumulative pixel offsets
   * from the gesture start. velocityY is in pixels/ms.
   */
  handlePan(
    _translationX: number,
    translationY: number,
    velocityY: number,
    state: GestureState,
  ): void {
    if (this.cellHeight <= 0) return;

    if (state === GestureState.ACTIVE) {
      // Convert pixel translation to row delta, keeping a fractional remainder
      const totalPixels = translationY + this.scrollRemainder;
      const deltaRows = Math.trunc(totalPixels / this.cellHeight);
      this.scrollRemainder = totalPixels - deltaRows * this.cellHeight;

      if (deltaRows !== 0) {
        // Negate: dragging down means scrolling up (seeing older content)
        this.config.onScroll(-deltaRows);
      }
    } else if (state === GestureState.END) {
      this.scrollRemainder = 0;

      // Fling: apply velocity-based scroll
      const absVelocity = Math.abs(velocityY);
      if (absVelocity > FLING_MIN_VELOCITY) {
        const flingRows = this.computeFlingRows(velocityY);
        if (flingRows !== 0) {
          this.config.onScroll(-flingRows);
        }
      }
    } else if (state === GestureState.CANCELLED) {
      this.scrollRemainder = 0;
    } else if (state === GestureState.BEGAN) {
      this.scrollRemainder = 0;
    }
  }

  /**
   * Compute the number of rows a fling gesture should scroll based on
   * initial velocity and deceleration.
   */
  private computeFlingRows(velocityPxPerMs: number): number {
    // d = v^2 / (2 * a)   — kinematic distance from constant deceleration
    const distancePx = (velocityPxPerMs * velocityPxPerMs) / (2 * FLING_DECELERATION);
    const sign = velocityPxPerMs > 0 ? 1 : -1;
    return Math.round((sign * distancePx) / this.cellHeight);
  }

  // -----------------------------------------------------------------------
  // Tap
  // -----------------------------------------------------------------------

  handleTap(x: number, y: number): void {
    if (this.selectionActive) {
      // Tap clears an active selection
      this.selectionActive = false;
      this.selectionAnchor = null;
      this.config.onSelectionChange(null);
      return;
    }

    const { row, col } = this.pixelToCell(x, y);
    this.config.onTap(row, col);
  }

  // -----------------------------------------------------------------------
  // Double-tap (word selection)
  // -----------------------------------------------------------------------

  handleDoubleTap(x: number, y: number): void {
    const { row, col } = this.pixelToCell(x, y);
    this.config.onDoubleTap(row, col);
  }

  // -----------------------------------------------------------------------
  // Long press (enter selection mode)
  // -----------------------------------------------------------------------

  handleLongPress(x: number, y: number): void {
    const { row, col } = this.pixelToCell(x, y);
    this.selectionActive = true;
    this.selectionAnchor = { row, col };

    this.config.onLongPress(row, col);

    // Initialize selection at the long-press point
    this.config.onSelectionChange({
      startRow: row,
      startCol: col,
      endRow: row,
      endCol: col,
    });
  }

  // -----------------------------------------------------------------------
  // Pinch-to-zoom
  // -----------------------------------------------------------------------

  handlePinch(scale: number, state: GestureState): void {
    if (state === GestureState.ACTIVE || state === GestureState.END) {
      this.config.onPinch(scale);
    }
  }

  // -----------------------------------------------------------------------
  // Selection drag (called during pan when selection is active)
  // -----------------------------------------------------------------------

  /**
   * Extend a selection during a drag gesture. Call this from the pan handler
   * when `isSelectionActive` is true.
   */
  extendSelection(x: number, y: number): void {
    if (!this.selectionActive || !this.selectionAnchor) return;

    const { row, col } = this.pixelToCell(x, y);
    this.config.onSelectionChange({
      startRow: this.selectionAnchor.row,
      startCol: this.selectionAnchor.col,
      endRow: row,
      endCol: col,
    });
  }

  get isSelectionActive(): boolean {
    return this.selectionActive;
  }

  clearSelection(): void {
    this.selectionActive = false;
    this.selectionAnchor = null;
    this.config.onSelectionChange(null);
  }
}
