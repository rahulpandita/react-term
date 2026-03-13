import type { CellGrid } from "@react-term/core";
import type { ITerminalAddon } from "../addon.js";
import type { WebTerminal } from "../web-terminal.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinkMatch {
  row: number;
  startCol: number;
  endCol: number;
  url: string;
}

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

/**
 * Regex pattern for detecting URLs in terminal text.
 * Matches http:// and https:// URLs.
 */
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

/**
 * Extract the text content of a single row from a CellGrid.
 */
function extractRowText(grid: CellGrid, row: number): string {
  let line = "";
  for (let col = 0; col < grid.cols; col++) {
    const cp = grid.getCodepoint(row, col);
    line += cp > 0x20 ? String.fromCodePoint(cp) : " ";
  }
  return line;
}

/**
 * Find all URLs in the visible rows of a grid.
 */
export function findLinks(grid: CellGrid): LinkMatch[] {
  const links: LinkMatch[] = [];

  for (let row = 0; row < grid.rows; row++) {
    const text = extractRowText(grid, row);
    URL_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;

    while (true) {
      m = URL_REGEX.exec(text);
      if (m === null) break;
      // Trim trailing punctuation that is likely not part of the URL
      let url = m[0];
      while (url.length > 0 && /[.,;:!?)']$/.test(url)) {
        url = url.slice(0, -1);
      }
      if (url.length === 0) continue;

      links.push({
        row,
        startCol: m.index,
        endCol: m.index + url.length - 1,
        url,
      });
    }
  }

  return links;
}

// ---------------------------------------------------------------------------
// WebLinksAddon
// ---------------------------------------------------------------------------

export class WebLinksAddon implements ITerminalAddon {
  private terminal: WebTerminal | null = null;
  private handler: (url: string) => void;
  private links: LinkMatch[] = [];
  private currentHoverLink: LinkMatch | null = null;

  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private clickHandler: ((e: MouseEvent) => void) | null = null;

  constructor(handler?: (url: string) => void) {
    this.handler =
      handler ??
      ((url: string) => {
        if (typeof window !== "undefined") {
          if (!url.startsWith("http://") && !url.startsWith("https://")) return;
          window.open(url, "_blank", "noopener,noreferrer");
        }
      });
  }

  activate(terminal: WebTerminal): void {
    this.terminal = terminal;

    // Listen for mouse events on the terminal's container
    const container = terminal.element;
    if (!container) return;

    this.mouseMoveHandler = (e: MouseEvent) => this.onMouseMove(e);
    this.clickHandler = (e: MouseEvent) => this.onClick(e);

    container.addEventListener("mousemove", this.mouseMoveHandler);
    container.addEventListener("click", this.clickHandler);
  }

  dispose(): void {
    if (this.terminal) {
      const container = this.terminal.element;
      if (container) {
        if (this.mouseMoveHandler) {
          container.removeEventListener("mousemove", this.mouseMoveHandler);
        }
        if (this.clickHandler) {
          container.removeEventListener("click", this.clickHandler);
        }
        container.style.cursor = "";
      }
    }

    this.terminal = null;
    this.links = [];
    this.currentHoverLink = null;
    this.mouseMoveHandler = null;
    this.clickHandler = null;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private refreshLinks(): void {
    if (!this.terminal) return;
    const grid = this.terminal.activeGrid;
    this.links = findLinks(grid);
  }

  private getCellPosition(e: MouseEvent): { row: number; col: number } | null {
    if (!this.terminal) return null;

    const container = this.terminal.element;
    if (!container) return null;

    const rect = container.getBoundingClientRect();
    const { width, height } = this.terminal.getCellSize();
    if (width <= 0 || height <= 0) return null;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const col = Math.floor(x / width);
    const row = Math.floor(y / height);

    return { row, col };
  }

  private findLinkAt(row: number, col: number): LinkMatch | null {
    for (const link of this.links) {
      if (link.row === row && col >= link.startCol && col <= link.endCol) {
        return link;
      }
    }
    return null;
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.terminal) return;

    // Refresh links on each mousemove for simplicity
    // (could be optimized to only refresh when rows change)
    this.refreshLinks();

    const pos = this.getCellPosition(e);
    if (!pos) return;

    const link = this.findLinkAt(pos.row, pos.col);
    const container = this.terminal.element;

    if (link) {
      if (container) container.style.cursor = "pointer";
      this.currentHoverLink = link;
    } else {
      if (container) container.style.cursor = "";
      this.currentHoverLink = null;
    }
  }

  private onClick(e: MouseEvent): void {
    if (!this.terminal) return;

    this.refreshLinks();

    const pos = this.getCellPosition(e);
    if (!pos) return;

    const link = this.findLinkAt(pos.row, pos.col);
    if (link) {
      e.preventDefault();
      this.handler(link.url);
    }
  }
}
