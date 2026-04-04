export function printTable(title: string, cols: string[], rows: string[][]) {
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  const line = (left: string, mid: string, right: string, fill: string) =>
    left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right;

  console.log(`\n${title}`);
  console.log(line("┌", "┬", "┐", "─"));
  console.log("│ " + cols.map((c, i) => pad(c, widths[i])).join(" │ ") + " │");
  console.log(line("├", "┼", "┤", "─"));
  for (let r = 0; r < rows.length; r++) {
    console.log("│ " + rows[r].map((c, i) => pad(c, widths[i])).join(" │ ") + " │");
    if (r < rows.length - 1) console.log(line("├", "┼", "┤", "─"));
  }
  console.log(line("└", "┴", "┘", "─"));
}

export function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return map;
}
