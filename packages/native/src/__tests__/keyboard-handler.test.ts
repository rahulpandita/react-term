import { describe, expect, it, vi } from "vitest";
import type { KeyModifiers } from "../input/KeyboardHandler.js";
import { KeyboardHandler } from "../input/KeyboardHandler.js";

const NO_MOD: KeyModifiers = { ctrl: false, alt: false, shift: false, meta: false };

function createHandler() {
  const onData = vi.fn();
  const handler = new KeyboardHandler(onData);
  return { handler, onData };
}

function lastBytes(onData: ReturnType<typeof vi.fn>): Uint8Array {
  return onData.mock.calls[onData.mock.calls.length - 1][0];
}

function lastString(onData: ReturnType<typeof vi.fn>): string {
  return new TextDecoder().decode(lastBytes(onData));
}

describe("KeyboardHandler", () => {
  // -----------------------------------------------------------------------
  // Regular keys
  // -----------------------------------------------------------------------

  describe("regular keys", () => {
    it("sends correct byte for a single character", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("a", NO_MOD);
      expect(lastString(onData)).toBe("a");
    });

    it("sends uppercase character", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("A", { ...NO_MOD, shift: true });
      expect(lastString(onData)).toBe("A");
    });
  });

  // -----------------------------------------------------------------------
  // Special keys
  // -----------------------------------------------------------------------

  describe("special keys", () => {
    it("Enter sends \\r", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("Enter", NO_MOD);
      expect(lastString(onData)).toBe("\r");
    });

    it("Backspace sends \\x7f", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("Backspace", NO_MOD);
      expect(lastBytes(onData)).toEqual(new Uint8Array([0x7f]));
    });

    it("Tab sends \\t", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("Tab", NO_MOD);
      expect(lastString(onData)).toBe("\t");
    });

    it("Escape sends \\x1b", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("Escape", NO_MOD);
      expect(lastBytes(onData)).toEqual(new Uint8Array([0x1b]));
    });

    it("Delete sends \\x1b[3~", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("Delete", NO_MOD);
      expect(lastString(onData)).toBe("\x1b[3~");
    });
  });

  // -----------------------------------------------------------------------
  // Arrow keys (normal mode)
  // -----------------------------------------------------------------------

  describe("arrow keys (normal mode)", () => {
    it("ArrowUp sends \\x1b[A", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("ArrowUp", NO_MOD);
      expect(lastString(onData)).toBe("\x1b[A");
    });

    it("ArrowDown sends \\x1b[B", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("ArrowDown", NO_MOD);
      expect(lastString(onData)).toBe("\x1b[B");
    });

    it("ArrowRight sends \\x1b[C", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("ArrowRight", NO_MOD);
      expect(lastString(onData)).toBe("\x1b[C");
    });

    it("ArrowLeft sends \\x1b[D", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("ArrowLeft", NO_MOD);
      expect(lastString(onData)).toBe("\x1b[D");
    });
  });

  // -----------------------------------------------------------------------
  // Arrow keys (application mode)
  // -----------------------------------------------------------------------

  describe("arrow keys (application cursor mode)", () => {
    it("ArrowUp sends \\x1bOA in app mode", () => {
      const { handler, onData } = createHandler();
      handler.setApplicationCursorKeys(true);
      handler.handleKeyPress("ArrowUp", NO_MOD);
      expect(lastString(onData)).toBe("\x1bOA");
    });

    it("ArrowDown sends \\x1bOB in app mode", () => {
      const { handler, onData } = createHandler();
      handler.setApplicationCursorKeys(true);
      handler.handleKeyPress("ArrowDown", NO_MOD);
      expect(lastString(onData)).toBe("\x1bOB");
    });

    it("ArrowRight sends \\x1bOC in app mode", () => {
      const { handler, onData } = createHandler();
      handler.setApplicationCursorKeys(true);
      handler.handleKeyPress("ArrowRight", NO_MOD);
      expect(lastString(onData)).toBe("\x1bOC");
    });

    it("ArrowLeft sends \\x1bOD in app mode", () => {
      const { handler, onData } = createHandler();
      handler.setApplicationCursorKeys(true);
      handler.handleKeyPress("ArrowLeft", NO_MOD);
      expect(lastString(onData)).toBe("\x1bOD");
    });
  });

  // -----------------------------------------------------------------------
  // Ctrl combos
  // -----------------------------------------------------------------------

  describe("ctrl combos", () => {
    it("Ctrl+C sends \\x03", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("c", { ...NO_MOD, ctrl: true });
      expect(lastBytes(onData)).toEqual(new Uint8Array([0x03]));
    });

    it("Ctrl+A sends \\x01", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("a", { ...NO_MOD, ctrl: true });
      expect(lastBytes(onData)).toEqual(new Uint8Array([0x01]));
    });

    it("Ctrl+Z sends \\x1a", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("z", { ...NO_MOD, ctrl: true });
      expect(lastBytes(onData)).toEqual(new Uint8Array([0x1a]));
    });

    it("Ctrl+Backspace sends \\x08", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("Backspace", { ...NO_MOD, ctrl: true });
      expect(lastBytes(onData)).toEqual(new Uint8Array([0x08]));
    });
  });

  // -----------------------------------------------------------------------
  // Alt combos
  // -----------------------------------------------------------------------

  describe("alt combos", () => {
    it("Alt+a sends ESC + a", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("a", { ...NO_MOD, alt: true });
      expect(lastString(onData)).toBe("\x1ba");
    });
  });

  // -----------------------------------------------------------------------
  // Meta key
  // -----------------------------------------------------------------------

  describe("meta key", () => {
    it("Meta+c does not send data (let OS handle it)", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("c", { ...NO_MOD, meta: true });
      expect(onData).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Modifier-only keys
  // -----------------------------------------------------------------------

  describe("modifier-only keys", () => {
    it("Shift alone does not send data", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("Shift", NO_MOD);
      expect(onData).not.toHaveBeenCalled();
    });

    it("Control alone does not send data", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("Control", NO_MOD);
      expect(onData).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // IME text input
  // -----------------------------------------------------------------------

  describe("handleTextInput", () => {
    it("sends UTF-8 encoded text", () => {
      const { handler, onData } = createHandler();
      handler.handleTextInput("hello");
      expect(lastString(onData)).toBe("hello");
    });

    it("handles multi-byte characters", () => {
      const { handler, onData } = createHandler();
      handler.handleTextInput("\u00e9"); // é
      const bytes = lastBytes(onData);
      expect(bytes).toEqual(new Uint8Array([0xc3, 0xa9]));
    });

    it("handles CJK characters", () => {
      const { handler, onData } = createHandler();
      handler.handleTextInput("\u4e16"); // 世
      expect(onData).toHaveBeenCalled();
      expect(lastBytes(onData).length).toBe(3); // UTF-8: 3 bytes
    });

    it("ignores empty string", () => {
      const { handler, onData } = createHandler();
      handler.handleTextInput("");
      expect(onData).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Function keys
  // -----------------------------------------------------------------------

  describe("function keys", () => {
    it("F1 sends \\x1bOP", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("F1", NO_MOD);
      expect(lastString(onData)).toBe("\x1bOP");
    });

    it("F5 sends \\x1b[15~", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("F5", NO_MOD);
      expect(lastString(onData)).toBe("\x1b[15~");
    });

    it("F12 sends \\x1b[24~", () => {
      const { handler, onData } = createHandler();
      handler.handleKeyPress("F12", NO_MOD);
      expect(lastString(onData)).toBe("\x1b[24~");
    });
  });
});
