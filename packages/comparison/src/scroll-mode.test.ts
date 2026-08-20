import { describe, expect, it } from "vitest";
import {
  getComparisonScrollInputMode,
  getEmbeddedParentOrigin,
  shouldForwardEmbeddedTouch,
  shouldForwardEmbeddedWheel,
} from "./scroll-mode.js";

describe("getComparisonScrollInputMode", () => {
  it("leaves page scrolling to the showcase when embedded", () => {
    expect(getComparisonScrollInputMode(true)).toBe("page");
  });

  describe("getEmbeddedParentOrigin", () => {
    it("prefers an explicit parent origin over the referrer", () => {
      expect(
        getEmbeddedParentOrigin(
          "?parentOrigin=https%3A%2F%2Fshowcase.example%2Fpath",
          "https://referrer.example/page",
        ),
      ).toBe("https://showcase.example");
    });

    it("falls back to a non-sensitive wildcard when parent metadata is unavailable", () => {
      expect(getEmbeddedParentOrigin("", "")).toBe("*");
    });
  });

  describe("shouldForwardEmbeddedTouch", () => {
    it("forwards vertical page gestures", () => {
      expect(shouldForwardEmbeddedTouch(8, 40, false)).toBe(true);
    });

    it("preserves horizontal gestures and xterm viewport scrolling", () => {
      expect(shouldForwardEmbeddedTouch(40, 8, false)).toBe(false);
      expect(shouldForwardEmbeddedTouch(0, 40, true)).toBe(false);
    });
  });

  describe("shouldForwardEmbeddedWheel", () => {
    it("forwards vertical gestures while preserving horizontal and xterm scrolling", () => {
      expect(shouldForwardEmbeddedWheel(4, 40, false)).toBe(true);
      expect(shouldForwardEmbeddedWheel(40, 4, false)).toBe(false);
      expect(shouldForwardEmbeddedWheel(0, 40, true)).toBe(false);
    });
  });

  it("keeps terminal history gestures when opened standalone", () => {
    expect(getComparisonScrollInputMode(false)).toBe("terminal");
  });
});
