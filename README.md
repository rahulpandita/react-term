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
- **OSC 10/11/12** — dynamic foreground/background/cursor color query/set via `setOsc10Callback`, `setOsc11Callback`, `setOsc12Callback`
- **OSC 104** — reset indexed color palette entries via `setOsc104Callback`

## Quick Start

```tsx
import { Terminal } from '@react-term/react';

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
| `@react-term/core` | Cell grid, VT parser, buffer management | 2.7K | 6.7K | 9.4K |
| `@react-term/web` | Canvas 2D, WebGL2, workers, addons | 6.8K | 2.9K | 9.7K |
| `@react-term/react` | React component, multi-pane layout | 451 | 106 | 557 |
| `@react-term/native` | React Native, gesture/keyboard, Skia | 1.0K | 944 | 2.0K |
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
import { SearchAddon, WebLinksAddon, FitAddon } from '@react-term/web';

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
import { TerminalPane } from '@react-term/react';

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

`collectPaneIds` is exported as a public helper from `@react-term/react`. It performs a depth-first traversal of a `PaneLayout` tree and returns all leaf pane IDs in order. Useful when you need the full set of pane IDs to initialize connections or manage state outside of the component.

```ts
import { collectPaneIds } from '@react-term/react';
import type { PaneLayout } from '@react-term/react';

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

`VTParser` (from `@react-term/core`) exposes hooks for terminal protocol extensions:

### OSC 52 — Clipboard

```ts
import { VTParser } from '@react-term/core';

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

### OSC 10 / 11 / 12 — Dynamic Colors

```ts
// OSC 10 — foreground (text) color
parser.setOsc10Callback((spec: string | null) => {
  if (spec === null) {
    // Query: respond with current foreground color in XParseColor format
    // e.g. send "\x1b]10;rgb:ffff/ffff/ffff\x07"
  } else {
    // Set: apply color spec (e.g. 'rgb:ff00/0000/0000', '#ff0000', 'red')
    setForegroundColor(spec);
  }
});

// OSC 11 — background color
parser.setOsc11Callback((spec: string | null) => {
  if (spec === null) {
    // Query: respond with current background color
  } else {
    setBackgroundColor(spec);
  }
});

// OSC 12 — cursor color
parser.setOsc12Callback((spec: string | null) => {
  if (spec === null) {
    // Query: respond with current cursor color
  } else {
    setCursorColor(spec);
  }
});
```

`spec` is the X11 color specification string (e.g. `'rgb:ff00/0000/0000'`, `'#ff0000'`) for a set operation, or `null` when the terminal application sends `?` to query the current value. When responding to a query, emit `OSC <code> ; <spec> BEL` back to the PTY.

Protocol sequences:
```
OSC 10 ; <spec-or-?> BEL   (e.g. \x1b]10;rgb:ffff/ffff/ffff\x07)
OSC 11 ; <spec-or-?> BEL   (e.g. \x1b]11;?\x07)
OSC 12 ; <spec-or-?> BEL   (e.g. \x1b]12;#ff0000\x07)
```

### OSC 104 — Reset Color Palette

```ts
parser.setOsc104Callback((index: number) => {
  if (index === -1) {
    // Reset all 256 palette entries to their defaults
    resetEntirePalette();
  } else {
    // Reset a specific palette entry (0–255) to its default
    resetPaletteEntry(index);
  }
});
```

`index` is `-1` when no argument is given (reset the entire palette), or `0`–`255` for a specific entry. The callback is invoked once per index when multiple indices are specified in a single sequence. This is the counterpart to `setOsc4Callback`: terminal applications typically set palette entries via OSC 4 and restore them via OSC 104 on exit.

Protocol sequences:
```
OSC 104 BEL                    — reset entire palette (\x1b]104\x07)
OSC 104 ; <c1> ; <c2> BEL     — reset entries c1, c2, … (\x1b]104;1;3;7\x07)
```

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

- **`@react-term/bench`** — unit-level parser benchmarks via `vitest bench`. Includes vtebench-compatible scenarios (dense cells, light cells, Unicode, cursor motion, scrolling) for apples-to-apples comparisons with alacritty/vtebench. Run with `pnpm --filter @react-term/bench bench`.
  - Slow scroll-region scenarios (2–4 s/iteration) are exported separately as `slowScenarios` for local profiling.
- **`@react-term/e2e-bench`** — end-to-end Playwright benchmarks that drive a Vite dev server and compare react-term against xterm.js across multiple scenarios. Results are written as JSON to `packages/e2e-bench/results/`. Run with `pnpm --filter @react-term/e2e-bench bench`.

A **benchmark CI workflow** (`.github/workflows/benchmark.yml`) runs both suites in parallel and posts a throughput summary table to the GitHub Actions run page.

Recent profiling-driven optimizations (PR [#29](https://github.com/rahulpandita/react-term/pull/29)) produced measurable gains: **vte-medium-cells +43 %**, **csi-params +20 %**, **unicode +31 %**. Key changes: `clearRowRaw()` for batched dirty marking, O(H) zero-alloc `copyWithin` for `insertLines`/`deleteLines`, inlined erase cell writes, and CSI REP clamping.

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
