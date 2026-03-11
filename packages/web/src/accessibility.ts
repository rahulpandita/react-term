/**
 * AccessibilityManager — parallel DOM approach for screen reader support.
 *
 * Creates an off-screen (but not display:none) container with an ARIA grid
 * that mirrors the terminal's CellGrid content. Updates are throttled to
 * 10 Hz to avoid excessive CPU usage.
 *
 * Inspired by the xterm.js accessibility approach.
 */

import type { CellGrid } from '@react-term/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a single row's text content from a CellGrid.
 * Trims trailing whitespace for cleaner screen reader output.
 */
export function extractRowText(grid: CellGrid, row: number): string {
  const cols = grid.cols;
  let text = '';
  for (let col = 0; col < cols; col++) {
    const cp = grid.getCodepoint(row, col);
    text += cp > 0x20 ? String.fromCodePoint(cp) : ' ';
  }
  return text.replace(/\s+$/, '');
}

// ---------------------------------------------------------------------------
// AccessibilityManager
// ---------------------------------------------------------------------------

export class AccessibilityManager {
  private container: HTMLElement;
  private liveRegion: HTMLElement;
  private treeContainer: HTMLElement;
  private rowElements: HTMLElement[];
  private grid: CellGrid;
  private rows: number;
  private cols: number;
  private disposed = false;

  /** Throttle interval in milliseconds (10 Hz). */
  private static readonly THROTTLE_MS = 100;

  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private updateScheduled = false;

  constructor(container: HTMLElement, grid: CellGrid, rows: number, cols: number) {
    this.grid = grid;
    this.rows = rows;
    this.cols = cols;
    this.container = container;

    // Create the off-screen accessibility tree container.
    // It is positioned absolutely, transparent, and ignores pointer events
    // so it does not interfere with the canvas rendering.
    this.treeContainer = document.createElement('div');
    this.treeContainer.setAttribute('role', 'grid');
    this.treeContainer.setAttribute('aria-label', 'Terminal output');
    this.treeContainer.setAttribute('aria-readonly', 'true');
    Object.assign(this.treeContainer.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      opacity: '0',
      pointerEvents: 'none',
      // clip-rect keeps it off-screen for sighted users while remaining
      // accessible to screen readers (unlike display:none).
      clip: 'rect(0 0 0 0)',
      clipPath: 'inset(50%)',
      whiteSpace: 'nowrap',
    });

    // Build initial row elements
    this.rowElements = [];
    for (let r = 0; r < rows; r++) {
      const rowEl = document.createElement('div');
      rowEl.setAttribute('role', 'row');
      rowEl.setAttribute('aria-posinset', String(r + 1));
      rowEl.setAttribute('aria-setsize', String(rows));
      this.treeContainer.appendChild(rowEl);
      this.rowElements.push(rowEl);
    }

    container.appendChild(this.treeContainer);

    // Create live region for announcements (e.g. bell, output chunks)
    this.liveRegion = document.createElement('div');
    this.liveRegion.setAttribute('role', 'log');
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-relevant', 'additions');
    Object.assign(this.liveRegion.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      opacity: '0',
      pointerEvents: 'none',
      clip: 'rect(0 0 0 0)',
      clipPath: 'inset(50%)',
      whiteSpace: 'nowrap',
    });
    container.appendChild(this.liveRegion);
  }

  /**
   * Update the accessibility tree for dirty rows.
   * Throttled to 10 Hz — safe to call on every render frame.
   */
  update(): void {
    if (this.disposed) return;

    if (this.throttleTimer !== null) {
      // An update is already scheduled; just mark that another one is wanted.
      this.updateScheduled = true;
      return;
    }

    this.performUpdate();

    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      if (this.updateScheduled) {
        this.updateScheduled = false;
        this.update();
      }
    }, AccessibilityManager.THROTTLE_MS);
  }

  /**
   * Announce text to screen readers via the live region.
   */
  announce(text: string, priority: 'polite' | 'assertive' = 'polite'): void {
    if (this.disposed) return;

    this.liveRegion.setAttribute('aria-live', priority);

    const span = document.createElement('span');
    span.textContent = text;
    this.liveRegion.appendChild(span);

    // Keep the live region from growing unboundedly.
    while (this.liveRegion.childNodes.length > 20) {
      this.liveRegion.removeChild(this.liveRegion.firstChild!);
    }
  }

  /**
   * Replace the grid reference (e.g. after resize).
   */
  setGrid(grid: CellGrid, rows: number, cols: number): void {
    this.grid = grid;
    this.rows = rows;
    this.cols = cols;

    // Rebuild row elements if the count changed
    while (this.rowElements.length > rows) {
      const el = this.rowElements.pop()!;
      this.treeContainer.removeChild(el);
    }
    while (this.rowElements.length < rows) {
      const rowEl = document.createElement('div');
      rowEl.setAttribute('role', 'row');
      this.treeContainer.appendChild(rowEl);
      this.rowElements.push(rowEl);
    }

    // Update aria attributes
    for (let r = 0; r < rows; r++) {
      this.rowElements[r].setAttribute('aria-posinset', String(r + 1));
      this.rowElements[r].setAttribute('aria-setsize', String(rows));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    if (this.treeContainer.parentElement) {
      this.treeContainer.parentElement.removeChild(this.treeContainer);
    }
    if (this.liveRegion.parentElement) {
      this.liveRegion.parentElement.removeChild(this.liveRegion);
    }

    this.rowElements = [];
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private performUpdate(): void {
    const grid = this.grid;
    const rows = Math.min(this.rows, this.rowElements.length);

    for (let r = 0; r < rows; r++) {
      if (!grid.isDirty(r)) continue;
      const text = extractRowText(grid, r);
      const el = this.rowElements[r];
      if (el.textContent !== text) {
        el.textContent = text;
      }
    }
  }
}
