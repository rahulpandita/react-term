/**
 * Tests for Kitty keyboard protocol — flag 16: report associated text.
 *
 * When kittyFlags & 16 is set (combined with flag 1 for disambiguate), ALL
 * CSI u key sequences include the Unicode codepoint(s) of the associated text
 * as a third parameter group:
 *
 *   CSI unicode-key-code[:shifted[:base]] ; modifiers[:event-type] ; text-codepoints u
 *
 * The associated text is the character(s) that would be produced by the key
 * press (what would be typed into a text editor). Examples:
 *
 *   'a' (flag 1+8+16)           → CSI 97 ; 1 ; 97 u     (\x1b[97;1;97u)
 *   Ctrl+a (flag 1+16)          → CSI 97 ; 5 ; 97 u     (\x1b[97;5;97u)
 *   Shift+a key='A' (flag 1+8+16) → CSI 65 ; 2 ; 65 u   (\x1b[65;2;65u)
 *   Enter (flag 1+8+16)         → CSI 13 ; 1 ; 13 u     (\x1b[13;1;13u)
 *   Tab (flag 1+8+16)           → CSI 9 ; 1 ; 9 u       (\x1b[9;1;9u)
 *   Backspace (flag 1+8+16)     → CSI 127 ; 1 ; 127 u   (\x1b[127;1;127u)
 *   Shift+Tab (flag 1+16)       → CSI 9 ; 2 ; 9 u       (\x1b[9;2;9u)
 *
 * Flag 16 without flag 1: no effect (legacy encoding unchanged).
 * Arrow/F-keys/Escape: no associated text parameter appended.
 *
 * Combined with flag 2 (event types) and flag 4 (alternate keys):
 *   'a' (flag 1+2+8+16) press   → CSI 97 ; 1:1 ; 97 u   (\x1b[97;1:1;97u)
 *   'a' (flag 1+4+8+16)         → CSI 97:65 ; 1 ; 97 u  (\x1b[97:65;1;97u)
 */

import { describe, expect, it, vi } from "vitest";
import { InputHandler } from "../input-handler.js";

function mk(): InputHandler {
  return new InputHandler({ onData: vi.fn() });
}

function keyDown(
  k: string,
  mods: {
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    metaKey?: boolean;
    repeat?: boolean;
  } = {},
): KeyboardEvent {
  return {
    key: k,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    metaKey: mods.metaKey ?? false,
    repeat: mods.repeat ?? false,
  } as KeyboardEvent;
}

function keyUp(
  k: string,
  mods: {
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  } = {},
): KeyboardEvent {
  return {
    key: k,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    metaKey: false,
    repeat: false,
  } as KeyboardEvent;
}

// ---------------------------------------------------------------------------
// Regression guard — flag 16 alone (no flag 1): no effect
// ---------------------------------------------------------------------------
describe("kitty-assoctext — flag 16 alone (no flag 1): no effect", () => {
  it("plain 'a' → 'a' unchanged (no flag 1)", () => {
    const h = mk();
    h.setKittyFlags(16);
    expect(h.keyToSequence(keyDown("a"))).toBe("a");
  });

  it("Enter → '\\r' unchanged (no flag 1)", () => {
    const h = mk();
    h.setKittyFlags(16);
    expect(h.keyToSequence(keyDown("Enter"))).toBe("\r");
  });

  it("Ctrl+a → '\\x01' unchanged (no flag 1)", () => {
    const h = mk();
    h.setKittyFlags(16);
    expect(h.keyToSequence(keyDown("a", { ctrlKey: true }))).toBe("\x01");
  });
});

// ---------------------------------------------------------------------------
// Flag 1+16 — modifier + printable character → text param appended
// ---------------------------------------------------------------------------
describe("kitty-assoctext — flag 1+16: modifier+char includes text parameter", () => {
  it("Ctrl+a → \\x1b[97;5;97u (text=97='a')", () => {
    const h = mk();
    h.setKittyFlags(1 | 16);
    expect(h.keyToSequence(keyDown("a", { ctrlKey: true }))).toBe("\x1b[97;5;97u");
  });

  it("Alt+b → \\x1b[98;3;98u (text=98='b')", () => {
    const h = mk();
    h.setKittyFlags(1 | 16);
    expect(h.keyToSequence(keyDown("b", { altKey: true }))).toBe("\x1b[98;3;98u");
  });

  it("Ctrl+Shift+A (key='A') → \\x1b[65;6;65u (text=65='A')", () => {
    const h = mk();
    h.setKittyFlags(1 | 16);
    expect(h.keyToSequence(keyDown("A", { ctrlKey: true, shiftKey: true }))).toBe("\x1b[65;6;65u");
  });

  it("Shift+Tab → \\x1b[9;2;9u (text=9=Tab)", () => {
    const h = mk();
    h.setKittyFlags(1 | 16);
    expect(h.keyToSequence(keyDown("Tab", { shiftKey: true }))).toBe("\x1b[9;2;9u");
  });
});

// ---------------------------------------------------------------------------
// Flag 1+8+16 — unmodified printable characters → text param appended
// ---------------------------------------------------------------------------
describe("kitty-assoctext — flag 1+8+16: unmodified printable chars include text", () => {
  it("unmodified 'a' → \\x1b[97;1;97u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8 | 16);
    expect(h.keyToSequence(keyDown("a"))).toBe("\x1b[97;1;97u");
  });

  it("unmodified 'z' → \\x1b[122;1;122u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8 | 16);
    expect(h.keyToSequence(keyDown("z"))).toBe("\x1b[122;1;122u");
  });

  it("unmodified '1' → \\x1b[49;1;49u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8 | 16);
    expect(h.keyToSequence(keyDown("1"))).toBe("\x1b[49;1;49u");
  });

  it("shift+a (key='A') → \\x1b[65;2;65u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8 | 16);
    expect(h.keyToSequence(keyDown("A", { shiftKey: true }))).toBe("\x1b[65;2;65u");
  });

  it("shift+'!' (key='!') → \\x1b[33;2;33u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8 | 16);
    expect(h.keyToSequence(keyDown("!", { shiftKey: true }))).toBe("\x1b[33;2;33u");
  });
});

// ---------------------------------------------------------------------------
// Flag 1+8+16 — functional keys → text param appended
// ---------------------------------------------------------------------------
describe("kitty-assoctext — flag 1+8+16: functional keys include text", () => {
  it("Enter → \\x1b[13;1;13u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8 | 16);
    expect(h.keyToSequence(keyDown("Enter"))).toBe("\x1b[13;1;13u");
  });

  it("Tab → \\x1b[9;1;9u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8 | 16);
    expect(h.keyToSequence(keyDown("Tab"))).toBe("\x1b[9;1;9u");
  });

  it("Backspace → \\x1b[127;1;127u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8 | 16);
    expect(h.keyToSequence(keyDown("Backspace"))).toBe("\x1b[127;1;127u");
  });
});

// ---------------------------------------------------------------------------
// Flag 1+8+16 — non-text keys → no text parameter
// ---------------------------------------------------------------------------
describe("kitty-assoctext — flag 1+8+16: non-text keys have no text parameter", () => {
  it("Escape → \\x1b[27u (no text param)", () => {
    const h = mk();
    h.setKittyFlags(1 | 8 | 16);
    expect(h.keyToSequence(keyDown("Escape"))).toBe("\x1b[27u");
  });

  it("modified ArrowUp → \\x1b[1;5A (no text param)", () => {
    const h = mk();
    h.setKittyFlags(1 | 8 | 16);
    expect(h.keyToSequence(keyDown("ArrowUp", { ctrlKey: true }))).toBe("\x1b[1;5A");
  });

  it("modified F1 → \\x1b[1;5P (no text param)", () => {
    const h = mk();
    h.setKittyFlags(1 | 8 | 16);
    expect(h.keyToSequence(keyDown("F1", { ctrlKey: true }))).toBe("\x1b[1;5P");
  });
});

// ---------------------------------------------------------------------------
// Flag 1+2+8+16 — event types + text param
// ---------------------------------------------------------------------------
describe("kitty-assoctext — flag 1+2+8+16: event types combined with text", () => {
  it("unmodified 'a' press → \\x1b[97;1:1;97u", () => {
    const h = mk();
    h.setKittyFlags(1 | 2 | 8 | 16);
    expect(h.keyToSequence(keyDown("a"))).toBe("\x1b[97;1:1;97u");
  });

  it("unmodified 'a' repeat → \\x1b[97;1:2;97u", () => {
    const h = mk();
    h.setKittyFlags(1 | 2 | 8 | 16);
    expect(h.keyToSequence(keyDown("a", { repeat: true }))).toBe("\x1b[97;1:2;97u");
  });

  it("unmodified 'a' release → \\x1b[97;1:3;97u", () => {
    const h = mk();
    h.setKittyFlags(1 | 2 | 8 | 16);
    expect(h.keyUpToSequence(keyUp("a"))).toBe("\x1b[97;1:3;97u");
  });

  it("Enter press → \\x1b[13;1:1;13u", () => {
    const h = mk();
    h.setKittyFlags(1 | 2 | 8 | 16);
    expect(h.keyToSequence(keyDown("Enter"))).toBe("\x1b[13;1:1;13u");
  });

  it("Enter release → \\x1b[13;1:3;13u", () => {
    const h = mk();
    h.setKittyFlags(1 | 2 | 8 | 16);
    expect(h.keyUpToSequence(keyUp("Enter"))).toBe("\x1b[13;1:3;13u");
  });
});

// ---------------------------------------------------------------------------
// Flag 1+4+8+16 — alternate keys + text param
// ---------------------------------------------------------------------------
describe("kitty-assoctext — flag 1+4+8+16: alternate keys combined with text", () => {
  it("unmodified 'a' → \\x1b[97:65;1;97u (altKey=:65, text=97)", () => {
    const h = mk();
    h.setKittyFlags(1 | 4 | 8 | 16);
    expect(h.keyToSequence(keyDown("a"))).toBe("\x1b[97:65;1;97u");
  });

  it("unmodified '1' → \\x1b[49:33;1;49u (altKey=:33='!', text=49='1')", () => {
    const h = mk();
    h.setKittyFlags(1 | 4 | 8 | 16);
    expect(h.keyToSequence(keyDown("1"))).toBe("\x1b[49:33;1;49u");
  });
});

// ---------------------------------------------------------------------------
// Disable flag 16 — restores previous behavior
// ---------------------------------------------------------------------------
describe("kitty-assoctext — disabling flag 16 restores previous behavior", () => {
  it("clearing flag 16: Ctrl+a returns to \\x1b[97;5u (no text param)", () => {
    const h = mk();
    h.setKittyFlags(1 | 16);
    expect(h.keyToSequence(keyDown("a", { ctrlKey: true }))).toBe("\x1b[97;5;97u");
    h.setKittyFlags(1);
    expect(h.keyToSequence(keyDown("a", { ctrlKey: true }))).toBe("\x1b[97;5u");
  });

  it("clearing flag 16: 'a' with flag 1+8 returns to \\x1b[97;1u (no text param)", () => {
    const h = mk();
    h.setKittyFlags(1 | 8 | 16);
    expect(h.keyToSequence(keyDown("a"))).toBe("\x1b[97;1;97u");
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("a"))).toBe("\x1b[97;1u");
  });
});
