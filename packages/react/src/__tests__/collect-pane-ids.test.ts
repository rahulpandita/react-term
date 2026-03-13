import { describe, expect, it } from "vitest";
import type { PaneLayout } from "../pane-layout.js";
import { collectPaneIds } from "../pane-layout.js";

// ---------------------------------------------------------------------------
// collectPaneIds — pure layout-tree traversal
// ---------------------------------------------------------------------------

describe("collectPaneIds", () => {
  it("single pane returns its own id", () => {
    const layout: PaneLayout = { type: "single", id: "term-1" };
    expect(collectPaneIds(layout)).toEqual(["term-1"]);
  });

  it("horizontal split with two singles returns both ids in order", () => {
    const layout: PaneLayout = {
      type: "horizontal",
      children: [
        { type: "single", id: "left" },
        { type: "single", id: "right" },
      ],
    };
    expect(collectPaneIds(layout)).toEqual(["left", "right"]);
  });

  it("vertical split with two singles returns both ids in order", () => {
    const layout: PaneLayout = {
      type: "vertical",
      children: [
        { type: "single", id: "top" },
        { type: "single", id: "bottom" },
      ],
    };
    expect(collectPaneIds(layout)).toEqual(["top", "bottom"]);
  });

  it("horizontal split with three children returns all ids in order", () => {
    const layout: PaneLayout = {
      type: "horizontal",
      children: [
        { type: "single", id: "a" },
        { type: "single", id: "b" },
        { type: "single", id: "c" },
      ],
    };
    expect(collectPaneIds(layout)).toEqual(["a", "b", "c"]);
  });

  it("nested layout returns leaf ids depth-first left-to-right", () => {
    // horizontal: [ vertical:[top-left, bottom-left], right ]
    const layout: PaneLayout = {
      type: "horizontal",
      children: [
        {
          type: "vertical",
          children: [
            { type: "single", id: "top-left" },
            { type: "single", id: "bottom-left" },
          ],
        },
        { type: "single", id: "right" },
      ],
    };
    expect(collectPaneIds(layout)).toEqual(["top-left", "bottom-left", "right"]);
  });

  it("deeply nested layout returns all leaf ids", () => {
    const layout: PaneLayout = {
      type: "horizontal",
      children: [
        { type: "single", id: "a" },
        {
          type: "vertical",
          children: [
            { type: "single", id: "b" },
            {
              type: "horizontal",
              children: [
                { type: "single", id: "c" },
                { type: "single", id: "d" },
              ],
            },
          ],
        },
      ],
    };
    expect(collectPaneIds(layout)).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores sizes field — returns same ids regardless of sizes", () => {
    const layout: PaneLayout = {
      type: "horizontal",
      children: [
        { type: "single", id: "x" },
        { type: "single", id: "y" },
      ],
      sizes: [0.3, 0.7],
    };
    expect(collectPaneIds(layout)).toEqual(["x", "y"]);
  });

  it("empty children array returns empty array", () => {
    const layout: PaneLayout = { type: "horizontal", children: [] };
    expect(collectPaneIds(layout)).toEqual([]);
  });
});
