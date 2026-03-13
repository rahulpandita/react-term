/**
 * PaneLayout — recursive layout tree for TerminalPane.
 * Kept in a separate module so pure layout logic can be unit-tested without
 * pulling in React/JSX.
 */

export type PaneLayout =
  | { type: "single"; id: string }
  | { type: "horizontal"; children: PaneLayout[]; sizes?: number[] }
  | { type: "vertical"; children: PaneLayout[]; sizes?: number[] };

/** Collect all leaf pane ids from a layout tree (depth-first, left-to-right). */
export function collectPaneIds(layout: PaneLayout): string[] {
  if (layout.type === "single") {
    return [layout.id];
  }
  const ids: string[] = [];
  for (const child of layout.children) {
    ids.push(...collectPaneIds(child));
  }
  return ids;
}
