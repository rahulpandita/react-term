// Feature detection for SharedArrayBuffer
const SAB_AVAILABLE =
  typeof SharedArrayBuffer !== "undefined" &&
  (typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : true);

// Cell packing: 2 x Uint32 per cell
// Word 0: [0-20] codepoint, [21] fg-is-rgb, [22] bg-is-rgb, [23-30] fg-index, [31] dirty
// Word 1: [0-7] bg-index, [8] bold, [9] italic, [10] underline, [11] strikethrough,
//         [12-13] underline-style, [14] inverse, [15] wide, [16-31] reserved

export const CELL_SIZE = 2; // 2 x uint32 per cell

/** Default blank cell word0: space (0x20) + default fg index 7. */
export const DEFAULT_CELL_W0 = 0x20 | (7 << 23);
/** Default blank cell word1: bg index 0, no attrs. */
export const DEFAULT_CELL_W1 = 0;

/** Safe modulo that always returns a non-negative result (JS % preserves sign). */
export function modPositive(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}

export class CellGrid {
  readonly cols: number;
  readonly rows: number;
  readonly data: Uint32Array;
  readonly dirtyRows: Int32Array;
  readonly rgbColors: Uint32Array;
  private readonly buffer: SharedArrayBuffer | ArrayBuffer;
  readonly isShared: boolean;
  private readonly _templateRow: Uint32Array;

  /**
   * Cursor data stored in the SAB for cross-worker access.
   * Layout: [cursorRow, cursorCol, cursorVisible, cursorStyle]
   * cursorStyle: 0 = block, 1 = underline, 2 = bar
   */
  readonly cursorData: Int32Array;

  /**
   * Circular row buffer offset. Logical row r maps to physical row
   * (r + rowOffsetData[0]) % rows. Scrolling rotates this offset
   * instead of copying cell data, making full-screen scroll O(1).
   */
  readonly rowOffsetData: Int32Array;

  constructor(cols: number, rows: number, existingBuffer?: SharedArrayBuffer) {
    this.cols = cols;
    this.rows = rows;

    const cellBytes = cols * rows * CELL_SIZE * 4;
    const dirtyBytes = rows * 4; // Int32Array: 4 bytes per element
    const rgbBytes = 512 * 4;
    const cursorBytes = 4 * 4; // 4 x Int32: row, col, visible, style
    const offsetBytes = 1 * 4; // 1 x Int32: row offset for circular buffer

    if (existingBuffer) {
      // Create views over an existing SharedArrayBuffer (used by workers
      // to share the same memory as the main thread).
      this.buffer = existingBuffer;
      this.isShared = true;
    } else {
      const totalBytes = cellBytes + dirtyBytes + rgbBytes + cursorBytes + offsetBytes;
      const BufferType = SAB_AVAILABLE ? SharedArrayBuffer : ArrayBuffer;
      this.buffer = new BufferType(totalBytes);
      this.isShared = SAB_AVAILABLE;
    }

    this.data = new Uint32Array(this.buffer, 0, cols * rows * CELL_SIZE);
    this.dirtyRows = new Int32Array(this.buffer, cellBytes, rows);
    this.rgbColors = new Uint32Array(this.buffer, cellBytes + dirtyBytes, 512);
    this.cursorData = new Int32Array(this.buffer, cellBytes + dirtyBytes + rgbBytes, 4);
    this.rowOffsetData = new Int32Array(
      this.buffer,
      cellBytes + dirtyBytes + rgbBytes + cursorBytes,
      1,
    );

    // Build a template row: each cell is a space with default fg=7
    this._templateRow = new Uint32Array(cols * CELL_SIZE);
    for (let c = 0; c < cols; c++) {
      this._templateRow[c * CELL_SIZE] = DEFAULT_CELL_W0;
      // [c * CELL_SIZE + 1] is already DEFAULT_CELL_W1 (0)
    }

    // Only clear when creating a fresh buffer — an existing buffer
    // already contains valid data from the main thread.
    if (!existingBuffer) {
      this.clear();
    }
  }

  /** Map logical row to physical row in the circular buffer. */
  physicalRow(row: number): number {
    // row is in [0, rows) and rowOffsetData[0] is in [0, rows),
    // so sum is in [0, 2*rows) — branch is cheaper than modulo.
    const sum = row + this.rowOffsetData[0];
    return sum >= this.rows ? sum - this.rows : sum;
  }

  /** Get the data array offset for the start of a logical row. */
  rowStart(row: number): number {
    return this.physicalRow(row) * this.cols * CELL_SIZE;
  }

  /** Rotate the circular buffer up by n rows (for scroll-up). */
  rotateUp(n = 1): void {
    const v = this.rowOffsetData[0] + (n % this.rows);
    this.rowOffsetData[0] = v >= this.rows ? v - this.rows : v;
  }

  /** Rotate the circular buffer down by n rows (for scroll-down). */
  rotateDown(n = 1): void {
    const v = this.rowOffsetData[0] - (n % this.rows);
    this.rowOffsetData[0] = v < 0 ? v + this.rows : v;
  }

  getCodepoint(row: number, col: number): number {
    return this.data[this.rowStart(row) + col * CELL_SIZE] & 0x1fffff;
  }

  getFgIndex(row: number, col: number): number {
    return (this.data[this.rowStart(row) + col * CELL_SIZE] >>> 23) & 0xff;
  }

  getBgIndex(row: number, col: number): number {
    return this.data[this.rowStart(row) + col * CELL_SIZE + 1] & 0xff;
  }

  getAttrs(row: number, col: number): number {
    return (this.data[this.rowStart(row) + col * CELL_SIZE + 1] >>> 8) & 0xff;
  }

  isFgRGB(row: number, col: number): boolean {
    return (this.data[this.rowStart(row) + col * CELL_SIZE] & (1 << 21)) !== 0;
  }

  isBgRGB(row: number, col: number): boolean {
    return (this.data[this.rowStart(row) + col * CELL_SIZE] & (1 << 22)) !== 0;
  }

  isBold(row: number, col: number): boolean {
    return (this.data[this.rowStart(row) + col * CELL_SIZE + 1] & (1 << 8)) !== 0;
  }

  isItalic(row: number, col: number): boolean {
    return (this.data[this.rowStart(row) + col * CELL_SIZE + 1] & (1 << 9)) !== 0;
  }

  isUnderline(row: number, col: number): boolean {
    return (this.data[this.rowStart(row) + col * CELL_SIZE + 1] & (1 << 10)) !== 0;
  }

  isStrikethrough(row: number, col: number): boolean {
    return (this.data[this.rowStart(row) + col * CELL_SIZE + 1] & (1 << 11)) !== 0;
  }

  isInverse(row: number, col: number): boolean {
    return (this.data[this.rowStart(row) + col * CELL_SIZE + 1] & (1 << 14)) !== 0;
  }

  isWide(row: number, col: number): boolean {
    return (this.data[this.rowStart(row) + col * CELL_SIZE + 1] & (1 << 15)) !== 0;
  }

  setCell(
    row: number,
    col: number,
    codepoint: number,
    fgIndex: number,
    bgIndex: number,
    attrs: number,
    fgIsRGB = false,
    bgIsRGB = false,
  ): void {
    const idx = this.rowStart(row) + col * CELL_SIZE;
    this.data[idx] =
      (codepoint & 0x1fffff) |
      (fgIsRGB ? 1 << 21 : 0) |
      (bgIsRGB ? 1 << 22 : 0) |
      ((fgIndex & 0xff) << 23);
    this.data[idx + 1] = (bgIndex & 0xff) | ((attrs & 0xff) << 8);
    this.markDirty(row);
  }

  markDirty(row: number): void {
    if (this.isShared) {
      Atomics.store(this.dirtyRows, row, 1);
    } else {
      this.dirtyRows[row] = 1;
    }
  }

  /** Mark a contiguous range of rows [from..to] dirty. */
  markDirtyRange(from: number, to: number): void {
    // fill() is not atomic, but the trailing Atomics.store acts as a release
    // fence. Render workers that miss a flag will catch it on the next frame.
    this.dirtyRows.fill(1, from, to + 1);
    if (this.isShared) {
      Atomics.store(this.dirtyRows, to, 1);
    }
  }

  isDirty(row: number): boolean {
    if (this.isShared) {
      return Atomics.load(this.dirtyRows, row) !== 0;
    }
    return this.dirtyRows[row] !== 0;
  }

  clearDirty(row: number): void {
    if (this.isShared) {
      Atomics.store(this.dirtyRows, row, 0);
    } else {
      this.dirtyRows[row] = 0;
    }
  }

  markAllDirty(): void {
    this.dirtyRows.fill(1);
    if (this.isShared) {
      Atomics.store(this.dirtyRows, this.rows - 1, 1);
    }
  }

  clear(): void {
    this.rowOffsetData[0] = 0;
    for (let r = 0; r < this.rows; r++) {
      this.data.set(this._templateRow, r * this.cols * CELL_SIZE);
    }
    this.markAllDirty();
  }

  /** Copy a logical row of cell data into a new Uint32Array. */
  copyRow(row: number): Uint32Array {
    const start = this.rowStart(row);
    return new Uint32Array(this.data.slice(start, start + this.cols * CELL_SIZE));
  }

  /** Overwrite a logical row from a previously copied Uint32Array. */
  pasteRow(row: number, src: Uint32Array): void {
    const start = this.rowStart(row);
    const rowLen = this.cols * CELL_SIZE;
    if (src.length <= rowLen) {
      this.data.set(src, start);
    } else {
      // Source row is wider than this grid — only copy what fits
      this.data.set(src.subarray(0, rowLen), start);
    }
    this.markDirty(row);
  }

  /** Fill a logical row with spaces and default attributes. */
  clearRow(row: number): void {
    const start = this.rowStart(row);
    this.data.set(this._templateRow, start);
    this.markDirty(row);
  }

  /** Fill a logical row with defaults without marking dirty (caller will batch-mark). */
  clearRowRaw(row: number): void {
    this.data.set(this._templateRow, this.rowStart(row));
  }

  // ---- Cursor in SAB -------------------------------------------------------

  /** Style string to Int32 encoding for cursorData[3]. */
  private static readonly CURSOR_STYLE_MAP: Record<string, number> = {
    block: 0,
    underline: 1,
    bar: 2,
  };
  private static readonly CURSOR_STYLE_REVERSE = ["block", "underline", "bar"] as const;

  /**
   * Write cursor state into the SAB so render workers can read it atomically.
   */
  setCursor(row: number, col: number, visible: boolean, style: string): void {
    if (this.isShared) {
      Atomics.store(this.cursorData, 0, row);
      Atomics.store(this.cursorData, 1, col);
      Atomics.store(this.cursorData, 2, visible ? 1 : 0);
      Atomics.store(this.cursorData, 3, CellGrid.CURSOR_STYLE_MAP[style] ?? 0);
    } else {
      this.cursorData[0] = row;
      this.cursorData[1] = col;
      this.cursorData[2] = visible ? 1 : 0;
      this.cursorData[3] = CellGrid.CURSOR_STYLE_MAP[style] ?? 0;
    }
  }

  /**
   * Read cursor state from the SAB.
   */
  getCursor(): { row: number; col: number; visible: boolean; style: string } {
    if (this.isShared) {
      return {
        row: Atomics.load(this.cursorData, 0),
        col: Atomics.load(this.cursorData, 1),
        visible: Atomics.load(this.cursorData, 2) !== 0,
        style: CellGrid.CURSOR_STYLE_REVERSE[Atomics.load(this.cursorData, 3)] ?? "block",
      };
    }
    return {
      row: this.cursorData[0],
      col: this.cursorData[1],
      visible: this.cursorData[2] !== 0,
      style: CellGrid.CURSOR_STYLE_REVERSE[this.cursorData[3]] ?? "block",
    };
  }

  getBuffer(): SharedArrayBuffer | ArrayBuffer {
    return this.buffer;
  }
}

// ---------------------------------------------------------------------------
// Selection text extraction
// ---------------------------------------------------------------------------

export interface SelectionRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Normalize a selection so that start is before end.
 */
export function normalizeSelection(sel: SelectionRange): SelectionRange {
  let { startRow, startCol, endRow, endCol } = sel;
  if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
    const tmpR = startRow;
    const tmpC = startCol;
    startRow = endRow;
    startCol = endCol;
    endRow = tmpR;
    endCol = tmpC;
  }
  return { startRow, startCol, endRow, endCol };
}

/**
 * Extract text from a CellGrid for the given selection range.
 *
 * - Normalizes the selection (handles backwards selections).
 * - Trims trailing spaces from each line.
 * - Joins lines with `\n`.
 */
export function extractText(
  grid: CellGrid,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): string {
  const sel = normalizeSelection({ startRow, startCol, endRow, endCol });
  const sr = Math.max(0, sel.startRow);
  const er = Math.min(grid.rows - 1, sel.endRow);
  const lines: string[] = [];

  for (let row = sr; row <= er; row++) {
    let colStart = 0;
    let colEnd = grid.cols - 1;

    if (row === sr) colStart = Math.max(0, sel.startCol);
    if (row === er) colEnd = Math.min(grid.cols - 1, sel.endCol);

    let line = "";
    for (let col = colStart; col <= colEnd; col++) {
      const cp = grid.getCodepoint(row, col);
      line += cp > 0x20 ? String.fromCodePoint(cp) : " ";
    }

    // Trim trailing spaces
    lines.push(line.replace(/\s+$/, ""));
  }

  return lines.join("\n");
}
