/**
 * Tests for Kitty keyboard protocol — flag 8: report all keys as escape codes.
 *
 * When kittyFlags & 8 is set (combined with flag 1 for disambiguate), ALL
 * key presses — including unmodified printable characters and functional keys
 * like Enter, Tab, and Backspace — are reported as CSI u escape sequences
 * instead of their literal character or legacy escape sequences.
 *
 * Encoding (flag 1 + 8 active):
 *   Unmodified 'a'       → CSI 97;1u      (\x1b[97;1u)
 *   Unmodified Enter     → CSI 13;1u      (\x1b[13;1u)
 *   Unmodified Tab       → CSI 9;1u       (\x1b[9;1u)
 *   Unmodified Backspace → CSI 127;1u     (\x1b[127;1u)
 *   Shift+a  (key='A')   → CSI 65;2u      (\x1b[65;2u)
 *   Ctrl+a               → CSI 97;5u      (\x1b[97;5u)  — unchanged from flag 1
 *
 * With flag 2 (report event types):
 *   Unmodified 'a' press   → CSI 97;1:1u
 *   Unmodified 'a' release → CSI 97;1:3u
 *
 * With flag 4 (report alternate keys):
 *   Unmodified 'a' → CSI 97:65;1u  (shifted alt = 'A'=65)
 *
 * Flag 8 without flag 1: no effect (legacy encoding unchanged).
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
// Regression guard — flag 8 alone (no flag 1): no effect
// ---------------------------------------------------------------------------
describe("kitty-allkeys — flag 8 alone (no flag 1): no effect", () => {
  it("plain 'a' → 'a' unchanged (no flag 1)", () => {
    const h = mk();
    h.setKittyFlags(8);
    expect(h.keyToSequence(keyDown("a"))).toBe("a");
  });

  it("Enter → '\\r' unchanged (no flag 1)", () => {
    const h = mk();
    h.setKittyFlags(8);
    expect(h.keyToSequence(keyDown("Enter"))).toBe("\r");
  });

  it("Ctrl+a → '\\x01' unchanged (no flag 1)", () => {
    const h = mk();
    h.setKittyFlags(8);
    expect(h.keyToSequence(keyDown("a", { ctrlKey: true }))).toBe("\x01");
  });
});

// ---------------------------------------------------------------------------
// Flag 1+8 — unmodified printable characters → CSI u
// ---------------------------------------------------------------------------
describe("kitty-allkeys — flag 1+8: unmodified printable chars → CSI u", () => {
  it("unmodified 'a' → \\x1b[97;1u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("a"))).toBe("\x1b[97;1u");
  });

  it("unmodified 'z' → \\x1b[122;1u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("z"))).toBe("\x1b[122;1u");
  });

  it("unmodified '1' → \\x1b[49;1u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("1"))).toBe("\x1b[49;1u");
  });

  it("unmodified space ' ' → \\x1b[32;1u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown(" "))).toBe("\x1b[32;1u");
  });

  it("shift+a (key='A', shiftKey=true) → \\x1b[65;2u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    // shift makes mod=2; key is 'A' (uppercase because shift is applied by browser)
    expect(h.keyToSequence(keyDown("A", { shiftKey: true }))).toBe("\x1b[65;2u");
  });

  it("shift+'!' (key='!', shiftKey=true) → \\x1b[33;2u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("!", { shiftKey: true }))).toBe("\x1b[33;2u");
  });
});

// ---------------------------------------------------------------------------
// Flag 1+8 — functional keys → CSI u
// ---------------------------------------------------------------------------
describe("kitty-allkeys — flag 1+8: functional keys → CSI u", () => {
  it("Enter → \\x1b[13;1u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("Enter"))).toBe("\x1b[13;1u");
  });

  it("Tab → \\x1b[9;1u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("Tab"))).toBe("\x1b[9;1u");
  });

  it("Backspace → \\x1b[127;1u", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("Backspace"))).toBe("\x1b[127;1u");
  });
});

// ---------------------------------------------------------------------------
// Flag 1+8 — modified keys unchanged from flag 1 behavior
// ---------------------------------------------------------------------------
describe("kitty-allkeys — flag 1+8: modified keys are unaffected (same as flag 1)", () => {
  it("Ctrl+a → \\x1b[97;5u (same as flag 1)", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("a", { ctrlKey: true }))).toBe("\x1b[97;5u");
  });

  it("Alt+a → \\x1b[97;3u (same as flag 1)", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("a", { altKey: true }))).toBe("\x1b[97;3u");
  });

  it("Shift+Tab → \\x1b[9;2u (same as flag 1)", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("Tab", { shiftKey: true }))).toBe("\x1b[9;2u");
  });

  it("Escape → \\x1b[27u (same as flag 1)", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("Escape"))).toBe("\x1b[27u");
  });
});

// ---------------------------------------------------------------------------
// Flag 1+2+8 — event types apply to all keys
// ---------------------------------------------------------------------------
describe("kitty-allkeys — flag 1+2+8: event types on all keys", () => {
  it("unmodified 'a' press → \\x1b[97;1:1u", () => {
    const h = mk();
    h.setKittyFlags(1 | 2 | 8);
    expect(h.keyToSequence(keyDown("a"))).toBe("\x1b[97;1:1u");
  });

  it("unmodified 'a' repeat → \\x1b[97;1:2u", () => {
    const h = mk();
    h.setKittyFlags(1 | 2 | 8);
    expect(h.keyToSequence(keyDown("a", { repeat: true }))).toBe("\x1b[97;1:2u");
  });

  it("unmodified 'a' release → \\x1b[97;1:3u", () => {
    const h = mk();
    h.setKittyFlags(1 | 2 | 8);
    expect(h.keyUpToSequence(keyUp("a"))).toBe("\x1b[97;1:3u");
  });

  it("Enter press → \\x1b[13;1:1u", () => {
    const h = mk();
    h.setKittyFlags(1 | 2 | 8);
    expect(h.keyToSequence(keyDown("Enter"))).toBe("\x1b[13;1:1u");
  });

  it("Enter release → \\x1b[13;1:3u", () => {
    const h = mk();
    h.setKittyFlags(1 | 2 | 8);
    expect(h.keyUpToSequence(keyUp("Enter"))).toBe("\x1b[13;1:3u");
  });

  it("Tab release → \\x1b[9;1:3u", () => {
    const h = mk();
    h.setKittyFlags(1 | 2 | 8);
    expect(h.keyUpToSequence(keyUp("Tab"))).toBe("\x1b[9;1:3u");
  });

  it("Backspace release → \\x1b[127;1:3u", () => {
    const h = mk();
    h.setKittyFlags(1 | 2 | 8);
    expect(h.keyUpToSequence(keyUp("Backspace"))).toBe("\x1b[127;1:3u");
  });
});

// ---------------------------------------------------------------------------
// Flag 1+4+8 — alternate key parameters on all keys
// ---------------------------------------------------------------------------
describe("kitty-allkeys — flag 1+4+8: alternate keys on unmodified printable", () => {
  it("unmodified 'a' includes shifted alt 'A' (65) → \\x1b[97:65;1u", () => {
    const h = mk();
    h.setKittyFlags(1 | 4 | 8);
    // 'a' (97): shifted='A'(65) != 97, base=97 == 97 → :65 suffix
    expect(h.keyToSequence(keyDown("a"))).toBe("\x1b[97:65;1u");
  });

  it("unmodified '1' includes shifted alt '!' (33) → \\x1b[49:33;1u", () => {
    const h = mk();
    h.setKittyFlags(1 | 4 | 8);
    // '1' (49): shifted='!'(33) != 49, base=49 == 49 → :33 suffix
    expect(h.keyToSequence(keyDown("1"))).toBe("\x1b[49:33;1u");
  });
});

// ---------------------------------------------------------------------------
// Disable flag 8 — restores legacy behavior
// ---------------------------------------------------------------------------
describe("kitty-allkeys — disabling flag 8 restores previous behavior", () => {
  it("clearing flags after flag 1+8: 'a' returns to 'a'", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("a"))).toBe("\x1b[97;1u"); // flag 8 active
    h.setKittyFlags(1); // back to flag 1 only
    expect(h.keyToSequence(keyDown("a"))).toBe("a"); // legacy
  });

  it("clearing flags after flag 1+8: Enter returns to '\\r'", () => {
    const h = mk();
    h.setKittyFlags(1 | 8);
    expect(h.keyToSequence(keyDown("Enter"))).toBe("\x1b[13;1u"); // flag 8 active
    h.setKittyFlags(0); // all off
    expect(h.keyToSequence(keyDown("Enter"))).toBe("\r"); // legacy
  });
});
