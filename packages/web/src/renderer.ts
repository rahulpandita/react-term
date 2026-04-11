import type { CursorState, SelectionRange, Theme } from "@next_term/core";
import { type CellGrid, DEFAULT_THEME, normalizeSelection } from "@next_term/core";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RendererOptions {
  fontSize: number;
  fontFamily: string;
  theme: Theme;
  devicePixelRatio?: number;
  /** CSS font-weight for normal text (default: 400). */
  fontWeight?: number;
  /** CSS font-weight for bold text (default: 700). */
  fontWeightBold?: number;
}

export interface HighlightRange {
  row: number;
  startCol: number;
  endCol: number;
  isCurrent: boolean;
}

export interface IRenderer {
  attach(canvas: HTMLCanvasElement, grid: CellGrid, cursor: CursorState): void;
  render(): void;
  resize(cols: number, rows: number): void;
  setTheme(theme: Theme): void;
  setSelection(selection: SelectionRange | null): void;
  setHighlights(highlights: HighlightRange[]): void;
  getCellSize(): { width: number; height: number };
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 256-color palette builder
// ---------------------------------------------------------------------------

/**
 * Build the full 256-color palette.
 *
 *   0-15   : theme ANSI colors
 *  16-231  : 6x6x6 color cube
 * 232-255  : grayscale ramp
 */
export function build256Palette(theme: Theme): string[] {
  const palette: string[] = new Array(256);

  // 0-15 from theme — map named colors to indexed positions
  const themeColors = [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ];
  for (let i = 0; i < 16; i++) {
    palette[i] = themeColors[i];
  }

  // 16-231: 6x6x6 color cube (hex format to hit hexToFloat4 fast path)
  const cubeLevels = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  const hex2 = (n: number) => n.toString(16).padStart(2, "0");
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        const idx = 16 + r * 36 + g * 6 + b;
        palette[idx] = `#${hex2(cubeLevels[r])}${hex2(cubeLevels[g])}${hex2(cubeLevels[b])}`;
      }
    }
  }

  // 232-255: grayscale ramp (8, 18, 28, ..., 238)
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    palette[232 + i] = `#${hex2(v)}${hex2(v)}${hex2(v)}`;
  }

  return palette;
}

// Attribute bit positions in core's attrs byte
const ATTR_BOLD = 0x01;
const ATTR_ITALIC = 0x02;
const ATTR_UNDERLINE = 0x04;
const ATTR_STRIKETHROUGH = 0x08;
const ATTR_INVERSE = 0x40;

// ---------------------------------------------------------------------------
// Canvas 2D Renderer
// ---------------------------------------------------------------------------

export class Canvas2DRenderer implements IRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private grid: CellGrid | null = null;
  private cursor: CursorState | null = null;

  private cellWidth = 0;
  private cellHeight = 0;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read via destructuring in render()
  private baselineOffset = 0;

  private fontSize: number;
  private fontFamily: string;
  private fontWeight: number;
  private fontWeightBold: number;
  private theme: Theme;
  private dpr: number;
  private palette: string[];

  private selection: SelectionRange | null = null;
  private highlights: HighlightRange[] = [];

  // Track previous cursor position to redraw the old cell when cursor moves
  private prevCursorRow = -1;
  private prevCursorCol = -1;

  private rafId: number | null = null;
  private disposed = false;

  constructor(options: RendererOptions) {
    this.fontSize = options.fontSize;
    this.fontFamily = options.fontFamily;
    this.fontWeight = options.fontWeight ?? 400;
    this.fontWeightBold = options.fontWeightBold ?? 700;
    this.theme = options.theme ?? DEFAULT_THEME;
    this.dpr =
      options.devicePixelRatio ?? (typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    this.palette = build256Palette(this.theme);
    this.measureCellSize();
  }

  // -----------------------------------------------------------------------
  // IRenderer
  // -----------------------------------------------------------------------

  attach(canvas: HTMLCanvasElement, grid: CellGrid, cursor: CursorState): void {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2d context");
    this.ctx = ctx;
    this.grid = grid;
    this.cursor = cursor;

    this.syncCanvasSize();
    grid.markAllDirty();
  }

  render(): void {
    if (this.disposed || !this.ctx || !this.grid || !this.cursor) return;

    const { ctx, grid, cellWidth, cellHeight, baselineOffset } = this;
    const cols = grid.cols;
    const rows = grid.rows;

    // If the cursor moved rows, mark the old row dirty so the cursor ghost is erased
    const curRow = this.cursor.row;
    const curCol = this.cursor.col;
    if (
      this.prevCursorRow >= 0 &&
      this.prevCursorRow < rows &&
      (this.prevCursorRow !== curRow || this.prevCursorCol !== curCol)
    ) {
      grid.markDirty(this.prevCursorRow);
    }
    // Also mark the current cursor row dirty so the cursor is drawn fresh
    if (curRow >= 0 && curRow < rows) {
      grid.markDirty(curRow);
    }
    this.prevCursorRow = curRow;
    this.prevCursorCol = curCol;

    for (let row = 0; row < rows; row++) {
      if (!grid.isDirty(row)) continue;

      // Clear the row (coordinates in CSS pixels — DPR handled by ctx transform)
      const y = row * cellHeight;
      ctx.clearRect(0, y, cols * cellWidth, cellHeight);

      // Draw default background for the whole row
      ctx.fillStyle = this.theme.background;
      ctx.fillRect(0, y, cols * cellWidth, cellHeight);

      for (let col = 0; col < cols; col++) {
        const x = col * cellWidth;

        // Read cell data from core's packed CellGrid
        const codepoint = grid.getCodepoint(row, col);
        const fgIdx = grid.getFgIndex(row, col);
        const bgIdx = grid.getBgIndex(row, col);
        const attrs = grid.getAttrs(row, col);
        const fgIsRGB = grid.isFgRGB(row, col);
        const bgIsRGB = grid.isBgRGB(row, col);
        const wide = grid.isWide(row, col);

        // Skip spacer cells (right half of wide character, codepoint 0)
        if (grid.isSpacerCell(row, col)) {
          continue;
        }

        // Effective cell width (wide chars span 2 columns)
        const effWidth = wide ? cellWidth * 2 : cellWidth;

        // Resolve colors
        let fg = this.resolveCellColor(fgIdx, fgIsRGB, grid, col, true);
        let bg = this.resolveCellColor(bgIdx, bgIsRGB, grid, col, false);

        // Handle inverse
        if (attrs & ATTR_INVERSE) {
          const tmp = fg;
          fg = bg;
          bg = tmp;
        }

        // Draw background if not the default bg
        if (bg !== this.theme.background) {
          ctx.fillStyle = bg;
          ctx.fillRect(x, y, effWidth, cellHeight);
        }

        // Draw character
        const ch = codepoint > 0x20 ? String.fromCodePoint(codepoint) : null;
        if (ch) {
          const bold = !!(attrs & ATTR_BOLD);
          const italic = !!(attrs & ATTR_ITALIC);
          ctx.font = this.buildFontString(bold, italic);
          ctx.fillStyle = fg;
          ctx.fillText(ch, x, y + baselineOffset);
        }

        // Underline
        if (attrs & ATTR_UNDERLINE) {
          const lineY = y + cellHeight - 1;
          ctx.strokeStyle = fg;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, lineY);
          ctx.lineTo(x + effWidth, lineY);
          ctx.stroke();
        }

        // Strikethrough
        if (attrs & ATTR_STRIKETHROUGH) {
          const lineY = y + cellHeight / 2;
          ctx.strokeStyle = fg;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, lineY);
          ctx.lineTo(x + effWidth, lineY);
          ctx.stroke();
        }
      }

      grid.clearDirty(row);
    }

    // Draw highlights (search results)
    this.drawHighlights();

    // Draw selection overlay
    this.drawSelection();

    // Draw cursor
    this.drawCursor();
  }

  resize(_cols: number, _rows: number): void {
    if (!this.canvas || !this.grid) return;
    this.syncCanvasSize();
    this.grid.markAllDirty();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.palette = build256Palette(theme);
    if (this.grid) {
      this.grid.markAllDirty();
    }
  }

  setSelection(selection: SelectionRange | null): void {
    this.selection = selection;
    if (this.grid) {
      this.grid.markAllDirty();
    }
  }

  setHighlights(highlights: HighlightRange[]): void {
    this.highlights = highlights;
    if (this.grid) {
      this.grid.markAllDirty();
    }
  }

  setFont(
    fontSize: number,
    fontFamily: string,
    fontWeight?: number,
    fontWeightBold?: number,
  ): void {
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    if (fontWeight !== undefined) this.fontWeight = fontWeight;
    if (fontWeightBold !== undefined) this.fontWeightBold = fontWeightBold;
    this.measureCellSize();
    if (this.grid) {
      this.syncCanvasSize();
      this.grid.markAllDirty();
    }
  }

  getCellSize(): { width: number; height: number } {
    return { width: this.cellWidth, height: this.cellHeight };
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.canvas = null;
    this.ctx = null;
    this.grid = null;
    this.cursor = null;
  }

  // -----------------------------------------------------------------------
  // Render loop
  // -----------------------------------------------------------------------

  startRenderLoop(): void {
    if (this.disposed) return;
    const loop = () => {
      if (this.disposed) return;
      this.render();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stopRenderLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private measureCellSize(): void {
    // Use an offscreen canvas to measure a monospace character
    const offscreen =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(100, 100)
        : /* istanbul ignore next */ null;

    let measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

    if (offscreen) {
      measureCtx = offscreen.getContext("2d");
    } else if (typeof document !== "undefined") {
      const tmpCanvas = document.createElement("canvas");
      tmpCanvas.width = 100;
      tmpCanvas.height = 100;
      measureCtx = tmpCanvas.getContext("2d");
    }

    if (!measureCtx) {
      // Fallback for environments without canvas (e.g. unit tests)
      this.cellWidth = Math.ceil(this.fontSize * 0.6);
      this.cellHeight = Math.ceil(this.fontSize * 1.2);
      this.baselineOffset = Math.ceil(this.fontSize);
      return;
    }

    measureCtx.font = this.buildFontString(false, false);
    const metrics = measureCtx.measureText("M");

    this.cellWidth = Math.ceil(metrics.width);
    // Use fontBoundingBoxAscent/Descent when available; fall back to heuristic.
    if (
      typeof metrics.fontBoundingBoxAscent === "number" &&
      typeof metrics.fontBoundingBoxDescent === "number"
    ) {
      const ascent = metrics.fontBoundingBoxAscent;
      const descent = metrics.fontBoundingBoxDescent;
      this.cellHeight = Math.ceil(ascent + descent);
      this.baselineOffset = Math.ceil(ascent);
    } else {
      this.cellHeight = Math.ceil(this.fontSize * 1.2);
      this.baselineOffset = Math.ceil(this.fontSize);
    }

    // Sanity
    if (this.cellWidth <= 0) this.cellWidth = Math.ceil(this.fontSize * 0.6);
    if (this.cellHeight <= 0) this.cellHeight = Math.ceil(this.fontSize * 1.2);
  }

  private syncCanvasSize(): void {
    if (!this.canvas || !this.grid) return;
    const { cols, rows } = this.grid;
    const width = cols * this.cellWidth;
    const height = rows * this.cellHeight;

    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    if (this.ctx) {
      // Scale context by DPR so all drawing uses CSS pixel coordinates.
      // The font size, cell dimensions, etc. are all in CSS pixels —
      // the DPR transform handles the physical pixel mapping.
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
  }

  private buildFontString(bold: boolean, italic: boolean): string {
    let font = "";
    if (italic) font += "italic ";
    font += `${bold ? this.fontWeightBold : this.fontWeight} `;
    font += `${this.fontSize}px ${this.fontFamily}`;
    return font;
  }

  /**
   * Resolve a cell's color index to a CSS color string.
   *
   * For indexed colors (fgIsRGB/bgIsRGB = false), colorIdx is the 256-color
   * palette index. Default foreground is index 7, default background is 0.
   *
   * For RGB colors, the actual RGB value is stored in grid.rgbColors.
   */
  private resolveCellColor(
    colorIdx: number,
    isRGB: boolean,
    grid: CellGrid,
    col: number,
    isForeground: boolean,
  ): string {
    if (isRGB) {
      // Look up full RGB from the rgbColors table
      const offset = isForeground ? col : 256 + col;
      const rgb = grid.rgbColors[offset];
      const r = (rgb >> 16) & 0xff;
      const g = (rgb >> 8) & 0xff;
      const b = rgb & 0xff;
      return `rgb(${r},${g},${b})`;
    }

    // Default colors: fg=7 means theme foreground, bg=0 means theme background
    if (isForeground && colorIdx === 7) return this.theme.foreground;
    if (!isForeground && colorIdx === 0) return this.theme.background;

    // Indexed 0-255
    if (colorIdx >= 0 && colorIdx < 256) {
      return this.palette[colorIdx];
    }

    return isForeground ? this.theme.foreground : this.theme.background;
  }

  private drawHighlights(): void {
    if (!this.ctx || !this.highlights.length) return;

    const { ctx, cellWidth, cellHeight } = this;

    for (const hl of this.highlights) {
      const x = hl.startCol * cellWidth;
      const y = hl.row * cellHeight;
      const w = (hl.endCol - hl.startCol + 1) * cellWidth;
      const h = cellHeight;

      if (hl.isCurrent) {
        // Current match: orange highlight
        ctx.fillStyle = "rgba(255, 165, 0, 0.5)";
      } else {
        // Other matches: semi-transparent yellow
        ctx.fillStyle = "rgba(255, 255, 0, 0.3)";
      }

      ctx.fillRect(x, y, w, h);
    }
  }

  private drawSelection(): void {
    if (!this.ctx || !this.grid || !this.selection) return;

    const { ctx, grid, cellWidth, cellHeight } = this;
    const sel = normalizeSelection(this.selection);

    const sr = Math.max(0, sel.startRow);
    const er = Math.min(grid.rows - 1, sel.endRow);

    // Skip if selection is empty (same cell)
    if (sr === er && sel.startCol === sel.endCol) return;

    ctx.fillStyle = this.theme.selectionBackground;
    ctx.globalAlpha = 0.5;

    for (let row = sr; row <= er; row++) {
      let colStart: number;
      let colEnd: number;

      if (sr === er) {
        // Single row selection
        colStart = sel.startCol;
        colEnd = sel.endCol;
      } else if (row === sr) {
        colStart = sel.startCol;
        colEnd = grid.cols - 1;
      } else if (row === er) {
        colStart = 0;
        colEnd = sel.endCol;
      } else {
        colStart = 0;
        colEnd = grid.cols - 1;
      }

      const x = colStart * cellWidth;
      const y = row * cellHeight;
      const w = (colEnd - colStart + 1) * cellWidth;
      const h = cellHeight;

      ctx.fillRect(x, y, w, h);
    }

    ctx.globalAlpha = 1.0;
  }

  private drawCursor(): void {
    if (!this.ctx || !this.cursor) return;
    const cursor = this.cursor;
    if (!cursor.visible) return;

    const { cellWidth, cellHeight } = this;
    const x = cursor.col * cellWidth;
    const y = cursor.row * cellHeight;

    this.ctx.fillStyle = this.theme.cursor;

    switch (cursor.style) {
      case "block":
        this.ctx.globalAlpha = 0.5;
        this.ctx.fillRect(x, y, cellWidth, cellHeight);
        this.ctx.globalAlpha = 1.0;
        break;

      case "underline": {
        const lineH = 2;
        this.ctx.fillRect(x, y + cellHeight - lineH, cellWidth, lineH);
        break;
      }

      case "bar": {
        const barW = 2;
        this.ctx.fillRect(x, y, barW, cellHeight);
        break;
      }
    }
  }
}
