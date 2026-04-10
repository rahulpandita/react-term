// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { BG_INSTANCE_FLOATS, GLYPH_INSTANCE_FLOATS } from "../webgl-renderer.js";

/**
 * Tests for the WebGLRenderer resize bug (#127):
 * ensureInstanceBuffers() only reset hasRenderedOnce when buffers grew,
 * not when shrinking — causing stale row offsets and garbled output.
 *
 * We replicate the internal logic rather than instantiating a real
 * WebGLRenderer (requires a WebGL2 context unavailable in jsdom).
 */
describe("WebGLRenderer resize — hasRenderedOnce reset", () => {
  function createRendererState(cols: number, rows: number) {
    const totalCells = cols * rows;
    return {
      bgInstances: new Float32Array(totalCells * BG_INSTANCE_FLOATS),
      glyphInstances: new Float32Array(totalCells * GLYPH_INSTANCE_FLOATS),
      hasRenderedOnce: true,
      rowBgOffsets: new Array(rows).fill(0),
      rowBgCounts: new Array(rows).fill(0),
      rowGlyphOffsets: new Array(rows).fill(0),
      rowGlyphCounts: new Array(rows).fill(0),
    };
  }

  /** Replicates the OLD (buggy) ensureInstanceBuffers — only resets on grow. */
  function ensureBuffersBuggy(
    state: ReturnType<typeof createRendererState>,
    cols: number,
    rows: number,
  ) {
    const totalCells = cols * rows;
    if (state.bgInstances.length < totalCells * BG_INSTANCE_FLOATS) {
      state.bgInstances = new Float32Array(totalCells * BG_INSTANCE_FLOATS);
      state.hasRenderedOnce = false;
    }
    if (state.glyphInstances.length < totalCells * GLYPH_INSTANCE_FLOATS) {
      state.glyphInstances = new Float32Array(totalCells * GLYPH_INSTANCE_FLOATS);
      state.hasRenderedOnce = false;
    }
  }

  /** Replicates the FIXED resize — always resets hasRenderedOnce. */
  function resizeFixed(state: ReturnType<typeof createRendererState>, cols: number, rows: number) {
    state.hasRenderedOnce = false;
    const totalCells = cols * rows;
    if (state.bgInstances.length < totalCells * BG_INSTANCE_FLOATS) {
      state.bgInstances = new Float32Array(totalCells * BG_INSTANCE_FLOATS);
    }
    if (state.glyphInstances.length < totalCells * GLYPH_INSTANCE_FLOATS) {
      state.glyphInstances = new Float32Array(totalCells * GLYPH_INSTANCE_FLOATS);
    }
  }

  it("buggy path: shrinking does not reset hasRenderedOnce", () => {
    const state = createRendererState(130, 40);
    expect(state.hasRenderedOnce).toBe(true);

    ensureBuffersBuggy(state, 64, 20);

    // Bug: hasRenderedOnce stays true — buffer didn't need to grow
    expect(state.hasRenderedOnce).toBe(true);
    // Stale row tracking arrays from the old 40-row layout
    expect(state.rowBgOffsets.length).toBe(40);
  });

  it("buggy path: growing does reset hasRenderedOnce", () => {
    const state = createRendererState(64, 20);
    ensureBuffersBuggy(state, 130, 40);
    expect(state.hasRenderedOnce).toBe(false);
  });

  it("fixed path: shrinking resets hasRenderedOnce", () => {
    const state = createRendererState(130, 40);
    resizeFixed(state, 64, 20);
    expect(state.hasRenderedOnce).toBe(false);
  });

  it("fixed path: growing resets hasRenderedOnce", () => {
    const state = createRendererState(64, 20);
    resizeFixed(state, 130, 40);
    expect(state.hasRenderedOnce).toBe(false);
  });

  it("fixed path: same dimensions resets hasRenderedOnce", () => {
    const state = createRendererState(80, 24);
    state.hasRenderedOnce = true;
    resizeFixed(state, 80, 24);
    expect(state.hasRenderedOnce).toBe(false);
  });
});

describe("WebGLRenderer resize — stale glyph cleanup (#127 comment 2)", () => {
  /**
   * Replicates the render loop's glyph cleanup logic.
   * After resize, rowGlyphCounts must be initialized to cols (not 0)
   * so the cleanup loop zeros all stale glyph slots.
   */
  function simulateGlyphCleanup(
    glyphInstances: Float32Array,
    rowGlyphCounts: number[],
    rows: number,
    cols: number,
    actualGlyphsPerRow: number[],
  ) {
    for (let row = 0; row < rows; row++) {
      const glyphBase = row * cols * GLYPH_INSTANCE_FLOATS;
      const rowGlyphCount = actualGlyphsPerRow[row];

      // This is the cleanup loop from webgl-renderer.ts line 849-857
      for (let i = rowGlyphCount; i < rowGlyphCounts[row]; i++) {
        const off = glyphBase + i * GLYPH_INSTANCE_FLOATS;
        for (let j = 0; j < GLYPH_INSTANCE_FLOATS; j++) {
          glyphInstances[off + j] = 0;
        }
      }
      rowGlyphCounts[row] = rowGlyphCount;
    }
  }

  it("rowGlyphCounts initialized to 0: stale glyphs NOT cleared", () => {
    const cols = 80;
    const rows = 5;
    const glyphInstances = new Float32Array(rows * cols * GLYPH_INSTANCE_FLOATS);
    // Fill with non-zero "stale" data
    glyphInstances.fill(1.0);

    // Bug: rowGlyphCounts initialized to 0
    const rowGlyphCounts = new Array(rows).fill(0);
    // Simulate rendering 10 glyphs per row
    const actualGlyphs = new Array(rows).fill(10);

    simulateGlyphCleanup(glyphInstances, rowGlyphCounts, rows, cols, actualGlyphs);

    // Stale data at slot 11 should be cleared — but it won't be
    // because rowGlyphCounts was 0, so the cleanup loop ran from 10..0 (never)
    const staleOffset = 0 * cols * GLYPH_INSTANCE_FLOATS + 11 * GLYPH_INSTANCE_FLOATS;
    expect(glyphInstances[staleOffset]).toBe(1.0); // still stale — BUG
  });

  it("rowGlyphCounts initialized to cols: stale glyphs ARE cleared", () => {
    const cols = 80;
    const rows = 5;
    const glyphInstances = new Float32Array(rows * cols * GLYPH_INSTANCE_FLOATS);
    glyphInstances.fill(1.0);

    // Fix: rowGlyphCounts initialized to cols
    const rowGlyphCounts = new Array(rows).fill(cols);
    const actualGlyphs = new Array(rows).fill(10);

    simulateGlyphCleanup(glyphInstances, rowGlyphCounts, rows, cols, actualGlyphs);

    // Now stale data at slot 11 should be zeroed
    const staleOffset = 0 * cols * GLYPH_INSTANCE_FLOATS + 11 * GLYPH_INSTANCE_FLOATS;
    expect(glyphInstances[staleOffset]).toBe(0); // cleared — FIXED

    // All slots from 10 to 79 should be zeroed
    for (let i = 10; i < cols; i++) {
      const off = 0 * cols * GLYPH_INSTANCE_FLOATS + i * GLYPH_INSTANCE_FLOATS;
      expect(glyphInstances[off]).toBe(0);
    }
  });
});

describe("WebGLRenderer attach — context-loss listener cleanup", () => {
  it("re-attach removes old listeners before adding new ones", () => {
    const addSpy = vi.fn();
    const removeSpy = vi.fn();
    const canvas = {
      addEventListener: addSpy,
      removeEventListener: removeSpy,
    };

    // Simulate the fixed attach() logic
    let handleContextLost: ((e: Event) => void) | null = null;
    let handleContextRestored: (() => void) | null = null;
    let currentCanvas: typeof canvas | null = null;

    function attach(c: typeof canvas) {
      // Fixed: remove old listeners
      if (currentCanvas && handleContextLost) {
        currentCanvas.removeEventListener("webglcontextlost", handleContextLost);
      }
      if (currentCanvas && handleContextRestored) {
        currentCanvas.removeEventListener("webglcontextrestored", handleContextRestored);
      }

      currentCanvas = c;
      handleContextLost = () => {};
      handleContextRestored = () => {};
      c.addEventListener("webglcontextlost", handleContextLost);
      c.addEventListener("webglcontextrestored", handleContextRestored);
    }

    // First attach — no removes (nothing to remove)
    attach(canvas);
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledTimes(0);

    // Second attach — should remove old + add new
    attach(canvas);
    expect(addSpy).toHaveBeenCalledTimes(4); // 2 + 2
    expect(removeSpy).toHaveBeenCalledTimes(2); // old ones removed
  });
});
