/**
 * Tests for Kitty keyboard protocol — flag 4: report alternate keys.
 *
 * When kittyFlags & 4 is set (together with flag 1 for disambiguate), the
 * CSI u key encoding includes alternate key sub-parameters in the key
 * codepoint field:
 *
 *   CSI key-codepoint[:shifted-key[:base-layout-key]] ; modifier[:event-type] u
 *
 * - shifted-key:    codepoint of the key when Shift is held (omitted if same as main)
 * - base-layout-key: codepoint of the key on a US-QWERTY layout w/o modifiers
 *                   (omitted if same as main)
 *
 * Examples (flag 1+4, press event):
 *   Ctrl+a  → ESC [ 97:65 ; 5 u       (main=97='a', shifted=65='A')
 *   Ctrl+A  → ESC [ 65::97 ; 6 u      (main=65='A', shifted omitted, base=97='a')
 *   Alt+1   → ESC [ 49:33 ; 3 u       (main=49='1', shifted=33='!')
 *   Alt+!   → ESC [ 33::49 ; 3 u      (main=33='!', shifted omitted, base=49='1')
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InputHandler } from "../input-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandler(): InputHandler {
  return new InputHandler({ onData: () => {} });
}

function key(
  handler: InputHandler,
  k: string,
  {
    ctrlKey = false,
    altKey = false,
    shiftKey = false,
  }: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {},
): string | null {
  return handler.keyToSequence({
    key: k,
    ctrlKey,
    altKey,
    shiftKey,
    metaKey: false,
    repeat: false,
  } as KeyboardEvent);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Kitty alternate keys (kitty-alternates, flag 4)", () => {
  let handler: InputHandler;

  beforeEach(() => {
    handler = makeHandler();
  });

  // -------------------------------------------------------------------------
  // Flag 4 alone (no flag 1) — should have no visible effect because
  // disambiguate mode is not active and unmodified keys fall back to legacy.
  // -------------------------------------------------------------------------

  it("flag 4 alone: Ctrl+a still uses legacy Ctrl encoding, no alternates", () => {
    handler.setKittyFlags(4); // flag 4 only, no flag 1
    // Without flag 1 (disambiguate), legacy encoding is used
    const seq = key(handler, "a", { ctrlKey: true });
    expect(seq).toBe("\x01"); // legacy Ctrl+A
  });

  // -------------------------------------------------------------------------
  // Flag 1+4 — alternate keys active for CSI u sequences
  // -------------------------------------------------------------------------

  it("flag 1+4: Ctrl+a includes shifted alternate 'A' (65)", () => {
    handler.setKittyFlags(1 | 4);
    // Ctrl+a → Ctrl modifier → mod=5, main=97('a'), shifted=65('A'), base same as main → omit alt2
    expect(key(handler, "a", { ctrlKey: true })).toBe("\x1b[97:65;5u");
  });

  it("flag 1+4: Ctrl+A (shift+ctrl+a) includes base alternate 'a' (97)", () => {
    handler.setKittyFlags(1 | 4);
    // Shift+Ctrl+A → mod=6, main=65('A'), shifted=65 same → omit alt1, base=97('a')
    expect(key(handler, "A", { ctrlKey: true, shiftKey: true })).toBe("\x1b[65::97;6u");
  });

  it("flag 1+4: Alt+b includes shifted alternate 'B' (66)", () => {
    handler.setKittyFlags(1 | 4);
    // Alt+b → mod=3, main=98('b'), shifted=66('B')
    expect(key(handler, "b", { altKey: true })).toBe("\x1b[98:66;3u");
  });

  it("flag 1+4: Alt+B (shift+alt+b) includes base alternate 'b' (98)", () => {
    handler.setKittyFlags(1 | 4);
    // Shift+Alt+B → mod=4, main=66('B'), shifted=66 same → omit, base=98('b')
    expect(key(handler, "B", { altKey: true, shiftKey: true })).toBe("\x1b[66::98;4u");
  });

  it("flag 1+4: Alt+1 (digit) includes shifted alternate '!' (33)", () => {
    handler.setKittyFlags(1 | 4);
    // Alt+1 → mod=3, main=49('1'), shifted=33('!')
    expect(key(handler, "1", { altKey: true })).toBe("\x1b[49:33;3u");
  });

  it("flag 1+4: Alt+! (shift+alt+1) includes base alternate '1' (49)", () => {
    handler.setKittyFlags(1 | 4);
    // Shift+Alt+! → mod=4, main=33('!'), shifted=33 same → omit, base=49('1')
    expect(key(handler, "!", { altKey: true, shiftKey: true })).toBe("\x1b[33::49;4u");
  });

  it("flag 1+4: Ctrl+z includes shifted alternate 'Z' (90)", () => {
    handler.setKittyFlags(1 | 4);
    expect(key(handler, "z", { ctrlKey: true })).toBe("\x1b[122:90;5u");
  });

  it("flag 1+4: modified arrow key has no alternate-key sub-parameters", () => {
    handler.setKittyFlags(1 | 4);
    // Arrow keys use functional encoding — no codepoint alternates
    expect(key(handler, "ArrowUp", { ctrlKey: true })).toBe("\x1b[1;5A");
  });

  it("flag 1+4: Shift+Tab has no alternate-key sub-parameters", () => {
    handler.setKittyFlags(1 | 4);
    expect(key(handler, "Tab", { shiftKey: true })).toBe("\x1b[9;2u");
  });

  // -------------------------------------------------------------------------
  // Combined flags 1+2+4 — alternate keys + event types
  // -------------------------------------------------------------------------

  it("flags 1+2+4: Ctrl+a (press) encodes both event type and alternate key", () => {
    handler.setKittyFlags(1 | 2 | 4);
    // main=97:65, mod=5, event=1 → ESC [ 97:65 ; 5:1 u
    expect(key(handler, "a", { ctrlKey: true })).toBe("\x1b[97:65;5:1u");
  });

  it("flags 1+2+4: Ctrl+A (shift+ctrl, press) encodes both event type and base alternate", () => {
    handler.setKittyFlags(1 | 2 | 4);
    // main=65::97, mod=6, event=1 → ESC [ 65::97 ; 6:1 u
    expect(key(handler, "A", { ctrlKey: true, shiftKey: true })).toBe("\x1b[65::97;6:1u");
  });

  // -------------------------------------------------------------------------
  // Flag 1 only (no flag 4) — no alternates added (regression guard)
  // -------------------------------------------------------------------------

  it("flag 1 only: Ctrl+a has NO alternate-key sub-parameters", () => {
    handler.setKittyFlags(1);
    expect(key(handler, "a", { ctrlKey: true })).toBe("\x1b[97;5u");
  });

  it("flag 1 only: Alt+b has NO alternate-key sub-parameters", () => {
    handler.setKittyFlags(1);
    expect(key(handler, "b", { altKey: true })).toBe("\x1b[98;3u");
  });
});
