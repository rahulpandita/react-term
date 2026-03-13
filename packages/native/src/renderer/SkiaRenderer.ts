/**
 * Skia-based renderer for React Native (JS fallback).
 *
 * Instead of directly rendering pixels, this class generates a declarative
 * list of `RenderCommand` objects that a @shopify/react-native-skia Canvas
 * component can consume. This keeps all rendering logic testable without
 * native dependencies.
 *
 * The command list is designed to be consumed in a single pass by a Skia
 * Canvas `onDraw` callback or by mapping commands to Skia React components.
 */

import type { CursorState, SelectionRange, Theme } from "@react-term/core";
import { type CellGrid, DEFAULT_THEME, normalizeSelection } from "@react-term/core";

// ---------------------------------------------------------------------------
// Render command types
// ---------------------------------------------------------------------------

export interface RenderCommand {
  type: "rect" | "text" | "line";
  x: number;
  y: number;
  width?: number;
  height?: number;
  color: string;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  /** Opacity override (0-1). Used for selection overlay and cursor. */
  opacity?: number;
}

// ---------------------------------------------------------------------------
// 256-color palette builder (shared with web renderer)
// ---------------------------------------------------------------------------

function build256Palette(theme: Theme): string[] {
  const palette: string[] = new Array(256);

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

  // 16-231: 6x6x6 color cube
  const cubeLevels = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        palette[16 + r * 36 + g * 6 + b] =
          `rgb(${cubeLevels[r]},${cubeLevels[g]},${cubeLevels[b]})`;
      }
    }
  }

  // 232-255: grayscale ramp
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    palette[232 + i] = `rgb(${v},${v},${v})`;
  }

  return palette;
}

// Attribute bit positions (matching core's packed attrs byte)
const ATTR_BOLD = 0x01;
const ATTR_ITALIC = 0x02;
const ATTR_UNDERLINE = 0x04;
const ATTR_STRIKETHROUGH = 0x08;
const ATTR_INVERSE = 0x40;

// ---------------------------------------------------------------------------
// SkiaRenderer
// ---------------------------------------------------------------------------

export class SkiaRenderer {
  private cellWidth: number;
  private cellHeight: number;
  private fontSize: number;
  private fontFamily: string;
  private theme: Theme;
  private palette: string[];

  constructor(options: { fontSize: number; fontFamily: string; theme?: Theme }) {
    this.fontSize = options.fontSize;
    this.fontFamily = options.fontFamily;
    this.theme = options.theme ?? DEFAULT_THEME;
    this.palette = build256Palette(this.theme);

    // Estimate cell size from font metrics (no canvas measurement in RN)
    this.cellWidth = Math.ceil(this.fontSize * 0.6);
    this.cellHeight = Math.ceil(this.fontSize * 1.2);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Generate render commands for the visible grid.
   *
   * This produces a flat list of drawing commands that a Skia Canvas can
   * execute in order. The order is: backgrounds, text, decorations,
   * selection overlay, cursor.
   */
  renderFrame(
    grid: CellGrid,
    cursor: CursorState,
    selection: SelectionRange | null,
  ): RenderCommand[] {
    const commands: RenderCommand[] = [];
    const { cols, rows } = grid;
    const { cellWidth, cellHeight, fontSize, fontFamily, theme } = this;

    // -- Row backgrounds & cell content -----------------------------------
    for (let row = 0; row < rows; row++) {
      // Full-row background
      commands.push({
        type: "rect",
        x: 0,
        y: row * cellHeight,
        width: cols * cellWidth,
        height: cellHeight,
        color: theme.background,
      });

      for (let col = 0; col < cols; col++) {
        const x = col * cellWidth;
        const y = row * cellHeight;

        const codepoint = grid.getCodepoint(row, col);
        const fgIdx = grid.getFgIndex(row, col);
        const bgIdx = grid.getBgIndex(row, col);
        const attrs = grid.getAttrs(row, col);
        const fgIsRGB = grid.isFgRGB(row, col);
        const bgIsRGB = grid.isBgRGB(row, col);

        let fg = this.resolveColor(fgIdx, fgIsRGB, grid, col, true);
        let bg = this.resolveColor(bgIdx, bgIsRGB, grid, col, false);

        // Handle inverse attribute
        if (attrs & ATTR_INVERSE) {
          const tmp = fg;
          fg = bg;
          bg = tmp;
        }

        // Cell background (only if non-default)
        if (bg !== theme.background) {
          commands.push({
            type: "rect",
            x,
            y,
            width: cellWidth,
            height: cellHeight,
            color: bg,
          });
        }

        // Character
        const ch = codepoint > 0x20 ? String.fromCodePoint(codepoint) : null;
        if (ch) {
          const bold = !!(attrs & ATTR_BOLD);
          const italic = !!(attrs & ATTR_ITALIC);
          commands.push({
            type: "text",
            x,
            y: y + Math.ceil(fontSize), // baseline offset
            color: fg,
            text: ch,
            fontSize,
            fontFamily,
            bold,
            italic,
          });
        }

        // Underline
        if (attrs & ATTR_UNDERLINE) {
          commands.push({
            type: "line",
            x,
            y: y + cellHeight - 1,
            width: cellWidth,
            height: 1,
            color: fg,
          });
        }

        // Strikethrough
        if (attrs & ATTR_STRIKETHROUGH) {
          commands.push({
            type: "line",
            x,
            y: y + Math.floor(cellHeight / 2),
            width: cellWidth,
            height: 1,
            color: fg,
          });
        }
      }
    }

    // -- Selection overlay ------------------------------------------------
    if (selection) {
      const sel = normalizeSelection(selection);
      const sr = Math.max(0, sel.startRow);
      const er = Math.min(rows - 1, sel.endRow);

      if (!(sr === er && sel.startCol === sel.endCol)) {
        for (let row = sr; row <= er; row++) {
          let colStart: number;
          let colEnd: number;

          if (sr === er) {
            colStart = sel.startCol;
            colEnd = sel.endCol;
          } else if (row === sr) {
            colStart = sel.startCol;
            colEnd = cols - 1;
          } else if (row === er) {
            colStart = 0;
            colEnd = sel.endCol;
          } else {
            colStart = 0;
            colEnd = cols - 1;
          }

          commands.push({
            type: "rect",
            x: colStart * cellWidth,
            y: row * cellHeight,
            width: (colEnd - colStart + 1) * cellWidth,
            height: cellHeight,
            color: theme.selectionBackground,
            opacity: 0.5,
          });
        }
      }
    }

    // -- Cursor -----------------------------------------------------------
    if (cursor.visible) {
      const cx = cursor.col * cellWidth;
      const cy = cursor.row * cellHeight;

      switch (cursor.style) {
        case "block":
          commands.push({
            type: "rect",
            x: cx,
            y: cy,
            width: cellWidth,
            height: cellHeight,
            color: theme.cursor,
            opacity: 0.5,
          });
          break;

        case "underline":
          commands.push({
            type: "rect",
            x: cx,
            y: cy + cellHeight - 2,
            width: cellWidth,
            height: 2,
            color: theme.cursor,
          });
          break;

        case "bar":
          commands.push({
            type: "rect",
            x: cx,
            y: cy,
            width: 2,
            height: cellHeight,
            color: theme.cursor,
          });
          break;
      }
    }

    return commands;
  }

  getCellSize(): { width: number; height: number } {
    return { width: this.cellWidth, height: this.cellHeight };
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.palette = build256Palette(theme);
  }

  setFont(fontSize: number, fontFamily: string): void {
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.cellWidth = Math.ceil(fontSize * 0.6);
    this.cellHeight = Math.ceil(fontSize * 1.2);
  }

  // -----------------------------------------------------------------------
  // Color resolution
  // -----------------------------------------------------------------------

  private resolveColor(
    colorIdx: number,
    isRGB: boolean,
    grid: CellGrid,
    col: number,
    isForeground: boolean,
  ): string {
    if (isRGB) {
      const offset = isForeground ? col : 256 + col;
      const rgb = grid.rgbColors[offset];
      const r = (rgb >> 16) & 0xff;
      const g = (rgb >> 8) & 0xff;
      const b = rgb & 0xff;
      return `rgb(${r},${g},${b})`;
    }

    // Default colors
    if (isForeground && colorIdx === 7) return this.theme.foreground;
    if (!isForeground && colorIdx === 0) return this.theme.background;

    if (colorIdx >= 0 && colorIdx < 256) {
      return this.palette[colorIdx];
    }

    return isForeground ? this.theme.foreground : this.theme.background;
  }
}
