import { test, expect } from '@playwright/test';
import type { BenchmarkResult } from '../src/types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TERMINALS = ['react-term', 'xterm'] as const;
// Subset of scenarios for automated benchmarks (the heavy-hitters)
const SCENARIOS = ['ascii', 'real-world', 'sgr-color', 'scrolling', 'cursor-motion', 'unicode'] as const;
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

  // Print summary table
  const grouped = new Map<string, BenchmarkResult[]>();
  for (const r of allResults) {
    const key = `${r.terminal} | ${r.scenario}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  console.log('\n=== Benchmark Results ===');
  console.log('Terminal     | Scenario       | Avg Time (ms) | Avg FPS | MB/s   | Runs');
  console.log('-------------|----------------|---------------|---------|--------|-----');
  for (const [key, runs] of grouped) {
    const avgTime = runs.reduce((s, r) => s + (r.metrics.totalTimeMs ?? 0), 0) / runs.length;
    const avgFps = runs.reduce((s, r) => s + (r.metrics.avgFps ?? 0), 0) / runs.length;
    const avgMBps = runs.reduce((s, r) => s + (r.metrics.throughputMBps ?? 0), 0) / runs.length;
    const [term, scen] = key.split(' | ');
    console.log(
      `${term.padEnd(12)} | ${scen.padEnd(14)} | ${avgTime.toFixed(1).padStart(13)} | ${avgFps.toFixed(1).padStart(7)} | ${avgMBps.toFixed(2).padStart(6)} | ${runs.length}`
    );
  }

  console.log(`\nWrote ${allResults.length} results to ${outPath}`);
  expect(allResults.length).toBeGreaterThan(0);
});
