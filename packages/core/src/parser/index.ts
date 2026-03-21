import type { BufferSet } from "../buffer.js";
import { CELL_SIZE, DEFAULT_CELL_W0, DEFAULT_CELL_W1 } from "../cell-grid.js";
import type { CursorState } from "../types.js";
import { Action, State, TABLE } from "./states.js";

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

  // CSI parameter collection — pre-allocated typed array avoids GC/hidden-class overhead
  private static readonly MAX_PARAMS = 16;
  private readonly params = new Int32Array(VTParser.MAX_PARAMS);
  private paramCount = 0;
  private currentParam = 0;
  private hasParam = false;
  // Stores only the last intermediate byte (0x20-0x2F). All sequences we
  // implement use at most one intermediate: ' ' (DECSCUSR), '!' (DECSTR),
  // '#' (DECALN), '(' / ')' (charset). The ISO 2022 spec defines rare
  // two-intermediate sequences (e.g. ESC $ ( F for 94x94 charsets) where
  // the first intermediate would be lost — acceptable since we don't
  // implement ISO 2022 multi-byte charset designation.
  private intermediatesByte = 0;
  private prefixByte = 0; // single byte: '?' = 0x3f, '>' = 0x3e, '=' = 0x3d, 0 = none

  // SGR state
  private fgIndex = 7; // default foreground (white)
  private bgIndex = 0; // default background (black)
  private attrs = 0;
  private fgIsRGB = false;
  private bgIsRGB = false;
  private fgRGB = 0;
  private bgRGB = 0;

  // OSC string collection — pre-allocated typed array avoids GC/hidden-class overhead
  private static readonly MAX_OSC_LENGTH = 4096;
  private readonly oscParts = new Uint8Array(VTParser.MAX_OSC_LENGTH);
  private oscLength = 0;

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

  // OSC 52 clipboard callback: (selection: string, data: string | null) => void
  // data is null for queries (?), base64 string for writes.
  private onOsc52: ((selection: string, data: string | null) => void) | null = null;

  // OSC 4 color palette callback: (index: number, spec: string | null) => void
  // spec is null for queries (?), color string (e.g. "rgb:ff/00/00") for sets.
  private onOsc4: ((index: number, spec: string | null) => void) | null = null;

  // OSC 7 current working directory callback: (uri: string) => void
  private onOsc7: ((uri: string) => void) | null = null;

  // OSC 10 foreground color callback: (spec: string | null) => void
  // spec is null for queries (?), color string for sets.
  private onOsc10: ((spec: string | null) => void) | null = null;

  // OSC 11 background color callback: (spec: string | null) => void
  private onOsc11: ((spec: string | null) => void) | null = null;

  // OSC 12 cursor color callback: (spec: string | null) => void
  private onOsc12: ((spec: string | null) => void) | null = null;

  // OSC 104 reset color palette callback: (index: number) => void
  // index is -1 for "reset all", or 0-255 for a specific palette entry.
  private onOsc104: ((index: number) => void) | null = null;

  // OSC 8 hyperlink callback: (params: string, uri: string) => void
  // params is the optional colon-separated key=value metadata (may be "").
  // uri is the hyperlink target (empty string closes the link).
  private onOsc8: ((params: string, uri: string) => void) | null = null;

  // OSC 133 shell integration callback: (type: string, payload: string) => void
  // type is the event letter: "A" (prompt start), "B" (command start),
  //   "C" (command output start), "D" (command end), "E" (command text), "P" (property), etc.
  // payload is the string after the type letter and its optional semicolon separator
  //   (e.g. exit code string for "D", "k=cwd;v=/path" for "P", empty string for A/B/C).
  private onOsc133: ((type: string, payload: string) => void) | null = null;

  constructor(bufferSet: BufferSet) {
    this.bufferSet = bufferSet;
  }

  /** Register a callback for title changes (OSC 0/1/2). */
  setTitleChangeCallback(cb: (title: string) => void): void {
    this.onTitleChange = cb;
  }

  /** Register a callback for OSC 52 clipboard sequences.
   *  `selection` is the clipboard selection string (e.g. "c" for clipboard).
   *  `data` is the base64-encoded payload, or null for a query request ("?").
   */
  setOsc52Callback(cb: (selection: string, data: string | null) => void): void {
    this.onOsc52 = cb;
  }

  /** Register a callback for OSC 4 color palette sequences.
   *  Called once per index;spec pair in the sequence.
   *  `index` is the palette index (0-255).
   *  `spec` is the color specification string (e.g. "rgb:ff/00/00"), or null for a query ("?").
   */
  setOsc4Callback(cb: (index: number, spec: string | null) => void): void {
    this.onOsc4 = cb;
  }

  /** Register a callback for OSC 7 current working directory sequences.
   *  Called with the URI payload (e.g. "file:///hostname/path").
   */
  setOsc7Callback(cb: (uri: string) => void): void {
    this.onOsc7 = cb;
  }

  /** Register a callback for OSC 10 foreground color sequences.
   *  `spec` is the color specification string (e.g. "rgb:ffff/ffff/ffff"), or null for a query ("?").
   */
  setOsc10Callback(cb: (spec: string | null) => void): void {
    this.onOsc10 = cb;
  }

  /** Register a callback for OSC 11 background color sequences.
   *  `spec` is the color specification string (e.g. "rgb:0000/0000/0000"), or null for a query ("?").
   */
  setOsc11Callback(cb: (spec: string | null) => void): void {
    this.onOsc11 = cb;
  }

  /** Register a callback for OSC 12 cursor color sequences.
   *  `spec` is the color specification string, or null for a query ("?").
   */
  setOsc12Callback(cb: (spec: string | null) => void): void {
    this.onOsc12 = cb;
  }

  /** Register a callback for OSC 104 reset color palette sequences.
   *  Called once per index to reset; `index` is 0-255 for a specific palette
   *  entry, or -1 when no index is given (reset the entire palette).
   */
  setOsc104Callback(cb: (index: number) => void): void {
    this.onOsc104 = cb;
  }

  /** Register a callback for OSC 8 hyperlink sequences.
   *  `params` is the optional colon-separated key=value metadata string (may be "").
   *  `uri` is the hyperlink target URI (empty string closes the active link).
   */
  setOsc8Callback(cb: (params: string, uri: string) => void): void {
    this.onOsc8 = cb;
  }

  /** Register a callback for OSC 133 shell integration (semantic prompt) sequences.
   *  `type` is the event letter: "A" (prompt start), "B" (command start),
   *  "C" (command output start), "D" (command end), "E" (command text), "P" (property), etc.
   *  `payload` is the string after the type letter and its semicolon separator
   *  (empty string for A/B/C; exit-code digits for D; command text for E; key=value for P).
   */
  setOsc133Callback(cb: (type: string, payload: string) => void): void {
    this.onOsc133 = cb;
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
    // Cache hot state in locals for the duration of the write call
    let state = this.state;
    let utf8Bytes = this.utf8Bytes;
    let utf8Codepoint = this.utf8Codepoint;

    const len = data.length;
    for (let i = 0; i < len; i++) {
      const byte = data[i];

      // ESC sequence fast-path: peek at the next byte to handle common
      // multi-byte escape sequences without per-byte table lookups.
      // ESC is an "anywhere" transition so this is valid from all states.
      if (byte === 0x1b && i + 1 < len) {
        const next = data[i + 1];

        // ESC \ — String Terminator. Dispatch OSC/DCS directly.
        if (next === 0x5c) {
          if (state === State.OSC_STRING) {
            this.oscDispatch();
          }
          // Clear params/intermediates so no state leaks from aborted sequences
          this.clear();
          state = State.GROUND;
          i++;
          continue;
        }

        // ESC [ — CSI entry, with optional fast dispatch
        if (next === 0x5b) {
          this.clear();
          if (i + 2 < len) {
            const fb = data[i + 2];
            // Parameterless CSI: ESC [ <final>
            if (fb >= 0x40 && fb <= 0x7e) {
              this.csiDispatch(fb);
              state = State.GROUND;
              i += 2;
              continue;
            }
            // CSI with private prefix: ESC [ <prefix> <final>
            if (fb >= 0x3c && fb <= 0x3f && i + 3 < len) {
              const fb2 = data[i + 3];
              if (fb2 >= 0x40 && fb2 <= 0x7e) {
                this.prefixByte = fb;
                this.csiDispatch(fb2);
                state = State.GROUND;
                i += 3;
                continue;
              }
            }
          }
          state = State.CSI_ENTRY;
          i++;
          continue;
        }

        // ESC ] — OSC string start
        if (next === 0x5d) {
          this.clear();
          this.oscLength = 0;
          state = State.OSC_STRING;
          i++;
          continue;
        }

        // ESC P — DCS entry
        if (next === 0x50) {
          this.clear();
          state = State.DCS_ENTRY;
          i++;
          continue;
        }

        // ESC + intermediate (0x20-0x2F) + final (0x30-0x7E) — 3-byte ESC
        if (next >= 0x20 && next <= 0x2f && i + 2 < len) {
          const fb = data[i + 2];
          if (fb >= 0x30 && fb <= 0x7e) {
            this.clear();
            this.intermediatesByte = next;
            this.escDispatch(fb);
            state = State.GROUND;
            i += 2;
            continue;
          }
        }

        // ESC + final byte — 2-byte ESC dispatch (D, E, M, 7, 8, =, >, c, H, etc.)
        // Excludes bytes already handled: 0x50(P), 0x58(SOS), 0x5B([), 0x5C(\),
        // 0x5D(]), 0x5E(PM), 0x5F(APC), and intermediates 0x20-0x2F.
        if (
          (next >= 0x30 && next <= 0x4f) ||
          (next >= 0x51 && next <= 0x57) ||
          next === 0x59 ||
          next === 0x5a ||
          (next >= 0x60 && next <= 0x7e)
        ) {
          this.clear();
          this.escDispatch(next);
          state = State.GROUND;
          i++;
          continue;
        }
      }

      // UTF-8 continuation handling in GROUND state (split across writes)
      if (state === State.GROUND && utf8Bytes > 0) {
        if ((byte & 0xc0) === 0x80) {
          utf8Codepoint = (utf8Codepoint << 6) | (byte & 0x3f);
          utf8Bytes--;
          if (utf8Bytes === 0) {
            this.printCodepoint(utf8Codepoint);
          }
          continue;
        }
        // Invalid continuation - reset and process byte normally
        utf8Bytes = 0;
      }

      // Combined printable batch: handles both ASCII (0x20-0x7E) and UTF-8
      // (0xC0-0xF7) in a single tight loop. Pre-computes cell template values
      // and caches grid state to avoid per-character method call overhead.
      // NOTE: utf8Bytes is guaranteed 0 here when state === GROUND
      // (the continuation handler above either continues or resets it).
      if (
        state === State.GROUND &&
        ((byte >= 0x20 && byte <= 0x7e) || (byte >= 0xc0 && byte <= 0xf7))
      ) {
        const buf = this.bufferSet.active;
        const cursor = buf.cursor;
        const grid = buf.grid;
        const gridData = grid.data;
        const gridCols = this.cols;

        const fgVal = this.fgIsRGB ? this.fgRGB & 0xff : this.fgIndex;
        const word0Base =
          (this.fgIsRGB ? 1 << 21 : 0) | (this.bgIsRGB ? 1 << 22 : 0) | ((fgVal & 0xff) << 23);
        const word1 =
          ((this.bgIsRGB ? this.bgRGB & 0xff : this.bgIndex) & 0xff) | ((this.attrs & 0xff) << 8);

        let cachedRow = cursor.row;
        let cachedRowStart = grid.rowStart(cachedRow);
        let lastCp = 0;
        let j = i;

        while (j < len) {
          const b = data[j];
          let cp: number;

          // ASCII (single byte) — most common, check first
          if (b >= 0x20 && b <= 0x7e) {
            cp = b;
          }
          // UTF-8 2-byte (0xC0-0xDF)
          else if (b >= 0xc0 && b < 0xe0) {
            if (j + 1 >= len || (data[j + 1] & 0xc0) !== 0x80) break;
            cp = ((b & 0x1f) << 6) | (data[j + 1] & 0x3f);
            j += 1;
          }
          // UTF-8 3-byte (0xE0-0xEF)
          else if (b >= 0xe0 && b < 0xf0) {
            if (j + 2 >= len || (data[j + 1] & 0xc0) !== 0x80 || (data[j + 2] & 0xc0) !== 0x80)
              break;
            cp = ((b & 0x0f) << 12) | ((data[j + 1] & 0x3f) << 6) | (data[j + 2] & 0x3f);
            j += 2;
          }
          // UTF-8 4-byte (0xF0-0xF7)
          else if (b >= 0xf0 && b <= 0xf7) {
            if (
              j + 3 >= len ||
              (data[j + 1] & 0xc0) !== 0x80 ||
              (data[j + 2] & 0xc0) !== 0x80 ||
              (data[j + 3] & 0xc0) !== 0x80
            )
              break;
            cp =
              ((b & 0x07) << 18) |
              ((data[j + 1] & 0x3f) << 12) |
              ((data[j + 2] & 0x3f) << 6) |
              (data[j + 3] & 0x3f);
            j += 3;
          }
          // Non-printable byte — exit batch
          else {
            break;
          }

          // Inline cell write — duplicates printCodepoint() for throughput.
          // If you change wrap/cell-write/cursor logic here, update printCodepoint() too.
          let scrolled = false;
          if (cursor.wrapPending) {
            cursor.wrapPending = false;
            if (this.autoWrapMode) {
              cursor.col = 0;
              cursor.row++;
              if (cursor.row > buf.scrollBottom) {
                cursor.row = buf.scrollBottom;
                this._scrollUpFull();
                scrolled = true;
              }
            }
          }

          if (cursor.col >= gridCols) cursor.col = gridCols - 1;

          if (cursor.row !== cachedRow || scrolled) {
            grid.markDirty(cachedRow);
            cachedRow = cursor.row;
            cachedRowStart = grid.rowStart(cachedRow);
          }

          const idx = cachedRowStart + cursor.col * CELL_SIZE;
          gridData[idx] = (cp & 0x1fffff) | word0Base;
          gridData[idx + 1] = word1;

          if (this.fgIsRGB) grid.rgbColors[cursor.col] = this.fgRGB;
          if (this.bgIsRGB) grid.rgbColors[256 + cursor.col] = this.bgRGB;

          if (cursor.col >= gridCols - 1) {
            cursor.wrapPending = true;
          } else {
            cursor.col++;
          }

          lastCp = cp;
          j++;
        }

        grid.markDirty(cachedRow);
        if (lastCp > 0) this.lastPrintedCodepoint = lastCp;

        // Handle incomplete UTF-8 at end of buffer
        if (j < len && data[j] >= 0xc0 && data[j] <= 0xf7) {
          const b = data[j];
          if (b < 0xe0) {
            utf8Bytes = 1;
            utf8Codepoint = b & 0x1f;
          } else if (b < 0xf0) {
            utf8Bytes = 2;
            utf8Codepoint = b & 0x0f;
          } else {
            utf8Bytes = 3;
            utf8Codepoint = b & 0x07;
          }
          i = j;
          continue;
        }

        i = j - 1;
        continue;
      }

      const packed = TABLE[state * 256 + byte];
      const action = packed >>> 4;
      state = packed & 0x0f;

      // Inlined action dispatch — eliminates performAction() call overhead
      // and adds read-ahead loops for PARAM, OSC_PUT, and DCS PUT.
      switch (action) {
        case Action.PRINT:
          this.printCodepoint(byte);
          break;
        case Action.EXECUTE:
          this.execute(byte);
          break;
        case Action.COLLECT:
          if (byte === 0x3f || byte === 0x3e || byte === 0x3d) {
            this.prefixByte = byte;
          } else {
            this.intermediatesByte = byte;
          }
          break;
        case Action.PARAM: {
          // Read-ahead: consume all consecutive param bytes (digits 0x30-0x39
          // and semicolons 0x3B) in a tight loop. For a typical CSI like
          // \x1b[38;2;128;64;32m this reduces 10 table lookups + 10 function
          // calls to 1 table lookup + 1 tight loop.
          let j = i;
          do {
            const b = data[j];
            if (b === 0x3b) {
              if (this.paramCount < VTParser.MAX_PARAMS) {
                this.params[this.paramCount++] = this.hasParam ? this.currentParam : 0;
              }
              this.currentParam = 0;
              this.hasParam = false;
            } else {
              if (this.currentParam <= 99999) {
                this.currentParam = this.currentParam * 10 + (b - 0x30);
              }
              this.hasParam = true;
            }
          } while (++j < len && ((data[j] >= 0x30 && data[j] <= 0x39) || data[j] === 0x3b));
          // Peek: if next byte is a CSI final (0x40-0x7E), dispatch directly
          // without returning to the table for one more lookup.
          if (state === State.CSI_PARAM && j < len) {
            const fb = data[j];
            if (fb >= 0x40 && fb <= 0x7e) {
              this.csiDispatch(fb);
              state = State.GROUND;
              i = j;
              break;
            }
          }
          i = j - 1;
          break;
        }
        case Action.ESC_DISPATCH:
          this.escDispatch(byte);
          break;
        case Action.CSI_DISPATCH:
          this.csiDispatch(byte);
          break;
        case Action.PUT:
          // DCS passthrough read-ahead — skip printable content bytes.
          // We don't implement DCS handlers, so just advance past the data.
          while (i + 1 < len && data[i + 1] >= 0x20 && data[i + 1] <= 0x7e) {
            i++;
          }
          break;
        case Action.OSC_START:
          this.oscLength = 0;
          break;
        case Action.OSC_PUT: {
          // Read-ahead: consume all consecutive OSC content bytes (0x20-0x7E)
          // Cap at MAX_OSC_LENGTH to prevent unbounded growth on malformed input.
          if (this.oscLength < VTParser.MAX_OSC_LENGTH) {
            this.oscParts[this.oscLength++] = byte;
          }
          while (i + 1 < len && data[i + 1] >= 0x20 && data[i + 1] <= 0x7e) {
            i++;
            if (this.oscLength < VTParser.MAX_OSC_LENGTH) {
              this.oscParts[this.oscLength++] = data[i];
            }
          }
          break;
        }
        case Action.OSC_END:
          this.oscDispatch();
          break;
        case Action.CLEAR:
          this.clear();
          break;
        // NONE, HOOK, UNHOOK, IGNORE — no-op
      }
    }

    // Write back locals
    this.state = state as State;
    this.utf8Bytes = utf8Bytes;
    this.utf8Codepoint = utf8Codepoint;
  }

  // Called from: UTF-8 split-write continuation, Action.PRINT fallback, CSI REP.
  // The combined batch in write() inlines this logic for throughput — keep in sync.
  private printCodepoint(cp: number): void {
    const buf = this.bufferSet.active;
    const cursor = buf.cursor;
    const grid = buf.grid;

    // Resolve pending wrap from a previous print at the last column
    if (cursor.wrapPending) {
      cursor.wrapPending = false;
      if (this.autoWrapMode) {
        cursor.col = 0;
        cursor.row++;
        if (cursor.row > buf.scrollBottom) {
          cursor.row = buf.scrollBottom;
          this._scrollUpFull();
        }
      }
    }

    // Safety clamp (should not be needed in normal operation)
    if (cursor.col >= this.cols) {
      cursor.col = this.cols - 1;
    }

    // Inline cell write — avoids setCell() function call overhead.
    const idx = grid.rowStart(cursor.row) + cursor.col * CELL_SIZE;
    const fgVal = this.fgIsRGB ? this.fgRGB & 0xff : this.fgIndex;
    grid.data[idx] =
      (cp & 0x1fffff) |
      (this.fgIsRGB ? 1 << 21 : 0) |
      (this.bgIsRGB ? 1 << 22 : 0) |
      ((fgVal & 0xff) << 23);
    grid.data[idx + 1] =
      ((this.bgIsRGB ? this.bgRGB & 0xff : this.bgIndex) & 0xff) | ((this.attrs & 0xff) << 8);
    grid.markDirty(cursor.row);

    // Store full RGB values in the rgbColors lookup if using RGB
    if (this.fgIsRGB) {
      grid.rgbColors[cursor.col] = this.fgRGB;
    }
    if (this.bgIsRGB) {
      grid.rgbColors[256 + cursor.col] = this.bgRGB;
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
      this._scrollUpFull();
    } else if (cursor.row < this.rows - 1) {
      cursor.row++;
    }
  }

  /**
   * Fast-path scroll up: combines scrollUpWithHistory + scrollUp for the
   * common full-screen case (rotateUp instead of copyWithin). Falls back
   * to scrollUpWithHistory for partial scroll regions.
   */
  private _scrollUpFull(): void {
    const buf = this.bufferSet.active;
    if (buf.scrollTop === 0 && buf.scrollBottom === this.rows - 1) {
      const grid = buf.grid;
      if (this.bufferSet.maxScrollback > 0 && buf === this.bufferSet.normal) {
        this.bufferSet.pushScrollback(grid.copyRow(0));
      }
      grid.rotateUp();
      grid.clearRowRaw(buf.scrollBottom);
      grid.markDirtyRange(buf.scrollTop, buf.scrollBottom);
    } else {
      this.bufferSet.scrollUpWithHistory();
    }
  }

  private clear(): void {
    this.paramCount = 0;
    this.currentParam = 0;
    this.hasParam = false;
    this.intermediatesByte = 0;
    this.prefixByte = 0;
  }

  private finalizeParams(): number {
    if (this.hasParam || this.paramCount > 0) {
      if (this.paramCount < VTParser.MAX_PARAMS) {
        this.params[this.paramCount++] = this.hasParam ? this.currentParam : 0;
      }
    }
    return this.paramCount;
  }

  private csiDispatch(finalByte: number): void {
    const paramCount = this.finalizeParams();
    const p0 = paramCount > 0 ? this.params[0] : 0;
    const p1 = paramCount > 1 ? this.params[1] : 0;
    const buf = this.bufferSet.active;

    if (this.prefixByte === 0x3f) {
      // '?' — private modes
      this.csiPrivate(finalByte, paramCount);
      return;
    }

    if (this.prefixByte === 0x3e) {
      // '>' — Secondary Device Attributes
      if (finalByte === 0x63 /* 'c' */ && (p0 || 0) === 0) {
        const response = new TextEncoder().encode("\x1b[>0;277;0c");
        this.responseBuffer.push(response);
      }
      return;
    }

    // Handle intermediates for special sequences
    if (this.intermediatesByte === 0x20) {
      // ' '
      if (finalByte === 0x71 /* 'q' */) {
        // DECSCUSR - Set Cursor Style
        this.setCursorStyle(p0 || 0);
      }
      return;
    }

    if (this.intermediatesByte === 0x21) {
      // '!'
      if (finalByte === 0x70 /* 'p' */) {
        // DECSTR - Soft Terminal Reset
        this.softReset();
      }
      return;
    }

    switch (finalByte) {
      case 0x41: // 'A' - CUU - Cursor Up
        this.cursorUp(p0 || 1);
        break;
      case 0x42: // 'B' - CUD - Cursor Down
        this.cursorDown(p0 || 1);
        break;
      case 0x43: // 'C' - CUF - Cursor Forward
        this.cursorForward(p0 || 1);
        break;
      case 0x44: // 'D' - CUB - Cursor Backward
        this.cursorBackward(p0 || 1);
        break;
      case 0x45: // 'E' - CNL - Cursor Next Line
        buf.cursor.col = 0;
        this.cursorDown(p0 || 1);
        break;
      case 0x46: // 'F' - CPL - Cursor Previous Line
        buf.cursor.col = 0;
        this.cursorUp(p0 || 1);
        break;
      case 0x47: // 'G' - CHA - Cursor Horizontal Absolute
        buf.cursor.wrapPending = false;
        buf.cursor.col = Math.min((p0 || 1) - 1, this.cols - 1);
        break;
      case 0x48: // 'H' - CUP - Cursor Position
      case 0x66: // 'f' - HVP - Horizontal Vertical Position
        this.cursorPosition(p0 || 1, p1 || 1);
        break;
      case 0x49: // 'I' - CHT - Cursor Forward Tab
        buf.cursor.wrapPending = false;
        for (let t = 0; t < (p0 || 1); t++) {
          buf.cursor.col = buf.nextTabStop(buf.cursor.col);
        }
        break;
      case 0x4a: // 'J' - ED - Erase in Display
        buf.cursor.wrapPending = false;
        this.eraseInDisplay(p0 || 0);
        break;
      case 0x4b: // 'K' - EL - Erase in Line
        buf.cursor.wrapPending = false;
        this.eraseInLine(p0 || 0);
        break;
      case 0x4c: // 'L' - IL - Insert Lines
        buf.cursor.wrapPending = false;
        this.insertLines(p0 || 1);
        break;
      case 0x4d: // 'M' - DL - Delete Lines
        buf.cursor.wrapPending = false;
        this.deleteLines(p0 || 1);
        break;
      case 0x50: // 'P' - DCH - Delete Characters
        buf.cursor.wrapPending = false;
        this.deleteChars(p0 || 1);
        break;
      case 0x53: // 'S' - SU - Scroll Up
        for (let i = 0; i < (p0 || 1); i++) {
          buf.scrollUp();
        }
        break;
      case 0x54: // 'T' - SD - Scroll Down
        for (let i = 0; i < (p0 || 1); i++) {
          buf.scrollDown();
        }
        break;
      case 0x5a: // 'Z' - CBT - Cursor Backward Tab
        buf.cursor.wrapPending = false;
        for (let t = 0; t < (p0 || 1); t++) {
          buf.cursor.col = buf.prevTabStop(buf.cursor.col);
        }
        break;
      case 0x60: // '`' - HPA - Horizontal Position Absolute
        buf.cursor.wrapPending = false;
        buf.cursor.col = Math.min((p0 || 1) - 1, this.cols - 1);
        break;
      case 0x61: // 'a' - HPR - Horizontal Position Relative
        this.cursorForward(p0 || 1);
        break;
      case 0x62: // 'b' - REP - Repeat Preceding Character
        if (this.lastPrintedCodepoint > 0) {
          // Clamp to one full screen to prevent DoS from large repeat counts
          const count = Math.min(p0 || 1, this.cols * this.rows);
          for (let i = 0; i < count; i++) {
            this.printCodepoint(this.lastPrintedCodepoint);
          }
        }
        break;
      case 0x63: // 'c' - DA - Primary Device Attributes
        if ((p0 || 0) === 0) {
          this.reportDeviceAttributes();
        }
        break;
      case 0x64: // 'd' - VPA - Line Position Absolute
        buf.cursor.wrapPending = false;
        buf.cursor.row = Math.min(Math.max((p0 || 1) - 1, 0), this.rows - 1);
        break;
      case 0x65: // 'e' - VPR - Vertical Position Relative
        this.cursorDown(p0 || 1);
        break;
      case 0x68: // 'h' - SM - Set Mode
        this.setMode(paramCount);
        break;
      case 0x6c: // 'l' - RM - Reset Mode
        this.resetMode(paramCount);
        break;
      case 0x6d: // 'm' - SGR - Select Graphic Rendition
        this.sgr(paramCount);
        break;
      case 0x6e: // 'n' - DSR - Device Status Report
        if (p0 === 6) {
          this.reportCursorPosition();
        }
        break;
      case 0x72: // 'r' - DECSTBM - Set Top and Bottom Margins
        this.setScrollRegion(p0 || 1, p1 || this.rows);
        break;
      case 0x73: // 's' - SCP - Save Cursor Position
        buf.saveCursor();
        break;
      case 0x74: // 't' - Window manipulation
        this.windowManipulation(paramCount);
        break;
      case 0x75: // 'u' - RCP - Restore Cursor Position
        buf.restoreCursor();
        break;
      case 0x40: // '@' - ICH - Insert Characters
        buf.cursor.wrapPending = false;
        this.insertChars(p0 || 1);
        break;
      case 0x58: // 'X' - ECH - Erase Characters
        buf.cursor.wrapPending = false;
        this.eraseChars(p0 || 1);
        break;
      case 0x67: // 'g' - TBC - Tab Clear
        if ((p0 || 0) === 0) {
          buf.tabStops.delete(buf.cursor.col);
        } else if (p0 === 3) {
          buf.tabStops.clear();
        }
        break;
    }
  }

  private csiPrivate(finalByte: number, paramCount: number): void {
    switch (finalByte) {
      case 0x68: // 'h' - DECSET
        for (let i = 0; i < paramCount; i++) {
          this.decset(this.params[i], true);
        }
        break;
      case 0x6c: // 'l' - DECRST
        for (let i = 0; i < paramCount; i++) {
          this.decset(this.params[i], false);
        }
        break;
      case 0x6e: // 'n' - DECDSR
        if (this.params[0] === 6) {
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
  private setMode(paramCount: number): void {
    for (let i = 0; i < paramCount; i++) {
      if (this.params[i] === 20) {
        this.lineFeedMode = true;
      }
    }
  }

  /** RM - Reset Mode (non-private) */
  private resetMode(paramCount: number): void {
    for (let i = 0; i < paramCount; i++) {
      if (this.params[i] === 20) {
        this.lineFeedMode = false;
      }
    }
  }

  private escDispatch(byte: number): void {
    const buf = this.bufferSet.active;

    // Handle ESC # sequences (intermediates contain '#')
    if (this.intermediatesByte === 0x23) {
      if (byte === 0x38) {
        // '8' — DECALN: fill screen with 'E'
        const grid = buf.grid;
        for (let r = 0; r < this.rows; r++) {
          for (let c = 0; c < this.cols; c++) {
            grid.setCell(r, c, 0x45, 7, 0, 0);
          }
        }
      }
      return;
    }

    // Handle ESC ( / ESC ) for character set designation
    if (this.intermediatesByte === 0x28 || this.intermediatesByte === 0x29) {
      return;
    }

    switch (byte) {
      case 0x37: // '7' - DECSC - Save Cursor
        buf.saveCursor();
        break;
      case 0x38: // '8' - DECRC - Restore Cursor
        buf.restoreCursor();
        break;
      case 0x3d: // '=' - DECKPAM - Application Keypad Mode
        this.applicationKeypad = true;
        break;
      case 0x3e: // '>' - DECKPNM - Normal Keypad Mode
        this.applicationKeypad = false;
        break;
      case 0x44: // 'D' - IND - Index
        buf.cursor.wrapPending = false;
        this.linefeed();
        break;
      case 0x45: // 'E' - NEL - Next Line
        buf.cursor.wrapPending = false;
        buf.cursor.col = 0;
        this.linefeed();
        break;
      case 0x4d: // 'M' - RI - Reverse Index
        buf.cursor.wrapPending = false;
        if (buf.cursor.row === buf.scrollTop) {
          buf.scrollDown();
        } else if (buf.cursor.row > 0) {
          buf.cursor.row--;
        }
        break;
      case 0x63: // 'c' - RIS - Full Reset
        this.fullReset();
        break;
      case 0x48: // 'H' - HTS - Horizontal Tab Set
        buf.tabStops.add(buf.cursor.col);
        break;
    }
  }

  // ---- OSC dispatch ----

  private oscDispatch(): void {
    // Find ';' separator in the numeric parts buffer
    let semiIdx = -1;
    for (let i = 0; i < this.oscLength; i++) {
      if (this.oscParts[i] === 0x3b) {
        semiIdx = i;
        break;
      }
    }

    // OSC 104 with no arguments (no semicolon) = reset the entire palette.
    if (semiIdx === -1) {
      if (this.onOsc104) {
        let c = 0;
        for (let i = 0; i < this.oscLength; i++) {
          c = c * 10 + (this.oscParts[i] - 0x30);
        }
        if (c === 104) this.onOsc104(-1);
      }
      return;
    }

    // Parse the code (digits before semicolon)
    let code = 0;
    for (let i = 0; i < semiIdx; i++) {
      code = code * 10 + (this.oscParts[i] - 0x30);
    }

    switch (code) {
      case 0: // Set icon name + window title
      case 1: // Set icon name
      case 2: // Set window title
        if (this.onTitleChange) {
          // Build string only when callback exists
          let data = "";
          for (let i = semiIdx + 1; i < this.oscLength; i++) {
            const ch = this.oscParts[i];
            // Strip control characters (C0/C1)
            if (ch >= 0x20 && ch < 0x7f) {
              data += String.fromCharCode(ch);
            }
          }
          this.onTitleChange(data);
        }
        break;
      case 4: // OSC 4 — set/query color palette entries
        // Format: 4;<index>;<spec>[;<index>;<spec>...] (pairs separated by ';')
        // spec is a color string (e.g. "rgb:ff/00/00", "#rrggbb") or "?" for a query.
        if (this.onOsc4) {
          // Walk pairs starting at semiIdx+1
          let pos = semiIdx + 1;
          while (pos < this.oscLength) {
            // Parse index (digits until ';')
            let nextSemi = -1;
            for (let i = pos; i < this.oscLength; i++) {
              if (this.oscParts[i] === 0x3b) {
                nextSemi = i;
                break;
              }
            }
            if (nextSemi === -1) break; // malformed: no spec separator
            let colorIdx = 0;
            for (let i = pos; i < nextSemi; i++) {
              colorIdx = colorIdx * 10 + (this.oscParts[i] - 0x30);
            }
            // Find end of spec (next ';' or end of OSC)
            let specEnd = this.oscLength;
            for (let i = nextSemi + 1; i < this.oscLength; i++) {
              if (this.oscParts[i] === 0x3b) {
                specEnd = i;
                break;
              }
            }
            // Build spec string
            const specLen = specEnd - nextSemi - 1;
            let spec: string | null;
            if (specLen === 1 && this.oscParts[nextSemi + 1] === 0x3f) {
              spec = null; // query
            } else {
              let s = "";
              for (let i = nextSemi + 1; i < specEnd; i++) {
                s += String.fromCharCode(this.oscParts[i]);
              }
              spec = s;
            }
            this.onOsc4(colorIdx, spec);
            pos = specEnd + 1; // advance past spec and trailing ';'
          }
        }
        break;
      case 7: // OSC 7 — current working directory (URI after semicolon)
        if (this.onOsc7) {
          let uri = "";
          for (let i = semiIdx + 1; i < this.oscLength; i++) {
            uri += String.fromCharCode(this.oscParts[i]);
          }
          this.onOsc7(uri);
        }
        break;
      case 52: // OSC 52 clipboard read/write
        if (this.onOsc52) {
          // Format: 52;<selection>;<base64-data> or 52;<selection>;?
          // Find second semicolon after semiIdx
          let semi2 = -1;
          for (let i = semiIdx + 1; i < this.oscLength; i++) {
            if (this.oscParts[i] === 0x3b) {
              semi2 = i;
              break;
            }
          }
          if (semi2 === -1) break;
          // Build selection string (bytes between first and second semicolons)
          let selection = "";
          for (let i = semiIdx + 1; i < semi2; i++) {
            selection += String.fromCharCode(this.oscParts[i]);
          }
          // Build data string (bytes after second semicolon)
          // A single "?" byte means query; otherwise it's base64 payload
          const payloadLen = this.oscLength - semi2 - 1;
          let osc52data: string | null = null;
          if (payloadLen === 1 && this.oscParts[semi2 + 1] === 0x3f) {
            // Query request
            osc52data = null;
          } else {
            let payload = "";
            for (let i = semi2 + 1; i < this.oscLength; i++) {
              payload += String.fromCharCode(this.oscParts[i]);
            }
            osc52data = payload;
          }
          this.onOsc52(selection, osc52data);
        }
        break;
      case 10: // OSC 10 — foreground color query/set
      case 11: // OSC 11 — background color query/set
      case 12: {
        // OSC 12 — cursor color query/set
        // Format: 10;<spec> or 10;? (query)
        const cb = code === 10 ? this.onOsc10 : code === 11 ? this.onOsc11 : this.onOsc12;
        if (cb) {
          const payloadStart = semiIdx + 1;
          const payloadLen = this.oscLength - payloadStart;
          let dynSpec: string | null;
          if (payloadLen === 1 && this.oscParts[payloadStart] === 0x3f) {
            dynSpec = null; // query
          } else {
            let s = "";
            for (let i = payloadStart; i < this.oscLength; i++) {
              s += String.fromCharCode(this.oscParts[i]);
            }
            dynSpec = s;
          }
          cb(dynSpec);
        }
        break;
      }
      // Other OSC codes can be added later
      case 8: // OSC 8 — hyperlinks
        // Format: 8;<params>;<uri>
        // <params> is optional colon-separated key=value metadata (may be "").
        // <uri> is the hyperlink target (empty string closes the link).
        if (this.onOsc8) {
          // Find the second semicolon (separating params from uri)
          let semi2 = -1;
          for (let i = semiIdx + 1; i < this.oscLength; i++) {
            if (this.oscParts[i] === 0x3b) {
              semi2 = i;
              break;
            }
          }
          if (semi2 === -1) break; // malformed: no URI separator
          // Build params string
          let osc8params = "";
          for (let i = semiIdx + 1; i < semi2; i++) {
            osc8params += String.fromCharCode(this.oscParts[i]);
          }
          // Build URI string
          let osc8uri = "";
          for (let i = semi2 + 1; i < this.oscLength; i++) {
            osc8uri += String.fromCharCode(this.oscParts[i]);
          }
          this.onOsc8(osc8params, osc8uri);
        }
        break;
      case 104: // OSC 104 — reset color palette entry/entries
        // Format: 104;<c1>;<c2>;... where c1..cN are 0-255 palette indices.
        // (The no-argument form is handled above in the semiIdx === -1 path.)
        if (this.onOsc104) {
          let pos = semiIdx + 1;
          while (pos < this.oscLength) {
            // Parse next decimal integer up to ';' or end
            let val = 0;
            let end = pos;
            while (end < this.oscLength && this.oscParts[end] !== 0x3b) {
              val = val * 10 + (this.oscParts[end] - 0x30);
              end++;
            }
            if (end > pos) this.onOsc104(val);
            pos = end + 1; // skip past the ';'
          }
        }
        break;
      case 133: // OSC 133 — shell integration / semantic prompts (FinalTerm protocol)
        // Format: 133;<type>[;<payload>]
        // <type> is a single ASCII letter: A (prompt start), B (command start),
        //   C (command output start), D (command end), E (command text), P (property), …
        // <payload> is everything after the type letter and its optional trailing semicolon.
        if (this.onOsc133) {
          // First byte after the code semicolon is the type letter.
          const typeStart = semiIdx + 1;
          if (typeStart >= this.oscLength) break; // malformed: no type letter
          const typeLetter = String.fromCharCode(this.oscParts[typeStart]);
          // Payload is everything after an optional semicolon following the type letter.
          let osc133payload = "";
          if (typeStart + 1 < this.oscLength) {
            // Skip the separating semicolon if present.
            const payloadStart =
              this.oscParts[typeStart + 1] === 0x3b ? typeStart + 2 : typeStart + 1;
            for (let i = payloadStart; i < this.oscLength; i++) {
              osc133payload += String.fromCharCode(this.oscParts[i]);
            }
          }
          this.onOsc133(typeLetter, osc133payload);
        }
        break;
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

  private windowManipulation(paramCount: number): void {
    const ps = paramCount > 0 ? this.params[0] : 0;
    switch (ps) {
      case 22: // Push title to stack
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
    const grid = this.grid;
    switch (mode) {
      case 0: // from cursor to end
        this.eraseCells(cursor.row, cursor.col, cursor.row, this.cols - 1);
        for (let r = cursor.row + 1; r < this.rows; r++) {
          grid.clearRowRaw(r);
        }
        if (cursor.row + 1 < this.rows) {
          grid.markDirtyRange(cursor.row + 1, this.rows - 1);
        }
        break;
      case 1: // from beginning to cursor
        for (let r = 0; r < cursor.row; r++) {
          grid.clearRowRaw(r);
        }
        if (cursor.row > 0) {
          grid.markDirtyRange(0, cursor.row - 1);
        }
        this.eraseCells(cursor.row, 0, cursor.row, cursor.col);
        break;
      case 2: // entire display
      case 3: // entire display + scrollback
        for (let r = 0; r < this.rows; r++) {
          grid.clearRowRaw(r);
        }
        grid.markDirtyRange(0, this.rows - 1);
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
    // Inline cell writes to avoid per-cell setCell + markDirty overhead
    const grid = this.grid;
    const rowBase = grid.rowStart(row);
    const start = Math.max(startCol, 0);
    const end = Math.min(endCol, this.cols - 1);
    for (let c = start; c <= end; c++) {
      const idx = rowBase + c * CELL_SIZE;
      grid.data[idx] = DEFAULT_CELL_W0;
      grid.data[idx + 1] = DEFAULT_CELL_W1;
    }
    grid.markDirty(row);
  }

  private eraseChars(n: number): void {
    const cursor = this.buf.cursor;
    const grid = this.grid;
    const rowBase = grid.rowStart(cursor.row);
    const end = Math.min(cursor.col + n, this.cols);
    for (let c = cursor.col; c < end; c++) {
      const idx = rowBase + c * CELL_SIZE;
      grid.data[idx] = DEFAULT_CELL_W0;
      grid.data[idx + 1] = DEFAULT_CELL_W1;
    }
    grid.markDirty(cursor.row);
  }

  // ---- Insert / Delete ----

  private insertLines(n: number): void {
    const cursor = this.buf.cursor;
    if (cursor.row < this.buf.scrollTop || cursor.row > this.buf.scrollBottom) return;
    const grid = this.grid;
    const rowSize = this.cols * CELL_SIZE;
    // Clamp n to available rows and shift in a single O(H) pass
    n = Math.min(n, this.buf.scrollBottom - cursor.row + 1);
    // Shift rows down by n: copy each row to its final position in one pass
    for (let r = this.buf.scrollBottom; r >= cursor.row + n; r--) {
      const src = grid.rowStart(r - n);
      const dst = grid.rowStart(r);
      grid.data.copyWithin(dst, src, src + rowSize);
    }
    // Clear the n inserted rows
    for (let r = cursor.row; r < cursor.row + n; r++) {
      grid.clearRowRaw(r);
    }
    grid.markDirtyRange(cursor.row, this.buf.scrollBottom);
  }

  private deleteLines(n: number): void {
    const cursor = this.buf.cursor;
    if (cursor.row < this.buf.scrollTop || cursor.row > this.buf.scrollBottom) return;
    const grid = this.grid;
    const rowSize = this.cols * CELL_SIZE;
    // Clamp n to available rows and shift in a single O(H) pass
    n = Math.min(n, this.buf.scrollBottom - cursor.row + 1);
    // Shift rows up by n: copy each row to its final position in one pass
    for (let r = cursor.row; r <= this.buf.scrollBottom - n; r++) {
      const src = grid.rowStart(r + n);
      const dst = grid.rowStart(r);
      grid.data.copyWithin(dst, src, src + rowSize);
    }
    // Clear the n vacated rows at the bottom
    for (let r = this.buf.scrollBottom - n + 1; r <= this.buf.scrollBottom; r++) {
      grid.clearRowRaw(r);
    }
    grid.markDirtyRange(cursor.row, this.buf.scrollBottom);
  }

  private insertChars(n: number): void {
    const cursor = this.buf.cursor;
    const row = cursor.row;
    // Clamp n to remaining space
    n = Math.min(n, this.cols - cursor.col);
    // Shift cells right using physical row offset
    const rowBase = this.grid.rowStart(row);
    for (let c = this.cols - 1; c >= cursor.col + n; c--) {
      const src = rowBase + (c - n) * CELL_SIZE;
      const dst = rowBase + c * CELL_SIZE;
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
    // Shift cells left using physical row offset
    const rowBase = this.grid.rowStart(row);
    for (let c = cursor.col; c < this.cols - n; c++) {
      const src = rowBase + (c + n) * CELL_SIZE;
      const dst = rowBase + c * CELL_SIZE;
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

  private sgr(paramCount: number): void {
    if (paramCount === 0) {
      this.params[0] = 0;
      paramCount = 1;
    }

    for (let i = 0; i < paramCount; i++) {
      const p = this.params[i];
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
          i = this.parseSgrColor(paramCount, i, true);
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
          i = this.parseSgrColor(paramCount, i, false);
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
  private parseSgrColor(paramCount: number, i: number, isFg: boolean): number {
    if (i + 1 >= paramCount) return i;

    const mode = this.params[i + 1];
    if (mode === 5) {
      // 256-color: 38;5;n or 48;5;n
      if (i + 2 < paramCount) {
        const colorIdx = this.params[i + 2];
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
      if (i + 4 < paramCount) {
        const r = this.params[i + 2] & 0xff;
        const g = this.params[i + 3] & 0xff;
        const b = this.params[i + 4] & 0xff;
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
    this.lastPrintedCodepoint = 0;
    this.responseBuffer = [];
    this.titleStack = [];
    this.bufferSet.activateNormal();
    this.softReset();
    this.buf.cursor.row = 0;
    this.buf.cursor.col = 0;
    this.grid.clear();
  }
}
