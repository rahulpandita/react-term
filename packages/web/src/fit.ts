/**
 * Calculate how many terminal columns/rows fit in a container element.
 */
export function calculateFit(
  container: HTMLElement,
  cellWidth: number,
  cellHeight: number,
): { cols: number; rows: number } {
  const { width, height } = container.getBoundingClientRect();

  const cols = Math.max(2, Math.floor(width / cellWidth));
  const rows = Math.max(1, Math.floor(height / cellHeight));

  // Guard against Infinity/NaN — critical gotcha from xterm.js
  if (!isFinite(cols) || !isFinite(rows)) {
    return { cols: 80, rows: 24 };
  }

  return { cols, rows };
}
