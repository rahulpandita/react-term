import { describe, expect, it } from "vitest";
import { SOFTWARE_RENDERER_RE } from "../web-terminal.js";

describe("SOFTWARE_RENDERER_RE", () => {
  it.each([
    ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)"],
    ["llvmpipe (LLVM 15.0, 256 bits)"],
    ["Google SwiftShader"],
    ["Microsoft Basic Render Driver"],
    // Windows Advanced Rasterization Platform — Azure VMs / RDP.
    ["Microsoft Corporation - WARP"],
    ["Apple Software Renderer"],
  ])("matches software renderer %s", (s) => {
    expect(SOFTWARE_RENDERER_RE.test(s)).toBe(true);
  });

  it.each([
    ["NVIDIA Corporation"],
    ["NVIDIA GeForce RTX 4090"],
    ["AMD Radeon Pro 560X OpenGL Engine"],
    ["Intel(R) Iris(TM) Plus Graphics 640"],
    ["Apple M2 Pro"],
    ["Mesa DRI Intel(R) HD Graphics (Broadwell GT2)"],
  ])("does not match hardware renderer %s", (s) => {
    expect(SOFTWARE_RENDERER_RE.test(s)).toBe(false);
  });
});
