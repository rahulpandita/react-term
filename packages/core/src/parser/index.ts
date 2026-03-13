import type { BufferSet } from "../buffer.js";
import { CELL_SIZE } from "../cell-grid.js";
import type { CursorState } from "../types.js";
import { Action, State, TABLE, unpackAction, unpackState } from "./states.js";

// Attribute bit positions in the attrs byte (word 1, bits 8-15)
const ATTR_BOLD = 0x01;
const ATTR_DIM = 0x10;
const ATTR_ITALIC = 0x02;
const ATTR_UNDERLINE = 0x04;
const ATTR_STRIKETHROUGH = 0x08;
// bits 4-5: underline style (reserved)
const ATTR_INVERSE = 0x40;
const ATTR_HIDDEN = 0x20;
// const ATTR_WIDE = 0x80;

/** Mouse tracking protocol. */
export type MouseProtocol = "none" | "x10" | "vt200" | "drag" | "any";
/** Mouse encoding format. */
export type MouseEncoding = "default" | "sgr";

export class VTParser {
  private state: State = State.GROUND;
  private readonly bufferSet: BufferSet;

  // CSI parameter collection
  private params: number[] = [];
  private currentParam = 0;
  private hasParam = false;
  private intermediates = "";
  private prefix = ""; // for private sequences like ?

  // SGR state
  private fgIndex = 7; // default foreground (white)
  private bgIndex = 0; // default background (black)
  private attrs = 0;
  private fgIsRGB = false;
  private bgIsRGB = false;
  private fgRGB = 0;
  private bgRGB = 0;

  // OSC string collection
  private oscString = "";

  // UTF-8 decoding state
  private utf8Bytes = 0;
  private utf8Codepoint = 0;

  // Terminal mode flags
  private lineFeedMode = false; // LNM: when set, LF also does CR
  private autoWrapMode = true; // DECAWM: when enabled (default), chars wrap at right margin
  private originMode = false; // DECOM: when set, cursor position relative to scroll region

  // Mode flags exposed to the input handler
  applicationCursorKeys = false; // DECCKM (mode 1)
  applicationKeypad = false; // DECKPAM / DECKPNM
  bracketedPasteMode = false; // mode 2004
  mouseProtocol: MouseProtocol = "none"; // modes 9, 1000, 1002, 1003
  mouseEncoding: MouseEncoding = "default"; // mode 1006
  sendFocusEvents = false; // mode 1004

  // REP — last printed codepoint for CSI b
  private lastPrintedCodepoint = 0;

  // Response buffer for DSR, DA, etc.
  private responseBuffer: Uint8Array[] = [];

  // Title stack for window manipulation
  private titleStack: string[] = [];

  // Title change callback
  private onTitleChange: ((title: string) => void) | null = null;

  constructor(bufferSet: BufferSet) {
    this.bufferSet = bufferSet;
  }

  /** Register a callback for title changes (OSC 0/1/2). */
  setTitleChangeCallback(cb: (title: string) => void): void {
    this.onTitleChange = cb;
  }

  get cursor(): CursorState {
    return this.bufferSet.active.cursor;
  }

  get cols(): number {
    return this.bufferSet.cols;
  }

  get rows(): number {
    return this.bufferSet.rows;
  }

  private get buf() {
    return this.bufferSet.active;
  }

  private get grid() {
    return this.bufferSet.active.grid;
  }

  /** Check if there are pending responses to read. */
  hasResponse(): boolean {
    return this.responseBuffer.length > 0;
  }

  /** Read the next response from the response buffer. */
  readResponse(): Uint8Array | null {
    return this.responseBuffer.shift() ?? null;
  }

  /** Process raw bytes from the PTY. */
  write(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];

      // UTF-8 continuation handling in GROUND state
      if (this.state === State.GROUND && this.utf8Bytes > 0) {
        if ((byte & 0xc0) === 0x80) {
          this.utf8Codepoint = (this.utf8Codepoint << 6) | (byte & 0x3f);
          this.utf8Bytes--;
          if (this.utf8Bytes === 0) {
            this.printCodepoint(this.utf8Codepoint);
          }
          continue;
        } else {
          // Invalid continuation - reset and process byte normally
          this.utf8Bytes = 0;
        }
      }

      // UTF-8 start byte detection in GROUND state
      if (this.state === State.GROUND && byte >= 0xc0 && byte <= 0xf7) {
        if (byte < 0xe0) {
          this.utf8Bytes = 1;
          this.utf8Codepoint = byte & 0x1f;
        } else if (byte < 0xf0) {
          this.utf8Bytes = 2;
          this.utf8Codepoint = byte & 0x0f;
        } else {
          this.utf8Bytes = 3;
          this.utf8Codepoint = byte & 0x07;
        }
        continue;
      }

      const packed = TABLE[this.state * 256 + byte];
      const action = unpackAction(packed);
      const nextState = unpackState(packed);

      this.performAction(action, byte);
      this.state = nextState;
    }
  }

  private performAction(action: Action, byte: number): void {
    switch (action) {
      case Action.PRINT:
        this.printCodepoint(byte);
        break;
      case Action.EXECUTE:
        this.execute(byte);
        break;
      case Action.COLLECT:
        this.collect(byte);
        break;
      case Action.PARAM:
        this.param(byte);
        break;
      case Action.CSI_DISPATCH:
        this.csiDispatch(byte);
        break;
      case Action.ESC_DISPATCH:
        this.escDispatch(byte);
        break;
      case Action.CLEAR:
        this.clear();
        break;
      case Action.OSC_START:
        this.oscString = "";
        break;
      case Action.OSC_PUT:
        this.oscString += String.fromCharCode(byte);
        break;
      case Action.OSC_END:
        this.oscDispatch();
        break;
      case Action.HOOK:
      case Action.PUT:
      case Action.UNHOOK:
      case Action.IGNORE:
      case Action.NONE:
        break;
    }
  }

  private printCodepoint(cp: number): void {
    const cursor = this.buf.cursor;

    // Resolve pending wrap from a previous print at the last column
    if (cursor.wrapPending) {
      cursor.wrapPending = false;
      if (this.autoWrapMode) {
        cursor.col = 0;
        cursor.row++;
        if (cursor.row > this.buf.scrollBottom) {
          cursor.row = this.buf.scrollBottom;
          this.bufferSet.scrollUpWithHistory();
        }
      }
      // If autoWrap is off, cursor stays at cols-1 and will overwrite
    }

    // Safety clamp (should not be needed in normal operation)
    if (cursor.col >= this.cols) {
      cursor.col = this.cols - 1;
    }

    this.grid.setCell(
      cursor.row,
      cursor.col,
      cp,
      this.fgIsRGB ? this.fgRGB & 0xff : this.fgIndex,
      this.bgIsRGB ? this.bgRGB & 0xff : this.bgIndex,
      this.attrs,
      this.fgIsRGB,
      this.bgIsRGB,
    );

    // Store full RGB values in the rgbColors lookup if using RGB
    if (this.fgIsRGB) {
      this.grid.rgbColors[cursor.col] = this.fgRGB;
    }
    if (this.bgIsRGB) {
      this.grid.rgbColors[256 + cursor.col] = this.bgRGB;
    }

    this.lastPrintedCodepoint = cp;

    // Advance cursor; if at last column, defer wrap
    if (cursor.col >= this.cols - 1) {
      cursor.wrapPending = true;
    } else {
      cursor.col++;
    }
  }

  private execute(byte: number): void {
    const cursor = this.buf.cursor;
    cursor.wrapPending = false;
    switch (byte) {
      case 0x07: // BEL
        break;
      case 0x08: // BS
        if (cursor.col > 0) cursor.col--;
        break;
      case 0x09: // HT (tab)
        cursor.col = this.buf.nextTabStop(cursor.col);
        break;
      case 0x0a: // LF
      case 0x0b: // VT
      case 0x0c: // FF
        if (this.lineFeedMode) {
          cursor.col = 0;
        }
        this.linefeed();
        break;
      case 0x0d: // CR
        cursor.col = 0;
        break;
      case 0x0e: // SO (shift out)
      case 0x0f: // SI (shift in)
        // Character set switching - not implemented
        break;
    }
  }

  private linefeed(): void {
    const cursor = this.buf.cursor;
    if (cursor.row === this.buf.scrollBottom) {
      this.bufferSet.scrollUpWithHistory();
    } else if (cursor.row < this.rows - 1) {
      cursor.row++;
    }
  }

  private clear(): void {
    this.params = [];
    this.currentParam = 0;
    this.hasParam = false;
    this.intermediates = "";
    this.prefix = "";
  }

  private collect(byte: number): void {
    const ch = String.fromCharCode(byte);
    if (ch === "?" || ch === ">" || ch === "=") {
      this.prefix = ch;
    } else {
      this.intermediates += ch;
    }
  }

  private param(byte: number): void {
    if (byte === 0x3b) {
      // semicolon - push current param
      this.params.push(this.hasParam ? this.currentParam : 0);
      this.currentParam = 0;
      this.hasParam = false;
    } else {
      // digit - clamp to prevent overflow
      this.currentParam = Math.min(this.currentParam * 10 + (byte - 0x30), 99999);
      this.hasParam = true;
    }
  }

  private finalizeParams(): number[] {
    if (this.hasParam || this.params.length > 0) {
      this.params.push(this.hasParam ? this.currentParam : 0);
    }
    return this.params;
  }

  private csiDispatch(finalByte: number): void {
    const params = this.finalizeParams();
    const ch = String.fromCharCode(finalByte);

    if (this.prefix === "?") {
      this.csiPrivate(ch, params);
      return;
    }

    if (this.prefix === ">") {
      // Secondary Device Attributes
      if (ch === "c" && (params[0] || 0) === 0) {
        // Report as xterm version 277
        const response = new TextEncoder().encode("\x1b[>0;277;0c");
        this.responseBuffer.push(response);
      }
      return;
    }

    // Handle intermediates for special sequences
    if (this.intermediates === " ") {
      switch (ch) {
        case "q": // DECSCUSR - Set Cursor Style
          this.setCursorStyle(params[0] || 0);
          return;
      }
    }

    if (this.intermediates === "!") {
      switch (ch) {
        case "p": // DECSTR - Soft Terminal Reset
          this.softReset();
          return;
      }
    }

    switch (ch) {
      case "A": // CUU - Cursor Up
        this.cursorUp(params[0] || 1);
        break;
      case "B": // CUD - Cursor Down
        this.cursorDown(params[0] || 1);
        break;
      case "C": // CUF - Cursor Forward
        this.cursorForward(params[0] || 1);
        break;
      case "D": // CUB - Cursor Backward
        this.cursorBackward(params[0] || 1);
        break;
      case "E": // CNL - Cursor Next Line
        this.buf.cursor.col = 0;
        this.cursorDown(params[0] || 1);
        break;
      case "F": // CPL - Cursor Previous Line
        this.buf.cursor.col = 0;
        this.cursorUp(params[0] || 1);
        break;
      case "G": // CHA - Cursor Horizontal Absolute
        this.buf.cursor.wrapPending = false;
        this.buf.cursor.col = Math.min((params[0] || 1) - 1, this.cols - 1);
        break;
      case "H": // CUP - Cursor Position
      case "f": // HVP - Horizontal Vertical Position
        this.cursorPosition(params[0] || 1, params[1] || 1);
        break;
      case "I": // CHT - Cursor Forward Tab
        this.buf.cursor.wrapPending = false;
        for (let t = 0; t < (params[0] || 1); t++) {
          this.buf.cursor.col = this.buf.nextTabStop(this.buf.cursor.col);
        }
        break;
      case "J": // ED - Erase in Display
        this.buf.cursor.wrapPending = false;
        this.eraseInDisplay(params[0] || 0);
        break;
      case "K": // EL - Erase in Line
        this.buf.cursor.wrapPending = false;
        this.eraseInLine(params[0] || 0);
        break;
      case "L": // IL - Insert Lines
        this.buf.cursor.wrapPending = false;
        this.insertLines(params[0] || 1);
        break;
      case "M": // DL - Delete Lines
        this.buf.cursor.wrapPending = false;
        this.deleteLines(params[0] || 1);
        break;
      case "P": // DCH - Delete Characters
        this.buf.cursor.wrapPending = false;
        this.deleteChars(params[0] || 1);
        break;
      case "S": // SU - Scroll Up
        for (let i = 0; i < (params[0] || 1); i++) {
          this.buf.scrollUp();
        }
        break;
      case "T": // SD - Scroll Down
        for (let i = 0; i < (params[0] || 1); i++) {
          this.buf.scrollDown();
        }
        break;
      case "Z": // CBT - Cursor Backward Tab
        this.buf.cursor.wrapPending = false;
        for (let t = 0; t < (params[0] || 1); t++) {
          this.buf.cursor.col = this.buf.prevTabStop(this.buf.cursor.col);
        }
        break;
      case "`": // HPA - Horizontal Position Absolute
        this.buf.cursor.wrapPending = false;
        this.buf.cursor.col = Math.min((params[0] || 1) - 1, this.cols - 1);
        break;
      case "a": // HPR - Horizontal Position Relative
        this.cursorForward(params[0] || 1);
        break;
      case "b": // REP - Repeat Preceding Character
        if (this.lastPrintedCodepoint > 0) {
          const count = params[0] || 1;
          for (let i = 0; i < count; i++) {
            this.printCodepoint(this.lastPrintedCodepoint);
          }
        }
        break;
      case "c": // DA - Primary Device Attributes
        if ((params[0] || 0) === 0) {
          this.reportDeviceAttributes();
        }
        break;
      case "d": // VPA - Line Position Absolute
        this.buf.cursor.wrapPending = false;
        this.buf.cursor.row = Math.min(Math.max((params[0] || 1) - 1, 0), this.rows - 1);
        break;
      case "e": // VPR - Vertical Position Relative
        this.cursorDown(params[0] || 1);
        break;
      case "h": // SM - Set Mode
        this.setMode(params);
        break;
      case "l": // RM - Reset Mode
        this.resetMode(params);
        break;
      case "m": // SGR - Select Graphic Rendition
        this.sgr(params);
        break;
      case "n": // DSR - Device Status Report
        if (params[0] === 6) {
          this.reportCursorPosition();
        }
        break;
      case "r": // DECSTBM - Set Top and Bottom Margins
        this.setScrollRegion(params[0] || 1, params[1] || this.rows);
        break;
      case "s": // SCP - Save Cursor Position
        this.buf.saveCursor();
        break;
      case "t": // Window manipulation
        this.windowManipulation(params);
        break;
      case "u": // RCP - Restore Cursor Position
        this.buf.restoreCursor();
        break;
      case "@": // ICH - Insert Characters
        this.buf.cursor.wrapPending = false;
        this.insertChars(params[0] || 1);
        break;
      case "X": // ECH - Erase Characters
        this.buf.cursor.wrapPending = false;
        this.eraseChars(params[0] || 1);
        break;
      case "g": // TBC - Tab Clear
        if ((params[0] || 0) === 0) {
          this.buf.tabStops.delete(this.buf.cursor.col);
        } else if (params[0] === 3) {
          this.buf.tabStops.clear();
        }
        break;
    }
  }

  private csiPrivate(ch: string, params: number[]): void {
    switch (ch) {
      case "h": // DECSET
        for (const p of params) {
          this.decset(p, true);
        }
        break;
      case "l": // DECRST
        for (const p of params) {
          this.decset(p, false);
        }
        break;
      case "n": // DECDSR — private device status reports
        if (params[0] === 6) {
          this.reportCursorPosition();
        }
        break;
    }
  }

  private decset(mode: number, on: boolean): void {
    switch (mode) {
      case 1: // DECCKM - Application Cursor Keys
        this.applicationCursorKeys = on;
        break;
      case 6: // DECOM - Origin Mode
        this.originMode = on;
        // When origin mode changes, cursor goes to home
        if (on) {
          this.buf.cursor.row = this.buf.scrollTop;
        } else {
          this.buf.cursor.row = 0;
        }
        this.buf.cursor.col = 0;
        break;
      case 7: // DECAWM - Auto-wrap mode
        this.autoWrapMode = on;
        break;
      case 9: // X10 mouse reporting
        this.mouseProtocol = on ? "x10" : "none";
        break;
      case 12: // Cursor blink (att610)
        // Tracked but cosmetic — cursor blink handled in renderer
        break;
      case 25: // DECTCEM - cursor visibility
        this.buf.cursor.visible = on;
        break;
      case 47: // Alternate screen buffer (no save/restore)
      case 1047:
        if (on) {
          this.bufferSet.activateAlternate();
        } else {
          this.bufferSet.activateNormal();
        }
        break;
      case 1000: // VT200 mouse (click only)
        this.mouseProtocol = on ? "vt200" : "none";
        break;
      case 1002: // Button event tracking (click + drag)
        this.mouseProtocol = on ? "drag" : "none";
        break;
      case 1003: // Any event tracking (all motion)
        this.mouseProtocol = on ? "any" : "none";
        break;
      case 1004: // Send focus events
        this.sendFocusEvents = on;
        break;
      case 1006: // SGR mouse encoding
        this.mouseEncoding = on ? "sgr" : "default";
        break;
      case 1048: // Save/restore cursor (standalone)
        if (on) {
          this.buf.saveCursor();
        } else {
          this.buf.restoreCursor();
        }
        break;
      case 1049: // Alternate screen buffer with save/restore cursor
        if (on) {
          this.bufferSet.normal.saveCursor();
          this.bufferSet.activateAlternate();
        } else {
          this.bufferSet.activateNormal();
          this.bufferSet.normal.restoreCursor();
        }
        break;
      case 2004: // Bracketed paste mode
        this.bracketedPasteMode = on;
        break;
      case 2026: // Synchronized output (acknowledged but no-op)
        break;
    }
  }

  /** SM - Set Mode (non-private) */
  private setMode(params: number[]): void {
    for (const p of params) {
      if (p === 20) {
        this.lineFeedMode = true;
      }
    }
  }

  /** RM - Reset Mode (non-private) */
  private resetMode(params: number[]): void {
    for (const p of params) {
      if (p === 20) {
        this.lineFeedMode = false;
      }
    }
  }

  private escDispatch(byte: number): void {
    const ch = String.fromCharCode(byte);

    // Handle ESC # sequences (intermediates contain '#')
    if (this.intermediates === "#") {
      if (ch === "8") {
        // DECALN — Screen Alignment Test: fill screen with 'E'
        for (let r = 0; r < this.rows; r++) {
          for (let c = 0; c < this.cols; c++) {
            this.grid.setCell(r, c, 0x45, 7, 0, 0); // 'E'
          }
        }
      }
      return;
    }

    // Handle ESC ( / ESC ) for character set designation
    if (this.intermediates === "(" || this.intermediates === ")") {
      // Character set switching — acknowledge but no-op for now
      return;
    }

    switch (ch) {
      case "7": // DECSC - Save Cursor
        this.buf.saveCursor();
        break;
      case "8": // DECRC - Restore Cursor
        this.buf.restoreCursor();
        break;
      case "=": // DECKPAM - Application Keypad Mode
        this.applicationKeypad = true;
        break;
      case ">": // DECKPNM - Normal Keypad Mode
        this.applicationKeypad = false;
        break;
      case "D": // IND - Index (move cursor down, scroll if at bottom)
        this.buf.cursor.wrapPending = false;
        this.linefeed();
        break;
      case "E": // NEL - Next Line
        this.buf.cursor.wrapPending = false;
        this.buf.cursor.col = 0;
        this.linefeed();
        break;
      case "M": // RI - Reverse Index (move cursor up, scroll if at top)
        this.buf.cursor.wrapPending = false;
        if (this.buf.cursor.row === this.buf.scrollTop) {
          this.buf.scrollDown();
        } else if (this.buf.cursor.row > 0) {
          this.buf.cursor.row--;
        }
        break;
      case "c": // RIS - Full Reset
        this.fullReset();
        break;
      case "H": // HTS - Horizontal Tab Set
        this.buf.tabStops.add(this.buf.cursor.col);
        break;
    }
  }

  // ---- OSC dispatch ----

  private oscDispatch(): void {
    const idx = this.oscString.indexOf(";");
    if (idx === -1) return;

    const code = parseInt(this.oscString.substring(0, idx), 10);
    const data = this.oscString.substring(idx + 1);

    switch (code) {
      case 0: // Set icon name + window title
      case 1: // Set icon name
      case 2: // Set window title
        // Strip control characters to enforce plain-text contract.
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching C0/C1 control chars
        this.onTitleChange?.(data.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""));
        break;
      // Other OSC codes (4, 7, 8, 10, 11, 12, 52, 104, 133) can be added later
    }
  }

  // ---- Cursor movement ----

  private cursorUp(n: number): void {
    this.buf.cursor.wrapPending = false;
    this.buf.cursor.row = Math.max(this.buf.cursor.row - n, this.buf.scrollTop);
  }

  private cursorDown(n: number): void {
    this.buf.cursor.wrapPending = false;
    this.buf.cursor.row = Math.min(this.buf.cursor.row + n, this.buf.scrollBottom);
  }

  private cursorForward(n: number): void {
    this.buf.cursor.wrapPending = false;
    this.buf.cursor.col = Math.min(this.buf.cursor.col + n, this.cols - 1);
  }

  private cursorBackward(n: number): void {
    this.buf.cursor.wrapPending = false;
    this.buf.cursor.col = Math.max(this.buf.cursor.col - n, 0);
  }

  private cursorPosition(row: number, col: number): void {
    this.buf.cursor.wrapPending = false;
    if (this.originMode) {
      // In origin mode, coordinates are relative to scroll region
      this.buf.cursor.row = Math.min(
        Math.max(row - 1 + this.buf.scrollTop, this.buf.scrollTop),
        this.buf.scrollBottom,
      );
    } else {
      this.buf.cursor.row = Math.min(Math.max(row - 1, 0), this.rows - 1);
    }
    this.buf.cursor.col = Math.min(Math.max(col - 1, 0), this.cols - 1);
  }

  // ---- Cursor style (DECSCUSR) ----

  private setCursorStyle(ps: number): void {
    switch (ps) {
      case 0:
      case 1: // blinking block
      case 2: // steady block
        this.buf.cursor.style = "block";
        break;
      case 3: // blinking underline
      case 4: // steady underline
        this.buf.cursor.style = "underline";
        break;
      case 5: // blinking bar
      case 6: // steady bar
        this.buf.cursor.style = "bar";
        break;
    }
  }

  // ---- Device Status Report (DSR) ----

  private reportCursorPosition(): void {
    const row = this.buf.cursor.row + 1;
    const col = this.buf.cursor.col + 1;
    const response = new TextEncoder().encode(`\x1b[${row};${col}R`);
    this.responseBuffer.push(response);
  }

  // ---- Primary Device Attributes (DA) ----

  private reportDeviceAttributes(): void {
    const response = new TextEncoder().encode("\x1b[?1;2c");
    this.responseBuffer.push(response);
  }

  // ---- Window manipulation ----

  private windowManipulation(params: number[]): void {
    const ps = params[0] || 0;
    switch (ps) {
      case 22: // Push title to stack
        // We don't track the actual title, but maintain the stack
        this.titleStack.push("");
        break;
      case 23: // Pop title from stack
        this.titleStack.pop();
        break;
    }
  }

  // ---- Erase ----

  private eraseInDisplay(mode: number): void {
    const cursor = this.buf.cursor;
    switch (mode) {
      case 0: // from cursor to end
        this.eraseCells(cursor.row, cursor.col, cursor.row, this.cols - 1);
        for (let r = cursor.row + 1; r < this.rows; r++) {
          this.grid.clearRow(r);
        }
        break;
      case 1: // from beginning to cursor
        for (let r = 0; r < cursor.row; r++) {
          this.grid.clearRow(r);
        }
        this.eraseCells(cursor.row, 0, cursor.row, cursor.col);
        break;
      case 2: // entire display
      case 3: // entire display + scrollback
        for (let r = 0; r < this.rows; r++) {
          this.grid.clearRow(r);
        }
        break;
    }
  }

  private eraseInLine(mode: number): void {
    const cursor = this.buf.cursor;
    switch (mode) {
      case 0: // from cursor to end of line
        this.eraseCells(cursor.row, cursor.col, cursor.row, this.cols - 1);
        break;
      case 1: // from beginning of line to cursor
        this.eraseCells(cursor.row, 0, cursor.row, cursor.col);
        break;
      case 2: // entire line
        this.grid.clearRow(cursor.row);
        break;
    }
  }

  private eraseCells(row: number, startCol: number, _endRow: number, endCol: number): void {
    for (let c = startCol; c <= endCol && c < this.cols; c++) {
      this.grid.setCell(row, c, 0x20, 7, 0, 0);
    }
  }

  private eraseChars(n: number): void {
    const cursor = this.buf.cursor;
    for (let i = 0; i < n && cursor.col + i < this.cols; i++) {
      this.grid.setCell(cursor.row, cursor.col + i, 0x20, 7, 0, 0);
    }
  }

  // ---- Insert / Delete ----

  private insertLines(n: number): void {
    const cursor = this.buf.cursor;
    if (cursor.row < this.buf.scrollTop || cursor.row > this.buf.scrollBottom) return;
    for (let i = 0; i < n; i++) {
      for (let r = this.buf.scrollBottom; r > cursor.row; r--) {
        this.grid.pasteRow(r, this.grid.copyRow(r - 1));
      }
      this.grid.clearRow(cursor.row);
    }
  }

  private deleteLines(n: number): void {
    const cursor = this.buf.cursor;
    if (cursor.row < this.buf.scrollTop || cursor.row > this.buf.scrollBottom) return;
    for (let i = 0; i < n; i++) {
      for (let r = cursor.row; r < this.buf.scrollBottom; r++) {
        this.grid.pasteRow(r, this.grid.copyRow(r + 1));
      }
      this.grid.clearRow(this.buf.scrollBottom);
    }
  }

  private insertChars(n: number): void {
    const cursor = this.buf.cursor;
    const row = cursor.row;
    // Clamp n to remaining space
    n = Math.min(n, this.cols - cursor.col);
    // Shift cells right
    for (let c = this.cols - 1; c >= cursor.col + n; c--) {
      const src = (row * this.cols + c - n) * CELL_SIZE;
      const dst = (row * this.cols + c) * CELL_SIZE;
      this.grid.data[dst] = this.grid.data[src];
      this.grid.data[dst + 1] = this.grid.data[src + 1];
    }
    // Clear inserted cells with default colors
    for (let i = 0; i < n; i++) {
      this.grid.setCell(row, cursor.col + i, 0x20, 7, 0, 0);
    }
    this.grid.markDirty(row);
  }

  private deleteChars(n: number): void {
    const cursor = this.buf.cursor;
    const row = cursor.row;
    // Clamp n to remaining space
    n = Math.min(n, this.cols - cursor.col);
    // Shift cells left
    for (let c = cursor.col; c < this.cols - n; c++) {
      const src = (row * this.cols + c + n) * CELL_SIZE;
      const dst = (row * this.cols + c) * CELL_SIZE;
      this.grid.data[dst] = this.grid.data[src];
      this.grid.data[dst + 1] = this.grid.data[src + 1];
    }
    // Clear vacated cells at end with default colors
    for (let c = this.cols - n; c < this.cols; c++) {
      this.grid.setCell(row, c, 0x20, 7, 0, 0);
    }
    this.grid.markDirty(row);
  }

  // ---- Scroll region ----

  private setScrollRegion(top: number, bottom: number): void {
    const t = Math.max(top - 1, 0);
    const b = Math.min(bottom - 1, this.rows - 1);
    if (t < b) {
      this.buf.scrollTop = t;
      this.buf.scrollBottom = b;
      // Cursor moves to home (respects DECOM)
      if (this.originMode) {
        this.buf.cursor.row = this.buf.scrollTop;
      } else {
        this.buf.cursor.row = 0;
      }
      this.buf.cursor.col = 0;
      this.buf.cursor.wrapPending = false;
    }
  }

  // ---- SGR ----

  private sgr(params: number[]): void {
    if (params.length === 0) {
      params = [0];
    }

    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      switch (p) {
        case 0: // Reset
          this.attrs = 0;
          this.fgIndex = 7;
          this.bgIndex = 0;
          this.fgIsRGB = false;
          this.bgIsRGB = false;
          break;
        case 1:
          this.attrs |= ATTR_BOLD;
          break;
        case 2:
          this.attrs |= ATTR_DIM;
          break;
        case 3:
          this.attrs |= ATTR_ITALIC;
          break;
        case 4:
          this.attrs |= ATTR_UNDERLINE;
          break;
        case 7:
          this.attrs |= ATTR_INVERSE;
          break;
        case 8:
          this.attrs |= ATTR_HIDDEN;
          break;
        case 9:
          this.attrs |= ATTR_STRIKETHROUGH;
          break;
        case 22:
          this.attrs &= ~(ATTR_BOLD | ATTR_DIM);
          break;
        case 23:
          this.attrs &= ~ATTR_ITALIC;
          break;
        case 24:
          this.attrs &= ~ATTR_UNDERLINE;
          break;
        case 27:
          this.attrs &= ~ATTR_INVERSE;
          break;
        case 28:
          this.attrs &= ~ATTR_HIDDEN;
          break;
        case 29:
          this.attrs &= ~ATTR_STRIKETHROUGH;
          break;

        // Standard foreground colors (30-37)
        case 30:
        case 31:
        case 32:
        case 33:
        case 34:
        case 35:
        case 36:
        case 37:
          this.fgIndex = p - 30;
          this.fgIsRGB = false;
          break;

        // Extended foreground (38)
        case 38:
          i = this.parseSgrColor(params, i, true);
          break;

        // Default foreground (39)
        case 39:
          this.fgIndex = 7;
          this.fgIsRGB = false;
          break;

        // Standard background colors (40-47)
        case 40:
        case 41:
        case 42:
        case 43:
        case 44:
        case 45:
        case 46:
        case 47:
          this.bgIndex = p - 40;
          this.bgIsRGB = false;
          break;

        // Extended background (48)
        case 48:
          i = this.parseSgrColor(params, i, false);
          break;

        // Default background (49)
        case 49:
          this.bgIndex = 0;
          this.bgIsRGB = false;
          break;

        // Bright foreground colors (90-97)
        case 90:
        case 91:
        case 92:
        case 93:
        case 94:
        case 95:
        case 96:
        case 97:
          this.fgIndex = p - 90 + 8;
          this.fgIsRGB = false;
          break;

        // Bright background colors (100-107)
        case 100:
        case 101:
        case 102:
        case 103:
        case 104:
        case 105:
        case 106:
        case 107:
          this.bgIndex = p - 100 + 8;
          this.bgIsRGB = false;
          break;
      }
    }
  }

  /** Parse SGR 38/48 extended color. Returns updated index. */
  private parseSgrColor(params: number[], i: number, isFg: boolean): number {
    if (i + 1 >= params.length) return i;

    const mode = params[i + 1];
    if (mode === 5) {
      // 256-color: 38;5;n or 48;5;n
      if (i + 2 < params.length) {
        const colorIdx = params[i + 2];
        if (isFg) {
          this.fgIndex = colorIdx & 0xff;
          this.fgIsRGB = false;
        } else {
          this.bgIndex = colorIdx & 0xff;
          this.bgIsRGB = false;
        }
        return i + 2;
      }
    } else if (mode === 2) {
      // 24-bit RGB: 38;2;r;g;b or 48;2;r;g;b
      if (i + 4 < params.length) {
        const r = params[i + 2] & 0xff;
        const g = params[i + 3] & 0xff;
        const b = params[i + 4] & 0xff;
        const rgb = (r << 16) | (g << 8) | b;
        if (isFg) {
          this.fgRGB = rgb;
          this.fgIsRGB = true;
        } else {
          this.bgRGB = rgb;
          this.bgIsRGB = true;
        }
        return i + 4;
      }
    }
    return i;
  }

  // ---- Soft reset (DECSTR) ----

  private softReset(): void {
    // Reset terminal modes but preserve certain settings
    this.attrs = 0;
    this.fgIndex = 7;
    this.bgIndex = 0;
    this.fgIsRGB = false;
    this.bgIsRGB = false;
    this.lineFeedMode = false;
    this.autoWrapMode = true;
    this.originMode = false;
    this.applicationCursorKeys = false;
    this.applicationKeypad = false;
    this.bracketedPasteMode = false;
    this.mouseProtocol = "none";
    this.mouseEncoding = "default";
    this.sendFocusEvents = false;
    this.buf.cursor.visible = true;
    this.buf.cursor.style = "block";
    this.buf.cursor.wrapPending = false;
    this.buf.scrollTop = 0;
    this.buf.scrollBottom = this.rows - 1;
    // Note: cursor position is NOT reset by soft reset
    // Note: screen content is NOT cleared by soft reset
  }

  private fullReset(): void {
    this.state = State.GROUND;
    this.clear();
    this.attrs = 0;
    this.fgIndex = 7;
    this.bgIndex = 0;
    this.fgIsRGB = false;
    this.bgIsRGB = false;
    this.lineFeedMode = false;
    this.autoWrapMode = true;
    this.originMode = false;
    this.applicationCursorKeys = false;
    this.applicationKeypad = false;
    this.bracketedPasteMode = false;
    this.mouseProtocol = "none";
    this.mouseEncoding = "default";
    this.sendFocusEvents = false;
    this.lastPrintedCodepoint = 0;
    this.responseBuffer = [];
    this.titleStack = [];
    this.bufferSet.activateNormal();
    this.buf.cursor.row = 0;
    this.buf.cursor.col = 0;
    this.buf.cursor.visible = true;
    this.buf.cursor.style = "block";
    this.buf.cursor.wrapPending = false;
    this.buf.scrollTop = 0;
    this.buf.scrollBottom = this.rows - 1;
    this.grid.clear();
  }
}
