import { CELL_SIZE, CellGrid } from "./cell-grid.js";
import type { CursorState } from "./types.js";

export class Buffer {
  readonly grid: CellGrid;
  cursor: CursorState;
  scrollTop: number;
  scrollBottom: number;
  /** Default tab-stop interval. */
  private readonly tabWidth = 8;
  /** Custom tab stops (column indices). */
  tabStops: Set<number>;

  // Saved cursor for DECSC / DECRC
  private savedCursor: CursorState | null = null;

  constructor(
    public readonly cols: number,
    public readonly rows: number,
    existingGrid?: CellGrid,
  ) {
    this.grid = existingGrid ?? new CellGrid(cols, rows);
    this.cursor = { row: 0, col: 0, visible: true, style: "block", wrapPending: false };
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    this.tabStops = new Set<number>();
    this.resetTabStops();
  }

  private resetTabStops(): void {
    this.tabStops.clear();
    for (let c = this.tabWidth; c < this.cols; c += this.tabWidth) {
      this.tabStops.add(c);
    }
  }

  nextTabStop(col: number): number {
    for (let c = col + 1; c < this.cols; c++) {
      if (this.tabStops.has(c)) return c;
    }
    return this.cols - 1;
  }

  prevTabStop(col: number): number {
    for (let c = col - 1; c >= 0; c--) {
      if (this.tabStops.has(c)) return c;
    }
    return 0;
  }

  saveCursor(): void {
    this.savedCursor = { ...this.cursor };
  }

  restoreCursor(): void {
    if (this.savedCursor) {
      this.cursor = { ...this.savedCursor };
    }
  }

  /** Scroll the scroll region up by one line. */
  scrollUp(): void {
    if (this.scrollTop === 0 && this.scrollBottom === this.rows - 1) {
      // Full-screen scroll: O(1) rotation instead of O(rows×cols) copy
      this.grid.rotateUp();
      this.grid.clearRowRaw(this.scrollBottom);
      this.grid.markDirtyRange(this.scrollTop, this.scrollBottom);
    } else {
      // Partial scroll region: shift rows up using copyWithin on physical offsets
      const rowSize = this.cols * CELL_SIZE;
      for (let r = this.scrollTop; r < this.scrollBottom; r++) {
        const dst = this.grid.rowStart(r);
        const src = this.grid.rowStart(r + 1);
        this.grid.data.copyWithin(dst, src, src + rowSize);
      }
      this.grid.clearRowRaw(this.scrollBottom);
      this.grid.markDirtyRange(this.scrollTop, this.scrollBottom);
    }
  }

  /**
   * Scroll the scroll region down by one line.
   */
  scrollDown(): void {
    if (this.scrollTop === 0 && this.scrollBottom === this.rows - 1) {
      // Full-screen scroll: O(1) rotation
      this.grid.rotateDown();
      this.grid.clearRowRaw(this.scrollTop);
      this.grid.markDirtyRange(this.scrollTop, this.scrollBottom);
    } else {
      // Partial scroll region: shift rows down using copyWithin on physical offsets
      const rowSize = this.cols * CELL_SIZE;
      for (let r = this.scrollBottom; r > this.scrollTop; r--) {
        const dst = this.grid.rowStart(r);
        const src = this.grid.rowStart(r - 1);
        this.grid.data.copyWithin(dst, src, src + rowSize);
      }
      this.grid.clearRowRaw(this.scrollTop);
      this.grid.markDirtyRange(this.scrollTop, this.scrollBottom);
    }
  }
}

export class BufferSet {
  normal: Buffer;
  alternate: Buffer;
  active: Buffer;

  /** Scrollback lines for the normal buffer (array of Uint32Array). */
  scrollback: Uint32Array[];
  readonly maxScrollback: number;

  constructor(
    public readonly cols: number,
    public readonly rows: number,
    maxScrollback = 5000,
    sharedBuffer?: SharedArrayBuffer,
    sharedAltBuffer?: SharedArrayBuffer,
  ) {
    this.normal = sharedBuffer
      ? new Buffer(cols, rows, new CellGrid(cols, rows, sharedBuffer))
      : new Buffer(cols, rows);
    this.alternate = sharedAltBuffer
      ? new Buffer(cols, rows, new CellGrid(cols, rows, sharedAltBuffer))
      : new Buffer(cols, rows);
    this.active = this.normal;
    this.scrollback = [];
    this.maxScrollback = maxScrollback;
  }

  get isAlternate(): boolean {
    return this.active === this.alternate;
  }

  activateAlternate(): void {
    if (this.active === this.alternate) return;
    this.active = this.alternate;
    this.alternate.grid.clear();
    this.alternate.cursor = { row: 0, col: 0, visible: true, style: "block", wrapPending: false };
    this.alternate.scrollTop = 0;
    this.alternate.scrollBottom = this.rows - 1;
  }

  activateNormal(): void {
    if (this.active === this.normal) return;
    this.active = this.normal;
  }

  /**
   * Push a line into scrollback (for the normal buffer).
   *
   * IMPORTANT: push() must happen before shift() — borrowRowBuffer()
   * returns scrollback[0] which the caller fills before calling this.
   * Reversing the order would evict the buffer before it's appended.
   */
  pushScrollback(line: Uint32Array): void {
    this.scrollback.push(line);
    if (this.scrollback.length > this.maxScrollback) {
      this.scrollback.shift();
    }
  }

  /**
   * Get a reusable row buffer or allocate a new one.
   * Reuses the buffer that's about to be evicted from scrollback.
   */
  borrowRowBuffer(size: number): Uint32Array {
    if (this.scrollback.length >= this.maxScrollback && this.maxScrollback > 0) {
      const existing = this.scrollback[0];
      if (existing && existing.length >= size) {
        return existing;
      }
    }
    return new Uint32Array(size);
  }

  /** Scroll the active buffer up, pushing the top line into scrollback if normal buffer. */
  scrollUpWithHistory(): void {
    if (this.maxScrollback > 0 && this.active === this.normal && this.active.scrollTop === 0) {
      const grid = this.active.grid;
      const rowSize = grid.cols * CELL_SIZE + grid.cols * 2;
      const dest = this.borrowRowBuffer(rowSize);
      grid.copyRowInto(0, dest);
      this.pushScrollback(dest);
    }
    this.active.scrollUp();
  }
}
