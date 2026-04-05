import type { PaneLayout } from "@next_term/react";

export function buildLayout(paneCount: number): PaneLayout {
  if (paneCount === 1) {
    return { type: "single", id: "pane-0" };
  }
  if (paneCount === 2) {
    return {
      type: "horizontal",
      children: [
        { type: "single", id: "pane-0" },
        { type: "single", id: "pane-1" },
      ],
    };
  }
  // For 4+ panes: split into two vertical columns
  const half = Math.ceil(paneCount / 2);
  const left: PaneLayout[] = [];
  const right: PaneLayout[] = [];
  for (let i = 0; i < paneCount; i++) {
    const leaf: PaneLayout = { type: "single", id: `pane-${i}` };
    if (i < half) left.push(leaf);
    else right.push(leaf);
  }
  return {
    type: "horizontal",
    children: [
      { type: "vertical", children: left },
      { type: "vertical", children: right },
    ],
  };
}
