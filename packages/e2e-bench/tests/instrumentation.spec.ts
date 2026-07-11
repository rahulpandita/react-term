import { expect, test } from "@playwright/test";
import type { BenchmarkResult } from "../src/types.js";

for (const terminal of ["react-term", "xterm"] as const) {
  test(`${terminal} reports distinct benchmark milestones`, async ({ page }) => {
    await page.goto("http://localhost:5174");
    await expect(page.locator("select").nth(1)).not.toBeEmpty({ timeout: 10_000 });

    await page.selectOption("select >> nth=0", terminal);
    await page.selectOption("select >> nth=1", "ascii");
    await page.fill('input[type="number"]', "1");
    await page.click('button:has-text("Start Benchmark")');
    await page.waitForSelector('[data-testid="status"][data-value="complete"]', {
      timeout: 120_000,
    });

    const result = await page.evaluate(() => window.__lastBenchmarkResult) as
      | BenchmarkResult
      | undefined;
    expect(result).toBeDefined();

    const metrics = result!.metrics;
    expect(metrics.receiveTimeMs).toBeGreaterThan(0);
    expect(metrics.processingTimeMs).toBeGreaterThan(0);
    expect(metrics.totalTimeMs).toBeGreaterThanOrEqual(
      Math.max(metrics.receiveTimeMs, metrics.processingTimeMs),
    );
    expect(metrics.throughputMBps).toBeGreaterThan(0);
    expect(metrics.receiveThroughputMBps).toBeGreaterThan(0);
    expect(metrics.endToEndThroughputMBps).toBeGreaterThan(0);
    expect(metrics.postReceiveProcessingMs).toBeGreaterThanOrEqual(0);
    expect(metrics.processingToIdleMs).toBeGreaterThanOrEqual(0);
    expect(metrics.mainThreadFrameAfterProcessingMs).toBeGreaterThanOrEqual(0);

    if (terminal === "react-term") {
      expect(metrics.parserCpuDurationMs).not.toBeNull();
      expect(metrics.parserCpuDurationMs).toBeGreaterThanOrEqual(0);
    } else {
      expect(metrics.parserCpuDurationMs).toBeNull();
    }
  });
}
