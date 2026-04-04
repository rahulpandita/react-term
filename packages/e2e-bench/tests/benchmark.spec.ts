import { test, expect } from '@playwright/test';
import type { BenchmarkResult } from '../src/types.js';
import { computeStats } from '../src/stats.js';
import { groupBy, printTable } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALL_TERMINALS = ['react-term', 'xterm'] as const;
// Allow CI to run a single terminal via env var for parallel jobs
const TERMINAL_FILTER = process.env.BENCH_TERMINAL;
const TERMINALS = TERMINAL_FILTER
  ? ALL_TERMINALS.filter(t => t === TERMINAL_FILTER)
  : ALL_TERMINALS;

const SCENARIOS = [
  'ascii', 'real-world', 'sgr-color', 'scrolling', 'cursor-motion', 'unicode',
  'vte-dense-cells', 'vte-light-cells', 'vte-medium-cells', 'vte-cursor-motion',
  'vte-scrolling', 'vte-scrolling-fullscreen', 'vte-unicode',
] as const;
const WARMUP_RUNS = 2;
const MEASURED_RUNS = 15;

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
      await page.fill('input[type="number"]', String(WARMUP_RUNS + MEASURED_RUNS));

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
  const grouped = groupBy(allResults, r => `${r.terminal}|${r.scenario}`);

  // Discard warmup runs per terminal+scenario group
  for (const [key, runs] of grouped) {
    if (runs.length > WARMUP_RUNS) {
      grouped.set(key, runs.slice(WARMUP_RUNS));
    }
  }

  // --- Detailed results table ---
  const detailCols = ['Terminal', 'Scenario', 'Median (ms)', 'Mean (ms)', 'Stddev', 'CV%', 'MB/s (med)', 'Stable', 'Runs'];
  const detailRows: string[][] = [];
  let stableCount = 0;
  let totalConfigs = 0;

  for (const [key, runs] of grouped) {
    const [term, scen] = key.split('|');
    const timeStats = computeStats(runs.map(r => r.metrics.totalTimeMs));
    const throughputStats = computeStats(runs.map(r => r.metrics.throughputMBps));
    totalConfigs++;
    if (timeStats.stable) stableCount++;

    detailRows.push([
      term,
      scen,
      timeStats.median.toFixed(1),
      timeStats.mean.toFixed(1),
      timeStats.stddev.toFixed(1),
      (timeStats.cv * 100).toFixed(1) + '%',
      throughputStats.median.toFixed(2),
      timeStats.stable ? '✓' : '✗',
      `${timeStats.filtered.length}/${runs.length}`,
    ]);
  }

  // --- Comparison table ---
  const byScenario = new Map<string, { rt: number; xt: number; rtStable: boolean; xtStable: boolean }>();
  for (const [key, runs] of grouped) {
    const [terminal, scenario] = key.split('|');
    const throughputStats = computeStats(runs.map(r => r.metrics.throughputMBps));
    const timeStats = computeStats(runs.map(r => r.metrics.totalTimeMs));
    const medianMbps = throughputStats.median;
    if (!byScenario.has(scenario)) byScenario.set(scenario, { rt: 0, xt: 0, rtStable: false, xtStable: false });
    const entry = byScenario.get(scenario)!;
    if (terminal === 'react-term') {
      entry.rt = medianMbps;
      entry.rtStable = timeStats.stable;
    } else {
      entry.xt = medianMbps;
      entry.xtStable = timeStats.stable;
    }
  }

  const compCols = ['Scenario', 'react-term (MB/s)', 'xterm (MB/s)', 'Speedup', 'Stable'];
  const compRows: string[][] = [];
  for (const [scenario, { rt, xt, rtStable, xtStable }] of byScenario) {
    const speedup = xt > 0 ? `${(rt / xt).toFixed(1)}x` : '-';
    const stable = rtStable && xtStable ? '✓' : '✗';
    compRows.push([scenario, rt.toFixed(2), xt.toFixed(2), speedup, stable]);
  }

  printTable('=== Benchmark Results ===', detailCols, detailRows);
  printTable('=== Throughput Comparison ===', compCols, compRows);

  console.log(`\n${stableCount} of ${totalConfigs} configs had stable results (CV < 10%)`);
  console.log(`\nWrote ${allResults.length} results to ${outPath}`);
  expect(allResults.length).toBeGreaterThan(0);
});
