# @next_term/core

Low-level terminal core: cell grid, VT parser, and buffer management. This package has no DOM dependencies and can run in any JavaScript environment (browser, Node, worker).

## Install

```bash
npm install @next_term/core
```

## Usage

Most users should use `@next_term/react` or `@next_term/web` instead. This package is for building custom terminal implementations or working directly with the VT parser.

```ts
import { BufferSet, VTParser, CellGrid, DEFAULT_THEME } from "@next_term/core";

// Create a buffer set (normal + alternate screen)
const bufferSet = new BufferSet(80, 24, 1000); // cols, rows, scrollback

// Create a VT parser
const parser = new VTParser(bufferSet);

// Parse terminal data
parser.write(new Uint8Array([0x1b, 0x5b, 0x31, 0x6d])); // ESC[1m (bold)
parser.write(new TextEncoder().encode("Hello, world!\r\n"));

// Read cell data
const grid = bufferSet.active.grid;
const codepoint = grid.getCodepoint(0, 0); // 'H' = 72
const fgIndex = grid.getFgIndex(0, 0);     // foreground color index
const attrs = grid.getAttrs(0, 0);         // bold, italic, underline, etc.
```

## Cell Format

Each cell is packed into 2 x Uint32 (8 bytes):

```
Word 0: [0-20]  codepoint (21 bits — full Unicode)
        [21]    fg-is-RGB flag
        [22]    bg-is-RGB flag
        [23-30] fg color index (0-255)
        [31]    reserved

Word 1: [0-7]   bg color index (0-255)
        [8]     bold
        [9]     italic
        [10]    underline
        [11]    strikethrough
        [12-13] underline style
        [14]    inverse
        [15]    wide character flag (ATTR_WIDE — set on first cell of a 2-column wide char)
```

Wide characters (CJK, Hangul, emoji, fullwidth forms) set `ATTR_WIDE` on the first cell and write a spacer cell (codepoint 0) in the next column. Renderers skip spacer cells and draw wide chars at 2× cell width.

## Wide Character Support

The VT parser handles Unicode character widths automatically:

- **Wide chars** (CJK, Hangul, Hiragana/Katakana, emoji, fullwidth forms): occupy 2 columns, set `ATTR_WIDE` flag
- **Combining marks** (U+0300+, variation selectors, ZWJ): absorbed without advancing the cursor
- **Normal chars**: occupy 1 column as usual

The `wcwidth` and `isCombining` utilities are exposed for custom integrations:

```ts
import { wcwidth, isCombining } from '@next_term/core';

wcwidth(0x4e2d);   // 2 — '中' (CJK)
wcwidth(0x1f600);  // 2 — '😀' (emoji)
wcwidth(0xff41);   // 2 — fullwidth 'ａ'
wcwidth(0x0041);   // 1 — 'A'
wcwidth(0x0300);   // 0 — combining grave accent

isCombining(0x0300); // true  — no cursor advance
isCombining(0x200d); // true  — ZWJ
isCombining(0x0041); // false
```

## SharedArrayBuffer

When `SharedArrayBuffer` is available (requires cross-origin isolation), `CellGrid` automatically uses shared memory. This enables zero-copy sharing between the main thread and Web Workers.

Dirty row tracking uses `Int32Array` with `Atomics` (not `Uint8Array` -- Atomics requires >= 32-bit typed arrays).

## Exports

```ts
export { CellGrid, CELL_SIZE, DEFAULT_CELL_W0, DEFAULT_CELL_W1 } from "@next_term/core";
export { BufferSet } from "@next_term/core";
export { VTParser } from "@next_term/core";
export { DEFAULT_THEME } from "@next_term/core";
export { extractText, normalizeSelection } from "@next_term/core";
export { wcwidth, isCombining } from "@next_term/core";

export type { Theme, CursorState, TerminalOptions, SelectionRange } from "@next_term/core";
```

## License

MIT
