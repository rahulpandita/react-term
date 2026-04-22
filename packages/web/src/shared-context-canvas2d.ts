/**
 * SharedCanvas2DContext — one Canvas2D context rendering N terminal panes.
 *
 * Parallel to `SharedWebGLContext`, but using a 2D context on a main-thread
 * canvas. Sits in the fallback chain below the WebGL2 shared context: when
 * hardware WebGL2 isn't available (SwiftShader on Linux CI, etc.) this keeps
 * multi-pane layouts on a single renderer instead of fanning out to N
 * per-pane render workers (which contend for cores on constrained hardware).
 *
 * Each registered terminal owns a viewport rectangle in CSS pixels; the
 * renderer iterates terminals, then dirty rows per terminal, clears the row
 * inside the viewport, and repaints cells + cursor.
 */

import type { CellGrid, CursorState, Theme } from "@next_term/core";
import { DEFAULT_THEME } from "@next_term/core";
import {
  ATTR_BOLD,
  ATTR_INVERSE,
  ATTR_ITALIC,
  ATTR_STRIKETHROUGH,
  ATTR_UNDERLINE,
} from "./cell-attrs.js";
import { build256Palette } from "./renderer.js";
import type { SharedContextHighlight } from "./shared-context.js";

interface TerminalEntry {
  grid: CellGrid;
  cursor: CursorState;
  viewport: { x: number; y: number; width: number; height: number };
  highlights: readonly SharedContextHighlight[];
  /** prev cursor position for dirty-marking when cursor moves */
  prevCursorRow: number;
  prevCursorCol: number;
  /** `true` once the terminal has been fully rendered at its current viewport. */
  fullyRendered: boolean;
}

export class SharedCanvas2DContext {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private terminals = new Map<string, TerminalEntry>();

  private theme: Theme;
  private palette: string[];
  private fontSize: number;
  private fontFamily: string;
  private fontWeight: number;
  private fontWeightBold: number;
  private dpr: number;
  private cellWidth = 0;
  private cellHeight = 0;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read via destructuring in renderTerminal()
  private baselineOffset = 0;

  private rafId: number | null = null;
  private disposed = false;
  /** When true, the next render clears and repaints every terminal once. */
  private needsFullClear = true;

  constructor(options?: {
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: number;
    fontWeightBold?: number;
    theme?: Partial<Theme>;
    devicePixelRatio?: number;
  }) {
    this.fontSize = options?.fontSize ?? 14;
    this.fontFamily = options?.fontFamily ?? "'Menlo', 'DejaVu Sans Mono', 'Consolas', monospace";
    this.fontWeight = options?.fontWeight ?? 400;
    this.fontWeightBold = options?.fontWeightBold ?? 700;
    this.theme = { ...DEFAULT_THEME, ...options?.theme };
    this.dpr =
      options?.devicePixelRatio ?? (typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    this.palette = build256Palette(this.theme);
    this.measureCellSize();

    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.position = "absolute";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.pointerEvents = "none";
  }

  /**
   * Acquire the 2D context. Matches SharedWebGLContext.init()'s throw-on-failure
   * shape so callers can layer fallbacks without changing their try/catch.
   */
  init(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
    // Scale once so all drawing happens in CSS-pixel coordinates.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // -----------------------------------------------------------------------
  // Public API — mirrors SharedWebGLContext
  // -----------------------------------------------------------------------

  addTerminal(id: string, grid: CellGrid, cursor: CursorState): void {
    this.terminals.set(id, {
      grid,
      cursor,
      viewport: { x: 0, y: 0, width: 0, height: 0 },
      highlights: [],
      prevCursorRow: -1,
      prevCursorCol: -1,
      fullyRendered: false,
    });
  }

  updateTerminal(id: string, grid: CellGrid, cursor: CursorState): void {
    const entry = this.terminals.get(id);
    if (!entry) return;
    entry.grid = grid;
    entry.cursor = cursor;
    entry.fullyRendered = false;
  }

  setViewport(id: string, x: number, y: number, width: number, height: number): void {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    )
      return;
    const entry = this.terminals.get(id);
    if (!entry) return;
    const vp = entry.viewport;
    if (vp.x === x && vp.y === y && vp.width === width && vp.height === height) return;
    entry.viewport = { x, y, width, height };
    entry.fullyRendered = false;
    // Clear on next frame so a shrinking viewport doesn't leave stale pixels
    // behind in the previously-occupied region.
    this.needsFullClear = true;
  }

  removeTerminal(id: string): void {
    this.terminals.delete(id);
    this.needsFullClear = true;
  }

  setHighlights(id: string, highlights: readonly SharedContextHighlight[]): void {
    const entry = this.terminals.get(id);
    if (!entry) return;
    entry.highlights = highlights;
    // Mark the union of old+new highlight rows dirty so old painted rectangles
    // get cleared. Simplest correct thing is to force a full repaint of this
    // terminal — highlight sets are small and change infrequently.
    entry.fullyRendered = false;
  }

  getTerminalIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getCellSize(): { width: number; height: number } {
    return { width: this.cellWidth, height: this.cellHeight };
  }

  syncCanvasSize(width: number, height: number): void {
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    // Setting canvas.width/height clears everything and resets the transform.
    if (this.ctx) this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    for (const entry of this.terminals.values()) {
      entry.fullyRendered = false;
    }
    this.needsFullClear = true;
  }

  startRenderLoop(): void {
    if (this.disposed || this.rafId !== null) return;
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRenderLoop();
    this.terminals.clear();
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.ctx = null;
  }

  setTheme(theme: Partial<Theme>): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.palette = build256Palette(this.theme);
    for (const entry of this.terminals.values()) {
      entry.fullyRendered = false;
      entry.grid.markAllDirty();
    }
    this.needsFullClear = true;
  }

  // -----------------------------------------------------------------------
  // Render loop
  // -----------------------------------------------------------------------

  render(): void {
    const ctx = this.ctx;
    if (this.disposed || !ctx) return;

    // Mark the old + new cursor rows dirty only when the cursor actually
    // moved. Unconditionally marking the current row every frame would defeat
    // the "skip idle frame" optimization below — the cursor row would always
    // look dirty even when nothing changed.
    for (const entry of this.terminals.values()) {
      const { cursor, grid } = entry;
      const moved = entry.prevCursorRow !== cursor.row || entry.prevCursorCol !== cursor.col;
      if (!moved) continue;
      if (entry.prevCursorRow >= 0 && entry.prevCursorRow < grid.rows) {
        grid.markDirty(entry.prevCursorRow);
      }
      if (cursor.row >= 0 && cursor.row < grid.rows) {
        grid.markDirty(cursor.row);
      }
      entry.prevCursorRow = cursor.row;
      entry.prevCursorCol = cursor.col;
    }

    // Early out: if nothing changed and we don't owe a full clear, skip the frame.
    let anyWork = this.needsFullClear;
    if (!anyWork) {
      for (const entry of this.terminals.values()) {
        if (!entry.fullyRendered) {
          anyWork = true;
          break;
        }
        const { grid } = entry;
        for (let r = 0; r < grid.rows; r++) {
          if (grid.isDirty(r)) {
            anyWork = true;
            break;
          }
        }
        if (anyWork) break;
      }
    }
    if (!anyWork) return;

    if (this.needsFullClear) {
      ctx.clearRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr);
      this.needsFullClear = false;
      // Force every terminal to repaint everything this frame.
      for (const entry of this.terminals.values()) {
        entry.fullyRendered = false;
      }
    }

    for (const [, entry] of this.terminals) {
      this.renderTerminal(ctx, entry);
    }
  }

  private renderTerminal(ctx: CanvasRenderingContext2D, entry: TerminalEntry): void {
    const { grid, cursor, viewport, highlights } = entry;
    if (viewport.width <= 0 || viewport.height <= 0) return;

    const { cellWidth, cellHeight, baselineOffset, theme } = this;
    const vpX = viewport.x;
    const vpY = viewport.y;
    // Clamp what we draw to what actually fits in the viewport — during a resize
    // the grid may be transiently larger than its box (fit is debounced).
    const visibleRows = Math.min(grid.rows, Math.floor(viewport.height / cellHeight));
    const visibleCols = Math.min(grid.cols, Math.floor(viewport.width / cellWidth));

    const forceAll = !entry.fullyRendered;

    // NOTE: selection is intentionally not drawn in shared-context mode yet —
    // matches SharedWebGLContext. Selection is a per-pane concept; wiring it
    // through the SharedContext interface is tracked as a follow-up.

    for (let row = 0; row < visibleRows; row++) {
      if (!forceAll && !grid.isDirty(row)) continue;

      const y = vpY + row * cellHeight;

      // Clear + paint default bg once per dirty row inside the viewport.
      ctx.clearRect(vpX, y, visibleCols * cellWidth, cellHeight);
      ctx.fillStyle = theme.background;
      ctx.fillRect(vpX, y, visibleCols * cellWidth, cellHeight);

      for (let col = 0; col < visibleCols; col++) {
        const x = vpX + col * cellWidth;
        if (grid.isSpacerCell(row, col)) continue;

        const codepoint = grid.getCodepoint(row, col);
        const fgIdx = grid.getFgIndex(row, col);
        const bgIdx = grid.getBgIndex(row, col);
        const attrs = grid.getAttrs(row, col);
        const fgIsRGB = grid.isFgRGB(row, col);
        const bgIsRGB = grid.isBgRGB(row, col);
        const wide = grid.isWide(row, col);
        const effWidth = wide ? cellWidth * 2 : cellWidth;

        let fg = this.resolveColor(fgIdx, fgIsRGB, grid.getFgRGB(row, col), true);
        let bg = this.resolveColor(bgIdx, bgIsRGB, grid.getBgRGB(row, col), false);

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

      // Search-result highlights for this row. Painted on the freshly-cleared
      // row so the translucent fill doesn't stack across frames.
      if (highlights.length > 0) {
        for (const hl of highlights) {
          if (hl.row !== row) continue;
          ctx.fillStyle = hl.isCurrent ? "rgba(255, 165, 0, 0.5)" : "rgba(255, 255, 0, 0.3)";
          ctx.fillRect(
            vpX + hl.startCol * cellWidth,
            y,
            (hl.endCol - hl.startCol + 1) * cellWidth,
            cellHeight,
          );
        }
      }

      if (cursor.visible && row === cursor.row && cursor.col < visibleCols) {
        const cx = vpX + cursor.col * cellWidth;
        ctx.fillStyle = theme.cursor;
        switch (cursor.style) {
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

    entry.fullyRendered = true;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildFontString(bold: boolean, italic: boolean): string {
    let font = "";
    if (italic) font += "italic ";
    font += `${bold ? this.fontWeightBold : this.fontWeight} `;
    font += `${this.fontSize}px ${this.fontFamily}`;
    return font;
  }

  private resolveColor(
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

  private measureCellSize(): void {
    const offscreen = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(100, 100) : null;
    let measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
    if (offscreen) {
      measureCtx = offscreen.getContext("2d");
    } else if (typeof document !== "undefined") {
      const tmp = document.createElement("canvas");
      tmp.width = 100;
      tmp.height = 100;
      measureCtx = tmp.getContext("2d");
    }
    if (!measureCtx) {
      this.cellWidth = Math.ceil(this.fontSize * 0.6);
      this.cellHeight = Math.ceil(this.fontSize * 1.2);
      this.baselineOffset = Math.ceil(this.fontSize);
      return;
    }
    measureCtx.font = `${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`;
    const metrics = measureCtx.measureText("M");
    this.cellWidth = Math.ceil(metrics.width);
    if (
      typeof metrics.fontBoundingBoxAscent === "number" &&
      typeof metrics.fontBoundingBoxDescent === "number"
    ) {
      this.cellHeight = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
      this.baselineOffset = Math.ceil(metrics.fontBoundingBoxAscent);
    } else {
      this.cellHeight = Math.ceil(this.fontSize * 1.2);
      this.baselineOffset = Math.ceil(this.fontSize);
    }
    if (this.cellWidth <= 0) this.cellWidth = Math.ceil(this.fontSize * 0.6);
    if (this.cellHeight <= 0) this.cellHeight = Math.ceil(this.fontSize * 1.2);
  }
}
