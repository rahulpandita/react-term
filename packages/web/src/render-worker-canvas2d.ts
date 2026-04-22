/**
 * Canvas2D render backend — runs inside the render worker.
 *
 * Reads cells from the SAB-backed CellGrid and paints them with the 2D
 * context on an OffscreenCanvas. Selection and cursor overlays are painted
 * per-row inside the dirty loop to avoid the alpha-stacking problem you'd
 * get by re-painting translucent rectangles every frame on top of clean rows.
 */

import type { Theme } from "@next_term/core";
import { normalizeSelection } from "@next_term/core";
import type { BackendInitOptions, RenderBackend, RenderFrame } from "./render-worker-backend.js";
import { build256Palette } from "./renderer.js";

const ATTR_BOLD = 0x01;
const ATTR_ITALIC = 0x02;
const ATTR_UNDERLINE = 0x04;
const ATTR_STRIKETHROUGH = 0x08;
const ATTR_INVERSE = 0x40;

export class Canvas2DBackend implements RenderBackend {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;

  private theme!: Theme;
  private palette: string[] = [];
  private fontSize = 14;
  private fontFamily = "monospace";
  private fontWeight = 400;
  private fontWeightBold = 700;
  private dpr = 1;
  private cellWidth = 0;
  private cellHeight = 0;
  private baselineOffset = 0;

  init(opts: BackendInitOptions): void {
    this.canvas = opts.canvas;
    this.theme = opts.theme;
    this.palette = build256Palette(opts.theme);
    this.fontSize = opts.fontSize;
    this.fontFamily = opts.fontFamily;
    this.fontWeight = opts.fontWeight;
    this.fontWeightBold = opts.fontWeightBold;
    this.dpr = opts.dpr;
    this.cellWidth = opts.cellWidth;
    this.cellHeight = opts.cellHeight;
    this.baselineOffset = opts.baselineOffset;

    const ctx = opts.canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2d context from OffscreenCanvas");
    this.ctx = ctx;

    this.syncCanvasSize(opts.cols, opts.rows, opts.cellWidth, opts.cellHeight, opts.dpr);
  }

  syncCanvasSize(
    cols: number,
    rows: number,
    cellWidth: number,
    cellHeight: number,
    dpr: number,
  ): void {
    if (!this.canvas || !this.ctx) return;
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.dpr = dpr;
    const width = cols * cellWidth;
    const height = rows * cellHeight;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    // Scale once so all drawing happens in CSS-pixel coordinates.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.palette = build256Palette(theme);
  }

  setFont(
    fontSize: number,
    fontFamily: string,
    fontWeight: number,
    fontWeightBold: number,
    dpr: number,
    cellWidth: number,
    cellHeight: number,
    baselineOffset: number,
  ): void {
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.fontWeight = fontWeight;
    this.fontWeightBold = fontWeightBold;
    this.dpr = dpr;
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.baselineOffset = baselineOffset;
  }

  render(frame: RenderFrame): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const {
      grid,
      cols,
      rows,
      cursorRow,
      cursorCol,
      cursorVisible,
      cursorStyle,
      selection,
      highlights,
    } = frame;
    const { cellWidth, cellHeight, baselineOffset, theme } = this;

    // Pre-compute the selection row range and whether the selection is empty.
    // Normalize so selections made bottom-up still render (otherwise endRow <
    // startRow and the whole range drops).
    let selStart = -1;
    let selEnd = -1;
    const normSel = selection ? normalizeSelection(selection) : null;
    if (normSel) {
      const sr = Math.max(0, normSel.startRow);
      const er = Math.min(rows - 1, normSel.endRow);
      const empty = sr === er && normSel.startCol === normSel.endCol;
      if (!empty && sr <= er) {
        selStart = sr;
        selEnd = er;
      }
    }

    for (let row = 0; row < rows; row++) {
      if (!grid.isDirty(row)) continue;

      const y = row * cellHeight;

      // Clear + paint the default background once for the whole row.
      ctx.clearRect(0, y, cols * cellWidth, cellHeight);
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, y, cols * cellWidth, cellHeight);

      for (let col = 0; col < cols; col++) {
        const x = col * cellWidth;

        if (grid.isSpacerCell(row, col)) continue;

        const codepoint = grid.getCodepoint(row, col);
        const fgIdx = grid.getFgIndex(row, col);
        const bgIdx = grid.getBgIndex(row, col);
        const attrs = grid.getAttrs(row, col);
        const fgIsRGB = grid.isFgRGB(row, col);
        const bgIsRGB = grid.isBgRGB(row, col);
        const wide = grid.isWide(row, col);

        const effWidth = wide ? cellWidth * 2 : cellWidth;

        let fg = this.resolveCellColor(fgIdx, fgIsRGB, grid.getFgRGB(row, col), true);
        let bg = this.resolveCellColor(bgIdx, bgIsRGB, grid.getBgRGB(row, col), false);

        if (attrs & ATTR_INVERSE) {
          const tmp = fg;
          fg = bg;
          bg = tmp;
        }

        if (bg !== theme.background) {
          ctx.fillStyle = bg;
          ctx.fillRect(x, y, effWidth, cellHeight);
        }

        if (codepoint > 0x20) {
          const bold = !!(attrs & ATTR_BOLD);
          const italic = !!(attrs & ATTR_ITALIC);
          ctx.font = this.buildFontString(bold, italic);
          ctx.fillStyle = fg;
          ctx.fillText(String.fromCodePoint(codepoint), x, y + baselineOffset);
        }

        if (attrs & ATTR_UNDERLINE) {
          const lineY = y + cellHeight - 1;
          ctx.strokeStyle = fg;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, lineY);
          ctx.lineTo(x + effWidth, lineY);
          ctx.stroke();
        }

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

      // Selection overlay for this row, painted once on a freshly-cleared row
      // so alpha does not stack across frames.
      if (normSel && row >= selStart && row <= selEnd) {
        let colStart: number;
        let colEnd: number;
        if (selStart === selEnd) {
          colStart = normSel.startCol;
          colEnd = normSel.endCol;
        } else if (row === selStart) {
          colStart = normSel.startCol;
          colEnd = cols - 1;
        } else if (row === selEnd) {
          colStart = 0;
          colEnd = normSel.endCol;
        } else {
          colStart = 0;
          colEnd = cols - 1;
        }
        ctx.fillStyle = theme.selectionBackground;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(colStart * cellWidth, y, (colEnd - colStart + 1) * cellWidth, cellHeight);
        ctx.globalAlpha = 1.0;
      }

      // Search-result highlights for this row. Painted on the freshly-cleared
      // row for the same alpha-stacking reason as selection above.
      if (highlights.length > 0) {
        for (const hl of highlights) {
          if (hl.row !== row) continue;
          ctx.fillStyle = hl.isCurrent ? "rgba(255, 165, 0, 0.5)" : "rgba(255, 255, 0, 0.3)";
          ctx.fillRect(
            hl.startCol * cellWidth,
            y,
            (hl.endCol - hl.startCol + 1) * cellWidth,
            cellHeight,
          );
        }
      }

      // Cursor for this row (cursor row is always marked dirty by the worker).
      if (cursorVisible && row === cursorRow) {
        const cx = cursorCol * cellWidth;
        ctx.fillStyle = theme.cursor;
        switch (cursorStyle) {
          case "block":
            ctx.globalAlpha = 0.5;
            ctx.fillRect(cx, y, cellWidth, cellHeight);
            ctx.globalAlpha = 1.0;
            break;
          case "underline": {
            const lineH = 2;
            ctx.fillRect(cx, y + cellHeight - lineH, cellWidth, lineH);
            break;
          }
          case "bar": {
            const barW = 2;
            ctx.fillRect(cx, y, barW, cellHeight);
            break;
          }
        }
      }

      grid.clearDirty(row);
    }
  }

  dispose(): void {
    this.canvas = null;
    this.ctx = null;
  }

  private buildFontString(bold: boolean, italic: boolean): string {
    let font = "";
    if (italic) font += "italic ";
    font += `${bold ? this.fontWeightBold : this.fontWeight} `;
    font += `${this.fontSize}px ${this.fontFamily}`;
    return font;
  }

  private resolveCellColor(
    colorIdx: number,
    isRGB: boolean,
    rgbValue: number,
    isForeground: boolean,
  ): string {
    if (isRGB) {
      const r = (rgbValue >> 16) & 0xff;
      const g = (rgbValue >> 8) & 0xff;
      const b = rgbValue & 0xff;
      return `rgb(${r},${g},${b})`;
    }
    if (isForeground && colorIdx === 7) return this.theme.foreground;
    if (!isForeground && colorIdx === 0) return this.theme.background;
    if (colorIdx >= 0 && colorIdx < 256) return this.palette[colorIdx];
    return isForeground ? this.theme.foreground : this.theme.background;
  }
}
