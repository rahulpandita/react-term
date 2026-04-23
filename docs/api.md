# API Reference

## React Component Props

### `TerminalPane` — `parserWorkers` and `useWorker`

`TerminalPane` automatically creates a shared **parser worker pool** so all panes share a fixed set of parser workers. This avoids the thread oversubscription that occurs when one `Web Worker` is spawned per pane at 16–32 panes.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `parserWorkers` | `number` | `DEFAULT_PARSER_WORKER_COUNT` | Number of workers in the shared pool (default: `min(hardwareConcurrency, 4)`). Set to `0` to disable the pool. |
| `useWorker` | `boolean` | auto | When `false`, disables the pool entirely; all parsing happens on the main thread. |

```tsx
// Default: pool of min(hardwareConcurrency, 4) workers shared by all panes
<TerminalPane layout={layout} onData={handleData} />

// Custom pool size for very large pane counts
<TerminalPane layout={layout} parserWorkers={8} onData={handleData} />

// Disable workers (main-thread parsing only)
<TerminalPane layout={layout} parserWorkers={0} onData={handleData} />
// or equivalently:
<TerminalPane layout={layout} useWorker={false} onData={handleData} />
```

### `Terminal` — `parserPool`

Pass an externally-created `ParserPool` to share one pool across multiple `Terminal` instances that are composed outside of `TerminalPane`. Requires `paneId` to be set.

```tsx
import { ParserPool } from '@next_term/web';
import { Terminal } from '@next_term/react';

const pool = new ParserPool(); // create once

// Both terminals share the same pool workers
<Terminal paneId="left"  parserPool={pool} onData={...} />
<Terminal paneId="right" parserPool={pool} onData={...} />

// Dispose the pool when you're done
pool.dispose();
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `parserPool` | `ParserPool` | -- | Shared parser worker pool. When provided, `paneId` must also be set. |

### `Terminal` — `sharedContext` and `paneId`

Two optional props allow multiple `Terminal` instances to share a single rendering context (either WebGL2 or Canvas 2D), avoiding Chrome's 16-context limit without using the higher-level `TerminalPane` layout component.

```ts
import { SharedWebGLContext, SharedCanvas2DContext } from '@next_term/web';
import { Terminal } from '@next_term/react';

// Hardware WebGL2 available — share one GL context:
const sharedCtx = new SharedWebGLContext();

<Terminal sharedContext={sharedCtx} paneId="left" onData={...} />
<Terminal sharedContext={sharedCtx} paneId="right" onData={...} />

// Software renderer / no WebGL2 — share one Canvas 2D context instead:
const sharedCtx2d = new SharedCanvas2DContext();

<Terminal sharedContext={sharedCtx2d} paneId="left" onData={...} />
<Terminal sharedContext={sharedCtx2d} paneId="right" onData={...} />
```

| Prop | Type | Description |
|------|------|-------------|
| `sharedContext` | `SharedWebGLContext \| SharedCanvas2DContext \| undefined` | Shared render context for multi-pane rendering. When provided, `paneId` must also be set. |
| `paneId` | `string \| undefined` | Unique identifier for this terminal within the shared context. Required when `sharedContext` is provided. |

`TerminalPane` automatically creates and manages the shared context internally using the following fallback chain:
1. **`SharedWebGLContext`** — hardware WebGL2 (fastest)
2. **`SharedCanvas2DContext`** — software/SwiftShader or no WebGL2 (one Canvas 2D for all panes)
3. **No shared context** — per-pane independent rendering (rarely reached)

These props are only needed when composing `Terminal` instances manually outside of `TerminalPane`.

### `Terminal` and `TerminalPane` — `fontWeight` and `fontWeightBold`

Two props control the CSS `font-weight` values used when rendering normal and bold text. Both `Terminal` and `TerminalPane` accept them.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `fontWeight` | `number` | `400` | CSS font-weight for normal text |
| `fontWeightBold` | `number` | `700` | CSS font-weight for bold text (SGR 1 / `\x1b[1m`) |

```tsx
<Terminal
  fontSize={14}
  fontFamily="'Fira Code', monospace"
  fontWeight={300}
  fontWeightBold={600}
  onData={(data) => socket.send(data)}
/>
```

Use cases include matching a thinner UI font (e.g. `fontWeight={300}`) or using a semi-bold style instead of full bold. Both values are threaded through all renderer paths (Canvas 2D, WebGL2, render worker).

### Software Renderer Auto-Detection

`WebTerminal` detects software WebGL renderers (e.g. SwiftShader in headless Chromium, virtual machines) and automatically falls back to the **Canvas 2D** renderer. This ensures correct rendering in CI pipelines and VMs that lack a real GPU.

```ts
import { WebTerminal } from '@next_term/web';

// renderer: 'auto' (default) — Canvas 2D is chosen automatically on software renderers:
const term = new WebTerminal(container, { renderer: 'auto' });

// Force Canvas 2D explicitly:
const term = new WebTerminal(container, { renderer: 'canvas2d' });

// Force WebGL2 even on software renderers (not recommended):
const term = new WebTerminal(container, { renderer: 'webgl' });
```

The `renderer` option accepts `'auto'` (default), `'canvas2d'`, or `'webgl'`.

### CSS Color Format Support

The WebGL renderer's `hexToFloat4` color parser accepts **any valid CSS color format**. All theme color fields (e.g. `theme.background`, `theme.foreground`, `theme.cursor`, palette entries) can use any of:

| Format | Example |
|--------|---------|
| Hex (6-digit) | `#1e1e2e` |
| Hex (3-digit) | `#123` |
| `rgb()` comma | `rgb(30, 30, 46)` |
| `rgb()` space | `rgb(30 30 46)` |
| `rgba()` | `rgba(30 30 46 / 0.9)` |
| `hsl()` | `hsl(240 20% 15%)` |
| `oklch()` | `oklch(20% 0.02 260)` |
| `color(srgb ...)` | `color(srgb 0.12 0.12 0.18)` |
| Named colors | `rebeccapurple`, `crimson` |

Hex fast paths (`#rrggbb` / `#rgb`) require no canvas. All other formats are resolved via a 1×1 `OffscreenCanvas` in the render worker, so there is no performance cost on the main thread.

This fixes the "completely black terminal" bug that occurred when theme colors came from `getComputedStyle` or CSS custom properties (e.g. `var(--color-bg)` resolved at runtime).

```ts
const term = new WebTerminal(container, {
  theme: {
    background: 'oklch(20% 0.02 260)',  // any CSS color works
    foreground: 'rgb(205 214 244)',
    cursor:     'hsl(267 84% 81%)',
  },
});
```

## Unicode Utilities

### `wcwidth` — Character Display Width

Exported from `@next_term/core`. Returns the display width (number of terminal columns) of a Unicode codepoint:

| Return | Meaning |
|--------|---------|
| `0` | Zero-width (combining marks, ZWJ, control chars, variation selectors) |
| `1` | Normal width (ASCII, Latin, Greek, Cyrillic, most BMP characters) |
| `2` | Full-width (CJK Unified Ideographs, Hangul, fullwidth Latin/ASCII, etc.) |

```ts
import { wcwidth, isCombining } from '@next_term/core';

wcwidth(0x0041);   // 1 — 'A'
wcwidth(0x4e2d);   // 2 — '中' (CJK)
wcwidth(0x1f600);  // 2 — '😀' (emoji)
wcwidth(0x0300);   // 0 — combining grave accent
wcwidth(0xff41);   // 2 — fullwidth 'ａ'

isCombining(0x0300);  // true — combining mark, no cursor advance
isCombining(0x0041);  // false
```

**Implementation**: O(1) BMP lookup via a 64 KB `Uint8Array` flat table (codepoints U+0000–U+FFFF). Supplementary planes (emoji, CJK Ext B–I) use binary search, with zero parser throughput regression verified at 146 MB/s (ASCII) / 301 MB/s (Unicode).

**VT parser integration**: The parser automatically calls `wcwidth()` for non-ASCII codepoints when writing characters to the cell grid. Wide characters (`wcwidth == 2`) set the `ATTR_WIDE` flag on the first cell and write a spacer cell (codepoint 0) in the next column. Combining characters (`isCombining == true`) are absorbed without advancing the cursor. All four renderers (Canvas 2D, WebGL, SharedWebGLContext, RenderWorker) skip spacer cells and render wide chars at 2× cell width.

### `isCombining`

Returns `true` if a codepoint is zero-width and should not advance the cursor (combining marks, variation selectors, ZWJ, etc.). Excludes C0/C1 controls and soft hyphen.

```ts
import { isCombining } from '@next_term/core';

isCombining(0x0300); // true  — U+0300 COMBINING GRAVE ACCENT
isCombining(0x200d); // true  — ZWJ
isCombining(0x0041); // false — 'A'
```

## Utilities

### `SharedCanvas2DContext`

Exported from `@next_term/web`. A Canvas 2D equivalent of `SharedWebGLContext`: one canvas renders all registered terminal panes via per-terminal viewport rectangles, repainting only dirty rows each frame. Use it when WebGL2 is unavailable (e.g., SwiftShader on Linux CI, VMs without a GPU).

```ts
import { SharedCanvas2DContext } from '@next_term/web';

const ctx = new SharedCanvas2DContext({
  fontSize: 14,
  fontFamily: "'Menlo', monospace",
  theme: { background: '#1e1e2e', foreground: '#cdd6f4' },
});

ctx.init(); // acquires the 2D context — throws if unavailable

// Mount the canvas in the DOM
document.getElementById('terminal-container').appendChild(ctx.getCanvas());
ctx.syncCanvasSize(container.clientWidth, container.clientHeight);

// Register terminals (one per pane)
ctx.addTerminal('left', grid, cursor);
ctx.setViewport('left', 0, 0, halfWidth, height);

ctx.addTerminal('right', grid2, cursor2);
ctx.setViewport('right', halfWidth, 0, halfWidth, height);

ctx.startRenderLoop();

// Cleanup
ctx.dispose();
```

**Constructor options** (all optional):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `fontSize` | `number` | `14` | Font size in pixels |
| `fontFamily` | `string` | `'Menlo', 'DejaVu Sans Mono', 'Consolas', monospace` | Font family |
| `fontWeight` | `number` | `400` | CSS font-weight for normal text |
| `fontWeightBold` | `number` | `700` | CSS font-weight for bold text |
| `theme` | `Partial<Theme>` | `DEFAULT_THEME` | Color theme |
| `devicePixelRatio` | `number` | `window.devicePixelRatio` | DPR for HiDPI screens |

**Key methods** (mirrors `SharedWebGLContext`):

| Method | Description |
|--------|-------------|
| `init()` | Acquire the 2D context. Throws if unavailable. |
| `addTerminal(id, grid, cursor)` | Register a terminal pane. |
| `updateTerminal(id, grid, cursor)` | Update grid/cursor reference for a pane. |
| `setViewport(id, x, y, w, h)` | Set the pane's viewport rectangle in CSS pixels. |
| `removeTerminal(id)` | Unregister a terminal pane. |
| `setHighlights(id, highlights)` | Update search highlights for a pane. |
| `syncCanvasSize(w, h)` | Resize the backing canvas (call on container resize). |
| `startRenderLoop()` | Start the `requestAnimationFrame` render loop. |
| `stopRenderLoop()` | Pause rendering. |
| `setTheme(theme)` | Apply a new partial theme and force repaint. |
| `getCanvas()` | Return the underlying `HTMLCanvasElement`. |
| `getCellSize()` | Return `{ width, height }` of one cell in pixels. |
| `dispose()` | Stop rendering, remove the canvas, and free resources. |

`TerminalPane` manages `SharedCanvas2DContext` automatically as the second item in its fallback chain — direct usage is only needed when composing `Terminal` instances manually.

### `ParserPool` and `ParserChannel`

Exported from `@next_term/web`. `ParserPool` manages N parser Web Workers shared across many terminal panes, avoiding thread oversubscription. Each pane acquires a `ParserChannel` (same API as `WorkerBridge`) assigned round-robin to one of the pool workers.

```ts
import { ParserPool, DEFAULT_PARSER_WORKER_COUNT } from '@next_term/web';

// Create a pool (default: min(hardwareConcurrency, 4) workers)
const pool = new ParserPool();

// Or specify a custom count:
const pool = new ParserPool(4);

// Each WebTerminal acquires a channel from the pool (via the parserPool option):
const term = new WebTerminal(container, {
  paneId: 'my-pane',
  parserPool: pool,
});

// Dispose pool after all terminals are disposed
pool.dispose();
```

`DEFAULT_PARSER_WORKER_COUNT` is `Math.min(navigator.hardwareConcurrency ?? 4, 4)`.

When using the `<TerminalPane>` React component, the pool is created and managed automatically. Use `parserWorkers={0}` or `useWorker={false}` to disable workers.

### `collectPaneIds`

Exported from `@next_term/react`. Performs a depth-first traversal of a `PaneLayout` tree and returns all leaf pane IDs in order. Useful for initializing connections or managing state outside of the component.

```ts
import { collectPaneIds } from '@next_term/react';
import type { PaneLayout } from '@next_term/react';

const layout: PaneLayout = {
  type: 'horizontal',
  children: [
    { type: 'single', id: 'left' },
    { type: 'vertical', children: [
      { type: 'single', id: 'top-right' },
      { type: 'single', id: 'bottom-right' },
    ]},
  ],
};

const ids = collectPaneIds(layout);
// => ['left', 'top-right', 'bottom-right']
```

## VTParser Callbacks

`VTParser` (from `@next_term/core`) exposes hooks for terminal protocol extensions.

### OSC 52 — Clipboard

```ts
import { VTParser } from '@next_term/core';

const parser = new VTParser();

parser.setOsc52Callback((selection: string, data: string | null) => {
  if (data === null) {
    // Query: respond with current clipboard contents (base64-encoded)
  } else {
    // Write: decode base64 `data` and write to clipboard for `selection`
    const text = atob(data);
    navigator.clipboard.writeText(text);
  }
});
```

`selection` is the clipboard target (e.g. `'c'` for system clipboard, `'p'` for primary). `data` is the raw base64 payload, or `null` for a query.

### OSC 4 — Color Palette

```ts
parser.setOsc4Callback((index: number, spec: string | null) => {
  if (spec === null) {
    // Query: respond with the current color for palette index `index`
  } else {
    // Set: apply color `spec` (e.g. 'rgb:ff/00/00', '#ff0000') at palette index
    updatePaletteColor(index, spec);
  }
});
```

Supports multiple `index;spec` pairs in a single OSC 4 sequence (per the OSC 4 specification). Palette indices range from 0–255.

### OSC 7 — Current Working Directory

```ts
parser.setOsc7Callback((uri: string) => {
  // uri is a file:// URI, e.g. "file://hostname/home/user/projects"
  const path = new URL(uri).pathname;
  console.log('Shell CWD changed to:', path);
});
```

Emitted by modern shells (bash, zsh, fish) whenever the working directory changes. The payload is a `file://` URI containing the host and absolute path. Consumers can use `setOsc7Callback` to track the shell's CWD — useful for opening new panes in the same directory or displaying the path in a tab title.

Protocol sequences:
```
OSC 7 ; <file-URI> BEL   (e.g. \x1b]7;file://host/path\x07)
OSC 7 ; <file-URI> ST    (e.g. \x1b]7;file://host/path\x1b\\)
```


### OSC 8 — Hyperlinks

```ts
parser.setOsc8Callback((params: string, uri: string) => {
  if (uri === '') {
    // Close the active hyperlink
    closeHyperlink();
  } else {
    // Open a hyperlink to `uri`
    // `params` is an optional colon-separated key=value metadata string
    // e.g. "id=link1:type=nav" — may be empty string
    openHyperlink(uri, params);
  }
});
```

`params` is the optional colon-separated key=value metadata string (e.g. `'id=link1:type=nav'`); it is an empty string when no metadata is provided. `uri` is the hyperlink target URL. An empty `uri` closes the currently active hyperlink.

Protocol sequences:
```
OSC 8 ; params ; uri BEL   (open hyperlink: e.g. \x1b]8;id=link1;https://example.com\x07)
OSC 8 ; ; BEL              (close hyperlink: \x1b]8;;\x07)
```

### OSC 10 / 11 / 12 — Dynamic Color Query/Set


```ts
// OSC 10 — foreground (text) color
parser.setOsc10Callback((spec: string | null) => {
  if (spec === null) {
    // Query: respond with current foreground color in "rgb:RRRR/GGGG/BBBB" format
  } else {
    // Set: apply color spec (e.g. 'rgb:ff/00/00', '#ff0000', 'red') as foreground
    updateForegroundColor(spec);
  }
});

// OSC 11 — background color
parser.setOsc11Callback((spec: string | null) => {
  if (spec === null) {
    // Query: respond with current background color
  } else {
    updateBackgroundColor(spec);
  }
});

// OSC 12 — cursor color
parser.setOsc12Callback((spec: string | null) => {
  if (spec === null) {
    // Query: respond with current cursor color
  } else {
    updateCursorColor(spec);
  }
});
```

`spec` is the color specification string (e.g. `'rgb:ff/00/00'`, `'#ff0000'`) when setting, or `null` when the terminal sends a query (`?`). On a query, respond by writing the current color value back to the PTY in the matching OSC response format.

Protocol sequences:
```
OSC 10 ; ? BEL       (query foreground color)
OSC 10 ; rgb:ff/00/00 BEL   (set foreground to red)
OSC 11 ; ? BEL       (query background color)
OSC 12 ; ? BEL       (query cursor color)
```

### OSC 104 — Reset Color Palette

```ts
parser.setOsc104Callback((index: number) => {
  if (index === -1) {
    // Reset all 256 palette entries to their defaults
    resetEntirePalette();
  } else {
    // Reset a single palette entry (0–255) to its default
    resetPaletteEntry(index);
  }
});
```

OSC 104 is the counterpart to OSC 4 — it restores indexed palette colors to their defaults. Terminal applications that temporarily modify palette entries via OSC 4 should issue OSC 104 on exit to clean up. The callback is invoked once per index to reset; `index` is `0`–`255` for a specific entry, or `-1` when no index is given (reset all).

Protocol sequences:
```
OSC 104 BEL             (reset entire palette)
OSC 104 ; 5 BEL         (reset palette entry 5)
OSC 104 ; 1 ; 3 ; 7 BEL (reset entries 1, 3, and 7)
```

### OSC 133 — Shell Integration (Semantic Prompts)

```ts
parser.setOsc133Callback((type: string, payload: string) => {
  switch (type) {
    case 'A': // Prompt start
      markPromptStart();
      break;
    case 'B': // Command start — shell is ready for input
      markCommandStart();
      break;
    case 'C': // Command output start — user pressed Enter
      markOutputStart();
      break;
    case 'D': // Command end — payload is the exit code (e.g. '0', '127') or empty
      const exitCode = payload === '' ? null : parseInt(payload, 10);
      markCommandEnd(exitCode);
      break;
    case 'E': // Command text (for history) — payload is the command string
      recordCommandText(payload);
      break;
    case 'P': // Property metadata — payload is 'key=value' pairs
      applyProperty(payload);
      break;
    default:  // Any other letter is forwarded as-is
      handleCustomMarker(type, payload);
  }
});
```

OSC 133 is the FinalTerm / shell integration protocol. Supported by bash, zsh, fish, and most modern shells when `$TERM_PROGRAM` is set.

| Type | Meaning | Payload |
|------|---------|---------|
| `A` | Prompt start | — |
| `B` | Command start (shell waiting for input) | — |
| `C` | Command output start (Enter pressed) | — |
| `D` | Command end / exit | exit-code digits, e.g. `"0"`, `"127"` (empty = unknown) |
| `E` | Command text (for history) | command string |
| `P` | Property metadata | `key=value` pairs |
| _(other)_ | Custom / forwarded | everything after separator |

Protocol sequences:
```
OSC 133 ; A BEL             (prompt start)
OSC 133 ; B BEL             (command start)
OSC 133 ; C BEL             (output start)
OSC 133 ; D ; 0 BEL         (command ended, exit code 0)
OSC 133 ; E ; ls -la BEL    (command text "ls -la")
OSC 133 ; P ; key=value BEL (property metadata)
```

### DEC Mode 2026 — Synchronized Output

```ts
parser.setSyncOutputCallback((active: boolean) => {
  if (active) {
    renderer.stopRenderLoop();
  } else {
    renderer.startRenderLoop();
    renderer.render();
  }
});
```

`active` is `true` when DECSET `?2026h` enables the mode and `false` when DECRST `?2026l` disables it. The `syncedOutput` boolean property on `VTParser` reflects the current state and is reset to `false` by soft reset (DECSTR).

Protocol sequences:
```
ESC [ ? 2026 h   (activate synchronized output — pause rendering)
ESC [ ? 2026 l   (deactivate synchronized output — resume rendering)
```

### DCS — Device Control String Handler

```ts
parser.setDcsCallback((
  finalByte: number,
  params: readonly number[],
  intermediate: number,
  data: string,
) => {
  if (finalByte === 0x70 /* 'p' */ && intermediate === 0) {
    handleCustomDcs(params, data);
  }
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `finalByte` | `number` | Final byte that triggered the sequence (0x40–0x7E) |
| `params` | `readonly number[]` | Numeric params (CSI-style; may be empty) |
| `intermediate` | `number` | Single intermediate byte (0x20–0x2F), or `0` if none |
| `data` | `string` | Passthrough bytes between final byte and ST (max 4096 chars) |

Protocol sequences:
```
ESC P <params> <intermediate> <finalByte> <data> ESC \   (7-bit)
ESC P <params> <intermediate> <finalByte> <data> 0x9C    (8-bit)
```

### DCS tmux Passthrough

```ts
parser.setDcsTmuxCallback((innerSeq: string) => {
  console.log("tmux inner sequence:", innerSeq);
});
```

Handles `ESC P tmux; ESC ESC (inner) ESC \` sequences. The inner sequence is automatically re-processed through the VT state machine. The callback receives the decoded inner string (doubled `ESC ESC` pairs unescaped to single `ESC`).

| Property | Details |
|----------|---------|
| Trigger | `ESC P t` followed by `mux;` prefix |
| ESC unescaping | `\x1b\x1b` → single `\x1b` |
| Recursion guard | Nested tmux passthrough is dropped |
| Buffer cap | 8192 bytes |

Protocol sequence:
```
ESC P tmux; ESC ESC (inner-sequence) ESC \
```

## Kitty Keyboard Protocol

### Flag Values (bitmask)

| Bit | Value | Meaning |
|-----|-------|---------|
| 0 | `1` | Disambiguate escape codes |
| 1 | `2` | Report event types (key-down / key-repeat / key-up) |
| 2 | `4` | Report alternate keys |
| 3 | `8` | Report all keys as escape codes |
| 4 | `16` | Report associated text |

### Supported Sequences

| Sequence | Action |
|----------|--------|
| `CSI = flags u` | Set flags (mode 1 = set, 2 = OR, 3 = AND, 4 = XOR) |
| `CSI > flags u` | Push current flags onto stack, then set new flags |
| `CSI < n u` | Pop `n` entries from stack (default 1) |
| `CSI ? u` | Query current flags → responds with `\x1b[?{flags}u` |

### Subscribing to Flag Changes

```ts
parser.setKittyFlagsCallback((flags: number) => {
  console.log("kitty flags changed:", flags);
});

// Current flags are also readable directly:
console.log(parser.kittyFlags);
```

The stack depth is capped at 99 entries. Both `kittyFlags` and the stack are reset to zero on a full terminal reset (`RIS`, `\x1bc`).

### Disambiguate Key Encoding (flag 1)

When bit 0 is active, `InputHandler` uses the unambiguous Kitty CSI u format:

```ts
import { InputHandler } from '@next_term/web';

const input = new InputHandler({ onData: (seq) => socket.send(seq) });
input.setKittyFlags(1);
```

| Key | Legacy sequence | Kitty disambiguate |
|-----|-----------------|--------------------|
| Escape | `\x1b` | `\x1b[27u` |
| Ctrl+a | `\x01` | `\x1b[97;5u` |
| Alt+a | `\x1ba` | `\x1b[97;3u` |
| Ctrl+Alt+a | — | `\x1b[97;7u` |
| Shift+Tab | — | `\x1b[9;2u` |

Modifier bitmask: shift=1, alt=2, ctrl=4. The wire value is bitmask + 1.

**Wiring parser flags to key encoding:**

When using `WebTerminal`, Kitty flag changes are automatically propagated to `InputHandler` via `syncParserModes()`. When using `VTParser` and `InputHandler` directly:

```ts
parser.setKittyFlagsCallback((flags) => {
  input.setKittyFlags(flags);
});
```

### Report Event Types (flag 2)

When bit 1 is active, `InputHandler` appends `:event-type` sub-parameters:

| Event | Type | Example (Ctrl+a) |
|-------|------|------------------|
| Press | `1` | `\x1b[97;5:1u` |
| Repeat | `2` | `\x1b[97;5:2u` |
| Release | `3` | `\x1b[97;5:3u` |

`keyUpToSequence(e: KeyboardEvent): string | null` produces release sequences for keyup events. Returns `null` if flag 2 is not set. When using `WebTerminal`, keyup events are handled automatically.

### Report Alternate Keys (flag 4)

When bit 2 is active, `InputHandler` appends alternate key sub-parameters:

```
CSI codepoint[:shifted[:base]] ; modifier[:eventType] u
```

| Input | Sequence | Notes |
|-------|----------|-------|
| Ctrl+a | `\x1b[97:65;5u` | main=`a`(97), shifted=`A`(65) |
| Ctrl+A (Shift+Ctrl+a) | `\x1b[65::97;6u` | main=`A`(65), base=`a`(97) |
| Alt+1 | `\x1b[49:33;3u` | main=`1`(49), shifted=`!`(33) |

Functional keys (arrows, F-keys) are unaffected. Flag 4 is a no-op without flag 1. Flags 2 and 4 compose naturally (`setKittyFlags(7)`).

### Report All Keys as Escape Codes (flag 8)

When bit 3 is active (flag value `8`, typically combined with flag 1 as `setKittyFlags(9)`), `InputHandler` encodes **all** key presses as CSI u escape sequences — including unmodified printable characters and functional keys that would otherwise produce literal characters (Enter → `\r`, Tab → `\t`, Backspace → `\x7f`).

```ts
import { InputHandler } from '@next_term/web';

const input = new InputHandler({ onData: (seq) => socket.send(seq) });

// Enable disambiguate (1) + report all keys (8):
input.setKittyFlags(9);
```

**Key encoding with flags 1+8 active:**

| Key | Legacy sequence | Flags 1+8 |
|-----|-----------------|-----------|
| `a` (unmodified) | `a` | `\x1b[97;1u` |
| `z` (unmodified) | `z` | `\x1b[122;1u` |
| Space (unmodified) | ` ` | `\x1b[32;1u` |
| Shift+a (key=`A`) | `A` | `\x1b[65;2u` |
| Enter | `\r` | `\x1b[13;1u` |
| Tab | `\t` | `\x1b[9;1u` |
| Backspace | `\x7f` | `\x1b[127;1u` |
| Ctrl+a | `\x01` | `\x1b[97;5u` (same as flag 1) |
| Escape | `\x1b` | `\x1b[27u` (same as flag 1) |

Flag 8 is a no-op without flag 1. Modified keys (Ctrl, Alt) are already encoded as CSI u by flag 1 alone, so flag 8 has no additional effect on them. Composing flag 8 with flags 2 and 4 works as expected — event types and alternate key sub-parameters apply to all keys including unmodified ones:

| Input | Sequence (flags 1+2+8, press) | Sequence (flags 1+4+8) |
|-------|-------------------------------|------------------------|
| `a` press | `\x1b[97;1:1u` | `\x1b[97:65;1u` |
| `a` release | `\x1b[97;1:3u` | — |
| Enter press | `\x1b[13;1:1u` | — |

### Report Associated Text (flag 16)

When bit 4 is active (flag value `16`), all CSI u key sequences include the Unicode codepoint(s) of the **associated text** as a third semicolon-delimited parameter group. The associated text is the character that would be inserted into a text editor by the key press.

```
CSI codepoint[:shifted[:base]] ; modifiers[:event-type] ; text-codepoints u
```

```ts
import { InputHandler } from '@next_term/web';

const input = new InputHandler({ onData: (seq) => socket.send(seq) });

// Enable disambiguate (1) + report all keys (8) + associated text (16):
input.setKittyFlags(1 | 8 | 16);
```

**Associated text examples:**

| Key | Flags | Sequence | Notes |
|-----|-------|----------|-------|
| `a` (unmodified) | 1+8+16 | `\x1b[97;1;97u` | text = `a` (97) |
| Ctrl+a | 1+16 | `\x1b[97;5;97u` | text = `a` (97) |
| Shift+a (key=`A`) | 1+8+16 | `\x1b[65;2;65u` | text = `A` (65) |
| Enter | 1+8+16 | `\x1b[13;1;13u` | text = CR (13) |
| Tab | 1+8+16 | `\x1b[9;1;9u` | text = HT (9) |
| Backspace | 1+8+16 | `\x1b[127;1;127u` | text = DEL (127) |
| Shift+Tab | 1+16 | `\x1b[9;2;9u` | text = HT (9) |
| ArrowUp (modified) | 1+8+16 | `\x1b[1;5A` | no text param (positional key) |
| F1 (modified) | 1+8+16 | `\x1b[1;5P` | no text param (positional key) |
| Escape | 1+8+16 | `\x1b[27u` | no text param |

Non-text keys (arrow keys, F-keys, Escape) do not receive a third parameter. Flag 16 is a no-op without flag 1. Composing flag 16 with flags 2 and 4:

| Input | Sequence (flags 1+2+8+16, press) | Sequence (flags 1+4+8+16) |
|-------|-----------------------------------|---------------------------|
| `a` press | `\x1b[97;1:1;97u` | `\x1b[97:65;1;97u` |
| `a` release | `\x1b[97;1:3;97u` | — |
| Enter press | `\x1b[13;1:1;13u` | — |

This completes the full Kitty keyboard protocol stack (flags 1–16). All five flags are independently composable via bitwise OR.
