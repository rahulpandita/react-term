/**
 * Keyboard input handling for the React Native terminal.
 *
 * Translates key presses and IME text input into VT escape sequences,
 * matching the logic in `@react-term/web`'s InputHandler.
 *
 * This is pure logic with no React Native dependencies — the RN component
 * feeds events from a hidden TextInput into this handler.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toBytes(s: string): Uint8Array {
  return encoder.encode(s);
}

// ---------------------------------------------------------------------------
// KeyboardHandler
// ---------------------------------------------------------------------------

export class KeyboardHandler {
  private onData: (data: Uint8Array) => void;
  private applicationCursorKeys: boolean;

  constructor(onData: (data: Uint8Array) => void) {
    this.onData = onData;
    this.applicationCursorKeys = false;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Process a key event from React Native's TextInput onKeyPress.
   * The `key` string follows the same naming as DOM KeyboardEvent.key
   * (e.g. "Enter", "Backspace", "ArrowUp", "a", "A").
   */
  handleKeyPress(key: string, modifiers: KeyModifiers): void {
    const seq = this.keyToSequence(key, modifiers);
    if (seq !== null) {
      this.onData(toBytes(seq));
    }
  }

  /**
   * Process IME composition / text input. This handles multi-character
   * input (e.g. CJK input methods, emoji, paste via TextInput).
   */
  handleTextInput(text: string): void {
    if (text.length > 0) {
      this.onData(encoder.encode(text));
    }
  }

  setApplicationCursorKeys(enabled: boolean): void {
    this.applicationCursorKeys = enabled;
  }

  // -----------------------------------------------------------------------
  // VT sequence generation
  // -----------------------------------------------------------------------

  /**
   * Convert a key name + modifiers into the VT sequence string to send
   * to the PTY, or null if the key should not be handled.
   *
   * This mirrors `@react-term/web` InputHandler.keyToSequence exactly.
   */
  keyToSequence(key: string, modifiers: KeyModifiers): string | null {
    const { ctrl, alt, meta } = modifiers;

    // Meta key combos are OS-level shortcuts — let them through
    if (meta) return null;

    // Ctrl + single letter -> control character
    if (ctrl && !alt && key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0);
      if (code >= 0x40 && code <= 0x5f) {
        return String.fromCharCode(code - 0x40);
      }
    }

    // Alt + key -> ESC prefix
    if (alt && !ctrl && key.length === 1) {
      return `\x1b${key}`;
    }

    // Special keys
    const appMode = this.applicationCursorKeys;
    switch (key) {
      case "Enter":
        return "\r";
      case "Backspace":
        return ctrl ? "\x08" : "\x7f";
      case "Tab":
        return "\t";
      case "Escape":
        return "\x1b";
      case "Delete":
        return "\x1b[3~";

      case "ArrowUp":
        return appMode ? "\x1bOA" : "\x1b[A";
      case "ArrowDown":
        return appMode ? "\x1bOB" : "\x1b[B";
      case "ArrowRight":
        return appMode ? "\x1bOC" : "\x1b[C";
      case "ArrowLeft":
        return appMode ? "\x1bOD" : "\x1b[D";

      case "Home":
        return "\x1b[H";
      case "End":
        return "\x1b[F";
      case "PageUp":
        return "\x1b[5~";
      case "PageDown":
        return "\x1b[6~";

      case "Insert":
        return "\x1b[2~";

      // Function keys
      case "F1":
        return "\x1bOP";
      case "F2":
        return "\x1bOQ";
      case "F3":
        return "\x1bOR";
      case "F4":
        return "\x1bOS";
      case "F5":
        return "\x1b[15~";
      case "F6":
        return "\x1b[17~";
      case "F7":
        return "\x1b[18~";
      case "F8":
        return "\x1b[19~";
      case "F9":
        return "\x1b[20~";
      case "F10":
        return "\x1b[21~";
      case "F11":
        return "\x1b[23~";
      case "F12":
        return "\x1b[24~";
    }

    // Modifier-only keys
    if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") {
      return null;
    }

    // Printable character
    if (key.length === 1) {
      return key;
    }

    return null;
  }
}
