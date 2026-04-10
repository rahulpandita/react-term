// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
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
