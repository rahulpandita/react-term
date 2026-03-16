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
- **Full VT100/ANSI** — SGR (16/256/RGB colors, bold, italic, underline, inverse), cursor control, scroll regions, alternate buffer

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
| `@react-term/core` | Cell grid, VT parser, buffer management | 2.1K | 4.9K | 7.1K |
| `@react-term/web` | Canvas 2D, WebGL2, workers, addons | 6.7K | 2.4K | 9.1K |
| `@react-term/react` | React component, multi-pane layout | 445 | 8 | 453 |
| `@react-term/native` | React Native, gesture/keyboard, Skia | 979 | 872 | 1.9K |
| **Total** | | **10.2K** | **8.2K+** | **18.5K+** |

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

### Agentic Workflows

This repository uses several automated workflows powered by GitHub Copilot's agentic CI system:

- **Daily Documentation Updater** (`.github/workflows/daily-doc-updater.md`) — runs every 24 hours, scans merged pull requests and commits, identifies user-facing changes, and automatically opens a draft PR to keep documentation up to date.
- **Agentic Wiki Writer** (`.github/workflows/agentic-wiki-writer.md`) — generates GitHub wiki pages from source code using the template defined in `.github/agentic-wiki/PAGES.md`. Triggered on PR merge or manually via workflow dispatch.
- **Daily Test Improver** (`.github/workflows/daily-test-improver.md`) — runs daily to improve test quality and coverage. Discovers untested code paths and opens draft PRs with new unit tests. Can also be triggered on-demand via a `/test-assist <instructions>` comment.

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
