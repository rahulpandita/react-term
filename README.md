# react-term

A modern terminal emulator for React and React Native, built from the ground up with Web Workers, SharedArrayBuffer, and WebGL2.

## Features

- **Off-main-thread parsing** — VT parser in a Web Worker, rendering on OffscreenCanvas
- **WebGL2 renderer** — instanced rendering with alpha-only glyph atlas
- **SharedArrayBuffer** — zero-copy cell grid shared between workers
- **Canvas 2D fallback** — automatic degradation when WebGL2/SAB unavailable
- **React Native** — touch input, Skia renderer, TurboModule-ready
- **Multi-pane** — single shared WebGL context (bypasses Chrome's 16-context limit)
- **Accessibility** — parallel DOM with ARIA attributes, screen reader support
- **Addons** — search (regex), web links, fit
- **Full VT100/ANSI** — SGR (16/256/RGB), cursor control, scroll regions, alternate buffer
- **OSC sequences** — clipboard (52), palette (4/104), hyperlinks (8), CWD (7), dynamic colors (10/11/12), shell integration (133)
- **DCS** — device control strings, tmux passthrough
- **Kitty keyboard protocol** — disambiguate, event types, alternate keys, push/pop stack
- **Bracketed paste** — injection-safe marker stripping
- **Synchronized output** — DEC mode 2026 render gating

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

react-term auto-detects the best rendering strategy:

1. **Full Worker** — Parser + OffscreenCanvas render worker (requires SAB + OffscreenCanvas)
2. **Parser Worker** — Parser in worker, WebGL2 on main thread (requires SAB)
3. **Main Thread** — Canvas 2D fallback (works everywhere)

## Addons

```tsx
import { SearchAddon, WebLinksAddon, FitAddon } from '@next_term/web';

const searchAddon = new SearchAddon();
terminal.loadAddon(searchAddon);
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

## Development

```bash
pnpm install
pnpm test          # Run all tests
pnpm lint          # Lint all packages (Biome)
pnpm typecheck     # TypeScript type checking
pnpm dev           # Start demo (local echo)
pnpm start         # Start demo with PTY server

# Set up pre-commit hooks (one-time)
git config core.hooksPath .githooks
```

### Benchmarks

```bash
pnpm --filter @next_term/bench bench       # Parser benchmarks
pnpm --filter @next_term/e2e-bench bench   # E2E benchmarks (vs xterm.js)
```

#### Benchmark Metrics

E2E benchmarks report four frame-timing metrics (all in ms, lower is better):

| Metric | Field | Meaning |
|--------|-------|---------|
| **Frame Time p50** | `frameTimeP50` | Median frame interval — measures smoothness during streaming |
| **Frame Time p90** | `frameTimeP90` | 90th-percentile frame interval — early jank indicator |
| **Frame Time p99** | `frameTimeP99` | 99th-percentile frame interval — worst-case jank indicator |
| **Time to Idle** | `timeToIdleMs` | Time from the last data byte to render idle — measures perceived latency |

> **Why not FPS?** rAF-based FPS penalizes terminals for *correctly* batching renders during bulk
> streaming. Native terminals (Alacritty, Kitty, Ghostty) all produce fewer frames during high
> throughput, which is the expected behavior. Frame time percentiles measure smoothness directly
> without this bias.

The multi-pane stress test runs configurations with **2, 4, 8, 16, and 32 panes** simultaneously.

#### Benchmark Modes

| Mode | URL param | Description |
|------|-----------|-------------|
| **Single** | `?mode=single` | One terminal vs xterm.js — throughput, frame time, idle latency |
| **Multi-pane** | `?mode=multi-pane` | N terminals sharing one WebGL context — scales from 2 to 32 panes |
| **Mux** | `?mode=mux` | Single WebSocket delivers interleaved data for N panes — simulates a terminal multiplexer (tmux/screen) |

#### Resize Cap

`WebTerminal` silently clamps dimensions to **500 columns × 500 rows** (`MAX_COLS` / `MAX_ROWS`). Requests above this limit are clamped and the `onResize` callback fires with the clamped values.

## Documentation

- [API Reference](docs/api.md) — VTParser callbacks, Kitty keyboard protocol, DCS handlers

## Design Decisions

- **SharedArrayBuffer from day one** — zero-copy sharing between workers with Atomics for lock-free dirty signaling
- **Alpha-only glyph atlas** — color applied at render time via shader multiplication
- **Table-driven VT parser** — Paul Williams state machine with pre-computed 14x256 lookup table
- **React as coordinator** — never re-renders on terminal data, only on config changes
- **Int32Array for dirty bits** — Atomics requires >=32-bit typed arrays
- **Single WebGL context for multi-pane** — gl.scissor() per pane (Chrome caps at 16 contexts)

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
