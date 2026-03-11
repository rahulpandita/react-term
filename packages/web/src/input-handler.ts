/**
 * Keyboard and mouse input handling for the web terminal.
 *
 * Makes the container element itself focusable (tabindex="0") and captures
 * keyboard events directly — no hidden textarea needed.
 */

import { extractText } from '@react-term/core';
import type { CellGrid, MouseProtocol, MouseEncoding } from '@react-term/core';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface InputHandlerOptions {
  /** Called when the user types data that should be sent to the PTY. */
  onData: (data: Uint8Array) => void;
  /** Called when the selection state changes. */
  onSelectionChange?: (selection: SelectionState | null) => void;
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
// InputHandler
// ---------------------------------------------------------------------------

export class InputHandler {
  private container: HTMLElement | null = null;
  private onData: (data: Uint8Array) => void;
  private onSelectionChange: ((sel: SelectionState | null) => void) | null;
  private applicationCursorKeys: boolean;

  // Bracketed paste mode — wraps pasted text in ESC[200~ ... ESC[201~
  private bracketedPasteMode = false;

  // Mouse reporting
  private mouseProtocol: MouseProtocol = 'none';
  private mouseEncoding: MouseEncoding = 'default';

  // Focus events
  private sendFocusEvents = false;

  private cellWidth = 0;
  private cellHeight = 0;

  // Grid reference for text extraction
  private grid: CellGrid | null = null;

  // Mouse / selection state
  private selecting = false;
  private selection: SelectionState | null = null;

  // Bound listeners (so we can remove them)
  private boundKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private boundPaste: ((e: ClipboardEvent) => void) | null = null;
  private boundMouseDown: ((e: MouseEvent) => void) | null = null;
  private boundMouseMove: ((e: MouseEvent) => void) | null = null;
  private boundMouseUp: ((e: MouseEvent) => void) | null = null;
  private boundFocus: (() => void) | null = null;
  private boundBlur: (() => void) | null = null;
  private boundWheel: ((e: WheelEvent) => void) | null = null;

  constructor(options: InputHandlerOptions) {
    this.onData = options.onData;
    this.onSelectionChange = options.onSelectionChange ?? null;
    this.applicationCursorKeys = options.applicationCursorKeys ?? false;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  attach(container: HTMLElement, cellWidth: number, cellHeight: number): void {
    this.container = container;
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;

    // Make the container focusable and set up for keyboard capture
    container.setAttribute('tabindex', '0');
    container.setAttribute('role', 'terminal');
    container.setAttribute('aria-label', 'Terminal');
    Object.assign(container.style, {
      outline: 'none',     // suppress focus ring — cursor provides visual focus
      cursor: 'text',
    });

    // Keyboard — listen directly on the container
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundPaste = this.handlePaste.bind(this);
    container.addEventListener('keydown', this.boundKeyDown);
    container.addEventListener('paste', this.boundPaste);

    // Mouse
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundWheel = this.handleWheel.bind(this);
    container.addEventListener('mousedown', this.boundMouseDown);
    container.addEventListener('wheel', this.boundWheel, { passive: false });
    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp);

    // Focus/blur events for mode 1004
    this.boundFocus = this.handleFocus.bind(this);
    this.boundBlur = this.handleBlur.bind(this);
    container.addEventListener('focus', this.boundFocus);
    container.addEventListener('blur', this.boundBlur);
  }

  focus(): void {
    this.container?.focus();
  }

  blur(): void {
    this.container?.blur();
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

  updateCellSize(cellWidth: number, cellHeight: number): void {
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
  }

  setGrid(grid: CellGrid): void {
    this.grid = grid;
  }

  getSelection(): SelectionState | null {
    return this.selection;
  }

  clearSelection(): void {
    this.selection = null;
    this.onSelectionChange?.(null);
  }

  dispose(): void {
    if (this.container && this.boundKeyDown) {
      this.container.removeEventListener('keydown', this.boundKeyDown);
    }
    if (this.container && this.boundPaste) {
      this.container.removeEventListener('paste', this.boundPaste);
    }
    if (this.container && this.boundMouseDown) {
      this.container.removeEventListener('mousedown', this.boundMouseDown);
    }
    if (this.container && this.boundWheel) {
      this.container.removeEventListener('wheel', this.boundWheel);
    }
    if (this.container && this.boundFocus) {
      this.container.removeEventListener('focus', this.boundFocus);
    }
    if (this.container && this.boundBlur) {
      this.container.removeEventListener('blur', this.boundBlur);
    }
    if (this.boundMouseMove) {
      document.removeEventListener('mousemove', this.boundMouseMove);
    }
    if (this.boundMouseUp) {
      document.removeEventListener('mouseup', this.boundMouseUp);
    }
    this.container = null;
    this.boundKeyDown = null;
    this.boundPaste = null;
    this.boundMouseDown = null;
    this.boundMouseMove = null;
    this.boundMouseUp = null;
    this.boundWheel = null;
    this.boundFocus = null;
    this.boundBlur = null;
  }

  // -----------------------------------------------------------------------
  // Keyboard handling
  // -----------------------------------------------------------------------

  private handleKeyDown(e: KeyboardEvent): void {
    // Ctrl+C or Cmd+C with active selection → copy to clipboard
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && this.selection && this.grid) {
      e.preventDefault();
      const text = extractText(
        this.grid,
        this.selection.startRow, this.selection.startCol,
        this.selection.endRow, this.selection.endCol,
      );
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(() => {/* ignore */});
      }
      this.clearSelection();
      return;
    }

    // Cmd+V / Ctrl+V: read from clipboard and send to PTY
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.readText().then((text) => {
          if (text) this.sendPastedText(text);
        }).catch(() => {/* ignore */});
      }
      return;
    }

    const seq = this.keyToSequence(e);
    if (seq !== null) {
      e.preventDefault();
      this.onData(toBytes(seq));
    }
  }

  private handlePaste(e: ClipboardEvent): void {
    e.preventDefault();
    const text = e.clipboardData?.getData('text');
    if (text) {
      this.sendPastedText(text);
    }
  }

  /** Send pasted text, wrapping in bracketed paste sequences if enabled. */
  private sendPastedText(text: string): void {
    if (this.bracketedPasteMode) {
      this.onData(toBytes('\x1b[200~' + text + '\x1b[201~'));
    } else {
      this.onData(toBytes(text));
    }
  }

  /**
   * Convert a KeyboardEvent into the VT sequence string to send to the PTY,
   * or null if the event should not be handled.
   */
  keyToSequence(e: KeyboardEvent): string | null {
    const { key, ctrlKey, altKey, metaKey } = e;

    // Meta key combos are browser shortcuts — let them through
    if (metaKey) return null;

    // Ctrl + single letter → control character
    if (ctrlKey && !altKey && key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0);
      if (code >= 0x40 && code <= 0x5f) {
        return String.fromCharCode(code - 0x40);
      }
    }

    // Alt + key → ESC prefix
    if (altKey && !ctrlKey && key.length === 1) {
      return '\x1b' + key;
    }

    // Special keys
    const appMode = this.applicationCursorKeys;
    switch (key) {
      case 'Enter':      return '\r';
      case 'Backspace':   return ctrlKey ? '\x08' : '\x7f';
      case 'Tab':         return '\t';
      case 'Escape':      return '\x1b';
      case 'Delete':      return '\x1b[3~';

      case 'ArrowUp':     return appMode ? '\x1bOA' : '\x1b[A';
      case 'ArrowDown':   return appMode ? '\x1bOB' : '\x1b[B';
      case 'ArrowRight':  return appMode ? '\x1bOC' : '\x1b[C';
      case 'ArrowLeft':   return appMode ? '\x1bOD' : '\x1b[D';

      case 'Home':        return '\x1b[H';
      case 'End':         return '\x1b[F';
      case 'PageUp':      return '\x1b[5~';
      case 'PageDown':    return '\x1b[6~';

      case 'Insert':      return '\x1b[2~';

      // Function keys
      case 'F1':          return '\x1bOP';
      case 'F2':          return '\x1bOQ';
      case 'F3':          return '\x1bOR';
      case 'F4':          return '\x1bOS';
      case 'F5':          return '\x1b[15~';
      case 'F6':          return '\x1b[17~';
      case 'F7':          return '\x1b[18~';
      case 'F8':          return '\x1b[19~';
      case 'F9':          return '\x1b[20~';
      case 'F10':         return '\x1b[21~';
      case 'F11':         return '\x1b[23~';
      case 'F12':         return '\x1b[24~';
    }

    // Modifier-only keys
    if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') {
      return null;
    }

    // Printable character
    if (key.length === 1) {
      return key;
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Focus / blur events (mode 1004)
  // -----------------------------------------------------------------------

  private handleFocus(): void {
    if (this.sendFocusEvents) {
      this.onData(toBytes('\x1b[I'));
    }
  }

  private handleBlur(): void {
    if (this.sendFocusEvents) {
      this.onData(toBytes('\x1b[O'));
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
    if (this.mouseEncoding === 'sgr') {
      // SGR encoding: ESC [ < button ; col+1 ; row+1 M/m
      const final = button === 3 ? 'm' : 'M';
      const btn = button === 3 ? 0 : button;
      return `\x1b[<${btn};${col + 1};${row + 1}${final}`;
    }
    // Default (X10) encoding: ESC [ M Cb Cx Cy (values + 32)
    const cb = String.fromCharCode(button + 32);
    const cx = String.fromCharCode(col + 1 + 32);
    const cy = String.fromCharCode(row + 1 + 32);
    return `\x1b[M${cb}${cx}${cy}`;
  }

  private handleMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return; // left click only
    const pos = this.getMouseCellPos(e);
    if (!pos) return;

    // If mouse reporting is active, send mouse event instead of selecting
    if (this.mouseProtocol !== 'none') {
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

    // Focus the container
    this.focus();
  }

  private handleMouseMove(e: MouseEvent): void {
    const pos = this.getMouseCellPos(e);

    // Drag reporting (mode 1002) or any-event reporting (mode 1003)
    if (pos && this.mouseProtocol === 'any') {
      // Any-event mode: report all motion
      this.onData(toBytes(this.encodeMouseEvent(32 + 0, pos.col, pos.row))); // 32 = motion flag
      return;
    }
    if (pos && this.mouseProtocol === 'drag' && e.buttons & 1) {
      // Drag mode: report motion only when button held
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
    // Send mouse release if reporting
    if (this.mouseProtocol !== 'none' && this.mouseProtocol !== 'x10') {
      const pos = this.getMouseCellPos(_e);
      if (pos) {
        this.onData(toBytes(this.encodeMouseEvent(3, pos.col, pos.row)));
      }
      return;
    }

    if (!this.selecting) return;
    this.selecting = false;

    // If start === end, clear selection (it was just a click)
    if (
      this.selection &&
      this.selection.startRow === this.selection.endRow &&
      this.selection.startCol === this.selection.endCol
    ) {
      this.selection = null;
      this.onSelectionChange?.(null);
      return;
    }

    // Copy selected text to clipboard
    if (this.selection && this.grid) {
      const text = extractText(
        this.grid,
        this.selection.startRow, this.selection.startCol,
        this.selection.endRow, this.selection.endCol,
      );
      if (text && typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(() => {/* ignore */});
      }
    }
  }

  private handleWheel(e: WheelEvent): void {
    if (this.mouseProtocol !== 'none') {
      e.preventDefault();
      const pos = this.getMouseCellPos(e);
      if (!pos) return;
      // Scroll up = button 64, scroll down = button 65
      const button = e.deltaY < 0 ? 64 : 65;
      this.onData(toBytes(this.encodeMouseEvent(button, pos.col, pos.row)));
    }
  }
}
