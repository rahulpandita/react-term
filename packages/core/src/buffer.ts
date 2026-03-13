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
  ) {
    this.grid = new CellGrid(cols, rows);
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

  /** Scroll the scroll region up by one line using copyWithin (zero-alloc). */
  scrollUp(): void {
    const rowSize = this.cols * CELL_SIZE;
    const dstStart = this.scrollTop * rowSize;
    const srcStart = (this.scrollTop + 1) * rowSize;
    const srcEnd = (this.scrollBottom + 1) * rowSize;
    this.grid.data.copyWithin(dstStart, srcStart, srcEnd);
    this.grid.clearRow(this.scrollBottom);
    this.grid.markDirtyRange(this.scrollTop, this.scrollBottom);
  }

  /**
   * Scroll the scroll region down by one line using copyWithin (zero-alloc).
   * copyWithin handles overlapping src/dst correctly (copies as if via a
   * temporary buffer), so shifting rows down by one is safe.
   */
  scrollDown(): void {
    const rowSize = this.cols * CELL_SIZE;
    const srcStart = this.scrollTop * rowSize;
    const srcEnd = this.scrollBottom * rowSize;
    const dstStart = (this.scrollTop + 1) * rowSize;
    this.grid.data.copyWithin(dstStart, srcStart, srcEnd);
    this.grid.clearRow(this.scrollTop);
    this.grid.markDirtyRange(this.scrollTop, this.scrollBottom);
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
  ) {
    this.normal = new Buffer(cols, rows);
    this.alternate = new Buffer(cols, rows);
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

  /** Push a line into scrollback (for the normal buffer). */
  pushScrollback(line: Uint32Array): void {
    this.scrollback.push(line);
    while (this.scrollback.length > this.maxScrollback) {
      this.scrollback.shift();
    }
  }

  /** Scroll the active buffer up, pushing the top line into scrollback if normal buffer. */
  scrollUpWithHistory(): void {
    if (this.maxScrollback > 0 && this.active === this.normal && this.active.scrollTop === 0) {
      this.pushScrollback(this.active.grid.copyRow(0));
    }
    this.active.scrollUp();
  }
}
