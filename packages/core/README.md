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
        [15]    wide character flag
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

export type { Theme, CursorState, TerminalOptions, SelectionRange } from "@next_term/core";
```

## License

MIT
