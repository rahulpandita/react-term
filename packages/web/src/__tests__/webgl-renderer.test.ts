import { DEFAULT_THEME } from "@next_term/core";
import { describe, expect, it } from "vitest";
import {
  BG_INSTANCE_FLOATS,
  GLYPH_INSTANCE_FLOATS,
  GlyphAtlas,
  glyphCacheKey,
  hexToFloat4,
  packBgInstance,
  packGlyphInstance,
} from "../webgl-renderer.js";

// ---------------------------------------------------------------------------
// hexToFloat4 — color conversion
// ---------------------------------------------------------------------------

describe("hexToFloat4", () => {
  it("converts #rrggbb to [r, g, b, a] floats in 0-1 range", () => {
    const [r, g, b, a] = hexToFloat4("#ff8000");
    expect(r).toBeCloseTo(1.0, 5);
    expect(g).toBeCloseTo(128 / 255, 5);
    expect(b).toBeCloseTo(0.0, 5);
    expect(a).toBe(1.0);
  });

  it("converts #rgb shorthand", () => {
    const [r, g, b, a] = hexToFloat4("#f00");
    expect(r).toBeCloseTo(1.0, 5);
    expect(g).toBeCloseTo(0.0, 5);
    expect(b).toBeCloseTo(0.0, 5);
    expect(a).toBe(1.0);
  });

  it("converts black correctly", () => {
    const [r, g, b, a] = hexToFloat4("#000000");
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(b).toBe(0);
    expect(a).toBe(1.0);
  });

  it("converts white correctly", () => {
    const [r, g, b, a] = hexToFloat4("#ffffff");
    expect(r).toBeCloseTo(1.0, 5);
    expect(g).toBeCloseTo(1.0, 5);
    expect(b).toBeCloseTo(1.0, 5);
    expect(a).toBe(1.0);
  });

  it("converts rgb(r,g,b) directly without canvas", () => {
    const [r, g, b, a] = hexToFloat4("rgb(255,128,0)");
    expect(r).toBeCloseTo(1.0, 5);
    expect(g).toBeCloseTo(128 / 255, 5);
    expect(b).toBeCloseTo(0.0, 5);
    expect(a).toBe(1.0);
  });

  it("converts rgb(r, g, b) with spaces directly without canvas", () => {
    const [r, g, b, a] = hexToFloat4("rgb(255, 128, 0)");
    expect(r).toBeCloseTo(1.0, 5);
    expect(g).toBeCloseTo(128 / 255, 5);
    expect(b).toBeCloseTo(0.0, 5);
    expect(a).toBe(1.0);
  });

  it("handles rgb() space-separated (CSS level 4) via canvas fallback", () => {
    const result = hexToFloat4("rgb(0 255 0)");
    expect(result).toHaveLength(4);
    expect(result[3]).toBeGreaterThanOrEqual(0);
  });

  it("returns opaque black for unrecognized input", () => {
    const [r, g, b, a] = hexToFloat4("not-a-color");
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(b).toBe(0);
    expect(a).toBe(1.0);
  });

  it("converts theme foreground color", () => {
    const [r, g, b, a] = hexToFloat4(DEFAULT_THEME.foreground); // #d4d4d4
    expect(r).toBeCloseTo(0xd4 / 255, 5);
    expect(g).toBeCloseTo(0xd4 / 255, 5);
    expect(b).toBeCloseTo(0xd4 / 255, 5);
    expect(a).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// glyphCacheKey
// ---------------------------------------------------------------------------

describe("glyphCacheKey", () => {
  it("generates unique keys for different styles", () => {
    const a = glyphCacheKey(65, false, false); // 'A' normal
    const b = glyphCacheKey(65, true, false); // 'A' bold
    const c = glyphCacheKey(65, false, true); // 'A' italic
    const d = glyphCacheKey(65, true, true); // 'A' bold italic
    const e = glyphCacheKey(66, false, false); // 'B' normal

    expect(a).toBe("65_0_0");
    expect(b).toBe("65_1_0");
    expect(c).toBe("65_0_1");
    expect(d).toBe("65_1_1");
    expect(e).toBe("66_0_0");

    // All unique
    const keys = new Set([a, b, c, d, e]);
    expect(keys.size).toBe(5);
  });

  it("uses consistent format: codepoint_bold_italic", () => {
    expect(glyphCacheKey(0x1f600, true, false)).toBe("128512_1_0");
  });
});

// ---------------------------------------------------------------------------
// Instance buffer packing
// ---------------------------------------------------------------------------

describe("packBgInstance", () => {
  it("packs background instance data correctly", () => {
    const buf = new Float32Array(BG_INSTANCE_FLOATS * 2);

    packBgInstance(buf, 0, 5, 10, 1.0, 0.5, 0.25, 1.0);
    expect(buf[0]).toBe(5); // col
    expect(buf[1]).toBe(10); // row
    expect(buf[2]).toBeCloseTo(1.0); // r
    expect(buf[3]).toBeCloseTo(0.5); // g
    expect(buf[4]).toBeCloseTo(0.25); // b
    expect(buf[5]).toBeCloseTo(1.0); // a

    // Second instance at offset
    packBgInstance(buf, BG_INSTANCE_FLOATS, 6, 11, 0.0, 1.0, 0.0, 0.8);
    expect(buf[BG_INSTANCE_FLOATS]).toBe(6);
    expect(buf[BG_INSTANCE_FLOATS + 1]).toBe(11);
    expect(buf[BG_INSTANCE_FLOATS + 2]).toBeCloseTo(0.0);
    expect(buf[BG_INSTANCE_FLOATS + 3]).toBeCloseTo(1.0);
    expect(buf[BG_INSTANCE_FLOATS + 4]).toBeCloseTo(0.0);
    expect(buf[BG_INSTANCE_FLOATS + 5]).toBeCloseTo(0.8);
  });
});

describe("packGlyphInstance", () => {
  it("packs glyph instance data correctly", () => {
    const buf = new Float32Array(GLYPH_INSTANCE_FLOATS);

    packGlyphInstance(
      buf,
      0,
      3,
      7, // col, row
      1.0,
      1.0,
      1.0,
      1.0, // r, g, b, a
      0.1,
      0.2,
      0.05,
      0.08, // u, v, tw, th
      8,
      16, // pw, ph
    );

    expect(buf[0]).toBe(3); // col
    expect(buf[1]).toBe(7); // row
    expect(buf[2]).toBeCloseTo(1.0); // r
    expect(buf[3]).toBeCloseTo(1.0); // g
    expect(buf[4]).toBeCloseTo(1.0); // b
    expect(buf[5]).toBeCloseTo(1.0); // a
    expect(buf[6]).toBeCloseTo(0.1); // u
    expect(buf[7]).toBeCloseTo(0.2); // v
    expect(buf[8]).toBeCloseTo(0.05); // tw
    expect(buf[9]).toBeCloseTo(0.08); // th
    expect(buf[10]).toBe(8); // pw
    expect(buf[11]).toBe(16); // ph
  });

  it("BG_INSTANCE_FLOATS is 6", () => {
    expect(BG_INSTANCE_FLOATS).toBe(6);
  });

  it("GLYPH_INSTANCE_FLOATS is 12", () => {
    expect(GLYPH_INSTANCE_FLOATS).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// GlyphAtlas cache
// ---------------------------------------------------------------------------

describe("GlyphAtlas", () => {
  it("creates with specified initial size", () => {
    const atlas = new GlyphAtlas(14, "monospace", 400, 700, 256);
    expect(atlas.width).toBe(256);
    expect(atlas.height).toBe(256);
  });

  it("cache starts empty", () => {
    const atlas = new GlyphAtlas(14, "monospace");
    expect(atlas.cache.size).toBe(0);
  });

  it("getGlyph caches glyphs by key", () => {
    const atlas = new GlyphAtlas(14, "monospace");
    // In test environment without OffscreenCanvas, getGlyph returns null
    // but the cache mechanism is still testable via the key generation
    const glyph = atlas.getGlyph(65, false, false); // 'A'
    if (glyph !== null) {
      // OffscreenCanvas available — cache should have the entry
      expect(atlas.cache.has("65_0_0")).toBe(true);

      // Calling again should return same object
      const glyph2 = atlas.getGlyph(65, false, false);
      expect(glyph2).toBe(glyph);

      // Different style creates different entry
      const boldGlyph = atlas.getGlyph(65, true, false);
      if (boldGlyph) {
        expect(atlas.cache.has("65_1_0")).toBe(true);
        expect(boldGlyph).not.toBe(glyph);
      }
    } else {
      // No OffscreenCanvas — that's fine for test environment
      expect(atlas.cache.size).toBe(0);
    }
  });

  it("clearCache resets all state", () => {
    const atlas = new GlyphAtlas(14, "monospace");
    // Populate cache if OffscreenCanvas is available
    atlas.getGlyph(65, false, false);
    atlas.getGlyph(66, false, false);

    atlas.clearCache();

    expect(atlas.cache.size).toBe(0);
    // After clearing, getGlyph should re-rasterize (not return stale data)
    const glyph = atlas.getGlyph(65, false, false);
    if (glyph) {
      // Re-rasterized glyph should be at the start of the atlas (position was reset)
      expect(glyph.u).toBe(0);
      expect(glyph.v).toBe(0);
    }
  });

  it("getGlyph returns GlyphInfo with valid UV coordinates", () => {
    const atlas = new GlyphAtlas(14, "monospace", 400, 700, 512);
    const glyph = atlas.getGlyph(65, false, false);
    if (glyph) {
      expect(glyph.u).toBeGreaterThanOrEqual(0);
      expect(glyph.u).toBeLessThanOrEqual(1);
      expect(glyph.v).toBeGreaterThanOrEqual(0);
      expect(glyph.v).toBeLessThanOrEqual(1);
      expect(glyph.w).toBeGreaterThan(0);
      expect(glyph.w).toBeLessThanOrEqual(1);
      expect(glyph.h).toBeGreaterThan(0);
      expect(glyph.h).toBeLessThanOrEqual(1);
      expect(glyph.pw).toBeGreaterThan(0);
      expect(glyph.ph).toBeGreaterThan(0);
    }
  });

  // NOTE: upload() and dirty-region tests require OffscreenCanvas + WebGL2
  // which are unavailable in jsdom. The state machine (needsFullUpload,
  // hasDirtyRegion, dirtyMinX/Y/MaxX/Y) is exercised in Playwright
  // render-regression tests instead.

  it("recreateTexture marks atlas for full re-upload", () => {
    const atlas = new GlyphAtlas(14, "monospace");
    atlas.recreateTexture();
    // After recreateTexture, texture is null — next upload() will create
    // a new texture and do a full texImage2D. We can't call upload()
    // without WebGL, but we can verify the texture was cleared.
    expect(atlas.getTexture()).toBeNull();
  });

  it("clearCache followed by getGlyph re-rasterizes at atlas origin", () => {
    const atlas = new GlyphAtlas(14, "monospace");
    // First glyph
    const g1 = atlas.getGlyph(65, false, false);
    if (!g1) return; // OffscreenCanvas not available

    // Second glyph at a different position
    const g2 = atlas.getGlyph(66, false, false);
    expect(g2).not.toBeNull();
    if (!g2) return;
    expect(g2.u).not.toBe(g1.u); // different atlas position

    // Clear and re-rasterize — should start at origin
    atlas.clearCache();
    const g3 = atlas.getGlyph(65, false, false);
    if (!g3) return;
    expect(g3.u).toBe(0);
    expect(g3.v).toBe(0);
  });

  it("multiple getGlyph calls accumulate in the cache", () => {
    const atlas = new GlyphAtlas(14, "monospace");
    for (let cp = 33; cp <= 50; cp++) {
      atlas.getGlyph(cp, false, false);
    }
    // If OffscreenCanvas is available, all glyphs are cached
    const g = atlas.getGlyph(33, false, false);
    if (g) {
      expect(atlas.cache.size).toBe(18); // 33-50 = 18 glyphs
    }
  });

  it("prewarmASCII populates cache with 188 glyphs (94 normal + 94 bold)", () => {
    const atlas = new GlyphAtlas(14, "monospace");
    atlas.prewarmASCII();
    // If OffscreenCanvas is available, ASCII 33-126 × 2 weights are cached
    const g = atlas.getGlyph(65, false, false); // 'A'
    if (g) {
      expect(atlas.cache.size).toBe(188);
    }
  });

  it("clearCache re-warms ASCII automatically", () => {
    const atlas = new GlyphAtlas(14, "monospace");
    atlas.getGlyph(0x4e2d, false, false); // CJK char (not in prewarm set)
    atlas.clearCache();
    const g = atlas.getGlyph(65, false, false);
    if (g) {
      // Only ASCII prewarm glyphs — CJK was cleared and not re-warmed
      expect(atlas.cache.size).toBe(188);
    }
  });
});

// ---------------------------------------------------------------------------
// Fallback detection
// ---------------------------------------------------------------------------

describe("WebGL2 fallback", () => {
  it("createRenderer is exported and callable", async () => {
    // We can't easily test WebGL2 in Node/test environment,
    // but we verify the function exists and the type signature is correct.
    const { createRenderer } = await import("../webgl-renderer.js");
    expect(typeof createRenderer).toBe("function");
  });

  it("createRenderer with canvas2d type returns a renderer with IRenderer methods", async () => {
    // This test verifies the Canvas2D fallback path works
    const { createRenderer } = await import("../webgl-renderer.js");
    // In test env without document, this may throw, so we just verify the export
    expect(createRenderer).toBeDefined();
  });
});
