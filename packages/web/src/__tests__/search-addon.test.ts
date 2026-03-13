import { CellGrid } from "@react-term/core";
import { describe, expect, it } from "vitest";
import { extractRowText, findAllMatches, SearchAddon } from "../addons/search.js";
import type { WebTerminal } from "../web-terminal.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a CellGrid and fill a row with the given text.
 */
function gridWithText(texts: string[], cols = 80, rows?: number): CellGrid {
  const r = rows ?? texts.length;
  const grid = new CellGrid(cols, r);
  for (let row = 0; row < texts.length; row++) {
    const text = texts[row];
    for (let col = 0; col < text.length && col < cols; col++) {
      const cp = text.charCodeAt(col);
      grid.setCell(row, col, cp, 7, 0, 0);
    }
  }
  return grid;
}

// ---------------------------------------------------------------------------
// extractRowText
// ---------------------------------------------------------------------------

describe("extractRowText", () => {
  it("extracts text from a grid row", () => {
    const grid = gridWithText(["Hello World"]);
    const text = extractRowText(grid, 0);
    // Text is padded with spaces up to cols width
    expect(text.trimEnd()).toBe("Hello World");
  });
});

// ---------------------------------------------------------------------------
// findAllMatches
// ---------------------------------------------------------------------------

describe("findAllMatches", () => {
  it("finds text in grid", () => {
    const grid = gridWithText(["Hello World", "Hello Again"]);
    const matches = findAllMatches(grid, "Hello");
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ row: 0, startCol: 0, endCol: 4 });
    expect(matches[1]).toEqual({ row: 1, startCol: 0, endCol: 4 });
  });

  it("case insensitive search by default", () => {
    const grid = gridWithText(["Hello World"]);
    const matches = findAllMatches(grid, "hello");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ row: 0, startCol: 0, endCol: 4 });
  });

  it("case sensitive search when option is set", () => {
    const grid = gridWithText(["Hello World"]);
    const matches = findAllMatches(grid, "hello", { caseSensitive: true });
    expect(matches).toHaveLength(0);
  });

  it("case sensitive search finds exact case", () => {
    const grid = gridWithText(["Hello World"]);
    const matches = findAllMatches(grid, "Hello", { caseSensitive: true });
    expect(matches).toHaveLength(1);
  });

  it("returns empty array for empty query", () => {
    const grid = gridWithText(["Hello World"]);
    const matches = findAllMatches(grid, "");
    expect(matches).toHaveLength(0);
  });

  it("returns empty array when no match", () => {
    const grid = gridWithText(["Hello World"]);
    const matches = findAllMatches(grid, "xyz");
    expect(matches).toHaveLength(0);
  });

  it("finds multiple matches in a single row", () => {
    const grid = gridWithText(["aaa"]);
    const matches = findAllMatches(grid, "a");
    expect(matches).toHaveLength(3);
  });

  it("regex search", () => {
    const grid = gridWithText(["foo123 bar456"]);
    const matches = findAllMatches(grid, "\\d+", { regex: true });
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ row: 0, startCol: 3, endCol: 5 });
    expect(matches[1]).toEqual({ row: 0, startCol: 10, endCol: 12 });
  });

  it("handles invalid regex gracefully", () => {
    const grid = gridWithText(["Hello World"]);
    const matches = findAllMatches(grid, "[invalid", { regex: true });
    expect(matches).toHaveLength(0);
  });

  it("whole word search", () => {
    const grid = gridWithText(["hello helloworld hello"]);
    const matches = findAllMatches(grid, "hello", { wholeWord: true });
    // "hello" at start and end are whole words, "helloworld" is not
    expect(matches).toHaveLength(2);
    expect(matches[0].startCol).toBe(0);
    expect(matches[1].startCol).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// SearchAddon
// ---------------------------------------------------------------------------

describe("SearchAddon", () => {
  /**
   * Create a minimal mock WebTerminal for testing.
   */
  function createMockTerminal(texts: string[]) {
    const grid = gridWithText(texts);
    let lastHighlights: Array<{
      row: number;
      startCol: number;
      endCol: number;
      isCurrent: boolean;
    }> = [];

    return {
      terminal: {
        activeGrid: grid,
        setHighlights(highlights: typeof lastHighlights) {
          lastHighlights = highlights;
        },
      },
      getHighlights: () => lastHighlights,
    };
  }

  it("findNext returns first match", () => {
    const { terminal } = createMockTerminal(["Hello World"]);
    const addon = new SearchAddon();
    addon.activate(terminal as unknown as WebTerminal);

    const match = addon.findNext("Hello");
    expect(match).toEqual({ row: 0, startCol: 0, endCol: 4 });
  });

  it("findNext cycles through matches", () => {
    const { terminal } = createMockTerminal(["Hello Hello"]);
    const addon = new SearchAddon();
    addon.activate(terminal as unknown as WebTerminal);

    const m1 = addon.findNext("Hello");
    expect(m1).toEqual({ row: 0, startCol: 0, endCol: 4 });

    const m2 = addon.findNext("Hello");
    expect(m2).toEqual({ row: 0, startCol: 6, endCol: 10 });

    // Wraps around
    const m3 = addon.findNext("Hello");
    expect(m3).toEqual({ row: 0, startCol: 0, endCol: 4 });
  });

  it("findPrevious cycles backwards", () => {
    const { terminal } = createMockTerminal(["Hello Hello"]);
    const addon = new SearchAddon();
    addon.activate(terminal as unknown as WebTerminal);

    // First call starts from the last match
    const m1 = addon.findPrevious("Hello");
    expect(m1).toEqual({ row: 0, startCol: 6, endCol: 10 });

    const m2 = addon.findPrevious("Hello");
    expect(m2).toEqual({ row: 0, startCol: 0, endCol: 4 });

    // Wraps around
    const m3 = addon.findPrevious("Hello");
    expect(m3).toEqual({ row: 0, startCol: 6, endCol: 10 });
  });

  it("clearSearch empties matches", () => {
    const { terminal } = createMockTerminal(["Hello World"]);
    const addon = new SearchAddon();
    addon.activate(terminal as unknown as WebTerminal);

    addon.findNext("Hello");
    expect(addon.getMatches()).toHaveLength(1);

    addon.clearSearch();
    expect(addon.getMatches()).toHaveLength(0);
    expect(addon.getCurrentMatch()).toBeNull();
  });

  it("no matches returns null", () => {
    const { terminal } = createMockTerminal(["Hello World"]);
    const addon = new SearchAddon();
    addon.activate(terminal as unknown as WebTerminal);

    const match = addon.findNext("xyz");
    expect(match).toBeNull();
  });

  it("getMatches returns all matches", () => {
    const { terminal } = createMockTerminal(["Hello World Hello"]);
    const addon = new SearchAddon();
    addon.activate(terminal as unknown as WebTerminal);

    addon.findNext("Hello");
    const matches = addon.getMatches();
    expect(matches).toHaveLength(2);
  });

  it("getCurrentMatch returns the current match", () => {
    const { terminal } = createMockTerminal(["Hello World"]);
    const addon = new SearchAddon();
    addon.activate(terminal as unknown as WebTerminal);

    expect(addon.getCurrentMatch()).toBeNull();

    addon.findNext("Hello");
    expect(addon.getCurrentMatch()).toEqual({ row: 0, startCol: 0, endCol: 4 });
  });

  it("updates highlights on the terminal", () => {
    const { terminal, getHighlights } = createMockTerminal(["Hello World"]);
    const addon = new SearchAddon();
    addon.activate(terminal as unknown as WebTerminal);

    addon.findNext("Hello");
    const highlights = getHighlights();
    expect(highlights).toHaveLength(1);
    expect(highlights[0].isCurrent).toBe(true);
  });

  it("findNext returns null when not activated", () => {
    const addon = new SearchAddon();
    expect(addon.findNext("test")).toBeNull();
  });

  it("dispose clears state", () => {
    const { terminal } = createMockTerminal(["Hello World"]);
    const addon = new SearchAddon();
    addon.activate(terminal as unknown as WebTerminal);

    addon.findNext("Hello");
    addon.dispose();

    expect(addon.getMatches()).toHaveLength(0);
    expect(addon.getCurrentMatch()).toBeNull();
  });
});
