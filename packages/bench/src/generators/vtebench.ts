import type { Scenario } from "./types.js";

const SIZE = 5 * 1024 * 1024;
const COLS = 80;
const LINES = 24;

const encoder = new TextEncoder();

/** Concatenate encoded chunks into a single Uint8Array. */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

/** Repeat a single iteration buffer to fill SIZE. */
function repeatToSize(iteration: Uint8Array): Uint8Array {
  const count = Math.ceil(SIZE / iteration.length);
  const data = new Uint8Array(count * iteration.length);
  for (let i = 0; i < count; i++) {
    data.set(iteration, i * iteration.length);
  }
  return data.subarray(0, SIZE);
}

/**
 * vtebench: dense_cells
 *
 * Full-screen update with 256-color fg+bg, bold, italic, underline on every cell.
 * Cycles through A-Z, each filling the entire grid.
 */
export function vteDenseCells(): Scenario {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (let charIdx = 0; charIdx < 26 && total < SIZE; charIdx++) {
    const char = String.fromCharCode(65 + charIdx); // A-Z
    // Cursor home
    const home = encoder.encode("\x1b[H");
    chunks.push(home);
    total += home.length;

    for (let line = 1; line <= LINES && total < SIZE; line++) {
      for (let col = 1; col <= COLS && total < SIZE; col++) {
        const index = line + col + charIdx;
        const fg = (index % 156) + 100;
        const bg = 255 - (index % 156) + 100;
        const seq = encoder.encode(`\x1b[38;5;${fg};48;5;${bg};1;3;4m${char}`);
        chunks.push(seq);
        total += seq.length;
      }
    }
  }

  const iteration = concatChunks(chunks, total);
  return { name: "vte-dense-cells", data: repeatToSize(iteration) };
}

/**
 * vtebench: light_cells
 *
 * Full-screen fill with plain characters, no escape sequences per cell.
 * Tests pure character throughput without styling overhead.
 */
export function vteLightCells(): Scenario {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (let charIdx = 0; charIdx < 26; charIdx++) {
    const char = String.fromCharCode(65 + charIdx);
    const home = encoder.encode("\x1b[H");
    chunks.push(home);
    total += home.length;

    // Fill entire screen with the character
    const fill = encoder.encode(char.repeat(COLS * LINES));
    chunks.push(fill);
    total += fill.length;
  }

  const iteration = concatChunks(chunks, total);
  return { name: "vte-light-cells", data: repeatToSize(iteration) };
}

/**
 * vtebench: medium_cells
 *
 * Simulated vim session — mixed escape sequences typical of a text editor.
 * Includes cursor positioning, SGR color, line clearing, screen regions.
 */
export function vteMediumCells(): Scenario {
  const chunks: Uint8Array[] = [];
  let total = 0;

  // Simulate a vim-like session with varied escape sequences
  const patterns = [
    // Status line update with colors
    `\x1b[${LINES};1H\x1b[K\x1b[38;5;250;48;5;236m NORMAL \x1b[38;5;252;48;5;239m main.ts \x1b[38;5;245;48;5;237m utf-8 | ln 42, col 15 \x1b[0m`,
    // Cursor positioning + colored code
    "\x1b[1;1H\x1b[K\x1b[38;5;81mimport\x1b[0m { \x1b[38;5;149mComponent\x1b[0m } \x1b[38;5;81mfrom\x1b[0m \x1b[38;5;186m'react'\x1b[0m;",
    // Line clear + indented code
    "\x1b[3;1H\x1b[K  \x1b[38;5;81mconst\x1b[0m \x1b[38;5;149mx\x1b[0m = \x1b[38;5;141m42\x1b[0m;",
    // Region scroll
    `\x1b[1;${LINES - 1}r\x1b[${LINES - 1};1H\n\x1b[1;${LINES}r`,
    // Cursor save/restore + partial update
    "\x1b7\x1b[5;10H\x1b[38;5;208mfunction\x1b[0m \x1b[38;5;149mhello\x1b[0m() {\x1b8",
    // Erase operations
    "\x1b[10;1H\x1b[2K\x1b[11;1H\x1b[1K\x1b[12;1H\x1b[0K",
    // Bulk line insert/delete
    "\x1b[15;1H\x1b[3L\x1b[38;5;245m// inserted lines\x1b[0m\x1b[18;1H\x1b[2M",
  ];

  while (total < SIZE) {
    for (const pattern of patterns) {
      if (total >= SIZE) break;
      const seq = encoder.encode(pattern);
      chunks.push(seq);
      total += seq.length;
    }
  }

  return { name: "vte-medium-cells", data: concatChunks(chunks, total) };
}

/**
 * vtebench: cursor_motion
 *
 * Spiral rectangle pattern — CUP to every position in a shrinking rectangle.
 * Heavy cursor addressing workload.
 */
export function vteCursorMotion(): Scenario {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (let charIdx = 0; charIdx < 26 && total < SIZE; charIdx++) {
    const char = String.fromCharCode(65 + charIdx);
    let colStart = 1;
    let colEnd = COLS;
    let lineStart = 1;
    let lineEnd = LINES;

    while (colStart <= colEnd && lineStart <= lineEnd && total < SIZE) {
      // Top edge: left to right
      for (let col = colStart; col < colEnd && total < SIZE; col++) {
        const seq = encoder.encode(`\x1b[${lineStart};${col}H${char}`);
        chunks.push(seq);
        total += seq.length;
      }
      // Right edge: top to bottom
      for (let line = lineStart; line < lineEnd && total < SIZE; line++) {
        const seq = encoder.encode(`\x1b[${line};${colEnd}H${char}`);
        chunks.push(seq);
        total += seq.length;
      }
      // Bottom edge: right to left
      for (let col = colEnd; col > colStart && total < SIZE; col--) {
        const seq = encoder.encode(`\x1b[${lineEnd};${col}H${char}`);
        chunks.push(seq);
        total += seq.length;
      }
      // Left edge: bottom to top
      for (let line = lineEnd; line > lineStart && total < SIZE; line--) {
        const seq = encoder.encode(`\x1b[${line};${colStart}H${char}`);
        chunks.push(seq);
        total += seq.length;
      }

      colStart++;
      colEnd--;
      lineStart++;
      lineEnd--;
    }
  }

  const iteration = concatChunks(chunks, total);
  return { name: "vte-cursor-motion", data: repeatToSize(iteration) };
}

/**
 * vtebench: scrolling
 *
 * Minimal scroll — "y\n" repeated. Tests scroll throughput with minimal payload.
 */
export function vteScrolling(): Scenario {
  const line = encoder.encode("y\n");
  const count = Math.floor(SIZE / line.length);
  const data = new Uint8Array(count * line.length);
  for (let i = 0; i < count; i++) {
    data.set(line, i * line.length);
  }
  return { name: "vte-scrolling", data };
}

/**
 * vtebench: scrolling_fullscreen
 *
 * Full-width lines — each line fills the entire terminal width before scrolling.
 */
export function vteScrollingFullscreen(): Scenario {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (let charIdx = 0; charIdx < 26; charIdx++) {
    const char = String.fromCharCode(65 + charIdx);
    const line = encoder.encode(`${char.repeat(COLS)}\n`);
    chunks.push(line);
    total += line.length;
  }

  const iteration = concatChunks(chunks, total);
  return { name: "vte-scrolling-fullscreen", data: repeatToSize(iteration) };
}

/**
 * vtebench: scrolling_bottom_region
 *
 * Scroll within a region that excludes the bottom line.
 * Tests DECSTBM scroll region handling.
 */
export function vteScrollingBottomRegion(): Scenario {
  // Setup: set scroll region to rows 1..(LINES-1)
  const setup = encoder.encode(`\x1b[1;${LINES - 1}r\x1b[${LINES - 1};1H`);
  const line = encoder.encode("y\n");
  const lineCount = Math.floor((SIZE - setup.length) / line.length);

  const data = new Uint8Array(setup.length + lineCount * line.length);
  data.set(setup, 0);
  for (let i = 0; i < lineCount; i++) {
    data.set(line, setup.length + i * line.length);
  }
  return { name: "vte-scrolling-bottom-region", data };
}

/**
 * vtebench: scrolling_top_region
 *
 * Scroll within a region that excludes the top line.
 */
export function vteScrollingTopRegion(): Scenario {
  const setup = encoder.encode(`\x1b[2;${LINES}r\x1b[${LINES};1H`);
  const line = encoder.encode("y\n");
  const lineCount = Math.floor((SIZE - setup.length) / line.length);

  const data = new Uint8Array(setup.length + lineCount * line.length);
  data.set(setup, 0);
  for (let i = 0; i < lineCount; i++) {
    data.set(line, setup.length + i * line.length);
  }
  return { name: "vte-scrolling-top-region", data };
}

/**
 * vtebench: scrolling_bottom_small_region
 *
 * Scroll within the top half of the screen only.
 */
export function vteScrollingBottomSmallRegion(): Scenario {
  const halfLines = Math.floor(LINES / 2);
  const setup = encoder.encode(`\x1b[1;${halfLines}r\x1b[${halfLines};1H`);
  const line = encoder.encode("y\n");
  const lineCount = Math.floor((SIZE - setup.length) / line.length);

  const data = new Uint8Array(setup.length + lineCount * line.length);
  data.set(setup, 0);
  for (let i = 0; i < lineCount; i++) {
    data.set(line, setup.length + i * line.length);
  }
  return { name: "vte-scrolling-bottom-small-region", data };
}

/**
 * vtebench: scrolling_top_small_region
 *
 * Scroll within the bottom half of the screen only.
 */
export function vteScrollingTopSmallRegion(): Scenario {
  const halfLines = Math.floor(LINES / 2);
  const setup = encoder.encode(`\x1b[${halfLines};${LINES}r\x1b[${LINES};1H`);
  const line = encoder.encode("y\n");
  const lineCount = Math.floor((SIZE - setup.length) / line.length);

  const data = new Uint8Array(setup.length + lineCount * line.length);
  data.set(setup, 0);
  for (let i = 0; i < lineCount; i++) {
    data.set(line, setup.length + i * line.length);
  }
  return { name: "vte-scrolling-top-small-region", data };
}

/**
 * vtebench: unicode
 *
 * Sequential Unicode codepoints from U+00A1 through various blocks.
 * Tests multi-byte UTF-8 decode and wide character handling.
 */
export function vteUnicode(): Scenario {
  const codepoints: string[] = [];

  // Latin Extended, Greek, Cyrillic, CJK, symbols, emoji
  // Matches vtebench's symbols file: U+00A1 through ~U+1F64F
  const ranges: [number, number][] = [
    [0x00a1, 0x024f], // Latin Extended
    [0x0370, 0x03ff], // Greek
    [0x0400, 0x04ff], // Cyrillic
    [0x2000, 0x206f], // General Punctuation
    [0x2100, 0x214f], // Letterlike Symbols
    [0x2190, 0x21ff], // Arrows
    [0x2200, 0x22ff], // Mathematical Operators
    [0x2500, 0x257f], // Box Drawing
    [0x2580, 0x259f], // Block Elements
    [0x25a0, 0x25ff], // Geometric Shapes
    [0x2600, 0x26ff], // Miscellaneous Symbols
    [0x2700, 0x27bf], // Dingbats
    [0x3000, 0x303f], // CJK Symbols
    [0x3040, 0x309f], // Hiragana
    [0x30a0, 0x30ff], // Katakana
    [0x4e00, 0x4f00], // CJK Unified (subset)
    [0x1f300, 0x1f5ff], // Misc Symbols and Pictographs
    [0x1f600, 0x1f64f], // Emoticons
  ];

  for (const [start, end] of ranges) {
    for (let cp = start; cp <= end; cp++) {
      // Skip surrogates
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      codepoints.push(String.fromCodePoint(cp));
    }
  }

  const symbols = encoder.encode(codepoints.join(""));
  const count = Math.ceil(SIZE / symbols.length);
  const data = new Uint8Array(count * symbols.length);
  for (let i = 0; i < count; i++) {
    data.set(symbols, i * symbols.length);
  }
  return { name: "vte-unicode", data: data.subarray(0, SIZE) };
}
