// @vitest-environment jsdom
/**
 * Tests for InputHandler keyboard handling:
 *  - keyToSequence: all special keys, function keys, arrow keys, Ctrl/Alt combos
 *  - Application cursor key mode (setApplicationCursorKeys)
 *  - Modifier-only keys (should not produce sequences)
 *  - Keydown dispatch: onData called with correct bytes via textarea keydown event
 *  - IME composition: compositionstart/compositionend events
 *  - Mobile textarea input event (virtual keyboard)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputHandler } from "../input-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode a Uint8Array passed to the onData spy into a plain string. */
function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Fire a keydown event on the textarea inside `container`. */
function fireKeyDown(container: HTMLElement, init: KeyboardEventInit & { key: string }): void {
  const ta = container.querySelector("textarea");
  if (!ta) throw new Error("No textarea found — did you call handler.attach()?");
  ta.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}

/** Fire a compositionstart event on the textarea inside `container`. */
function fireCompositionStart(container: HTMLElement): void {
  const ta = container.querySelector("textarea");
  if (!ta) throw new Error("No textarea found");
  ta.dispatchEvent(new Event("compositionstart", { bubbles: true }));
}

/** Fire a compositionend event on the textarea inside `container`. */
function fireCompositionEnd(container: HTMLElement, data: string): void {
  const ta = container.querySelector("textarea");
  if (!ta) throw new Error("No textarea found");
  const evt = new CompositionEvent("compositionend", {
    bubbles: true,
    data,
  });
  ta.dispatchEvent(evt);
}

/** Set textarea value and fire an `input` event (simulates mobile keyboard). */
function fireTextareaInput(container: HTMLElement, value: string): void {
  const ta = container.querySelector("textarea") as HTMLTextAreaElement | null;
  if (!ta) throw new Error("No textarea found");
  ta.value = value;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------------------------------------------------------------------------
// keyToSequence tests (pure mapping, no DOM events)
// ---------------------------------------------------------------------------

describe("InputHandler — keyToSequence", () => {
  let handler: InputHandler;

  beforeEach(() => {
    handler = new InputHandler({ onData: vi.fn() });
  });

  // Navigation keys
  it("Enter → \\r", () => {
    expect(handler.keyToSequence({ key: "Enter" } as KeyboardEvent)).toBe("\r");
  });

  it("Backspace → DEL (\\x7f)", () => {
    expect(handler.keyToSequence({ key: "Backspace", ctrlKey: false } as KeyboardEvent)).toBe(
      "\x7f",
    );
  });

  it("Ctrl+Backspace → BS (\\x08)", () => {
    expect(handler.keyToSequence({ key: "Backspace", ctrlKey: true } as KeyboardEvent)).toBe(
      "\x08",
    );
  });

  it("Tab → \\t", () => {
    expect(handler.keyToSequence({ key: "Tab" } as KeyboardEvent)).toBe("\t");
  });

  it("Escape → \\x1b", () => {
    expect(handler.keyToSequence({ key: "Escape" } as KeyboardEvent)).toBe("\x1b");
  });

  it("Delete → \\x1b[3~", () => {
    expect(handler.keyToSequence({ key: "Delete" } as KeyboardEvent)).toBe("\x1b[3~");
  });

  it("Insert → \\x1b[2~", () => {
    expect(handler.keyToSequence({ key: "Insert" } as KeyboardEvent)).toBe("\x1b[2~");
  });

  it("Home → \\x1b[H", () => {
    expect(handler.keyToSequence({ key: "Home" } as KeyboardEvent)).toBe("\x1b[H");
  });

  it("End → \\x1b[F", () => {
    expect(handler.keyToSequence({ key: "End" } as KeyboardEvent)).toBe("\x1b[F");
  });

  it("PageUp → \\x1b[5~", () => {
    expect(handler.keyToSequence({ key: "PageUp" } as KeyboardEvent)).toBe("\x1b[5~");
  });

  it("PageDown → \\x1b[6~", () => {
    expect(handler.keyToSequence({ key: "PageDown" } as KeyboardEvent)).toBe("\x1b[6~");
  });

  // Arrow keys (normal cursor mode)
  it("ArrowUp → \\x1b[A (normal mode)", () => {
    expect(handler.keyToSequence({ key: "ArrowUp" } as KeyboardEvent)).toBe("\x1b[A");
  });

  it("ArrowDown → \\x1b[B (normal mode)", () => {
    expect(handler.keyToSequence({ key: "ArrowDown" } as KeyboardEvent)).toBe("\x1b[B");
  });

  it("ArrowRight → \\x1b[C (normal mode)", () => {
    expect(handler.keyToSequence({ key: "ArrowRight" } as KeyboardEvent)).toBe("\x1b[C");
  });

  it("ArrowLeft → \\x1b[D (normal mode)", () => {
    expect(handler.keyToSequence({ key: "ArrowLeft" } as KeyboardEvent)).toBe("\x1b[D");
  });

  // Function keys
  it("F1 → \\x1bOP", () => {
    expect(handler.keyToSequence({ key: "F1" } as KeyboardEvent)).toBe("\x1bOP");
  });

  it("F2 → \\x1bOQ", () => {
    expect(handler.keyToSequence({ key: "F2" } as KeyboardEvent)).toBe("\x1bOQ");
  });

  it("F3 → \\x1bOR", () => {
    expect(handler.keyToSequence({ key: "F3" } as KeyboardEvent)).toBe("\x1bOR");
  });

  it("F4 → \\x1bOS", () => {
    expect(handler.keyToSequence({ key: "F4" } as KeyboardEvent)).toBe("\x1bOS");
  });

  it("F5 → \\x1b[15~", () => {
    expect(handler.keyToSequence({ key: "F5" } as KeyboardEvent)).toBe("\x1b[15~");
  });

  it("F6 → \\x1b[17~", () => {
    expect(handler.keyToSequence({ key: "F6" } as KeyboardEvent)).toBe("\x1b[17~");
  });

  it("F7 → \\x1b[18~", () => {
    expect(handler.keyToSequence({ key: "F7" } as KeyboardEvent)).toBe("\x1b[18~");
  });

  it("F8 → \\x1b[19~", () => {
    expect(handler.keyToSequence({ key: "F8" } as KeyboardEvent)).toBe("\x1b[19~");
  });

  it("F9 → \\x1b[20~", () => {
    expect(handler.keyToSequence({ key: "F9" } as KeyboardEvent)).toBe("\x1b[20~");
  });

  it("F10 → \\x1b[21~", () => {
    expect(handler.keyToSequence({ key: "F10" } as KeyboardEvent)).toBe("\x1b[21~");
  });

  it("F11 → \\x1b[23~", () => {
    expect(handler.keyToSequence({ key: "F11" } as KeyboardEvent)).toBe("\x1b[23~");
  });

  it("F12 → \\x1b[24~", () => {
    expect(handler.keyToSequence({ key: "F12" } as KeyboardEvent)).toBe("\x1b[24~");
  });

  // Ctrl + letter
  it("Ctrl+A → \\x01 (SOH)", () => {
    expect(
      handler.keyToSequence({
        key: "a",
        ctrlKey: true,
        altKey: false,
        metaKey: false,
      } as KeyboardEvent),
    ).toBe("\x01");
  });

  it("Ctrl+Z → \\x1a (SUB)", () => {
    expect(
      handler.keyToSequence({
        key: "z",
        ctrlKey: true,
        altKey: false,
        metaKey: false,
      } as KeyboardEvent),
    ).toBe("\x1a");
  });

  it("Ctrl+[ → \\x1b (ESC)", () => {
    expect(
      handler.keyToSequence({
        key: "[",
        ctrlKey: true,
        altKey: false,
        metaKey: false,
      } as KeyboardEvent),
    ).toBe("\x1b");
  });

  it("Ctrl+\\ → \\x1c (FS)", () => {
    expect(
      handler.keyToSequence({
        key: "\\",
        ctrlKey: true,
        altKey: false,
        metaKey: false,
      } as KeyboardEvent),
    ).toBe("\x1c");
  });

  // Alt + letter → ESC prefix
  it("Alt+a → \\x1ba", () => {
    expect(
      handler.keyToSequence({
        key: "a",
        altKey: true,
        ctrlKey: false,
        metaKey: false,
      } as KeyboardEvent),
    ).toBe("\x1ba");
  });

  it("Alt+b → \\x1bb", () => {
    expect(
      handler.keyToSequence({
        key: "b",
        altKey: true,
        ctrlKey: false,
        metaKey: false,
      } as KeyboardEvent),
    ).toBe("\x1bb");
  });

  // Meta key combos → null (browser shortcut)
  it("Meta+C → null (let browser handle)", () => {
    expect(
      handler.keyToSequence({
        key: "c",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
      } as KeyboardEvent),
    ).toBeNull();
  });

  it("Meta+ArrowUp → null", () => {
    expect(handler.keyToSequence({ key: "ArrowUp", metaKey: true } as KeyboardEvent)).toBeNull();
  });

  // Modifier-only keys → null
  it("Shift alone → null", () => {
    expect(handler.keyToSequence({ key: "Shift" } as KeyboardEvent)).toBeNull();
  });

  it("Control alone → null", () => {
    expect(handler.keyToSequence({ key: "Control" } as KeyboardEvent)).toBeNull();
  });

  it("Alt alone → null", () => {
    expect(handler.keyToSequence({ key: "Alt" } as KeyboardEvent)).toBeNull();
  });

  it("Meta alone → null", () => {
    expect(handler.keyToSequence({ key: "Meta" } as KeyboardEvent)).toBeNull();
  });

  // Printable characters pass through
  it("Space → ' '", () => {
    expect(handler.keyToSequence({ key: " " } as KeyboardEvent)).toBe(" ");
  });

  it("'a' → 'a'", () => {
    expect(handler.keyToSequence({ key: "a" } as KeyboardEvent)).toBe("a");
  });

  it("'Z' → 'Z'", () => {
    expect(handler.keyToSequence({ key: "Z" } as KeyboardEvent)).toBe("Z");
  });

  it("'€' (multi-byte but key.length === 1) → '€'", () => {
    // key.length === 1 even for multi-byte code points (surrogate pairs aside)
    expect(handler.keyToSequence({ key: "€" } as KeyboardEvent)).toBe("€");
  });

  // Unknown multi-char key → null
  it("Unknown multi-char key 'AudioVolumeUp' → null", () => {
    expect(handler.keyToSequence({ key: "AudioVolumeUp" } as KeyboardEvent)).toBeNull();
  });

  it("'Dead' key → null", () => {
    expect(handler.keyToSequence({ key: "Dead" } as KeyboardEvent)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Application cursor key mode
// ---------------------------------------------------------------------------

describe("InputHandler — application cursor key mode", () => {
  it("Arrow keys use SS3 sequences (\\x1bO…) in app mode", () => {
    const handler = new InputHandler({ onData: vi.fn() });
    handler.setApplicationCursorKeys(true);

    expect(handler.keyToSequence({ key: "ArrowUp" } as KeyboardEvent)).toBe("\x1bOA");
    expect(handler.keyToSequence({ key: "ArrowDown" } as KeyboardEvent)).toBe("\x1bOB");
    expect(handler.keyToSequence({ key: "ArrowRight" } as KeyboardEvent)).toBe("\x1bOC");
    expect(handler.keyToSequence({ key: "ArrowLeft" } as KeyboardEvent)).toBe("\x1bOD");
  });

  it("Reverting to normal mode restores CSI sequences (\\x1b[…)", () => {
    const handler = new InputHandler({ onData: vi.fn() });
    handler.setApplicationCursorKeys(true);
    handler.setApplicationCursorKeys(false);

    expect(handler.keyToSequence({ key: "ArrowUp" } as KeyboardEvent)).toBe("\x1b[A");
    expect(handler.keyToSequence({ key: "ArrowDown" } as KeyboardEvent)).toBe("\x1b[B");
  });

  it("Initial applicationCursorKeys option sets app mode immediately", () => {
    const handler = new InputHandler({
      onData: vi.fn(),
      applicationCursorKeys: true,
    });
    expect(handler.keyToSequence({ key: "ArrowLeft" } as KeyboardEvent)).toBe("\x1bOD");
  });
});

// ---------------------------------------------------------------------------
// Keydown dispatch via DOM (onData called with encoded bytes)
// ---------------------------------------------------------------------------

describe("InputHandler — keydown dispatch", () => {
  let container: HTMLDivElement;
  let onData: ReturnType<typeof vi.fn>;
  let handler: InputHandler;

  beforeEach(() => {
    onData = vi.fn();
    handler = new InputHandler({ onData });
    container = document.createElement("div");
    document.body.appendChild(container);
    handler.attach(container, 8, 16);
  });

  afterEach(() => {
    handler.dispose();
    container.remove();
  });

  it("ArrowUp fires \\x1b[A to onData", () => {
    fireKeyDown(container, { key: "ArrowUp" });
    expect(onData).toHaveBeenCalledOnce();
    expect(decode(onData.mock.calls[0][0])).toBe("\x1b[A");
  });

  it("F1 fires \\x1bOP to onData", () => {
    fireKeyDown(container, { key: "F1" });
    expect(decode(onData.mock.calls[0][0])).toBe("\x1bOP");
  });

  it("Enter fires \\r to onData", () => {
    fireKeyDown(container, { key: "Enter" });
    expect(decode(onData.mock.calls[0][0])).toBe("\r");
  });

  it("Ctrl+C fires \\x03 to onData", () => {
    fireKeyDown(container, { key: "c", ctrlKey: true });
    expect(decode(onData.mock.calls[0][0])).toBe("\x03");
  });

  it("Alt+f fires \\x1bf to onData", () => {
    fireKeyDown(container, { key: "f", altKey: true });
    expect(decode(onData.mock.calls[0][0])).toBe("\x1bf");
  });

  it("Modifier-only keys (Shift) do not call onData", () => {
    fireKeyDown(container, { key: "Shift" });
    expect(onData).not.toHaveBeenCalled();
  });

  it("Meta key combos do not call onData (browser shortcuts)", () => {
    fireKeyDown(container, { key: "c", metaKey: true });
    expect(onData).not.toHaveBeenCalled();
  });

  it("Unknown special keys (AudioVolumeUp) do not call onData", () => {
    fireKeyDown(container, { key: "AudioVolumeUp" });
    expect(onData).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// IME composition events
// ---------------------------------------------------------------------------

describe("InputHandler — IME composition", () => {
  let container: HTMLDivElement;
  let onData: ReturnType<typeof vi.fn>;
  let handler: InputHandler;

  beforeEach(() => {
    onData = vi.fn();
    handler = new InputHandler({ onData });
    container = document.createElement("div");
    document.body.appendChild(container);
    handler.attach(container, 8, 16);
  });

  afterEach(() => {
    handler.dispose();
    container.remove();
  });

  it("compositionend sends composed text to onData", () => {
    fireCompositionStart(container);
    fireCompositionEnd(container, "日本語");
    expect(onData).toHaveBeenCalledOnce();
    expect(decode(onData.mock.calls[0][0])).toBe("日本語");
  });

  it("compositionend with empty data does not call onData", () => {
    fireCompositionStart(container);
    fireCompositionEnd(container, "");
    expect(onData).not.toHaveBeenCalled();
  });

  it("keydown during composition does not send to onData", () => {
    fireCompositionStart(container);
    // Simulate keydown for a character key while composing
    fireKeyDown(container, { key: "a" });
    expect(onData).not.toHaveBeenCalled();
  });

  it("keydown after compositionend sends normally again", () => {
    fireCompositionStart(container);
    fireCompositionEnd(container, "あ");
    onData.mockClear();

    fireKeyDown(container, { key: "Enter" });
    expect(onData).toHaveBeenCalledOnce();
    expect(decode(onData.mock.calls[0][0])).toBe("\r");
  });
});

// ---------------------------------------------------------------------------
// Mobile textarea input event
// ---------------------------------------------------------------------------

describe("InputHandler — mobile textarea input", () => {
  let container: HTMLDivElement;
  let onData: ReturnType<typeof vi.fn>;
  let handler: InputHandler;

  beforeEach(() => {
    onData = vi.fn();
    handler = new InputHandler({ onData });
    container = document.createElement("div");
    document.body.appendChild(container);
    handler.attach(container, 8, 16);
  });

  afterEach(() => {
    handler.dispose();
    container.remove();
  });

  it("input event sends textarea value to onData and clears it", () => {
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireTextareaInput(container, "hello");
    expect(onData).toHaveBeenCalledOnce();
    expect(decode(onData.mock.calls[0][0])).toBe("hello");
    // textarea should be cleared after send
    expect(ta.value).toBe("");
  });

  it("input event with empty value does not call onData", () => {
    fireTextareaInput(container, "");
    expect(onData).not.toHaveBeenCalled();
  });

  it("input event during IME composition is suppressed", () => {
    fireCompositionStart(container);
    fireTextareaInput(container, "intermediate");
    expect(onData).not.toHaveBeenCalled();
  });
});
