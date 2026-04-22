/**
 * Software-GPU mux benchmark.
 *
 * Mirrors mux-benchmark.spec.ts but forces the browser onto SwiftShader so
 * we can reproduce the Linux-CI / software-WebGL condition on any machine.
 * Captures a CPU profile for one representative cell (react-term, 8 panes)
 * so we can load it in DevTools for a flame graph.
 *
 * Output naming includes an env-configurable label so A/B runs across git
 * branches are easy to tell apart — e.g. `BENCH_LABEL=canvas2d-worker pnpm bench`.
 */
import { type CDPSession, expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeStats } from "../src/stats.js";
import type { MultiPaneResult } from "../src/types.js";
import { groupBy, printTable } from "./test-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TERMINALS = ["react-term", "xterm"] as const;
const PANE_COUNTS = [2, 4, 8, 16] as const;
const SCENARIO = "sgr-color";
const WARMUP_RUNS = 2;
const MEASURED_RUNS = 5;
const LABEL = process.env.BENCH_LABEL ?? "unlabelled";

// Profile one representative cell (react-term, the middle pane count) to keep
// the overhead of tracing out of the numbers that matter.
const PROFILE_TERMINAL = "react-term";
const PROFILE_PANE_COUNT = 8;

test.use({
  launchOptions: {
    args: [
      "--enable-features=SharedArrayBuffer",
      "--disable-gpu",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  },
});

test("mux benchmark (software GPU)", async ({ page }) => {
  // Surface page console output so we can verify the renderer path each cell
  // actually took (e.g. "SharedWebGLContext init failed" → per-pane fallback).
  const rendererLogs: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (
      text.includes("SharedWebGLContext") ||
      text.includes("Render worker error") ||
      text.includes("Software renderer")
    ) {
      rendererLogs.push(`[${msg.type()}] ${text}`);
    }
  });

  const allResults: MultiPaneResult[] = [];
  let profileSaved = false;

  for (const terminal of TERMINALS) {
    for (const paneCount of PANE_COUNTS) {
      await page.goto("http://localhost:5174?mode=mux");
      await expect(page.locator("select").nth(1)).not.toBeEmpty({ timeout: 10_000 });

      await page.selectOption("select >> nth=0", terminal);

      const options = await page.locator("select >> nth=1 >> option").allTextContents();
      if (!options.includes(SCENARIO)) {
        console.log(`Scenario "${SCENARIO}" not available, skipping`);
        continue;
      }

      await page.selectOption("select >> nth=1", SCENARIO);
      await page.selectOption('[data-testid="pane-count"]', String(paneCount));
      await page.fill('input[type="number"]', String(WARMUP_RUNS + MEASURED_RUNS));

      // CPU profile for the designated cell. We start right before the bench
      // begins and stop right after — tracing the whole run would include
      // page-nav setup and skew the flame graph.
      const shouldProfile =
        !profileSaved && terminal === PROFILE_TERMINAL && paneCount === PROFILE_PANE_COUNT;
      let cdp: CDPSession | null = null;
      if (shouldProfile) {
        cdp = await page.context().newCDPSession(page);
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.start");
      }

      await page.click('button:has-text("Start Benchmark")');

      await page.waitForSelector('[data-testid="status"][data-value="complete"]', {
        timeout: 10 * 60 * 1000,
      });

      if (cdp) {
        const { profile } = await cdp.send("Profiler.stop");
        const resultsDir = path.resolve(__dirname, "..", "results");
        if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
        const profilePath = path.join(resultsDir, `cpuprofile-${LABEL}.cpuprofile`);
        fs.writeFileSync(profilePath, JSON.stringify(profile));
        console.log(`Wrote CPU profile to ${profilePath}`);
        profileSaved = true;
      }

      const results = await page.evaluate(() => window.__allMultiPaneResults ?? []);
      allResults.push(...(results as MultiPaneResult[]));
    }
  }

  const resultsDir = path.resolve(__dirname, "..", "results");
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(resultsDir, `mux-benchmark-sw-${LABEL}-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));

  const allGrouped = groupBy(allResults, (r) => `${r.terminal}|${r.paneCount}`);

  const grouped = new Map<string, MultiPaneResult[]>();
  for (const [key, runs] of allGrouped) {
    grouped.set(key, runs.length > WARMUP_RUNS ? runs.slice(WARMUP_RUNS) : runs);
  }

  const compCols = [
    "Terminal",
    "Panes",
    "MB/s",
    "Frame p50 (ms)",
    "Frame p90 (ms)",
    "Frame p99 (ms)",
    "Idle (ms)",
    "setTimeout Avg",
    "setTimeout Max",
  ];
  const compRows: string[][] = [];
  for (const [key, runs] of grouped) {
    const [term, panes] = key.split("|");
    compRows.push([
      term,
      panes,
      computeStats(runs.map((r) => r.metrics.throughputMBps)).median.toFixed(2),
      computeStats(runs.map((r) => r.metrics.frameTimeP50)).median.toFixed(1),
      computeStats(runs.map((r) => r.metrics.frameTimeP90)).median.toFixed(1),
      computeStats(runs.map((r) => r.metrics.frameTimeP99)).median.toFixed(1),
      computeStats(runs.map((r) => r.metrics.timeToIdleMs)).median.toFixed(1),
      computeStats(runs.map((r) => r.responsiveness.avgSetTimeoutDelay)).median.toFixed(2),
      computeStats(runs.map((r) => r.responsiveness.maxSetTimeoutDelay)).median.toFixed(2),
    ]);
  }

  printTable(
    `=== Mux Benchmark Results — software GPU, label=${LABEL} ===`,
    compCols,
    compRows,
  );

  if (rendererLogs.length > 0) {
    console.log("\n--- Renderer-path console logs ---");
    for (const line of rendererLogs.slice(0, 40)) console.log(line);
    if (rendererLogs.length > 40) {
      console.log(`... (${rendererLogs.length - 40} more suppressed)`);
    }
  }

  console.log(`\nWrote ${allResults.length} results to ${outPath}`);
  expect(allResults.length).toBeGreaterThan(0);
});
