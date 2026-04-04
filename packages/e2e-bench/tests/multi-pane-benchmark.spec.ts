import { test, expect } from '@playwright/test';
import type { MultiPaneResult } from '../src/types.js';
import { computeStats } from '../src/stats.js';
import { groupBy, printTable } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TERMINALS = ['react-term', 'xterm'] as const;
const PANE_COUNTS = [2, 4, 6] as const;
const SCENARIO = 'sgr-color';
const WARMUP_RUNS = 2;
const MEASURED_RUNS = 5;

test('multi-pane benchmark matrix', async ({ page }) => {
  const allResults: MultiPaneResult[] = [];

  for (const terminal of TERMINALS) {
    for (const paneCount of PANE_COUNTS) {
      await page.goto('http://localhost:5174?mode=multi-pane');
      await expect(page.locator('select').nth(1)).not.toBeEmpty({ timeout: 10_000 });

      await page.selectOption('select >> nth=0', terminal);

      const options = await page.locator('select >> nth=1 >> option').allTextContents();
      if (!options.includes(SCENARIO)) {
        console.log(`Scenario "${SCENARIO}" not available, skipping`);
        continue;
      }

      await page.selectOption('select >> nth=1', SCENARIO);
      await page.selectOption('[data-testid="pane-count"]', String(paneCount));
      await page.fill('input[type="number"]', String(WARMUP_RUNS + MEASURED_RUNS));
      await page.click('button:has-text("Start Benchmark")');

      await page.waitForSelector('[data-testid="status"][data-value="complete"]', {
        timeout: 10 * 60 * 1000,
      });

      const results = await page.evaluate(() => window.__allMultiPaneResults ?? []);
      allResults.push(...(results as MultiPaneResult[]));
    }
  }

  // Write results
  const resultsDir = path.resolve(__dirname, '..', 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(resultsDir, `multi-pane-benchmark-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));

  const allGrouped = groupBy(allResults, r => `${r.terminal}|${r.paneCount}`);

  // Discard warmup runs per group
  const grouped = new Map<string, MultiPaneResult[]>();
  for (const [key, runs] of allGrouped) {
    grouped.set(key, runs.length > WARMUP_RUNS ? runs.slice(WARMUP_RUNS) : runs);
  }

  // --- Comparison table (using median from computeStats) ---
  const compCols = [
    'Terminal', 'Panes', 'Throughput (MB/s)', 'Avg FPS',
    'setTimeout Avg (ms)', 'setTimeout Max (ms)', 'Long Tasks',
  ];
  const compRows: string[][] = [];
  for (const [key, runs] of grouped) {
    const [term, panes] = key.split('|');
    compRows.push([
      term,
      panes,
      computeStats(runs.map(r => r.metrics.throughputMBps)).median.toFixed(2),
      computeStats(runs.map(r => r.metrics.avgFps)).median.toFixed(1),
      computeStats(runs.map(r => r.responsiveness.avgSetTimeoutDelay)).median.toFixed(2),
      computeStats(runs.map(r => r.responsiveness.maxSetTimeoutDelay)).median.toFixed(2),
      computeStats(runs.map(r => r.metrics.longTaskCount)).median.toFixed(1),
    ]);
  }

  printTable('=== Multi-Pane Benchmark Results ===', compCols, compRows);

  // --- Detailed per-run table ---
  const detailCols = [
    'Terminal', 'Panes', 'Run', 'Time (ms)', 'MB/s', 'Avg FPS',
    'setTimeout Avg', 'setTimeout Max', 'Long Tasks', 'LT Duration (ms)',
  ];
  const detailRows: string[][] = [];
  for (const r of allResults) {
    detailRows.push([
      r.terminal,
      String(r.paneCount),
      String(r.run),
      r.metrics.totalTimeMs.toFixed(1),
      r.metrics.throughputMBps.toFixed(2),
      r.metrics.avgFps.toFixed(1),
      r.responsiveness.avgSetTimeoutDelay.toFixed(2),
      r.responsiveness.maxSetTimeoutDelay.toFixed(2),
      String(r.metrics.longTaskCount),
      r.metrics.longTaskDurationMs.toFixed(1),
    ]);
  }

  printTable('=== Detailed Per-Run Results ===', detailCols, detailRows);

  console.log(`\nWrote ${allResults.length} results to ${outPath}`);
  expect(allResults.length).toBeGreaterThan(0);
});
