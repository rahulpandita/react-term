import type { ITerminalAddon } from '../addon.js';
import type { WebTerminal } from '../web-terminal.js';
import type { CellGrid } from '@react-term/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchMatch {
  row: number;
  startCol: number;
  endCol: number;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text content of a single row from a CellGrid.
 */
export function extractRowText(grid: CellGrid, row: number): string {
  let line = '';
  for (let col = 0; col < grid.cols; col++) {
    const cp = grid.getCodepoint(row, col);
    line += cp > 0x20 ? String.fromCodePoint(cp) : ' ';
  }
  return line;
}

/**
 * Find all matches of a query in a grid.
 */
export function findAllMatches(
  grid: CellGrid,
  query: string,
  options?: SearchOptions,
): SearchMatch[] {
  if (!query) return [];

  const caseSensitive = options?.caseSensitive ?? false;
  const wholeWord = options?.wholeWord ?? false;
  const useRegex = options?.regex ?? false;

  let regex: RegExp;
  try {
    let pattern: string;
    if (useRegex) {
      pattern = query;
    } else {
      // Escape special regex characters for literal search
      pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    if (wholeWord) {
      pattern = `\\b${pattern}\\b`;
    }

    const flags = caseSensitive ? 'g' : 'gi';
    regex = new RegExp(pattern, flags);
  } catch {
    // Invalid regex — return no matches
    return [];
  }

  const matches: SearchMatch[] = [];

  for (let row = 0; row < grid.rows; row++) {
    const text = extractRowText(grid, row);
    let m: RegExpExecArray | null;

    // Reset lastIndex for each row
    regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null) {
      matches.push({
        row,
        startCol: m.index,
        endCol: m.index + m[0].length - 1,
      });
      // Prevent infinite loops on zero-length matches
      if (m[0].length === 0) {
        regex.lastIndex++;
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// SearchAddon
// ---------------------------------------------------------------------------

export class SearchAddon implements ITerminalAddon {
  private terminal: WebTerminal | null = null;
  private matches: SearchMatch[] = [];
  private currentMatchIndex = -1;
  private lastQuery = '';
  private lastOptions: SearchOptions = {};

  activate(terminal: WebTerminal): void {
    this.terminal = terminal;
  }

  dispose(): void {
    this.clearSearch();
    this.terminal = null;
  }

  /**
   * Search forward for the next match of the given query.
   * Returns the match or null if none found.
   */
  findNext(query: string, options?: SearchOptions): SearchMatch | null {
    if (!this.terminal) return null;

    // Re-run search if query or options changed
    if (query !== this.lastQuery || !this.optionsEqual(options)) {
      this.performSearch(query, options);
    }

    if (this.matches.length === 0) return null;

    this.currentMatchIndex = (this.currentMatchIndex + 1) % this.matches.length;
    this.updateHighlights();
    return this.matches[this.currentMatchIndex];
  }

  /**
   * Search backward for the previous match of the given query.
   * Returns the match or null if none found.
   */
  findPrevious(query: string, options?: SearchOptions): SearchMatch | null {
    if (!this.terminal) return null;

    // Re-run search if query or options changed
    if (query !== this.lastQuery || !this.optionsEqual(options)) {
      this.performSearch(query, options);
    }

    if (this.matches.length === 0) return null;

    this.currentMatchIndex =
      this.currentMatchIndex <= 0
        ? this.matches.length - 1
        : this.currentMatchIndex - 1;
    this.updateHighlights();
    return this.matches[this.currentMatchIndex];
  }

  /**
   * Clear all search state and highlights.
   */
  clearSearch(): void {
    this.matches = [];
    this.currentMatchIndex = -1;
    this.lastQuery = '';
    this.lastOptions = {};
    if (this.terminal) {
      this.terminal.setHighlights([]);
    }
  }

  /**
   * Get all current matches.
   */
  getMatches(): SearchMatch[] {
    return this.matches;
  }

  /**
   * Get the current highlighted match.
   */
  getCurrentMatch(): SearchMatch | null {
    if (this.currentMatchIndex < 0 || this.currentMatchIndex >= this.matches.length) {
      return null;
    }
    return this.matches[this.currentMatchIndex];
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private performSearch(query: string, options?: SearchOptions): void {
    this.lastQuery = query;
    this.lastOptions = options ? { ...options } : {};
    this.currentMatchIndex = -1;

    if (!this.terminal) {
      this.matches = [];
      return;
    }

    const grid = this.terminal.activeGrid;
    this.matches = findAllMatches(grid, query, options);
  }

  private updateHighlights(): void {
    if (!this.terminal) return;

    const highlights = this.matches.map((m, i) => ({
      row: m.row,
      startCol: m.startCol,
      endCol: m.endCol,
      isCurrent: i === this.currentMatchIndex,
    }));

    this.terminal.setHighlights(highlights);
  }

  private optionsEqual(options?: SearchOptions): boolean {
    const a = this.lastOptions;
    const b = options ?? {};
    return (
      (a.caseSensitive ?? false) === (b.caseSensitive ?? false) &&
      (a.wholeWord ?? false) === (b.wholeWord ?? false) &&
      (a.regex ?? false) === (b.regex ?? false)
    );
  }
}
