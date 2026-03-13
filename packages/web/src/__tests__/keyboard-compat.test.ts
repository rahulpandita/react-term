import { beforeEach, describe, expect, it, vi } from "vitest";
import { InputHandler } from "../input-handler.js";

function mockKeyEvent(key: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...opts,
  } as KeyboardEvent;
}

describe("Keyboard Compatibility Tests (ported from xterm.js)", () => {
  let handler: InputHandler;

  beforeEach(() => {
    handler = new InputHandler({ onData: vi.fn() });
  });

  // ---------------------------------------------------------------------------
  // Arrow keys — normal mode
  // ---------------------------------------------------------------------------

  describe("arrow keys (normal mode)", () => {
    it("ArrowUp → \\x1b[A", () => {
      expect(handler.keyToSequence(mockKeyEvent("ArrowUp"))).toBe("\x1b[A");
    });

    it("ArrowDown → \\x1b[B", () => {
      expect(handler.keyToSequence(mockKeyEvent("ArrowDown"))).toBe("\x1b[B");
    });

    it("ArrowRight → \\x1b[C", () => {
      expect(handler.keyToSequence(mockKeyEvent("ArrowRight"))).toBe("\x1b[C");
    });

    it("ArrowLeft → \\x1b[D", () => {
      expect(handler.keyToSequence(mockKeyEvent("ArrowLeft"))).toBe("\x1b[D");
    });
  });

  // ---------------------------------------------------------------------------
  // Arrow keys — application cursor mode
  // ---------------------------------------------------------------------------

  describe("arrow keys (application cursor mode)", () => {
    beforeEach(() => {
      handler.setApplicationCursorKeys(true);
    });

    it("ArrowUp → \\x1bOA", () => {
      expect(handler.keyToSequence(mockKeyEvent("ArrowUp"))).toBe("\x1bOA");
    });

    it("ArrowDown → \\x1bOB", () => {
      expect(handler.keyToSequence(mockKeyEvent("ArrowDown"))).toBe("\x1bOB");
    });

    it("ArrowRight → \\x1bOC", () => {
      expect(handler.keyToSequence(mockKeyEvent("ArrowRight"))).toBe("\x1bOC");
    });

    it("ArrowLeft → \\x1bOD", () => {
      expect(handler.keyToSequence(mockKeyEvent("ArrowLeft"))).toBe("\x1bOD");
    });
  });

  // ---------------------------------------------------------------------------
  // Function keys
  // ---------------------------------------------------------------------------

  describe("function keys", () => {
    it("F1 → \\x1bOP", () => {
      expect(handler.keyToSequence(mockKeyEvent("F1"))).toBe("\x1bOP");
    });

    it("F2 → \\x1bOQ", () => {
      expect(handler.keyToSequence(mockKeyEvent("F2"))).toBe("\x1bOQ");
    });

    it("F3 → \\x1bOR", () => {
      expect(handler.keyToSequence(mockKeyEvent("F3"))).toBe("\x1bOR");
    });

    it("F4 → \\x1bOS", () => {
      expect(handler.keyToSequence(mockKeyEvent("F4"))).toBe("\x1bOS");
    });

    it("F5 → \\x1b[15~", () => {
      expect(handler.keyToSequence(mockKeyEvent("F5"))).toBe("\x1b[15~");
    });

    it("F6 → \\x1b[17~", () => {
      expect(handler.keyToSequence(mockKeyEvent("F6"))).toBe("\x1b[17~");
    });

    it("F7 → \\x1b[18~", () => {
      expect(handler.keyToSequence(mockKeyEvent("F7"))).toBe("\x1b[18~");
    });

    it("F8 → \\x1b[19~", () => {
      expect(handler.keyToSequence(mockKeyEvent("F8"))).toBe("\x1b[19~");
    });

    it("F9 → \\x1b[20~", () => {
      expect(handler.keyToSequence(mockKeyEvent("F9"))).toBe("\x1b[20~");
    });

    it("F10 → \\x1b[21~", () => {
      expect(handler.keyToSequence(mockKeyEvent("F10"))).toBe("\x1b[21~");
    });

    it("F11 → \\x1b[23~", () => {
      expect(handler.keyToSequence(mockKeyEvent("F11"))).toBe("\x1b[23~");
    });

    it("F12 → \\x1b[24~", () => {
      expect(handler.keyToSequence(mockKeyEvent("F12"))).toBe("\x1b[24~");
    });
  });

  // ---------------------------------------------------------------------------
  // Navigation keys
  // ---------------------------------------------------------------------------

  describe("navigation keys", () => {
    it("Home → \\x1b[H", () => {
      expect(handler.keyToSequence(mockKeyEvent("Home"))).toBe("\x1b[H");
    });

    it("End → \\x1b[F", () => {
      expect(handler.keyToSequence(mockKeyEvent("End"))).toBe("\x1b[F");
    });

    it("PageUp → \\x1b[5~", () => {
      expect(handler.keyToSequence(mockKeyEvent("PageUp"))).toBe("\x1b[5~");
    });

    it("PageDown → \\x1b[6~", () => {
      expect(handler.keyToSequence(mockKeyEvent("PageDown"))).toBe("\x1b[6~");
    });

    it("Insert → \\x1b[2~", () => {
      expect(handler.keyToSequence(mockKeyEvent("Insert"))).toBe("\x1b[2~");
    });

    it("Delete → \\x1b[3~", () => {
      expect(handler.keyToSequence(mockKeyEvent("Delete"))).toBe("\x1b[3~");
    });
  });

  // ---------------------------------------------------------------------------
  // Special keys
  // ---------------------------------------------------------------------------

  describe("special keys", () => {
    it("Enter → \\r", () => {
      expect(handler.keyToSequence(mockKeyEvent("Enter"))).toBe("\r");
    });

    it("Tab → \\t", () => {
      expect(handler.keyToSequence(mockKeyEvent("Tab"))).toBe("\t");
    });

    it("Escape → \\x1b", () => {
      expect(handler.keyToSequence(mockKeyEvent("Escape"))).toBe("\x1b");
    });

    it("Backspace → \\x7f", () => {
      expect(handler.keyToSequence(mockKeyEvent("Backspace"))).toBe("\x7f");
    });

    it("Ctrl+Backspace → \\x08", () => {
      expect(handler.keyToSequence(mockKeyEvent("Backspace", { ctrlKey: true }))).toBe("\x08");
    });
  });

  // ---------------------------------------------------------------------------
  // Ctrl + letter → control characters
  // ---------------------------------------------------------------------------

  describe("ctrl key combinations", () => {
    it("Ctrl+A → \\x01", () => {
      expect(handler.keyToSequence(mockKeyEvent("a", { ctrlKey: true }))).toBe("\x01");
    });

    it("Ctrl+C → \\x03", () => {
      expect(handler.keyToSequence(mockKeyEvent("c", { ctrlKey: true }))).toBe("\x03");
    });

    it("Ctrl+Z → \\x1a", () => {
      expect(handler.keyToSequence(mockKeyEvent("z", { ctrlKey: true }))).toBe("\x1a");
    });
  });

  // ---------------------------------------------------------------------------
  // Alt + key → ESC prefix
  // ---------------------------------------------------------------------------

  describe("alt key combinations", () => {
    it("Alt+a → \\x1ba", () => {
      expect(handler.keyToSequence(mockKeyEvent("a", { altKey: true }))).toBe("\x1ba");
    });

    it("Alt+z → \\x1bz", () => {
      expect(handler.keyToSequence(mockKeyEvent("z", { altKey: true }))).toBe("\x1bz");
    });
  });

  // ---------------------------------------------------------------------------
  // Printable characters
  // ---------------------------------------------------------------------------

  describe("printable characters", () => {
    it("'a' → 'a'", () => {
      expect(handler.keyToSequence(mockKeyEvent("a"))).toBe("a");
    });

    it("'Z' → 'Z'", () => {
      expect(handler.keyToSequence(mockKeyEvent("Z"))).toBe("Z");
    });

    it("'1' → '1'", () => {
      expect(handler.keyToSequence(mockKeyEvent("1"))).toBe("1");
    });

    it("' ' → ' '", () => {
      expect(handler.keyToSequence(mockKeyEvent(" "))).toBe(" ");
    });
  });

  // ---------------------------------------------------------------------------
  // Meta key should return null (let browser handle)
  // ---------------------------------------------------------------------------

  describe("meta key passthrough", () => {
    it("Meta+c → null", () => {
      expect(handler.keyToSequence(mockKeyEvent("c", { metaKey: true }))).toBeNull();
    });

    it("Meta+v → null", () => {
      expect(handler.keyToSequence(mockKeyEvent("v", { metaKey: true }))).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Modifier-only keys should return null
  // ---------------------------------------------------------------------------

  describe("modifier-only keys", () => {
    it("Shift → null", () => {
      expect(handler.keyToSequence(mockKeyEvent("Shift"))).toBeNull();
    });

    it("Control → null", () => {
      expect(handler.keyToSequence(mockKeyEvent("Control"))).toBeNull();
    });

    it("Alt → null", () => {
      expect(handler.keyToSequence(mockKeyEvent("Alt"))).toBeNull();
    });

    it("Meta → null", () => {
      expect(handler.keyToSequence(mockKeyEvent("Meta"))).toBeNull();
    });
  });
});
