import { test, expect } from '@playwright/test';
import type { BenchmarkResult } from '../src/types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TERMINALS = ['react-term', 'xterm'] as const;
// Subset of scenarios for automated benchmarks (the heavy-hitters)
const SCENARIOS = [
  // Original scenarios
  'ascii', 'real-world', 'sgr-color', 'scrolling', 'cursor-motion', 'unicode',
  // vtebench scenarios (alacritty/vtebench standard)
  'vte-dense-cells', 'vte-light-cells', 'vte-medium-cells', 'vte-cursor-motion',
  'vte-scrolling', 'vte-scrolling-fullscreen', 'vte-unicode',
] as const;
const RUNS_PER_CONFIG = 3;

test('e2e benchmark matrix', async ({ page }) => {
  const allResults: BenchmarkResult[] = [];

  for (const terminal of TERMINALS) {
    for (const scenario of SCENARIOS) {
      // Fresh page load per terminal+scenario — ensures fully clean state
      // (no leaked WebGL contexts, Workers, or accumulated GC pressure)
      await page.goto('http://localhost:5174');
      await expect(page.locator('select').nth(1)).not.toBeEmpty({ timeout: 10_000 });

      // Select terminal
      await page.selectOption('select >> nth=0', terminal);

      // Check if scenario exists in the dropdown
      const options = await page.locator('select >> nth=1 >> option').allTextContents();
      if (!options.includes(scenario)) {
        continue;
      }

      // Select scenario
      await page.selectOption('select >> nth=1', scenario);

      // Set runs
      await page.fill('input[type="number"]', String(RUNS_PER_CONFIG));

      // Click start
      await page.click('button:has-text("Start Benchmark")');

      // Wait for completion
      await page.waitForSelector('[data-testid="status"][data-value="complete"]', {
        timeout: 5 * 60 * 1000,
      });

      // Collect results
      const results = await page.evaluate(() => window.__allBenchmarkResults ?? []);
      allResults.push(...(results as BenchmarkResult[]));
    }
  }

  // Write results to file
  const resultsDir = path.resolve(__dirname, '..', 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(resultsDir, `benchmark-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));

  // Group results by terminal+scenario
  const grouped = new Map<string, BenchmarkResult[]>();
  for (const r of allResults) {
    const key = `${r.terminal}|${r.scenario}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  // Compute averages per terminal+scenario
  const avg = (runs: BenchmarkResult[], fn: (r: BenchmarkResult) => number) =>
    runs.reduce((s, r) => s + fn(r), 0) / runs.length;

  // --- Detailed results table ---
  const detailCols = ['Terminal', 'Scenario', 'Avg Time (ms)', 'Avg FPS', 'MB/s', 'Runs'];
  const detailRows: string[][] = [];
  for (const [key, runs] of grouped) {
    const [term, scen] = key.split('|');
    detailRows.push([
      term,
      scen,
      avg(runs, r => r.metrics.totalTimeMs).toFixed(1),
      avg(runs, r => r.metrics.avgFps).toFixed(1),
      avg(runs, r => r.metrics.throughputMBps).toFixed(2),
      String(runs.length),
    ]);
  }

  // --- Comparison table ---
  const byScenario = new Map<string, { rt: number; xt: number }>();
  for (const [key, runs] of grouped) {
    const [terminal, scenario] = key.split('|');
    const mbps = avg(runs, r => r.metrics.throughputMBps);
    if (!byScenario.has(scenario)) byScenario.set(scenario, { rt: 0, xt: 0 });
    const entry = byScenario.get(scenario)!;
    if (terminal === 'react-term') entry.rt = mbps;
    else entry.xt = mbps;
  }

  const compCols = ['Scenario', 'react-term (MB/s)', 'xterm (MB/s)', 'Speedup'];
  const compRows: string[][] = [];
  for (const [scenario, { rt, xt }] of byScenario) {
    const speedup = xt > 0 ? `${(rt / xt).toFixed(1)}x` : '-';
    compRows.push([scenario, rt.toFixed(2), xt.toFixed(2), speedup]);
  }

  // --- Box-drawing table printer ---
  function printTable(title: string, cols: string[], rows: string[][]) {
    const widths = cols.map((c, i) =>
      Math.max(c.length, ...rows.map(r => r[i].length))
    );
    const pad = (s: string, w: number) => s + ' '.repeat(w - s.length);
    const line = (left: string, mid: string, right: string, fill: string) =>
      left + widths.map(w => fill.repeat(w + 2)).join(mid) + right;

    console.log(`\n${title}`);
    console.log(line('┌', '┬', '┐', '─'));
    console.log('│ ' + cols.map((c, i) => pad(c, widths[i])).join(' │ ') + ' │');
    console.log(line('├', '┼', '┤', '─'));
    for (let r = 0; r < rows.length; r++) {
      console.log('│ ' + rows[r].map((c, i) => pad(c, widths[i])).join(' │ ') + ' │');
      if (r < rows.length - 1) console.log(line('├', '┼', '┤', '─'));
    }
    console.log(line('└', '┴', '┘', '─'));
  }

  printTable('=== Benchmark Results ===', detailCols, detailRows);
  printTable('=== Throughput Comparison ===', compCols, compRows);

  console.log(`\nWrote ${allResults.length} results to ${outPath}`);
  expect(allResults.length).toBeGreaterThan(0);
});
