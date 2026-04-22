import { describe, expect, it } from "vitest";
import { pickWorkerBackend } from "../web-terminal.js";

describe("pickWorkerBackend", () => {
  it('renderer:"canvas2d" always picks canvas2d, regardless of WebGL2 probe', () => {
    expect(pickWorkerBackend("canvas2d", true)).toBe("canvas2d");
    expect(pickWorkerBackend("canvas2d", false)).toBe("canvas2d");
  });

  it('renderer:"webgl" always picks webgl2, even when the probe reports software', () => {
    // This is the M3 fix: an explicit `renderer:"webgl"` should honor the
    // force even if WebGL2 is backed by SwiftShader. Main thread doesn't
    // second-guess; user asked for it.
    expect(pickWorkerBackend("webgl", true)).toBe("webgl2");
    expect(pickWorkerBackend("webgl", false)).toBe("webgl2");
  });

  it('renderer:"auto" picks webgl2 when hardware WebGL2 is available', () => {
    expect(pickWorkerBackend("auto", true)).toBe("webgl2");
  });

  it('renderer:"auto" picks canvas2d when no hardware WebGL2 is available', () => {
    // Software WebGL2 is slower than Canvas2D for terminal rendering, so
    // auto-mode prefers Canvas2D to avoid the guaranteed fallback round-trip.
    expect(pickWorkerBackend("auto", false)).toBe("canvas2d");
  });
});
