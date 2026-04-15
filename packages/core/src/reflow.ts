import { CELL_SIZE, DEFAULT_CELL_W0, DEFAULT_CELL_W1 } from "./cell-grid.js";

export const MAX_LOGICAL_LINE_LEN = 4096;
const WIDE_BIT = 1 << 15; // Word 1 bit 15

export interface RowData {
  cells: Uint32Array;
  wrapped: boolean;
}

export interface ReflowResult {
  reflowed: RowData[];
  newCursorRow: number;
  newCursorCol: number;
}

/** Check if a cell at the given position is a default (empty) cell. */
function isDefaultCell(cells: Uint32Array, cellIndex: number): boolean {
  const offset = cellIndex * CELL_SIZE;
  return cells[offset] === DEFAULT_CELL_W0 && cells[offset + 1] === DEFAULT_CELL_W1;
}

/** Find the last non-default cell index + 1 (content length) in a row. */
function contentLength(cells: Uint32Array, cols: number): number {
  for (let i = cols - 1; i >= 0; i--) {
    if (!isDefaultCell(cells, i)) {
      return i + 1;
    }
  }
  return 0;
}

/** Safety cap on total output rows to prevent OOM when shrinking to very
 *  narrow widths (e.g., 200-col scrollback reflowed to 2 cols = 100× expansion). */
const MAX_OUTPUT_ROWS = 200_000;

export function reflowRows(
  rows: RowData[],
  oldCols: number,
  newCols: number,
  cursorAbsRow: number,
  cursorCol: number,
): ReflowResult {
  // Empty input
  if (rows.length === 0) {
    return { reflowed: [], newCursorRow: 0, newCursorCol: 0 };
  }

  // No change in width — return rows unchanged with cursor fixed
  if (newCols === oldCols) {
    const clampedRow = Math.min(cursorAbsRow, rows.length - 1);
    const rowCols = rows[clampedRow].cells.length / CELL_SIZE;
    const clampedCol = Math.min(cursorCol, rowCols - 1);
    return {
      reflowed: rows.map((r) => ({ cells: new Uint32Array(r.cells), wrapped: r.wrapped })),
      newCursorRow: clampedRow,
      newCursorCol: Math.max(0, clampedCol),
    };
  }

  // ---- Phase 1: JOIN — group physical rows into logical lines ----
  interface LogicalLine {
    cells: Uint32Array;
    length: number; // number of cells used
    cursorOffset: number; // cursor offset within this logical line, or -1
  }

  const logicalLines: LogicalLine[] = [];
  const currentCells = new Uint32Array(MAX_LOGICAL_LINE_LEN * CELL_SIZE);
  let currentLen = 0;
  let currentCursorOffset = -1;

  function flushLogicalLine(): void {
    // Copy only the used portion
    const trimmed = new Uint32Array(currentCells.buffer, 0, currentLen * CELL_SIZE).slice();
    logicalLines.push({
      cells: trimmed,
      length: currentLen,
      cursorOffset: currentCursorOffset,
    });
    currentLen = 0;
    currentCursorOffset = -1;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowCols = row.cells.length / CELL_SIZE;
    const isLastOfLogical = !row.wrapped;

    // Track cursor before appending
    if (i === cursorAbsRow) {
      currentCursorOffset = currentLen + cursorCol;
    }

    // Determine how many cells to append from this row
    let appendLen: number;
    if (isLastOfLogical) {
      // Last row of a logical line — trim trailing defaults
      appendLen = contentLength(row.cells, rowCols);
    } else {
      // Internal wrapped row — use full width (it wrapped because it was full)
      appendLen = rowCols;
    }

    // Check if appending would exceed MAX_LOGICAL_LINE_LEN
    if (currentLen + appendLen > MAX_LOGICAL_LINE_LEN) {
      // Append what we can
      const canFit = MAX_LOGICAL_LINE_LEN - currentLen;
      if (canFit > 0) {
        currentCells.set(row.cells.subarray(0, canFit * CELL_SIZE), currentLen * CELL_SIZE);
        currentLen += canFit;
      }
      flushLogicalLine();

      // Remainder goes into a new logical line
      const remainder = appendLen - canFit;
      if (remainder > 0) {
        currentCells.set(
          row.cells.subarray(canFit * CELL_SIZE, (canFit + remainder) * CELL_SIZE),
          0,
        );
        currentLen = remainder;
      }

      // Fix cursor offset if it was in this row and got split across
      // the MAX_LOGICAL_LINE_LEN boundary.
      if (i === cursorAbsRow) {
        if (cursorCol < canFit) {
          // Cursor landed in the flushed line — already captured by
          // flushLogicalLine() via currentCursorOffset (set at line 88).
          currentCursorOffset = -1;
        } else {
          // Cursor is in the remainder portion
          currentCursorOffset = cursorCol - canFit;
        }
      }

      if (isLastOfLogical) {
        flushLogicalLine();
      }
    } else {
      // Append cells
      if (appendLen > 0) {
        currentCells.set(row.cells.subarray(0, appendLen * CELL_SIZE), currentLen * CELL_SIZE);
        currentLen += appendLen;
      }

      if (isLastOfLogical) {
        flushLogicalLine();
      }
    }
  }

  // If there's a dangling logical line (shouldn't happen if last row has wrapped=false,
  // but handle defensively)
  if (currentLen > 0 || currentCursorOffset >= 0) {
    flushLogicalLine();
  }

  // ---- Phase 2 & 3: TRIM + SPLIT ----
  const result: RowData[] = [];
  let newCursorRow = 0;
  let newCursorCol = 0;

  for (const line of logicalLines) {
    // Phase 2 — find actual content length
    let lineContentLen = 0;
    for (let i = line.length - 1; i >= 0; i--) {
      if (!isDefaultCell(line.cells, i)) {
        lineContentLen = i + 1;
        break;
      }
    }

    // If empty line, emit one empty unwrapped row
    if (lineContentLen === 0) {
      const emptyCells = new Uint32Array(newCols * CELL_SIZE);
      for (let c = 0; c < newCols; c++) {
        emptyCells[c * CELL_SIZE] = DEFAULT_CELL_W0;
        emptyCells[c * CELL_SIZE + 1] = DEFAULT_CELL_W1;
      }
      if (line.cursorOffset >= 0) {
        newCursorRow = result.length;
        newCursorCol = Math.min(line.cursorOffset, newCols - 1);
      }
      result.push({ cells: emptyCells, wrapped: false });
      continue;
    }

    // Phase 3 — split into newCols-wide chunks
    let pos = 0;
    while (pos < lineContentLen && result.length < MAX_OUTPUT_ROWS) {
      let chunkEnd = Math.min(pos + newCols, lineContentLen);

      // Check for wide char at chunk boundary
      if (chunkEnd < lineContentLen && chunkEnd > pos) {
        // Check if the last cell of the chunk has the WIDE bit
        const lastCellIdx = chunkEnd - 1;
        const w1 = line.cells[lastCellIdx * CELL_SIZE + 1];
        if (w1 & WIDE_BIT) {
          // Don't split the wide char pair — reduce chunk by 1
          chunkEnd--;
        }
      }

      // Ensure we make progress (at minimum 1 cell per chunk)
      if (chunkEnd <= pos) {
        chunkEnd = pos + 1;
      }

      const chunkLen = chunkEnd - pos;
      const rowCells = new Uint32Array(newCols * CELL_SIZE);

      // Copy chunk cells
      rowCells.set(line.cells.subarray(pos * CELL_SIZE, chunkEnd * CELL_SIZE), 0);

      // Fill remaining cells with defaults
      for (let c = chunkLen; c < newCols; c++) {
        rowCells[c * CELL_SIZE] = DEFAULT_CELL_W0;
        rowCells[c * CELL_SIZE + 1] = DEFAULT_CELL_W1;
      }

      // Determine if this chunk is wrapped (all chunks except the last of the logical line)
      const isLastChunk = chunkEnd >= lineContentLen;

      // Cursor tracking
      if (line.cursorOffset >= 0) {
        if (line.cursorOffset >= pos && line.cursorOffset < chunkEnd) {
          newCursorRow = result.length;
          newCursorCol = line.cursorOffset - pos;
        } else if (isLastChunk && line.cursorOffset >= chunkEnd) {
          // Cursor past content — clamp to end of last row of its logical line
          newCursorRow = result.length;
          newCursorCol = Math.min(line.cursorOffset - pos, newCols - 1);
        }
      }

      result.push({ cells: rowCells, wrapped: !isLastChunk });
      pos = chunkEnd;
    }
  }

  return { reflowed: result, newCursorRow, newCursorCol };
}
