/**
 * Tests for kitty-disambiguate (kitty keyboard protocol flag 1).
 *
 * When kittyFlags & 1 (disambiguate escape codes) is set on the InputHandler,
 * key sequences must use the Kitty encoding so that previously ambiguous
 * keys become unambiguous:
 *
 *  - Escape alone           → CSI 27 u           (\x1b[27u)
 *  - Modifier + letter      → CSI codepoint ; mod+1 u
 *  - Modified special keys  → CSI 1 ; mod+1 <final>  or  CSI n ; mod+1 ~
 *  - Shift+Tab              → CSI 9 ; 2 u
 *
 * Without the flag set, existing legacy sequences are preserved.
 */

import { describe, expect, it, vi } from "vitest";
import { InputHandler } from "../input-handler.js";

function mk(): InputHandler {
  return new InputHandler({ onData: vi.fn() });
}

function key(
  k: string,
  mods: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {},
): KeyboardEvent {
  return {
    key: k,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    metaKey: mods.metaKey ?? false,
  } as KeyboardEvent;
}

// ---------------------------------------------------------------------------
// Without kitty flags — legacy sequences (regression guard)
// ---------------------------------------------------------------------------
describe("kitty-disambiguate — legacy mode (kittyFlags = 0)", () => {
  it("Escape → \\x1b (unchanged)", () => {
    const h = mk();
    expect(h.keyToSequence(key("Escape"))).toBe("\x1b");
  });

  it("Ctrl+a → \\x01 (unchanged)", () => {
    const h = mk();
    expect(h.keyToSequence(key("a", { ctrlKey: true }))).toBe("\x01");
  });

  it("Alt+a → \\x1ba (unchanged)", () => {
    const h = mk();
    expect(h.keyToSequence(key("a", { altKey: true }))).toBe("\x1ba");
  });

  it("ArrowUp → \\x1b[A (unchanged)", () => {
    const h = mk();
    expect(h.keyToSequence(key("ArrowUp"))).toBe("\x1b[A");
  });
});

// ---------------------------------------------------------------------------
// With kitty-disambiguate flag
// ---------------------------------------------------------------------------
describe("kitty-disambiguate — flag 1 set", () => {
  // Helper: create handler with disambiguate flag active
  function mkD(): InputHandler {
    const h = mk();
    h.setKittyFlags(1);
    return h;
  }

  // --- Escape ---
  it("Escape alone → CSI 27 u  (\\x1b[27u)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("Escape"))).toBe("\x1b[27u");
  });

  // --- Ctrl + letter ---
  it("Ctrl+a → CSI 97 ; 5 u  (\\x1b[97;5u)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("a", { ctrlKey: true }))).toBe("\x1b[97;5u");
  });

  it("Ctrl+c → CSI 99 ; 5 u  (\\x1b[99;5u)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("c", { ctrlKey: true }))).toBe("\x1b[99;5u");
  });

  it("Ctrl+z → CSI 122 ; 5 u  (\\x1b[122;5u)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("z", { ctrlKey: true }))).toBe("\x1b[122;5u");
  });

  // --- Alt + letter ---
  it("Alt+a → CSI 97 ; 3 u  (\\x1b[97;3u)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("a", { altKey: true }))).toBe("\x1b[97;3u");
  });

  it("Alt+z → CSI 122 ; 3 u  (\\x1b[122;3u)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("z", { altKey: true }))).toBe("\x1b[122;3u");
  });

  // --- Ctrl + Alt + letter ---
  it("Ctrl+Alt+a → CSI 97 ; 7 u  (\\x1b[97;7u)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("a", { ctrlKey: true, altKey: true }))).toBe("\x1b[97;7u");
  });

  // --- Shift + Tab ---
  it("Shift+Tab → CSI 9 ; 2 u  (\\x1b[9;2u)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("Tab", { shiftKey: true }))).toBe("\x1b[9;2u");
  });

  // --- Plain Tab remains unchanged ---
  it("Tab (no mod) → \\t (unchanged)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("Tab"))).toBe("\t");
  });

  // --- Plain Enter remains unchanged ---
  it("Enter (no mod) → \\r (unchanged)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("Enter"))).toBe("\r");
  });

  // --- Modified arrow keys: CSI 1 ; mod <letter> ---
  it("Ctrl+ArrowUp → CSI 1 ; 5 A  (\\x1b[1;5A)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("ArrowUp", { ctrlKey: true }))).toBe("\x1b[1;5A");
  });

  it("Shift+ArrowDown → CSI 1 ; 2 B  (\\x1b[1;2B)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("ArrowDown", { shiftKey: true }))).toBe("\x1b[1;2B");
  });

  it("Alt+ArrowLeft → CSI 1 ; 3 D  (\\x1b[1;3D)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("ArrowLeft", { altKey: true }))).toBe("\x1b[1;3D");
  });

  it("Ctrl+Shift+ArrowRight → CSI 1 ; 6 C  (\\x1b[1;6C)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("ArrowRight", { ctrlKey: true, shiftKey: true }))).toBe("\x1b[1;6C");
  });

  // Unmodified arrow keys stay the same in disambiguate mode
  it("ArrowUp (no mod) → \\x1b[A (unchanged)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("ArrowUp"))).toBe("\x1b[A");
  });

  // --- Modified Home/End ---
  it("Ctrl+Home → CSI 1 ; 5 H  (\\x1b[1;5H)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("Home", { ctrlKey: true }))).toBe("\x1b[1;5H");
  });

  it("Shift+End → CSI 1 ; 2 F  (\\x1b[1;2F)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("End", { shiftKey: true }))).toBe("\x1b[1;2F");
  });

  // --- Modified tilde-style keys: CSI n ; mod ~ ---
  it("Shift+Delete → CSI 3 ; 2 ~  (\\x1b[3;2~)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("Delete", { shiftKey: true }))).toBe("\x1b[3;2~");
  });

  it("Ctrl+PageUp → CSI 5 ; 5 ~  (\\x1b[5;5~)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("PageUp", { ctrlKey: true }))).toBe("\x1b[5;5~");
  });

  it("Shift+F5 → CSI 15 ; 2 ~  (\\x1b[15;2~)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("F5", { shiftKey: true }))).toBe("\x1b[15;2~");
  });

  // --- Modified ESC-O style function keys (F1-F4) ---
  it("Ctrl+F1 → CSI 1 ; 5 P  (\\x1b[1;5P)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("F1", { ctrlKey: true }))).toBe("\x1b[1;5P");
  });

  it("Shift+F2 → CSI 1 ; 2 Q  (\\x1b[1;2Q)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("F2", { shiftKey: true }))).toBe("\x1b[1;2Q");
  });

  // --- setKittyFlags updates behavior dynamically ---
  it("setKittyFlags(0) restores legacy Escape → \\x1b", () => {
    const h = mkD();
    h.setKittyFlags(0);
    expect(h.keyToSequence(key("Escape"))).toBe("\x1b");
  });

  it("setKittyFlags(0) restores legacy Ctrl+a → \\x01", () => {
    const h = mkD();
    h.setKittyFlags(0);
    expect(h.keyToSequence(key("a", { ctrlKey: true }))).toBe("\x01");
  });

  // --- Printable chars without modifiers pass through unchanged ---
  it("plain 'a' → 'a' (unchanged)", () => {
    const h = mkD();
    expect(h.keyToSequence(key("a"))).toBe("a");
  });
});
