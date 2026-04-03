# react-term

A modern terminal emulator for React and React Native, built from the ground up with Web Workers, SharedArrayBuffer, and WebGL2.

## Features

- **Off-main-thread architecture** — VT parser runs in a Web Worker, rendering optionally on OffscreenCanvas
- **WebGL2 renderer** — instanced rendering with alpha-only glyph atlas, 2 draw calls per frame
- **SharedArrayBuffer** — zero-copy cell grid shared between parser and renderer workers
- **Canvas 2D fallback** — automatic degradation when WebGL2/SAB unavailable
- **React Native support** — touch-first input, Skia renderer, TurboModule-ready
- **Multi-pane** — single shared WebGL context (bypasses Chrome's 16-context limit)
- **Accessibility** — parallel DOM with ARIA attributes, screen reader support
- **Addons** — search (regex), web links, fit
- **Full VT100/ANSI** — SGR (16/256/RGB colors, bold, italic, underline, inverse), cursor control (CUU/CUD/CUF/CUB/CNL/CPL/CHA/CHT/CBT/VPA/VPR/HPA/HPR), line/char editing (IL/DL/ICH/DCH/ECH), buffer scroll (SU/SD), character repeat (REP), ESC sequences (IND/NEL/RI/HTS/RIS), scroll regions, alternate buffer
- **OSC 52** — clipboard read/write via `setOsc52Callback`
- **OSC 4** — terminal color palette set/query via `setOsc4Callback`
- **OSC 7** — shell current working directory notification via `setOsc7Callback`
- **OSC 8** — clickable hyperlinks via `setOsc8Callback`
- **OSC 10/11/12** — dynamic foreground/background/cursor color query/set via `setOsc10Callback`, `setOsc11Callback`, `setOsc12Callback`
- **OSC 104** — reset indexed color palette entries via `setOsc104Callback`
- **OSC 133** — shell integration / semantic prompts (FinalTerm protocol) via `setOsc133Callback`
- **Bracketed paste** — DEC mode 2004 with injection-safe marker stripping; nested `ESC[200~`/`ESC[201~` sequences in pasted content are automatically stripped to prevent terminal injection attacks
- **DEC mode 2026** — synchronized output render gating; `setSyncOutputCallback` notifies when the mode activates/deactivates, pausing/resuming the main-thread render loop for flicker-free batch updates
- **DCS handler framework** — `setDcsCallback` dispatches fully-parsed DCS (Device Control String) sequences (final byte, params, intermediate, passthrough data) to application code; unlocks tmux passthrough and custom protocol extensions
- **DCS tmux passthrough** — `setDcsTmuxCallback` decodes `ESC P tmux; … ESC \` sequences: doubled ESCs are unescaped, the inner sequence is re-processed through the VT state machine, and the callback receives the decoded inner string
- **Kitty keyboard protocol flags** — `kittyFlags` property (bitmask) and `setKittyFlagsCallback` track the active keyboard enhancement flags; full push/pop stack (`CSI > u` / `CSI < u`), set/OR/AND/XOR modes (`CSI = flags ; mode u`), and query (`CSI ? u`) are all supported

## Quick Start

```tsx
import { Terminal } from '@next_term/react';

function App() {
  const termRef = useRef(null);

  return (
    <Terminal
      ref={termRef}
      autoFit
      fontSize={14}
      fontFamily="monospace"
      onData={(data) => websocket.send(data)}
    />
  );
}
```

## Packages

| Package | Description | Source | Tests | Total |
|---------|------------|-------:|------:|------:|
| `@next_term/core` | Cell grid, VT parser, buffer management | 2.7K | 6.7K | 9.4K |
| `@next_term/web` | Canvas 2D, WebGL2, workers, addons | 6.8K | 2.9K | 9.7K |
| `@next_term/react` | React component, multi-pane layout | 451 | 106 | 557 |
| `@next_term/native` | React Native, gesture/keyboard, Skia | 1.0K | 944 | 2.0K |
| **Total** | | **11.0K** | **10.7K** | **21.7K** |

## Architecture

```
PTY / WebSocket
      |
[Parser Worker] --SharedArrayBuffer--> [Render Worker]
  VT state machine                       OffscreenCanvas
  Writes to SAB                          WebGL2 glyph atlas
  Dirty row bits                         2 draw calls/frame
      |                                        |
[Main Thread]                            <canvas> element
  DOM events only
  React coordination
```

## Rendering Strategies

react-term auto-detects the best rendering strategy:

1. **Full Worker** — Parser + OffscreenCanvas render worker (requires SAB + OffscreenCanvas)
2. **Parser Worker** — Parser in worker, WebGL2 on main thread (requires SAB)
3. **Main Thread** — Canvas 2D fallback (works everywhere)

## Addons

```tsx
import { SearchAddon, WebLinksAddon, FitAddon } from '@next_term/web';

const searchAddon = new SearchAddon();
const webLinksAddon = new WebLinksAddon();
const fitAddon = new FitAddon();

// Load via imperative handle
terminal.loadAddon(searchAddon);
terminal.loadAddon(webLinksAddon);

// Search
searchAddon.findNext('error', { caseSensitive: false, regex: true });
```

## Multi-Pane

```tsx
import { TerminalPane } from '@next_term/react';

<TerminalPane
  layout={{
    type: 'horizontal',
    children: [
      { type: 'single', id: 'left' },
      { type: 'vertical', children: [
        { type: 'single', id: 'top-right' },
        { type: 'single', id: 'bottom-right' },
      ]},
    ],
    sizes: [0.5, 0.5],
  }}
  onData={(paneId, data) => connections[paneId].send(data)}
/>
```

### `collectPaneIds`

`collectPaneIds` is exported as a public helper from `@next_term/react`. It performs a depth-first traversal of a `PaneLayout` tree and returns all leaf pane IDs in order. Useful when you need the full set of pane IDs to initialize connections or manage state outside of the component.

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

`VTParser` (from `@next_term/core`) exposes hooks for terminal protocol extensions:

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

OSC 133 is the FinalTerm / shell integration protocol. Supported by bash, zsh, fish, and most modern shells when `$TERM_PROGRAM` is set. Shells emit these markers to annotate terminal output with semantic boundaries that host applications (terminals, IDEs, AI assistants) use to track prompt zones, capture command output, and read exit codes.

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
    // Mode activated: terminal is about to receive a batch of output.
    // Pause rendering to avoid partial-frame flicker.
    renderer.stopRenderLoop();
  } else {
    // Mode deactivated: batch is complete.
    // Resume rendering and flush one immediate frame.
    renderer.startRenderLoop();
    renderer.render();
  }
});
```

`active` is `true` when DECSET `?2026h` enables the mode and `false` when DECRST `?2026l` disables it. The `WebTerminal` class handles this automatically for main-thread rendering (Canvas 2D); the offscreen render worker has its own loop and is not affected.

The `syncedOutput` boolean property on `VTParser` reflects the current state and is reset to `false` by soft reset (DECSTR, `ESC [ ! p`).

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
  // finalByte identifies the DCS command (e.g. 0x70 = 'p', 0x71 = 'q')
  // params are the numeric parameters before the intermediate/final byte
  // intermediate is the single intermediate byte (0x20–0x2F), or 0 if none
  // data is the passthrough string between the final byte and ST

  if (finalByte === 0x70 /* 'p' */ && intermediate === 0) {
    // Example: handle a custom DCS p sequence
    handleCustomDcs(params, data);
  }
});
```

`setDcsCallback` registers a handler that is called once per fully-received DCS sequence — after the String Terminator (`ESC \` or C1 ST `0x9C`). The data collection buffer is capped at 4096 bytes to prevent unbounded memory growth on malformed input.

| Parameter | Type | Description |
|-----------|------|-------------|
| `finalByte` | `number` | Final byte that triggered the sequence (0x40–0x7E), e.g. `0x70` for `'p'` |
| `params` | `readonly number[]` | Numeric params collected before the intermediate/final byte (CSI-style; may be empty) |
| `intermediate` | `number` | Single intermediate byte (0x20–0x2F), or `0` if none |
| `data` | `string` | Passthrough bytes between the final byte and ST, as a string (max 4096 chars) |

Protocol sequences:
```
ESC P <params> <intermediate> <finalByte> <data> ESC \   (7-bit: ESC P … ESC \)
ESC P <params> <intermediate> <finalByte> <data> 0x9C    (8-bit: ESC P … C1 ST)
```

Common use-cases: DECRQSS responses, Sixel graphics (`DCS … q … ST`), ReGIS graphics.

### DCS tmux Passthrough

```ts
parser.setDcsTmuxCallback((innerSeq: string) => {
  // innerSeq is the decoded inner escape sequence string
  // e.g. "\x1b[1m" for a bold SGR wrapped in tmux DCS
  console.log("tmux inner sequence:", innerSeq);
});
```

`setDcsTmuxCallback` registers a handler for DCS tmux passthrough sequences of the form `ESC P tmux; ESC ESC (inner) ESC \`. The inner sequence is automatically re-processed through the VT state machine — window titles, SGR attributes, clipboard writes, and all other callbacks fire as if the inner sequence had been received directly. The callback receives the decoded inner string (doubled `ESC ESC` pairs unescaped to single `ESC`) after dispatch.

| Property | Details |
|----------|---------|
| Trigger | `ESC P t` followed by `mux;` prefix in PUT bytes |
| ESC unescaping | `\x1b\x1b` in passthrough → single `\x1b` in inner sequence |
| Outer ST | `\x1b\` terminates the tmux DCS and triggers dispatch |
| Inner re-processing | Inner bytes are fed back through `write()` automatically |
| Recursion guard | Nested tmux passthrough is dropped (`tmuxDepth` counter) |
| Buffer cap | 8 192 bytes; bytes beyond the cap are silently dropped |

Protocol sequence:
```
ESC P tmux; ESC ESC (inner-sequence) ESC \
```

Where each `ESC` byte in the inner sequence is encoded as `ESC ESC` (doubled). The outer string terminator is a lone `ESC \`.

Example — window title set via tmux passthrough:
```ts
parser.setTitleChangeCallback((title) => console.log("title:", title));

// Sends: ESC P tmux; ESC ESC ] 0 ; My Title ESC ESC \ ESC \
parser.write("\x1bPtmux;\x1b\x1b]0;My Title\x1b\x1b\\\x1b\\");
// logs: title: My Title
```

### Kitty Keyboard Protocol Flags

```ts
parser.setKittyFlagsCallback((flags: number) => {
  // flags is the new bitmask after any CSI = / > / < u sequence
  console.log("kitty flags changed:", flags);
});
```

`setKittyFlagsCallback` registers a callback fired whenever the active Kitty keyboard enhancement flags change. The current bitmask is also readable at any time via `parser.kittyFlags`.

**Flag values (bitmask):**

| Bit | Value | Meaning |
|-----|-------|---------|
| 0 | `1` | Disambiguate escape codes |
| 1 | `2` | Report event types (key-down / key-repeat / key-up) |
| 2 | `4` | Report alternate keys |
| 3 | `8` | Report all keys as escape codes |
| 4 | `16` | Report associated text |

**Supported sequences:**

| Sequence | Action |
|----------|--------|
| `CSI = flags u` | Set flags (mode 1 = set, 2 = OR, 3 = AND, 4 = XOR) |
| `CSI > flags u` | Push current flags onto stack, then set new flags |
| `CSI < n u` | Pop `n` entries from stack (default 1) |
| `CSI ? u` | Query current flags → responds with `\x1b[?{flags}u` |

The stack depth is capped at 99 entries. Both `kittyFlags` and the stack are reset to zero on a full terminal reset (`RIS`, `\x1bc`).

Example — reading the active flags and subscribing to changes:
```ts
import { VTParser } from '@next_term/core';

const parser = new VTParser(bufferSet);

parser.setKittyFlagsCallback((flags) => {
  const disambiguate = (flags & 1) !== 0;
  const reportEventTypes = (flags & 2) !== 0;
  const reportAlternateKeys = (flags & 4) !== 0;
  console.log({ disambiguate, reportEventTypes, reportAlternateKeys });
});

// App sends: CSI = 3 u  (set bits 0 and 1)
parser.write("\x1b[=3u");
// → callback fires with flags = 3

// Inspect directly at any time:
console.log(parser.kittyFlags); // 3
```

### Kitty Keyboard Protocol — Disambiguate Key Encoding

When bit 0 of the Kitty flags is active, `InputHandler` switches its key encoding from legacy VT sequences to the unambiguous Kitty CSI u format.

```ts
import { InputHandler } from '@next_term/web';

const input = new InputHandler({ onData: (seq) => socket.send(seq) });

// Enable disambiguate mode (flag 1):
input.setKittyFlags(1);
```

**Key encoding with flag 1 active:**

| Key | Legacy sequence | Kitty disambiguate |
|-----|-----------------|--------------------|
| Escape | `\x1b` | `\x1b[27u` |
| Ctrl+a | `\x01` | `\x1b[97;5u` |
| Alt+a | `\x1ba` | `\x1b[97;3u` |
| Ctrl+Alt+a | — | `\x1b[97;7u` |
| Shift+Tab | — | `\x1b[9;2u` |
| Ctrl+ArrowUp | — | `\x1b[1;5A` |
| Shift+Delete | — | `\x1b[3;2~` |
| Ctrl+F1 | — | `\x1b[1;5P` |
| ArrowUp (unmodified) | `\x1b[A` | `\x1b[A` (unchanged) |

Modifier bitmask: shift=1, alt=2, ctrl=4. The wire value is bitmask + 1.  
Unmodified printable characters and unmodified navigation keys retain their legacy encoding even with the flag active.

**Wiring parser flags to key encoding:**

When using `WebTerminal`, Kitty flag changes received from the remote application are automatically propagated to `InputHandler` via `syncParserModes()` (called after every `write()`). No manual wiring is needed.

When using `VTParser` and `InputHandler` directly (without `WebTerminal`), connect them via `setKittyFlagsCallback`:

```ts
import { VTParser } from '@next_term/core';
import { InputHandler } from '@next_term/web';

const input = new InputHandler({ onData: (seq) => socket.send(seq) });

parser.setKittyFlagsCallback((flags) => {
  // Keep InputHandler encoding in sync with what the app requested
  input.setKittyFlags(flags);
});
```

Calling `input.setKittyFlags(0)` (or any value with bit 0 clear) restores legacy key encoding immediately.

### Kitty Keyboard Protocol — Report Event Types (flag 2)

When bit 1 of the Kitty flags is active (flag value `2`, typically combined with flag 1 as `setKittyFlags(3)`), `InputHandler` appends an `:event-type` sub-parameter to all enhanced Kitty CSI sequences. This lets the receiving application distinguish key-press, key-repeat, and key-release events.

```ts
import { InputHandler } from '@next_term/web';

const input = new InputHandler({ onData: (seq) => socket.send(seq) });

// Enable disambiguate (1) + report event types (2):
input.setKittyFlags(3);
```

**Event type encoding:**

| Event | Trigger | Type | Example (Ctrl+a) |
|-------|---------|------|------------------|
| Press | keydown, repeat=false | `1` | `\x1b[97;5:1u` |
| Repeat | keydown, repeat=true | `2` | `\x1b[97;5:2u` |
| Release | keyup | `3` | `\x1b[97;5:3u` |

The `:event-type` suffix is appended to all enhanced sequences (CSI u, modified cursor/tilde/Fn keys). Unmodified keys that fall back to legacy encoding do not carry an event type.

**`keyUpToSequence(e: KeyboardEvent): string | null`** — produces the release sequence for a keyup event when `kittyFlags & 2` is active. Returns `null` if flag 2 is not set or the key has no Kitty-encoded release (legacy-only unmodified keys).

```ts
// In a WebTerminal or custom setup, forward keyup events:
textarea.addEventListener("keyup", (e) => {
  const seq = input.keyUpToSequence(e);
  if (seq !== null) {
    e.preventDefault();
    socket.send(seq);
  }
});
```

> **Note:** When using `WebTerminal`, keyup events are handled automatically — the `InputHandler` registers its own `keyup` listener on the textarea when `kittyFlags & 2` is set.

**Escape with flag 2** uses the fully expanded form `\x1b[27;1:Nu` (where `N` is the event type), instead of the shorter `\x1b[27u` used by flag 1 alone, to carry the modifier field required for the event type sub-parameter.

### Kitty Keyboard Protocol — Report Alternate Keys (flag 4)

When bit 2 of the Kitty flags is active (flag value `4`, typically combined with flag 1 as `setKittyFlags(5)`), `InputHandler` appends alternate key sub-parameters to the key codepoint in CSI u sequences for single printable characters. This lets the receiving application identify the physical key and its shifted variant independently of which modifier was held.

```
CSI codepoint[:shifted[:base]] ; modifier[:eventType] u
```

- **shifted**: codepoint of the key when Shift is held on the same physical key (omitted when equal to `codepoint`)
- **base**: codepoint of the physical key without any modifiers, US QWERTY layout (omitted when equal to `codepoint`)

```ts
import { InputHandler } from '@next_term/web';

const input = new InputHandler({ onData: (seq) => socket.send(seq) });

// Enable disambiguate (1) + report alternate keys (4):
input.setKittyFlags(5);
```

**Alternate key examples (flags 1+4, press event):**

| Input | Sequence | Notes |
|-------|----------|-------|
| Ctrl+a | `\x1b[97:65;5u` | main=`a`(97), shifted=`A`(65) |
| Ctrl+A (Shift+Ctrl+a) | `\x1b[65::97;6u` | main=`A`(65), shifted omitted (same), base=`a`(97) |
| Alt+1 | `\x1b[49:33;3u` | main=`1`(49), shifted=`!`(33) |
| Alt+! (Shift+Alt+1) | `\x1b[33::49;3u` | main=`!`(33), shifted omitted (same), base=`1`(49) |

Functional keys (arrows, F-keys, tilde-style) are unaffected — they use positional encoding, not Unicode codepoints, so no alternate sub-parameters are added. Flag 4 is a no-op without flag 1.

**Composing flags 2 and 4:** Both flags can be active simultaneously (`setKittyFlags(7)` — flags 1+2+4). The event type sub-parameter is appended to the modifier field, and the alternate key sub-parameters are appended to the codepoint field:

| Input | Sequence (flags 1+2+4, press) |
|-------|-------------------------------|
| Ctrl+a | `\x1b[97:65;5:1u` |
| Ctrl+A (Shift+Ctrl+a) | `\x1b[65::97;6:1u` |

## Development

```bash
pnpm install
pnpm test          # Run all tests
pnpm lint          # Lint all packages (Biome)
pnpm lint:fix      # Lint and auto-fix
pnpm typecheck     # Run TypeScript type checking
pnpm dev           # Start demo (local echo)
pnpm start         # Start demo with PTY server
```

### CI & Code Quality

The repository enforces code quality via:

- **CI workflow** (`.github/workflows/ci.yml`) — runs on every pull request and push to `main`: installs, type-checks, lints with Biome, and runs the full test suite.
- **Pre-commit hook** (`.githooks/pre-commit`) — runs `lint-staged` before every commit. Install once with `git config core.hooksPath .githooks`.
- **Biome** (`biome.json`) — opinionated formatter and linter for TypeScript/JavaScript.

### Benchmarking

Two benchmark packages measure parser and end-to-end rendering throughput:

- **`@next_term/bench`** — unit-level parser benchmarks via `vitest bench`. Includes vtebench-compatible scenarios (dense cells, light cells, Unicode, cursor motion, scrolling) for apples-to-apples comparisons with alacritty/vtebench. Run with `pnpm --filter @next_term/bench bench`.
  - Slow scroll-region scenarios (2–4 s/iteration) are exported separately as `slowScenarios` for local profiling.
- **`@next_term/e2e-bench`** — end-to-end Playwright benchmarks that drive a Vite dev server and compare react-term against xterm.js across multiple scenarios. Results are written as JSON to `packages/e2e-bench/results/`. Run with `pnpm --filter @next_term/e2e-bench bench`.

A **benchmark CI workflow** (`.github/workflows/benchmark.yml`) runs both suites in parallel and posts a throughput summary table to the GitHub Actions run page.

Recent profiling-driven optimizations (PR [#29](https://github.com/rahulpandita/react-term/pull/29)) produced measurable gains: **vte-medium-cells +43 %**, **csi-params +20 %**, **unicode +31 %**. Key changes: `clearRowRaw()` for batched dirty marking, O(H) zero-alloc `copyWithin` for `insertLines`/`deleteLines`, inlined erase cell writes, and CSI REP clamping.

PR [#77](https://github.com/rahulpandita/react-term/pull/77) introduced further parser improvements — **CSI full-sequence read-ahead** (parsing all params and dispatching inline, bypassing the state machine round-trip) and **print-batch streamlining** (running cell index, eliminated redundant per-character row-change checks, guarded post-batch dirty marking). Measured gains: **cursor-motion 1.15x faster**, **vte-cursor-motion 1.19x faster**, **csi-params 2.75x faster**, **sgr-color 1.53x faster**, **vte-dense-cells 1.85x faster**, **csi-long-params 2.95x faster**. The E2E suite shows react-term winning all 13 scenarios vs xterm.js (1.6×–30.3× faster).

### Agentic Workflows

This repository uses several automated workflows powered by GitHub Copilot's agentic CI system:

- **Daily Documentation Updater** (`.github/workflows/daily-doc-updater.md`) — runs every 24 hours, scans merged pull requests and commits, identifies user-facing changes, and automatically opens a draft PR to keep documentation up to date.
- **Agentic Wiki Writer** (`.github/workflows/agentic-wiki-writer.md`) — generates GitHub wiki pages from source code using the template defined in `.github/agentic-wiki/PAGES.md`. Triggered on PR merge or manually via workflow dispatch.
- **Daily Test Improver** (`.github/workflows/daily-test-improver.md`) — runs daily to improve test quality and coverage. Discovers untested code paths and opens draft PRs with new unit tests. Can also be triggered on-demand via a `/test-assist <instructions>` comment.
- **Daily Feature Improver** (`.github/workflows/daily-feature-improver.md`) — runs daily to incrementally implement modern terminal protocol features (OSC sequences, DCS, Kitty keyboard protocol, etc.) using a test-first approach. Maintains a feature support matrix in a pinned GitHub Issue and selects the next feature based on a dependency graph. Can also be triggered on-demand via a `/feature-assist <instructions>` comment.

## Design Decisions

- **SharedArrayBuffer from day one** — enables zero-copy sharing between workers with Atomics for lock-free dirty signaling
- **Alpha-only glyph atlas** — color applied at render time via shader multiplication (Warp/Zed pattern), avoids duplicating glyphs per color
- **Table-driven VT parser** — Paul Williams state machine with pre-computed 14x256 lookup table
- **React as coordinator** — never re-renders on terminal data, only on config changes
- **Int32Array for dirty bits** — Atomics requires >=32-bit typed arrays (learned from xterm.js gotchas)
- **Single WebGL context for multi-pane** — gl.scissor() + gl.viewport() per pane (Chrome caps at 16 contexts)
- **Watermark flow control** — HIGH=500KB/LOW=100KB prevents unbounded memory growth

## License

[MIT](LICENSE)

## References

Built on research from:
- xterm.js architecture and known issues
- ghostty-web (Coder) — WASM parser + RenderState pattern
- Alacritty — GPU glyph atlas, 2 draw calls
- Warp — alpha-only atlas, 3 sub-pixel bins, SDF rectangles
- Zutty — compute shader per-cell parallel rendering
- Zed — GPUI batched text runs
