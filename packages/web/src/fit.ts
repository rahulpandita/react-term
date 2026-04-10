/**
 * Calculate how many terminal columns/rows fit in a container element.
 * Subtracts CSS padding so the canvas fits inside the content box.
 */
export function calculateFit(
  container: HTMLElement,
  cellWidth: number,
  cellHeight: number,
): { cols: number; rows: number } {
  const rect = container.getBoundingClientRect();

  let width = rect.width;
  let height = rect.height;

  if (typeof getComputedStyle === "function") {
    const style = getComputedStyle(container);
    width -= (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    height -= (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  }

  const cols = Math.max(2, Math.floor(width / cellWidth));
  const rows = Math.max(1, Math.floor(height / cellHeight));

  // Guard against Infinity/NaN — critical gotcha from xterm.js
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return { cols: 80, rows: 24 };
  }

  return { cols, rows };
}
