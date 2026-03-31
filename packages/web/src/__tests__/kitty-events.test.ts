/**
 * Tests for kitty-events (kitty keyboard protocol flag 2).
 *
 * When kittyFlags & 2 (report event types) is set on the InputHandler,
 * key sequences must include the event type as a `:event-type` suffix in
 * the CSI u parameter section:
 *
 *   press (keydown, repeat=false) → event type 1  → \x1b[cp;mod:1u
 *   repeat (keydown, repeat=true) → event type 2  → \x1b[cp;mod:2u
 *   release (keyup)               → event type 3  → \x1b[cp;mod:3u
 *
 * Flag 2 is only meaningful when combined with flag 1 (disambiguate).
 * Without flag 2, no event type suffix is appended (regression guard).
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
    metaKey?: boolean;
  } = {},
): KeyboardEvent {
  return {
    key: k,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    metaKey: mods.metaKey ?? false,
    repeat: false,
  } as KeyboardEvent;
}

// ---------------------------------------------------------------------------
// Regression guard — flag 1 only (no event type suffix)
// ---------------------------------------------------------------------------
describe("kitty-events — flag 1 only (no event type suffix)", () => {
  function mkD(): InputHandler {
    const h = mk();
    h.setKittyFlags(1);
    return h;
  }

  it("Ctrl+a press → \\x1b[97;5u (no :event-type)", () => {
    const h = mkD();
    expect(h.keyToSequence(keyDown("a", { ctrlKey: true }))).toBe("\x1b[97;5u");
  });

  it("Escape press → \\x1b[27u (no :event-type)", () => {
    const h = mkD();
    expect(h.keyToSequence(keyDown("Escape"))).toBe("\x1b[27u");
  });

  it("Shift+Tab press → \\x1b[9;2u (no :event-type)", () => {
    const h = mkD();
    expect(h.keyToSequence(keyDown("Tab", { shiftKey: true }))).toBe("\x1b[9;2u");
  });

  it("keyUpToSequence returns null when flag 2 not set", () => {
    const h = mkD();
    expect(h.keyUpToSequence(keyUp("a", { ctrlKey: true }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Flag 1 + 2 — press events (keydown, repeat=false → event type 1)
// ---------------------------------------------------------------------------
describe("kitty-events — flags 1+2, press (event type 1)", () => {
  function mkE(): InputHandler {
    const h = mk();
    h.setKittyFlags(3); // 1 | 2
    return h;
  }

  it("Escape press → \\x1b[27;1:1u", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("Escape"))).toBe("\x1b[27;1:1u");
  });

  it("Ctrl+a press → \\x1b[97;5:1u", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("a", { ctrlKey: true }))).toBe("\x1b[97;5:1u");
  });

  it("Alt+b press → \\x1b[98;3:1u", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("b", { altKey: true }))).toBe("\x1b[98;3:1u");
  });

  it("Ctrl+Alt+a press → \\x1b[97;7:1u", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("a", { ctrlKey: true, altKey: true }))).toBe("\x1b[97;7:1u");
  });

  it("Shift+Alt+a press → \\x1b[97;4:1u", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("a", { shiftKey: true, altKey: true }))).toBe("\x1b[97;4:1u");
  });

  it("Shift+Tab press → \\x1b[9;2:1u", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("Tab", { shiftKey: true }))).toBe("\x1b[9;2:1u");
  });

  it("modified ArrowUp press → \\x1b[1;5:1A (Ctrl+ArrowUp)", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("ArrowUp", { ctrlKey: true }))).toBe("\x1b[1;5:1A");
  });

  it("modified Delete press → \\x1b[3;2:1~ (Shift+Delete)", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("Delete", { shiftKey: true }))).toBe("\x1b[3;2:1~");
  });

  it("modified F1 press → \\x1b[1;5:1P (Ctrl+F1)", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("F1", { ctrlKey: true }))).toBe("\x1b[1;5:1P");
  });

  it("modified F5 press → \\x1b[15;5:1~ (Ctrl+F5)", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("F5", { ctrlKey: true }))).toBe("\x1b[15;5:1~");
  });

  it("unmodified ArrowUp press → \\x1b[A (legacy fallback, no event type)", () => {
    // Unmodified keys still fall back to legacy encoding
    const h = mkE();
    expect(h.keyToSequence(keyDown("ArrowUp"))).toBe("\x1b[A");
  });

  it("unmodified printable key 'z' press → 'z' (legacy fallback)", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("z"))).toBe("z");
  });
});

// ---------------------------------------------------------------------------
// Flag 1 + 2 — repeat events (keydown, repeat=true → event type 2)
// ---------------------------------------------------------------------------
describe("kitty-events — flags 1+2, repeat (event type 2)", () => {
  function mkE(): InputHandler {
    const h = mk();
    h.setKittyFlags(3); // 1 | 2
    return h;
  }

  it("Ctrl+a repeat → \\x1b[97;5:2u", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("a", { ctrlKey: true, repeat: true }))).toBe("\x1b[97;5:2u");
  });

  it("Escape repeat → \\x1b[27;1:2u", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("Escape", { repeat: true }))).toBe("\x1b[27;1:2u");
  });

  it("Shift+Tab repeat → \\x1b[9;2:2u", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("Tab", { shiftKey: true, repeat: true }))).toBe("\x1b[9;2:2u");
  });

  it("modified ArrowDown repeat → \\x1b[1;5:2B (Ctrl+ArrowDown)", () => {
    const h = mkE();
    expect(h.keyToSequence(keyDown("ArrowDown", { ctrlKey: true, repeat: true }))).toBe(
      "\x1b[1;5:2B",
    );
  });
});

// ---------------------------------------------------------------------------
// Flag 1 + 2 — release events (keyup → event type 3) via keyUpToSequence()
// ---------------------------------------------------------------------------
describe("kitty-events — flags 1+2, release (event type 3)", () => {
  function mkE(): InputHandler {
    const h = mk();
    h.setKittyFlags(3); // 1 | 2
    return h;
  }

  it("Ctrl+a release → \\x1b[97;5:3u", () => {
    const h = mkE();
    expect(h.keyUpToSequence(keyUp("a", { ctrlKey: true }))).toBe("\x1b[97;5:3u");
  });

  it("Alt+b release → \\x1b[98;3:3u", () => {
    const h = mkE();
    expect(h.keyUpToSequence(keyUp("b", { altKey: true }))).toBe("\x1b[98;3:3u");
  });

  it("Escape release → \\x1b[27;1:3u", () => {
    const h = mkE();
    expect(h.keyUpToSequence(keyUp("Escape"))).toBe("\x1b[27;1:3u");
  });

  it("Shift+Tab release → \\x1b[9;2:3u", () => {
    const h = mkE();
    expect(h.keyUpToSequence(keyUp("Tab", { shiftKey: true }))).toBe("\x1b[9;2:3u");
  });

  it("modified ArrowUp release → \\x1b[1;5:3A (Ctrl+ArrowUp)", () => {
    const h = mkE();
    expect(h.keyUpToSequence(keyUp("ArrowUp", { ctrlKey: true }))).toBe("\x1b[1;5:3A");
  });

  it("modified Delete release → \\x1b[3;2:3~ (Shift+Delete)", () => {
    const h = mkE();
    expect(h.keyUpToSequence(keyUp("Delete", { shiftKey: true }))).toBe("\x1b[3;2:3~");
  });

  it("unmodified ArrowUp release → null (legacy sequences don't report release)", () => {
    const h = mkE();
    expect(h.keyUpToSequence(keyUp("ArrowUp"))).toBeNull();
  });

  it("unmodified printable 'z' release → null (legacy fallback, no release)", () => {
    const h = mkE();
    expect(h.keyUpToSequence(keyUp("z"))).toBeNull();
  });

  it("modifier-only key Meta release → null", () => {
    const h = mkE();
    expect(h.keyUpToSequence(keyUp("Meta"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setKittyFlags(0) restores no keyup behavior
// ---------------------------------------------------------------------------
describe("kitty-events — clearing flags disables event types", () => {
  it("setKittyFlags(0) after flag 2: Ctrl+a press → legacy \\x01, no :event-type", () => {
    const h = mk();
    h.setKittyFlags(3);
    h.setKittyFlags(0);
    expect(h.keyToSequence(keyDown("a", { ctrlKey: true }))).toBe("\x01");
  });

  it("setKittyFlags(0): keyUpToSequence returns null", () => {
    const h = mk();
    h.setKittyFlags(3);
    h.setKittyFlags(0);
    expect(h.keyUpToSequence(keyUp("a", { ctrlKey: true }))).toBeNull();
  });

  it("setKittyFlags(1) only: Ctrl+a → \\x1b[97;5u (no :event-type suffix)", () => {
    const h = mk();
    h.setKittyFlags(3);
    h.setKittyFlags(1);
    expect(h.keyToSequence(keyDown("a", { ctrlKey: true }))).toBe("\x1b[97;5u");
  });
});
