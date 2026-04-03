/**
 * Keyboard, mouse, and touch input handling for the web terminal.
 *
 * Uses a hidden <textarea> to capture keyboard input. This is essential
 * for mobile browsers (iOS Safari, Android Chrome) where a plain div with
 * tabindex="0" does NOT trigger the virtual keyboard. The textarea is
 * positioned behind the terminal canvas so it's invisible but focusable.
 *
 * Touch gestures are delegated to the shared GestureHandler from
 * @next_term/core, providing the same behavior on web and native:
 * tap to focus, pan to scroll, long-press to select, pinch to zoom.
 */

import type { CellGrid, MouseEncoding, MouseProtocol } from "@next_term/core";
import { extractText, GestureHandler, GestureState } from "@next_term/core";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface InputHandlerOptions {
  /** Called when the user types data that should be sent to the PTY. */
  onData: (data: Uint8Array) => void;
  /** Called when the selection state changes. */
  onSelectionChange?: (selection: SelectionState | null) => void;
  /** Called when the user scrolls (deltaRows: positive = scroll down / toward newer). */
  onScroll?: (deltaRows: number) => void;
  /** Called when pinch-to-zoom changes font size. Receives the new fontSize. */
  onFontSizeChange?: (fontSize: number) => void;
  /** Whether the terminal is in application cursor-key mode (\x1bOA vs \x1b[A). */
  applicationCursorKeys?: boolean;
}

export interface SelectionState {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toBytes(s: string): Uint8Array {
  return encoder.encode(s);
}

// ---------------------------------------------------------------------------
// Kitty alternate-key helpers (flag 4)
// ---------------------------------------------------------------------------

/** Returns the shifted codepoint for an ASCII character (0 if not applicable). */
function _kittyShiftedCp(cp: number): number {
  if (cp >= 97 && cp <= 122) return cp - 32; // a-z → A-Z
  if (cp >= 65 && cp <= 90) return cp; // A-Z → same (already the shifted form)
  // digits 0-9 → their shifted symbols: )!@#$%^&*(
  if (cp >= 48 && cp <= 57) return ")!@#$%^&*(".charCodeAt(cp - 48);
  return 0;
}

/** Returns the base (unshifted) codepoint for an ASCII character (0 if not applicable). */
function _kittyBaseCp(cp: number): number {
  if (cp >= 65 && cp <= 90) return cp + 32; // A-Z → a-z
  if (cp >= 97 && cp <= 122) return cp; // a-z → same (already the base form)
  // shifted digit symbols → corresponding digit
  switch (cp) {
    case 33:
      return 49; // ! → 1
    case 64:
      return 50; // @ → 2
    case 35:
      return 51; // # → 3
    case 36:
      return 52; // $ → 4
    case 37:
      return 53; // % → 5
    case 94:
      return 54; // ^ → 6
    case 38:
      return 55; // & → 7
    case 42:
      return 56; // * → 8
    case 40:
      return 57; // ( → 9
    case 41:
      return 48; // ) → 0
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Touch constants
// ---------------------------------------------------------------------------

/** Milliseconds to wait before recognizing a long press. */
const LONG_PRESS_DELAY = 500;

/** Maximum pixel movement allowed during a tap. */
const TAP_THRESHOLD = 10;

/** Font size limits for pinch-to-zoom. */
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

// ---------------------------------------------------------------------------
// InputHandler
// ---------------------------------------------------------------------------

export class InputHandler {
  private container: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private onData: (data: Uint8Array) => void;
  private onSelectionChange: ((sel: SelectionState | null) => void) | null;
  private onScroll: ((deltaRows: number) => void) | null;
  private onFontSizeChange: ((fontSize: number) => void) | null;
  private applicationCursorKeys: boolean;

  // Bracketed paste mode — wraps pasted text in ESC[200~ ... ESC[201~
  private bracketedPasteMode = false;

  // Mouse reporting
  private mouseProtocol: MouseProtocol = "none";
  private mouseEncoding: MouseEncoding = "default";

  // Focus events
  private sendFocusEvents = false;

  // Kitty keyboard protocol flags (mirror of VTParser.kittyFlags)
  private kittyFlags = 0;

  private cellWidth = 0;
  private cellHeight = 0;

  // Current font size for pinch-to-zoom
  private currentFontSize = 14;

  // Grid reference for text extraction
  private grid: CellGrid | null = null;

  // Mouse / selection state
  private selecting = false;
  private selection: SelectionState | null = null;

  // Shared gesture handler (from @next_term/core)
  private gestureHandler: GestureHandler | null = null;

  // Touch DOM state (bridges DOM TouchEvents to GestureHandler)
  private touchStartX = 0;
  private touchStartY = 0;
  private touchLastX = 0;
  private touchLastY = 0;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private pinchStartDistance = 0;
  private pinchStartFontSize = 0;
  private isPinching = false;

  // Swipe direction lock: once a swipe direction is determined, it stays locked
  // for the gesture duration ('none' | 'horizontal' | 'vertical')
  private swipeDirection: "none" | "horizontal" | "vertical" = "none";
  // Horizontal swipe: accumulated pixel remainder for left/right arrow keys
  private hSwipeRemainder = 0;

  // Whether an IME composition is in progress (CJK, etc.)
  private composing = false;

  // Custom copy tooltip for iOS/mobile (native callout doesn't work with programmatic selection)
  private copyTooltip: HTMLElement | null = null;
  /** Text currently staged for copy. */
  private pendingCopyText = "";

  // Bound listeners (so we can remove them)
  private boundKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private boundKeyUp: ((e: KeyboardEvent) => void) | null = null;
  private boundInput: ((e: Event) => void) | null = null;
  private boundCompositionStart: (() => void) | null = null;
  private boundCompositionEnd: ((e: CompositionEvent) => void) | null = null;
  private boundPaste: ((e: ClipboardEvent) => void) | null = null;
  private boundMouseDown: ((e: MouseEvent) => void) | null = null;
  private boundMouseMove: ((e: MouseEvent) => void) | null = null;
  private boundMouseUp: ((e: MouseEvent) => void) | null = null;
  private boundFocus: (() => void) | null = null;
  private boundBlur: (() => void) | null = null;
  private boundWheel: ((e: WheelEvent) => void) | null = null;
  private boundTouchStart: ((e: TouchEvent) => void) | null = null;
  private boundTouchMove: ((e: TouchEvent) => void) | null = null;
  private boundTouchEnd: ((e: TouchEvent) => void) | null = null;
  private boundTouchCancel: ((e: TouchEvent) => void) | null = null;

  constructor(options: InputHandlerOptions) {
    this.onData = options.onData;
    this.onSelectionChange = options.onSelectionChange ?? null;
    this.onScroll = options.onScroll ?? null;
    this.onFontSizeChange = options.onFontSizeChange ?? null;
    this.applicationCursorKeys = options.applicationCursorKeys ?? false;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  attach(container: HTMLElement, cellWidth: number, cellHeight: number): void {
    this.container = container;
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;

    // Container setup — not focusable itself, the textarea handles focus
    container.setAttribute("role", "terminal");
    container.setAttribute("aria-label", "Terminal");
    Object.assign(container.style, {
      outline: "none",
      cursor: "text",
      position: "relative",
      // Prevent default touch behaviors (pull-to-refresh, scroll bounce)
      touchAction: "none",
    });

    // Create hidden textarea for keyboard input.
    // iOS Safari (and Android Chrome) only show the virtual keyboard when
    // an <input> or <textarea> element receives focus. We position the
    // textarea behind the terminal canvas so it's invisible but still
    // triggers the on-screen keyboard.
    const ta = document.createElement("textarea");
    ta.setAttribute("autocapitalize", "none");
    ta.setAttribute("autocomplete", "off");
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("spellcheck", "false");
    ta.setAttribute("tabindex", "0");
    ta.setAttribute("aria-hidden", "true");
    Object.assign(ta.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "1px",
      height: "1px",
      opacity: "0",
      padding: "0",
      border: "none",
      outline: "none",
      resize: "none",
      overflow: "hidden",
      // iOS: prevent zoom on focus (font-size < 16px triggers auto-zoom)
      fontSize: "16px",
      // Keep it in the DOM flow but invisible
      zIndex: "-1",
      caretColor: "transparent",
    });
    container.appendChild(ta);
    this.textarea = ta;

    // Initialize shared gesture handler
    this.gestureHandler = new GestureHandler(cellWidth, cellHeight, {
      onScroll: (deltaRows) => {
        if (this.onScroll) {
          this.onScroll(deltaRows);
        }
        // No fallback — vertical swipe is for scrollback only.
        // Horizontal swipe sends arrow keys (handled in handleTouchMove).
      },
      onTap: (_row, _col) => {
        // Tap clears selection; focus is handled by touchstart
        if (this.selection) {
          this.clearSelection();
        }
      },
      onDoubleTap: (_row, _col) => {
        // TODO: word selection
      },
      onLongPress: (_row, _col) => {
        // Selection is started by GestureHandler via onSelectionChange
      },
      onPinch: (scale) => {
        const newSize = Math.round(
          Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, this.pinchStartFontSize * scale)),
        );
        if (newSize !== this.currentFontSize) {
          this.currentFontSize = newSize;
          this.onFontSizeChange?.(newSize);
        }
      },
      onSelectionChange: (sel) => {
        this.selection = sel;
        this.onSelectionChange?.(sel);

        // When selection is non-empty, put the text into the hidden textarea
        // and select it so iOS Safari shows the native "Copy" callout menu.
        if (sel && this.grid) {
          if (sel.startRow !== sel.endRow || sel.startCol !== sel.endCol) {
            const text = extractText(this.grid, sel.startRow, sel.startCol, sel.endRow, sel.endCol);
            if (text) {
              this.showCopyTooltip(text);
            }
          }
        } else if (!sel) {
          this.hideCopyTooltip();
        }
      },
    });

    // Keyboard — listen on the textarea
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundKeyUp = this.handleKeyUp.bind(this);
    this.boundInput = this.handleInput.bind(this);
    this.boundCompositionStart = this.handleCompositionStart.bind(this);
    this.boundCompositionEnd = this.handleCompositionEnd.bind(this);
    this.boundPaste = this.handlePaste.bind(this);
    ta.addEventListener("keydown", this.boundKeyDown);
    ta.addEventListener("keyup", this.boundKeyUp);
    ta.addEventListener("input", this.boundInput);
    ta.addEventListener("compositionstart", this.boundCompositionStart);
    ta.addEventListener("compositionend", this.boundCompositionEnd);
    ta.addEventListener("paste", this.boundPaste);

    // Mouse
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundWheel = this.handleWheel.bind(this);
    container.addEventListener("mousedown", this.boundMouseDown);
    container.addEventListener("wheel", this.boundWheel, { passive: false });
    document.addEventListener("mousemove", this.boundMouseMove);
    document.addEventListener("mouseup", this.boundMouseUp);

    // Touch — bridges DOM TouchEvents to the shared GestureHandler
    this.boundTouchStart = this.handleTouchStart.bind(this);
    this.boundTouchMove = this.handleTouchMove.bind(this);
    this.boundTouchEnd = this.handleTouchEnd.bind(this);
    this.boundTouchCancel = this.handleTouchCancel.bind(this);
    container.addEventListener("touchstart", this.boundTouchStart, { passive: false });
    container.addEventListener("touchmove", this.boundTouchMove, { passive: false });
    container.addEventListener("touchend", this.boundTouchEnd, { passive: false });
    container.addEventListener("touchcancel", this.boundTouchCancel);

    // Focus/blur events for mode 1004 — on the textarea
    this.boundFocus = this.handleFocus.bind(this);
    this.boundBlur = this.handleBlur.bind(this);
    ta.addEventListener("focus", this.boundFocus);
    ta.addEventListener("blur", this.boundBlur);

    // Clicking the container should focus the textarea
    container.addEventListener("mousedown", (e) => {
      // Don't steal focus if it's a right-click / context menu
      if (e.button === 0) {
        // Delay focus to after mousedown handler runs
        setTimeout(() => ta.focus(), 0);
      }
    });
  }

  focus(): void {
    this.textarea?.focus();
  }

  blur(): void {
    this.textarea?.blur();
  }

  setApplicationCursorKeys(enabled: boolean): void {
    this.applicationCursorKeys = enabled;
  }

  setBracketedPasteMode(enabled: boolean): void {
    this.bracketedPasteMode = enabled;
  }

  setMouseProtocol(protocol: MouseProtocol): void {
    this.mouseProtocol = protocol;
  }

  setMouseEncoding(encoding: MouseEncoding): void {
    this.mouseEncoding = encoding;
  }

  setSendFocusEvents(enabled: boolean): void {
    this.sendFocusEvents = enabled;
  }

  setKittyFlags(flags: number): void {
    this.kittyFlags = flags;
  }

  updateCellSize(cellWidth: number, cellHeight: number): void {
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.gestureHandler?.updateCellSize(cellWidth, cellHeight);
  }

  setFontSize(fontSize: number): void {
    this.currentFontSize = fontSize;
  }

  setGrid(grid: CellGrid): void {
    this.grid = grid;
  }

  getSelection(): SelectionState | null {
    return this.selection;
  }

  clearSelection(): void {
    this.selection = null;
    this.gestureHandler?.clearSelection();
    this.onSelectionChange?.(null);
    this.hideCopyTooltip();
  }

  dispose(): void {
    this.cancelLongPress();

    // Textarea listeners
    if (this.textarea && this.boundKeyDown) {
      this.textarea.removeEventListener("keydown", this.boundKeyDown);
    }
    if (this.textarea && this.boundKeyUp) {
      this.textarea.removeEventListener("keyup", this.boundKeyUp);
    }
    if (this.textarea && this.boundInput) {
      this.textarea.removeEventListener("input", this.boundInput);
    }
    if (this.textarea && this.boundCompositionStart) {
      this.textarea.removeEventListener("compositionstart", this.boundCompositionStart);
    }
    if (this.textarea && this.boundCompositionEnd) {
      this.textarea.removeEventListener("compositionend", this.boundCompositionEnd);
    }
    if (this.textarea && this.boundPaste) {
      this.textarea.removeEventListener("paste", this.boundPaste);
    }
    if (this.textarea && this.boundFocus) {
      this.textarea.removeEventListener("focus", this.boundFocus);
    }
    if (this.textarea && this.boundBlur) {
      this.textarea.removeEventListener("blur", this.boundBlur);
    }
    // Remove textarea from DOM
    if (this.textarea?.parentNode) {
      this.textarea.parentNode.removeChild(this.textarea);
    }

    // Container listeners
    if (this.container && this.boundMouseDown) {
      this.container.removeEventListener("mousedown", this.boundMouseDown);
    }
    if (this.container && this.boundWheel) {
      this.container.removeEventListener("wheel", this.boundWheel);
    }
    if (this.container && this.boundTouchStart) {
      this.container.removeEventListener("touchstart", this.boundTouchStart);
    }
    if (this.container && this.boundTouchMove) {
      this.container.removeEventListener("touchmove", this.boundTouchMove);
    }
    if (this.container && this.boundTouchEnd) {
      this.container.removeEventListener("touchend", this.boundTouchEnd);
    }
    if (this.container && this.boundTouchCancel) {
      this.container.removeEventListener("touchcancel", this.boundTouchCancel);
    }

    // Document listeners
    if (this.boundMouseMove) {
      document.removeEventListener("mousemove", this.boundMouseMove);
    }
    if (this.boundMouseUp) {
      document.removeEventListener("mouseup", this.boundMouseUp);
    }

    if (this.copyTooltip?.parentNode) {
      this.copyTooltip.parentNode.removeChild(this.copyTooltip);
    }
    this.copyTooltip = null;
    this.textarea = null;
    this.container = null;
    this.gestureHandler = null;
    this.boundKeyDown = null;
    this.boundKeyUp = null;
    this.boundInput = null;
    this.boundCompositionStart = null;
    this.boundCompositionEnd = null;
    this.boundPaste = null;
    this.boundMouseDown = null;
    this.boundMouseMove = null;
    this.boundMouseUp = null;
    this.boundWheel = null;
    this.boundTouchStart = null;
    this.boundTouchMove = null;
    this.boundTouchEnd = null;
    this.boundTouchCancel = null;
    this.boundFocus = null;
    this.boundBlur = null;
  }

  // -----------------------------------------------------------------------
  // Keyboard handling
  // -----------------------------------------------------------------------

  private handleKeyDown(e: KeyboardEvent): void {
    // During IME composition, let the browser handle it
    if (this.composing) return;

    // Ctrl+C or Cmd+C with active selection → copy to clipboard
    if ((e.ctrlKey || e.metaKey) && e.key === "c" && this.selection && this.grid) {
      e.preventDefault();
      const text = extractText(
        this.grid,
        this.selection.startRow,
        this.selection.startCol,
        this.selection.endRow,
        this.selection.endCol,
      );
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(() => {
          /* ignore */
        });
      }
      this.clearSelection();
      return;
    }

    // Cmd+V / Ctrl+V: read from clipboard and send to PTY
    if ((e.ctrlKey || e.metaKey) && e.key === "v") {
      e.preventDefault();
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) this.sendPastedText(text);
          })
          .catch(() => {
            /* ignore */
          });
      }
      return;
    }

    const seq = this.keyToSequence(e);
    if (seq !== null) {
      e.preventDefault();
      this.onData(toBytes(seq));
      // Clear the textarea so mobile input doesn't accumulate
      if (this.textarea) this.textarea.value = "";
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (this.composing) return;
    const seq = this.keyUpToSequence(e);
    if (seq !== null) {
      e.preventDefault();
      this.onData(toBytes(seq));
    }
  }

  /**
   * Handle input events from the hidden textarea.
   * On mobile browsers, the virtual keyboard fires `input` events rather
   * than `keydown` for printable characters. We read the textarea value
   * and send any new characters to the PTY.
   */
  private handleInput(_e: Event): void {
    // During IME composition, wait for compositionend
    if (this.composing) return;

    if (!this.textarea) return;
    const data = this.textarea.value;
    if (data) {
      this.onData(toBytes(data));
      this.textarea.value = "";
    }
  }

  private handleCompositionStart(): void {
    this.composing = true;
  }

  private handleCompositionEnd(e: CompositionEvent): void {
    this.composing = false;
    // Send the composed text (CJK characters, accented letters, etc.)
    if (e.data) {
      this.onData(toBytes(e.data));
    }
    if (this.textarea) this.textarea.value = "";
  }

  private handlePaste(e: ClipboardEvent): void {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (text) {
      this.sendPastedText(text);
    }
  }

  /** Send pasted text, wrapping in bracketed paste sequences if enabled. */
  private sendPastedText(text: string): void {
    if (this.bracketedPasteMode) {
      // Strip nested bracket-paste markers from the pasted content:
      // ESC[201~ could prematurely terminate the paste region on the receiver;
      // ESC[200~ would create a malformed nested bracket-paste sequence.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is intentional here
      const safe = text.replace(/\u001b\[20[01]~/g, "");
      this.onData(toBytes(`\x1b[200~${safe}\x1b[201~`));
    } else {
      this.onData(toBytes(text));
    }
  }

  /**
   * Convert a KeyboardEvent into the VT sequence string to send to the PTY,
   * or null if the event should not be handled.
   */
  keyToSequence(e: KeyboardEvent): string | null {
    const { key, ctrlKey, altKey, metaKey, shiftKey } = e;

    // Meta key combos are browser shortcuts — let them through
    if (metaKey) return null;

    // Kitty disambiguate mode (flag 1): use CSI u encoding for ambiguous keys
    if (this.kittyFlags & 1) {
      return this._keyToSequenceKitty(key, ctrlKey, altKey, shiftKey, e.repeat ? 2 : 1);
    }

    // Ctrl + single letter → control character
    if (ctrlKey && !altKey && key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0);
      if (code >= 0x40 && code <= 0x5f) {
        return String.fromCharCode(code - 0x40);
      }
    }

    // Alt + key → ESC prefix
    if (altKey && !ctrlKey && key.length === 1) {
      return `\x1b${key}`;
    }

    // Special keys
    const appMode = this.applicationCursorKeys;
    switch (key) {
      case "Enter":
        return "\r";
      case "Backspace":
        return ctrlKey ? "\x08" : "\x7f";
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

  /**
   * Produce the key-release sequence for a keyup event.
   * Only meaningful when kittyFlags & 2 (report event types) is active.
   * Returns null if event types are not enabled or the key has no kitty-encoded release.
   */
  keyUpToSequence(e: KeyboardEvent): string | null {
    if (!(this.kittyFlags & 2)) return null;
    if (e.metaKey) return null;
    return this._keyToSequenceKitty(e.key, e.ctrlKey, e.altKey, e.shiftKey, 3);
  }

  /**
   * Kitty keyboard protocol key encoding (disambiguate mode, flag 1).
   *
   * Modifier bitmask (add 1 for the wire value):
   *   shift=1, alt=2, ctrl=4
   *
   * Encoding rules:
   * - Escape                → CSI 27 u  (CSI 27;1:type u when flag 2)
   * - Modifier + letter     → CSI codepoint[:alt] ; modifier+1 u
   * - Shift+Tab             → CSI 9 ; 2 u
   * - Modified cursor keys  → CSI 1 ; modifier+1 <ABCDHF>
   * - Modified tilde keys   → CSI n ; modifier+1 ~
   * - Modified ESC-O F1-F4  → CSI 1 ; modifier+1 <PQRS>
   * - Unmodified keys       → fall back to legacy encoding (no event type suffix)
   *
   * When kittyFlags & 2 (report event types), `:eventType` is appended to the
   * modifier parameter of all enhanced sequences (not legacy fallbacks).
   * When kittyFlags & 4 (report alternate keys), the key codepoint gains
   * `:shifted[:base]` sub-parameters for single printable characters.
   */
  private _keyToSequenceKitty(
    key: string,
    ctrlKey: boolean,
    altKey: boolean,
    shiftKey: boolean,
    eventType = 1,
  ): string | null {
    // Modifier value: 1 + bitmask(shift=1, alt=2, ctrl=4)
    const mod = 1 + (shiftKey ? 1 : 0) + (altKey ? 2 : 0) + (ctrlKey ? 4 : 0);
    const hasModifier = mod !== 1;
    // Event type suffix for flag 2 (report event types): ":eventType" appended to modifier
    const et = this.kittyFlags & 2 ? `:${eventType}` : "";

    // Escape always gets CSI u encoding to remove ambiguity with ESC-prefix sequences
    if (key === "Escape") {
      return this.kittyFlags & 2 ? `\x1b[27;1:${eventType}u` : "\x1b[27u";
    }

    // Shift+Tab → CSI 9 ; 2 u
    if (key === "Tab" && shiftKey) {
      return `\x1b[9;${mod}${et}${this._kittyTextParam("Tab")}u`;
    }

    // Modifier + single printable character → CSI codepoint[:alt] ; mod u
    // Flag 8 (report all keys as escape codes) also encodes unmodified/shift-only chars.
    if (key.length === 1 && ((hasModifier && (ctrlKey || altKey)) || this.kittyFlags & 8)) {
      return `\x1b[${key.charCodeAt(0)}${this._kittyAltParam(key)};${mod}${et}${this._kittyTextParam(key)}u`;
    }

    // Modified cursor keys → CSI 1 ; mod <letter>
    if (hasModifier) {
      switch (key) {
        case "ArrowUp":
          return `\x1b[1;${mod}${et}A`;
        case "ArrowDown":
          return `\x1b[1;${mod}${et}B`;
        case "ArrowRight":
          return `\x1b[1;${mod}${et}C`;
        case "ArrowLeft":
          return `\x1b[1;${mod}${et}D`;
        case "Home":
          return `\x1b[1;${mod}${et}H`;
        case "End":
          return `\x1b[1;${mod}${et}F`;
        // Modified tilde-style keys: CSI n ; mod ~
        case "Delete":
          return `\x1b[3;${mod}${et}~`;
        case "Insert":
          return `\x1b[2;${mod}${et}~`;
        case "PageUp":
          return `\x1b[5;${mod}${et}~`;
        case "PageDown":
          return `\x1b[6;${mod}${et}~`;
        // Modified F1-F4 (ESC-O style → CSI 1 ; mod <letter>)
        case "F1":
          return `\x1b[1;${mod}${et}P`;
        case "F2":
          return `\x1b[1;${mod}${et}Q`;
        case "F3":
          return `\x1b[1;${mod}${et}R`;
        case "F4":
          return `\x1b[1;${mod}${et}S`;
        // Modified F5-F12 (tilde-style)
        case "F5":
          return `\x1b[15;${mod}${et}~`;
        case "F6":
          return `\x1b[17;${mod}${et}~`;
        case "F7":
          return `\x1b[18;${mod}${et}~`;
        case "F8":
          return `\x1b[19;${mod}${et}~`;
        case "F9":
          return `\x1b[20;${mod}${et}~`;
        case "F10":
          return `\x1b[21;${mod}${et}~`;
        case "F11":
          return `\x1b[23;${mod}${et}~`;
        case "F12":
          return `\x1b[24;${mod}${et}~`;
      }
    }

    // Unmodified keys: fall through to legacy encoding.
    // Flag 8 (report all keys as escape codes): functional keys that produce literal
    // characters are encoded as CSI u before the legacy-only eventType=3 guard.
    if (this.kittyFlags & 8) {
      switch (key) {
        case "Enter":
          return `\x1b[13;1${et}${this._kittyTextParam("Enter")}u`;
        case "Tab":
          return `\x1b[9;1${et}${this._kittyTextParam("Tab")}u`;
        case "Backspace":
          return `\x1b[127;1${et}${this._kittyTextParam("Backspace")}u`;
      }
    }
    // Legacy sequences don't support release events — return null on keyup (eventType=3).
    if (eventType === 3) return null;
    switch (key) {
      case "Enter":
        return "\r";
      case "Backspace":
        return "\x7f";
      case "Tab":
        return "\t";
      case "Delete":
        return "\x1b[3~";
      case "ArrowUp":
        return "\x1b[A";
      case "ArrowDown":
        return "\x1b[B";
      case "ArrowRight":
        return "\x1b[C";
      case "ArrowLeft":
        return "\x1b[D";
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

    if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") {
      return null;
    }

    if (key.length === 1) {
      return key;
    }

    return null;
  }

  /**
   * Alternate key sub-parameters for flag 4 (report alternate keys).
   *
   * Returns the sub-parameter string to append to the Unicode codepoint in
   * CSI u sequences: `:shifted`, `::base`, `:shifted:base`, or `""`.
   * - shifted: codepoint when Shift is held on the same physical key
   * - base: codepoint of the physical key without modifiers (US QWERTY)
   * Sub-parameters equal to the main codepoint are omitted.
   */
  private _kittyAltParam(key: string): string {
    if (!(this.kittyFlags & 4) || key.length !== 1) return "";
    const cp = key.charCodeAt(0);
    const shifted = _kittyShiftedCp(cp);
    const base = _kittyBaseCp(cp);
    const alt1 = shifted !== 0 && shifted !== cp ? `${shifted}` : "";
    const alt2 = base !== 0 && base !== cp ? `${base}` : "";
    if (!alt1 && !alt2) return "";
    if (!alt2) return `:${alt1}`;
    return `:${alt1}:${alt2}`;
  }

  /**
   * Associated text sub-parameter for flag 16 (report associated text).
   *
   * Returns the `;codepoint` third-parameter suffix for keys that produce text,
   * or `""` when flag 16 is inactive or the key produces no associated text.
   */
  private _kittyTextParam(key: string): string {
    if (!(this.kittyFlags & 16)) return "";
    if (key.length === 1) return `;${key.charCodeAt(0)}`;
    switch (key) {
      case "Enter":
        return ";13";
      case "Tab":
        return ";9";
      case "Backspace":
        return ";127";
    }
    return "";
  }

  // -----------------------------------------------------------------------
  // Focus / blur events (mode 1004)
  // -----------------------------------------------------------------------

  private handleFocus(): void {
    if (this.sendFocusEvents) {
      this.onData(toBytes("\x1b[I"));
    }
  }

  private handleBlur(): void {
    if (this.sendFocusEvents) {
      this.onData(toBytes("\x1b[O"));
    }
  }

  // -----------------------------------------------------------------------
  // Mouse / selection handling
  // -----------------------------------------------------------------------

  private getMouseCellPos(e: MouseEvent): { col: number; row: number } | null {
    if (!this.container || this.cellWidth <= 0 || this.cellHeight <= 0) return null;
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const col = Math.floor(x / this.cellWidth);
    const row = Math.floor(y / this.cellHeight);
    return { col: Math.max(0, col), row: Math.max(0, row) };
  }

  /**
   * Encode a mouse event as a VT sequence.
   * button: 0=left, 1=middle, 2=right, 3=release, 64=scrollUp, 65=scrollDown
   */
  private encodeMouseEvent(button: number, col: number, row: number): string {
    if (this.mouseEncoding === "sgr") {
      const final = button === 3 ? "m" : "M";
      const btn = button === 3 ? 0 : button;
      return `\x1b[<${btn};${col + 1};${row + 1}${final}`;
    }
    const cb = String.fromCharCode(button + 32);
    const cx = String.fromCharCode(col + 1 + 32);
    const cy = String.fromCharCode(row + 1 + 32);
    return `\x1b[M${cb}${cx}${cy}`;
  }

  private handleMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const pos = this.getMouseCellPos(e);
    if (!pos) return;

    if (this.mouseProtocol !== "none") {
      e.preventDefault();
      this.onData(toBytes(this.encodeMouseEvent(0, pos.col, pos.row)));
      this.focus();
      return;
    }

    this.selecting = true;
    this.selection = {
      startRow: pos.row,
      startCol: pos.col,
      endRow: pos.row,
      endCol: pos.col,
    };
    this.focus();
  }

  private handleMouseMove(e: MouseEvent): void {
    const pos = this.getMouseCellPos(e);

    if (pos && this.mouseProtocol === "any") {
      this.onData(toBytes(this.encodeMouseEvent(32 + 0, pos.col, pos.row)));
      return;
    }
    if (pos && this.mouseProtocol === "drag" && e.buttons & 1) {
      this.onData(toBytes(this.encodeMouseEvent(32 + 0, pos.col, pos.row)));
      return;
    }

    if (!this.selecting || !this.selection) return;
    if (!pos) return;

    this.selection.endRow = pos.row;
    this.selection.endCol = pos.col;
    this.onSelectionChange?.(this.selection);
  }

  private handleMouseUp(_e: MouseEvent): void {
    if (this.mouseProtocol !== "none" && this.mouseProtocol !== "x10") {
      const pos = this.getMouseCellPos(_e);
      if (pos) {
        this.onData(toBytes(this.encodeMouseEvent(3, pos.col, pos.row)));
      }
      return;
    }

    if (!this.selecting) return;
    this.selecting = false;

    if (
      this.selection &&
      this.selection.startRow === this.selection.endRow &&
      this.selection.startCol === this.selection.endCol
    ) {
      this.selection = null;
      this.onSelectionChange?.(null);
      return;
    }

    if (this.selection && this.grid) {
      const text = extractText(
        this.grid,
        this.selection.startRow,
        this.selection.startCol,
        this.selection.endRow,
        this.selection.endCol,
      );
      if (text) {
        this.showCopyTooltip(text);
      }
    }
  }

  private handleWheel(e: WheelEvent): void {
    if (this.mouseProtocol !== "none") {
      e.preventDefault();
      const pos = this.getMouseCellPos(e);
      if (!pos) return;
      const button = e.deltaY < 0 ? 64 : 65;
      this.onData(toBytes(this.encodeMouseEvent(button, pos.col, pos.row)));
    }
  }

  // -----------------------------------------------------------------------
  // Touch → GestureHandler bridge
  //
  // DOM TouchEvents are translated into the platform-agnostic GestureHandler
  // API (handlePan, handleTap, handleLongPress, handlePinch, extendSelection).
  // This gives the web the same gesture behavior as React Native.
  // -----------------------------------------------------------------------

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private getPinchDistance(t1: Touch, t2: Touch): number {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Convert a touch point to local pixel coordinates relative to container. */
  private touchToLocal(touch: Touch): { x: number; y: number } | null {
    if (!this.container) return null;
    const rect = this.container.getBoundingClientRect();
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  }

  private handleTouchStart(e: TouchEvent): void {
    // Don't focus here — wait for touchend to confirm it's a tap.
    // Focusing on touchstart shows the keyboard before we know if
    // the user intends to scroll, causing a scroll/keyboard race.

    if (e.touches.length === 2) {
      // Pinch start
      e.preventDefault();
      this.cancelLongPress();
      this.isPinching = true;
      this.pinchStartDistance = this.getPinchDistance(e.touches[0], e.touches[1]);
      this.pinchStartFontSize = this.currentFontSize;
      return;
    }

    if (e.touches.length !== 1) return;
    e.preventDefault();

    const touch = e.touches[0];
    this.touchStartX = touch.clientX;
    this.touchStartY = touch.clientY;
    this.touchLastX = touch.clientX;
    this.touchLastY = touch.clientY;
    this.isPinching = false;
    this.swipeDirection = "none";
    this.hSwipeRemainder = 0;

    // Mouse reporting: translate touch to mouse press
    if (this.mouseProtocol !== "none") {
      const local = this.touchToLocal(touch);
      if (local && this.gestureHandler) {
        const pos = this.gestureHandler.pixelToCell(local.x, local.y);
        this.onData(toBytes(this.encodeMouseEvent(0, pos.col, pos.row)));
      }
      return;
    }

    // Start long-press timer → delegates to GestureHandler.handleLongPress
    this.cancelLongPress();
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      const local = this.touchToLocal(touch);
      if (local && this.gestureHandler) {
        this.gestureHandler.handleLongPress(local.x, local.y);
      }
    }, LONG_PRESS_DELAY);

    // Signal pan began
    this.gestureHandler?.handlePan(0, 0, 0, GestureState.BEGAN);
  }

  private handleTouchMove(e: TouchEvent): void {
    if (this.isPinching && e.touches.length === 2) {
      // Pinch zoom — delegate to GestureHandler
      e.preventDefault();
      const currentDistance = this.getPinchDistance(e.touches[0], e.touches[1]);
      const scale = currentDistance / this.pinchStartDistance;
      this.gestureHandler?.handlePinch(scale, GestureState.ACTIVE);
      return;
    }

    if (e.touches.length !== 1) return;
    e.preventDefault();

    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - this.touchStartX);
    const dy = Math.abs(touch.clientY - this.touchStartY);

    // Cancel long press if moved beyond threshold
    if (dx > TAP_THRESHOLD || dy > TAP_THRESHOLD) {
      this.cancelLongPress();
    }

    // Mouse reporting: translate touch drag
    if (this.mouseProtocol !== "none") {
      if (this.mouseProtocol === "drag" || this.mouseProtocol === "any") {
        const local = this.touchToLocal(touch);
        if (local && this.gestureHandler) {
          const pos = this.gestureHandler.pixelToCell(local.x, local.y);
          this.onData(toBytes(this.encodeMouseEvent(32 + 0, pos.col, pos.row)));
        }
      }
      return;
    }

    // Selection drag — delegate to GestureHandler
    if (this.gestureHandler?.isSelectionActive) {
      const local = this.touchToLocal(touch);
      if (local) {
        this.gestureHandler.extendSelection(local.x, local.y);
      }
      return;
    }

    // Determine swipe direction on first significant movement.
    // Bias toward vertical (scroll) — require dx > 1.5 * dy for horizontal lock.
    // This prevents near-diagonal swipes from accidentally sending arrow keys.
    if (this.swipeDirection === "none" && (dx > TAP_THRESHOLD || dy > TAP_THRESHOLD)) {
      this.swipeDirection = dx > 1.5 * dy ? "horizontal" : "vertical";
    }

    if (this.swipeDirection === "horizontal") {
      // Horizontal swipe → send arrow keys for command-line navigation
      const deltaX = touch.clientX - this.touchLastX;
      this.touchLastX = touch.clientX;
      this.touchLastY = touch.clientY;
      const totalPixels = deltaX + this.hSwipeRemainder;
      const steps = Math.trunc(totalPixels / this.cellWidth);
      this.hSwipeRemainder = totalPixels - steps * this.cellWidth;
      if (steps !== 0) {
        const key = steps > 0 ? "\x1b[C" : "\x1b[D"; // right : left
        const count = Math.abs(steps);
        for (let i = 0; i < count; i++) {
          this.onData(toBytes(key));
        }
      }
    } else if (this.swipeDirection === "vertical") {
      // Vertical swipe → scroll terminal (scrollback buffer)
      const deltaY = touch.clientY - this.touchLastY;
      this.touchLastX = touch.clientX;
      this.touchLastY = touch.clientY;
      this.gestureHandler?.handlePan(
        touch.clientX - this.touchStartX,
        deltaY,
        0,
        GestureState.ACTIVE,
      );
    } else {
      // Direction not yet determined — just track position, don't act
      this.touchLastX = touch.clientX;
      this.touchLastY = touch.clientY;
    }
  }

  private handleTouchEnd(e: TouchEvent): void {
    // Pinch ended but one finger remains
    if (this.isPinching) {
      this.isPinching = false;
      this.gestureHandler?.handlePinch(1, GestureState.END);
      if (e.touches.length === 1) {
        const touch = e.touches[0];
        this.touchStartX = touch.clientX;
        this.touchStartY = touch.clientY;
        this.touchLastY = touch.clientY;
      }
      return;
    }

    this.cancelLongPress();

    // Mouse reporting: send release
    if (this.mouseProtocol !== "none" && this.mouseProtocol !== "x10") {
      if (e.changedTouches.length > 0) {
        const touch = e.changedTouches[0];
        const local = this.touchToLocal(touch);
        if (local && this.gestureHandler) {
          const pos = this.gestureHandler.pixelToCell(local.x, local.y);
          this.onData(toBytes(this.encodeMouseEvent(3, pos.col, pos.row)));
        }
      }
      return;
    }

    // End pan gesture (with velocity for fling)
    if (e.changedTouches.length > 0) {
      const touch = e.changedTouches[0];
      const dx = Math.abs(touch.clientX - this.touchStartX);
      const dy = Math.abs(touch.clientY - this.touchStartY);

      if (dx < TAP_THRESHOLD && dy < TAP_THRESHOLD) {
        // Confirmed tap — focus to show keyboard, then delegate to GestureHandler
        this.focus();
        const local = this.touchToLocal(touch);
        if (local) {
          this.gestureHandler?.handleTap(local.x, local.y);
        }
      } else {
        // End of pan
        this.gestureHandler?.handlePan(0, 0, 0, GestureState.END);
      }
    }
  }

  private handleTouchCancel(_e: TouchEvent): void {
    this.cancelLongPress();
    this.isPinching = false;
    this.gestureHandler?.handlePan(0, 0, 0, GestureState.CANCELLED);
  }

  /**
   * Show a floating "Copy" button near the selection so the user can tap
   * to copy. iOS Safari doesn't show its native callout for programmatic
   * selections, so we provide our own.
   */
  private showCopyTooltip(text: string): void {
    this.pendingCopyText = text;

    if (!this.container) return;

    // Position near the top-center of the selection
    const sel = this.selection;
    if (!sel) return;

    const minRow = Math.min(sel.startRow, sel.endRow);
    const midCol = Math.round((sel.startCol + sel.endCol) / 2);
    const topPx = minRow * this.cellHeight;
    const leftPx = midCol * this.cellWidth;

    if (!this.copyTooltip) {
      const tip = document.createElement("div");
      Object.assign(tip.style, {
        position: "absolute",
        zIndex: "100",
        display: "flex",
        gap: "2px",
        padding: "6px 16px",
        borderRadius: "8px",
        backgroundColor: "rgba(60, 60, 60, 0.95)",
        color: "#fff",
        fontSize: "14px",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        cursor: "pointer",
        userSelect: "none",
        WebkitUserSelect: "none",
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
        whiteSpace: "nowrap",
        pointerEvents: "auto",
        transform: "translateX(-50%)",
      });
      tip.textContent = "Copy";

      tip.addEventListener("touchend", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.doCopy();
      });
      tip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.doCopy();
      });

      this.container.appendChild(tip);
      this.copyTooltip = tip;
    }

    // Position above the selection, clamped within the container
    const tipTop = Math.max(0, topPx - 40);
    this.copyTooltip.style.top = `${tipTop}px`;
    this.copyTooltip.style.left = `${Math.max(30, leftPx)}px`;
    this.copyTooltip.style.display = "flex";
  }

  /** Copy pending text to clipboard and dismiss the tooltip. */
  private doCopy(): void {
    if (this.pendingCopyText && typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(this.pendingCopyText).catch(() => {
        /* ignore */
      });
    }
    this.hideCopyTooltip();
    this.clearSelection();
  }

  /** Hide the copy tooltip. */
  private hideCopyTooltip(): void {
    if (this.copyTooltip) {
      this.copyTooltip.style.display = "none";
    }
    this.pendingCopyText = "";
  }
}
