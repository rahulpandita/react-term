// @vitest-environment jsdom
import { CellGrid } from "@react-term/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findLinks, WebLinksAddon } from "../addons/web-links.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// URL detection
// ---------------------------------------------------------------------------

describe("findLinks", () => {
  it("detects http URL", () => {
    const grid = gridWithText(["Visit http://example.com today"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("http://example.com");
    expect(links[0].row).toBe(0);
    expect(links[0].startCol).toBe(6);
  });

  it("detects https URL", () => {
    const grid = gridWithText(["Go to https://example.com/path"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/path");
  });

  it("detects URL with query params", () => {
    const grid = gridWithText(["https://example.com/search?q=test&page=1"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/search?q=test&page=1");
  });

  it("detects URL with fragment", () => {
    const grid = gridWithText(["https://example.com/page#section"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/page#section");
  });

  it("detects URL with port", () => {
    const grid = gridWithText(["http://localhost:3000/api"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("http://localhost:3000/api");
  });

  it("detects multiple URLs on different rows", () => {
    const grid = gridWithText(["First: https://example.com", "Second: https://other.com"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe("https://example.com");
    expect(links[0].row).toBe(0);
    expect(links[1].url).toBe("https://other.com");
    expect(links[1].row).toBe(1);
  });

  it("detects multiple URLs on same row", () => {
    const grid = gridWithText(["https://a.com and https://b.com"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe("https://a.com");
    expect(links[1].url).toBe("https://b.com");
  });

  it("does not detect non-URL text", () => {
    const grid = gridWithText(["This is plain text"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(0);
  });

  it("does not detect partial URL without protocol", () => {
    const grid = gridWithText(["example.com is a website"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(0);
  });

  it("trims trailing punctuation from URLs", () => {
    const grid = gridWithText(["See https://example.com."]);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com");
  });

  it("trims trailing comma from URLs", () => {
    const grid = gridWithText(["Visit https://example.com, then"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com");
  });

  it("trims trailing parenthesis from URLs", () => {
    const grid = gridWithText(["(see https://example.com)"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com");
  });

  it("handles URL with path and trailing slash", () => {
    const grid = gridWithText(["https://example.com/path/to/page/"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/path/to/page/");
  });

  it("returns correct column positions", () => {
    const grid = gridWithText(["     https://x.com"]);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].startCol).toBe(5);
    expect(links[0].endCol).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// Default handler URL scheme guard
// ---------------------------------------------------------------------------

describe("WebLinksAddon default handler", () => {
  it("opens http URLs", () => {
    const openSpy = vi.fn();
    vi.stubGlobal("window", { open: openSpy });

    const addon = new WebLinksAddon();
    // Access the default handler via a click simulation — invoke handler directly
    (addon as unknown as { handler: (url: string) => void }).handler("http://example.com");

    expect(openSpy).toHaveBeenCalledWith("http://example.com", "_blank", "noopener,noreferrer");
    vi.unstubAllGlobals();
  });

  it("opens https URLs", () => {
    const openSpy = vi.fn();
    vi.stubGlobal("window", { open: openSpy });

    const addon = new WebLinksAddon();
    (addon as unknown as { handler: (url: string) => void }).handler("https://example.com");

    expect(openSpy).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    vi.unstubAllGlobals();
  });

  it("rejects javascript: URLs", () => {
    const openSpy = vi.fn();
    vi.stubGlobal("window", { open: openSpy });

    const addon = new WebLinksAddon();
    (addon as unknown as { handler: (url: string) => void }).handler("javascript:alert(1)");

    expect(openSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects data: URLs", () => {
    const openSpy = vi.fn();
    vi.stubGlobal("window", { open: openSpy });

    const addon = new WebLinksAddon();
    (addon as unknown as { handler: (url: string) => void }).handler(
      "data:text/html,<script>alert(1)</script>",
    );

    expect(openSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// WebLinksAddon — mouse interaction (activate / dispose / hover / click)
// ---------------------------------------------------------------------------

// jsdom getBoundingClientRect returns {left:0, top:0}, so:
//   col = floor(clientX / cellWidth)
//   row = floor(clientY / cellHeight)
const CELL_W = 8;
const CELL_H = 16;

function makeTerminal(
  grid: CellGrid,
  container: HTMLElement,
): {
  element: HTMLElement;
  activeGrid: CellGrid;
  getCellSize: () => { width: number; height: number };
} {
  return {
    element: container,
    activeGrid: grid,
    getCellSize: () => ({ width: CELL_W, height: CELL_H }),
  };
}

describe("WebLinksAddon — activate and dispose", () => {
  let container: HTMLDivElement;
  let addon: WebLinksAddon;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    addon = new WebLinksAddon(vi.fn());
  });

  afterEach(() => {
    addon.dispose();
    document.body.removeChild(container);
  });

  it("attaches mousemove and click listeners on activate", () => {
    const grid = gridWithText(["https://example.com"]);
    const terminal = makeTerminal(grid, container);
    const addSpy = vi.spyOn(container, "addEventListener");

    addon.activate(terminal as never);

    const events = addSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("mousemove");
    expect(events).toContain("click");
  });

  it("removes event listeners on dispose", () => {
    const grid = gridWithText(["https://example.com"]);
    const terminal = makeTerminal(grid, container);
    addon.activate(terminal as never);

    const removeSpy = vi.spyOn(container, "removeEventListener");
    addon.dispose();

    const events = removeSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("mousemove");
    expect(events).toContain("click");
  });

  it("clears cursor style on dispose", () => {
    const grid = gridWithText(["https://example.com"]);
    const terminal = makeTerminal(grid, container);
    addon.activate(terminal as never);
    container.style.cursor = "pointer";

    addon.dispose();

    expect(container.style.cursor).toBe("");
  });

  it("dispose is safe to call before activate", () => {
    expect(() => addon.dispose()).not.toThrow();
  });

  it("dispose is idempotent", () => {
    const grid = gridWithText(["https://example.com"]);
    const terminal = makeTerminal(grid, container);
    addon.activate(terminal as never);
    addon.dispose();
    expect(() => addon.dispose()).not.toThrow();
  });
});

describe("WebLinksAddon — mousemove hover", () => {
  let container: HTMLDivElement;
  let addon: WebLinksAddon;

  // Row 0: "Visit https://example.com here"
  // startCol = 6, endCol = 6+18 = 24 ("https://example.com" = 19 chars → endCol = 24)
  // Hover pixel for col=6: clientX = 6*8 = 48, row=0: clientY = 0

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    addon = new WebLinksAddon(vi.fn());
    const grid = gridWithText(["Visit https://example.com here"]);
    const terminal = makeTerminal(grid, container);
    addon.activate(terminal as never);
  });

  afterEach(() => {
    addon.dispose();
    document.body.removeChild(container);
  });

  it("sets cursor to pointer when hovering over a link", () => {
    container.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 48, clientY: 0, bubbles: true }),
    );
    expect(container.style.cursor).toBe("pointer");
  });

  it("resets cursor when hovering away from the link", () => {
    // First hover over link
    container.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 48, clientY: 0, bubbles: true }),
    );
    expect(container.style.cursor).toBe("pointer");

    // Then move to an empty area (col = 0)
    container.dispatchEvent(new MouseEvent("mousemove", { clientX: 0, clientY: 0, bubbles: true }));
    expect(container.style.cursor).toBe("");
  });

  it("keeps cursor as pointer while traversing across link columns", () => {
    // col 10 is inside "https://example.com" (startCol=6, endCol=24)
    container.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 80, clientY: 0, bubbles: true }),
    );
    expect(container.style.cursor).toBe("pointer");
  });

  it("does not set pointer cursor on a row with no link", () => {
    // row 1 doesn't exist in a 1-row grid — col will be out of range, no link
    container.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 48, clientY: 16, bubbles: true }),
    );
    expect(container.style.cursor).toBe("");
  });
});

describe("WebLinksAddon — click handling", () => {
  let container: HTMLDivElement;
  let handler: ReturnType<typeof vi.fn>;
  let addon: WebLinksAddon;

  // Row 0: "Click https://example.com now"
  // "https://example.com" starts at col 6 (after "Click "), length 19, endCol=24

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    handler = vi.fn();
    addon = new WebLinksAddon(handler);
    const grid = gridWithText(["Click https://example.com now"]);
    const terminal = makeTerminal(grid, container);
    addon.activate(terminal as never);
  });

  afterEach(() => {
    addon.dispose();
    document.body.removeChild(container);
  });

  it("calls custom handler with URL when clicking on a link", () => {
    // col 6 * 8 = 48 → lands on 'h' of https://
    container.dispatchEvent(new MouseEvent("click", { clientX: 48, clientY: 0, bubbles: true }));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("https://example.com");
  });

  it("does not call handler when clicking outside the link", () => {
    // col 0 = before the URL
    container.dispatchEvent(new MouseEvent("click", { clientX: 0, clientY: 0, bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("calls handler for each of multiple links on different rows", () => {
    addon.dispose();
    handler = vi.fn();
    addon = new WebLinksAddon(handler);
    const grid = gridWithText(["https://first.com", "https://second.com"]);
    const terminal = makeTerminal(grid, container);
    addon.activate(terminal as never);

    // Click first URL: row 0, col 0
    container.dispatchEvent(new MouseEvent("click", { clientX: 0, clientY: 0, bubbles: true }));
    expect(handler).toHaveBeenCalledWith("https://first.com");

    handler.mockClear();

    // Click second URL: row 1, col 0 → clientY = 16
    container.dispatchEvent(new MouseEvent("click", { clientX: 0, clientY: 16, bubbles: true }));
    expect(handler).toHaveBeenCalledWith("https://second.com");
  });

  it("stops firing events after dispose", () => {
    addon.dispose();
    container.dispatchEvent(new MouseEvent("click", { clientX: 48, clientY: 0, bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("WebLinksAddon — coordinate edge cases", () => {
  let container: HTMLDivElement;
  let handler: ReturnType<typeof vi.fn>;
  let addon: WebLinksAddon;

  afterEach(() => {
    addon?.dispose();
    if (container?.parentNode) document.body.removeChild(container);
  });

  it("ignores click when terminal has no container element", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    handler = vi.fn();
    addon = new WebLinksAddon(handler);

    const grid = gridWithText(["https://example.com"]);
    const terminal = {
      element: null as unknown as HTMLElement,
      activeGrid: grid,
      getCellSize: () => ({ width: CELL_W, height: CELL_H }),
    };
    // activate returns early when element is null
    addon.activate(terminal as never);

    // No listeners should be attached — clicking the container does nothing
    container.dispatchEvent(new MouseEvent("click", { clientX: 0, clientY: 0, bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores click when cell size is zero (renderer not ready)", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    handler = vi.fn();
    addon = new WebLinksAddon(handler);

    const grid = gridWithText(["https://example.com"]);
    const terminal = {
      element: container,
      activeGrid: grid,
      getCellSize: () => ({ width: 0, height: 0 }),
    };
    addon.activate(terminal as never);

    container.dispatchEvent(new MouseEvent("click", { clientX: 0, clientY: 0, bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
  });
});
