// @vitest-environment jsdom

import { CellGrid } from "@next_term/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessibilityManager, extractRowText } from "../accessibility.js";

// ---------------------------------------------------------------------------
// extractRowText
// ---------------------------------------------------------------------------

describe("extractRowText", () => {
  it("extracts text from a grid row", () => {
    const grid = new CellGrid(10, 3);
    // Write "Hello" into row 0
    const chars = "Hello";
    for (let i = 0; i < chars.length; i++) {
      grid.setCell(0, i, chars.charCodeAt(i), 7, 0, 0);
    }

    const text = extractRowText(grid, 0);
    expect(text).toBe("Hello");
  });

  it("trims trailing whitespace", () => {
    const grid = new CellGrid(10, 3);
    // Write "Hi" — remaining cols are spaces
    grid.setCell(0, 0, "H".charCodeAt(0), 7, 0, 0);
    grid.setCell(0, 1, "i".charCodeAt(0), 7, 0, 0);

    const text = extractRowText(grid, 0);
    expect(text).toBe("Hi");
  });

  it("returns empty string for blank row", () => {
    const grid = new CellGrid(10, 3);
    const text = extractRowText(grid, 0);
    expect(text).toBe("");
  });
});

// ---------------------------------------------------------------------------
// AccessibilityManager
// ---------------------------------------------------------------------------

describe("AccessibilityManager", () => {
  let container: HTMLElement;
  let grid: CellGrid;
  let manager: AccessibilityManager;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    grid = new CellGrid(10, 3);
    manager = new AccessibilityManager(container, grid, 3, 10);
  });

  afterEach(() => {
    manager.dispose();
    document.body.removeChild(container);
  });

  it("creates row elements with correct count", () => {
    const rows = container.querySelectorAll('[role="row"]');
    expect(rows.length).toBe(3);
  });

  it("sets aria-posinset and aria-setsize on row elements", () => {
    const rows = container.querySelectorAll('[role="row"]');
    expect(rows[0].getAttribute("aria-posinset")).toBe("1");
    expect(rows[0].getAttribute("aria-setsize")).toBe("3");
    expect(rows[2].getAttribute("aria-posinset")).toBe("3");
    expect(rows[2].getAttribute("aria-setsize")).toBe("3");
  });

  it('creates a grid container with role="grid"', () => {
    const gridEl = container.querySelector('[role="grid"]');
    expect(gridEl).not.toBeNull();
    expect(gridEl?.getAttribute("aria-label")).toBe("Terminal output");
  });

  it('creates a live region with role="log"', () => {
    const liveRegion = container.querySelector('[role="log"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.getAttribute("aria-live")).toBe("polite");
  });

  it("updates row text content from grid", () => {
    // Write "ABC" into row 1
    grid.setCell(1, 0, 65, 7, 0, 0); // A
    grid.setCell(1, 1, 66, 7, 0, 0); // B
    grid.setCell(1, 2, 67, 7, 0, 0); // C
    grid.markDirty(1);

    manager.update();

    const rows = container.querySelectorAll('[role="row"]');
    expect(rows[1].textContent).toBe("ABC");
  });

  it("does not update non-dirty rows", () => {
    // Write text then clear dirty
    grid.setCell(0, 0, 65, 7, 0, 0); // A
    grid.clearDirty(0);

    // Set some initial content
    manager.update();

    // The row should remain empty since it was not dirty during update
    const rows = container.querySelectorAll('[role="row"]');
    // Row 0 wasn't dirty during update, but during setCell it got marked dirty
    // then we cleared dirty, so update should skip it
    expect(rows[0].textContent).toBe("");
  });

  it("announce adds text to live region", () => {
    manager.announce("Terminal bell");

    const liveRegion = container.querySelector('[role="log"]');
    expect(liveRegion?.textContent).toContain("Terminal bell");
  });

  it("announce with assertive priority sets aria-live", () => {
    manager.announce("Alert!", "assertive");

    const liveRegion = container.querySelector('[role="log"]');
    expect(liveRegion?.getAttribute("aria-live")).toBe("assertive");
  });

  it("throttles rapid updates", () => {
    vi.useFakeTimers();

    // Write data and call update multiple times
    grid.setCell(0, 0, 65, 7, 0, 0); // A
    grid.markDirty(0);
    manager.update(); // First call fires immediately

    const rows = container.querySelectorAll('[role="row"]');
    expect(rows[0].textContent).toBe("A");

    // Second rapid update should be deferred
    grid.setCell(0, 0, 66, 7, 0, 0); // B
    grid.markDirty(0);
    manager.update();

    // Not updated yet (throttled)
    expect(rows[0].textContent).toBe("A");

    // Advance timer past throttle interval
    vi.advanceTimersByTime(150);

    // Now the deferred update should have fired
    expect(rows[0].textContent).toBe("B");

    vi.useRealTimers();
  });

  it("setGrid rebuilds rows on count change", () => {
    const newGrid = new CellGrid(10, 5);
    manager.setGrid(newGrid, 5, 10);

    const rows = container.querySelectorAll('[role="row"]');
    expect(rows.length).toBe(5);
    expect(rows[4].getAttribute("aria-posinset")).toBe("5");
    expect(rows[4].getAttribute("aria-setsize")).toBe("5");
  });

  it("setGrid reduces rows on smaller grid", () => {
    const newGrid = new CellGrid(10, 1);
    manager.setGrid(newGrid, 1, 10);

    const rows = container.querySelectorAll('[role="row"]');
    expect(rows.length).toBe(1);
  });

  it("dispose removes DOM elements", () => {
    manager.dispose();

    const gridEl = container.querySelector('[role="grid"]');
    const liveRegion = container.querySelector('[role="log"]');
    expect(gridEl).toBeNull();
    expect(liveRegion).toBeNull();
  });

  it("dispose is idempotent", () => {
    manager.dispose();
    manager.dispose(); // Should not throw
  });

  it("dispose cancels a pending throttle timer", () => {
    vi.useFakeTimers();

    // Trigger the first update to arm the throttle timer
    grid.markDirty(0);
    manager.update();

    // Dispose while timer is still running — should not throw or fire later
    manager.dispose();

    // Advancing time must not cause errors
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();

    vi.useRealTimers();
  });

  it("update() after dispose does not modify the DOM", () => {
    manager.dispose();
    grid.setCell(0, 0, "X".charCodeAt(0), 7, 0, 0);
    grid.markDirty(0);
    const htmlBefore = container.innerHTML;
    manager.update();
    expect(container.innerHTML).toBe(htmlBefore);
  });

  it("announce() after dispose does not add to the live region", () => {
    // Capture the live region reference before dispose removes it from the DOM
    const liveRegion = container.querySelector('[role="log"]') as HTMLElement;
    const countBefore = liveRegion.childNodes.length;
    manager.dispose();
    manager.announce("hello");
    // The live region should not have gained any children
    expect(liveRegion.childNodes.length).toBe(countBefore);
  });

  it("announce caps the live region at 20 child nodes", () => {
    // Add 25 announcements — the region should be trimmed to ≤ 20 children
    for (let i = 0; i < 25; i++) {
      manager.announce(`message ${i}`);
    }

    const liveRegion = container.querySelector('[role="log"]');
    expect(liveRegion?.childNodes.length).toBeLessThanOrEqual(20);
  });
});
