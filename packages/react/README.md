# @next_term/react

React components for the react-term terminal emulator.

## Install

```bash
npm install @next_term/react @next_term/core @next_term/web
```

## Basic Usage

```tsx
import { Terminal } from "@next_term/react";
import type { TerminalHandle } from "@next_term/react";
import { useEffect, useRef } from "react";

function App() {
  const termRef = useRef<TerminalHandle>(null);

  // Write PTY/WebSocket data to the terminal
  useEffect(() => {
    const ws = new WebSocket("ws://localhost:8080");
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => termRef.current?.write(new Uint8Array(e.data));
    return () => ws.close();
  }, []);

  return (
    <Terminal
      ref={termRef}
      autoFit
      fontSize={14}
      fontFamily="monospace"
      onData={(data) => {
        // User typed something — send to your backend
        ws.send(data);
      }}
      onResize={({ cols, rows }) => {
        // Terminal was resized — notify PTY
        ws.send(`\x1b[8;${rows};${cols}t`);
      }}
    />
  );
}
```

## Multi-Pane Layout

`<TerminalPane>` manages multiple terminals in a split layout with a single shared WebGL context (avoids Chrome's 16-context limit).

```tsx
import { TerminalPane } from "@next_term/react";
import type { TerminalPaneHandle, PaneLayout } from "@next_term/react";

const layout: PaneLayout = {
  type: "horizontal",
  children: [
    { type: "single", id: "editor" },
    {
      type: "vertical",
      children: [
        { type: "single", id: "terminal" },
        { type: "single", id: "logs" },
      ],
      sizes: [0.6, 0.4],
    },
  ],
  sizes: [0.5, 0.5],
};

function IDE() {
  const paneRef = useRef<TerminalPaneHandle>(null);

  return (
    <TerminalPane
      ref={paneRef}
      layout={layout}
      fontSize={13}
      fontFamily="monospace"
      onData={(paneId, data) => {
        connections.get(paneId)?.send(data);
      }}
      style={{ width: "100%", height: "100vh" }}
    />
  );
}

// Write to a specific pane
paneRef.current?.getTerminal("logs")?.write("Build complete.\r\n");
```

## Props

### `<Terminal>`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `cols` | `number` | `80` | Initial column count |
| `rows` | `number` | `24` | Initial row count |
| `fontSize` | `number` | `16` | Font size in pixels |
| `fontFamily` | `string` | `"'Courier New', monospace"` | CSS font-family |
| `fontWeight` | `number` | `400` | Normal text weight |
| `fontWeightBold` | `number` | `700` | Bold text weight |
| `theme` | `Partial<Theme>` | Dark theme | Terminal colors |
| `scrollback` | `number` | `1000` | Scrollback buffer lines |
| `autoFit` | `boolean` | `false` | Auto-resize to container |
| `renderer` | `"auto" \| "webgl" \| "canvas2d"` | `"auto"` | Rendering backend |
| `renderMode` | `"auto" \| "offscreen" \| "main"` | `"auto"` | Where rendering runs |
| `useWorker` | `boolean` | auto | VT parser in Web Worker |
| `sharedContext` | `SharedWebGLContext` | -- | Shared WebGL context for multi-pane |
| `paneId` | `string` | -- | Pane ID (required with sharedContext or parserPool) |
| `parserPool` | `ParserPool` | -- | Shared parser worker pool (managed automatically by TerminalPane) |
| `onData` | `(data: Uint8Array) => void` | -- | User input callback |
| `onResize` | `(size) => void` | -- | Resize callback |
| `onTitleChange` | `(title: string) => void` | -- | OSC title change |
| `className` | `string` | -- | CSS class on container |
| `style` | `React.CSSProperties` | -- | Inline styles on container |

### `<TerminalPane>`

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `layout` | `PaneLayout` | — | Split layout tree |
| `onData` | `(paneId, data) => void` | — | Input from any pane |
| `fontSize` | `number` | — | Shared font size |
| `fontFamily` | `string` | — | Shared font family |
| `fontWeight` | `number` | — | Shared normal text weight |
| `fontWeightBold` | `number` | — | Shared bold text weight |
| `theme` | `Partial<Theme>` | — | Shared theme |
| `useWorker` | `boolean` | auto | Enable/disable the parser worker pool. `false` or `parserWorkers={0}` disables workers entirely. |
| `parserWorkers` | `number` | `DEFAULT_PARSER_WORKER_COUNT` | Number of shared parser workers in the pool (default: `min(hardwareConcurrency, 4)`). Set to `0` to disable. |
| `className` | `string` | — | CSS class on root container |
| `style` | `React.CSSProperties` | — | Inline styles on root container |

### `TerminalPaneHandle`

```ts
interface TerminalPaneHandle {
  getTerminal(paneId: string): TerminalHandle | null;
  getPaneIds(): string[];
}
```

### `TerminalHandle`

```ts
interface TerminalHandle {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  blur(): void;
  fit(): void;
  // Save / restore — see "Save and restore" below.
  serialize?(): TerminalState;
  hydrate?(state: TerminalState): void;
  getParserModes?(): ParserModeState;
  setParserModes?(modes: ParserModeState): void;
}
```

## Save and restore

`<Terminal>` can capture its current state (grid contents, cursor, scrollback,
active buffer, parser modes) and restore it onto a freshly-mounted instance.
Use this when you reparent the terminal across a layout change (tabs, splits,
dialog open/close) and want to avoid a blank flash.

### Quick start

```tsx
import { Terminal } from "@next_term/react";
import type { TerminalHandle, TerminalState } from "@next_term/react";
import { useRef, useState } from "react";

function Saveable() {
  const ref = useRef<TerminalHandle>(null);
  const [snapshot, setSnapshot] = useState<TerminalState>();

  return (
    <>
      <button onClick={() => setSnapshot(ref.current?.serialize?.())}>Save</button>
      {snapshot && (
        // Remount with `initialState`. The first paint shows the restored
        // grid — no blank-then-fill flash.
        <Terminal ref={ref} cols={80} rows={24} initialState={snapshot} />
      )}
    </>
  );
}
```

### Two ways in

| API | When |
|---|---|
| `initialState` prop on `<Terminal>` | First mount. Applied **before** the render loop or parser worker starts — guarantees a blank frame is never shown. |
| `hydrate(state)` imperative method | Already-mounted terminal. Useful for "undo" / "switch session" / live restore. Routes through the parser worker so in-flight writes are preserved (FIFO). |

### Dimensions must match

`hydrate()` no-ops with a `console.warn` if `state.cols`/`state.rows` differ
from the live terminal. Either resize the terminal first or capture a fresh
snapshot at the new size.

### Worker-mode caveat

In worker mode (the default when `crossOriginIsolated` is true) the parser
worker owns the scrollback. The snapshot's `scrollback` field will be empty;
restoring still recovers the active grid and cursor. If you need server-side
replay of scrollback, drive it through `write()` after hydrate.

### Snapshot shape

```ts
interface TerminalState {
  version: 1;                       // bumped on schema break
  cols: number;
  rows: number;
  cells: Uint32Array;               // active grid, 4 × u32 per cell
  wrapFlags: Int32Array;            // 1 per row (soft-wrap flag)
  cursor: { row, col, visible, style };
  scrollback: { rows, wrap, compact };
  parserModes: ParserModeState;     // app-cursor, bracketed paste, mouse, etc.
  isAlternate: boolean;             // alt buffer flag (vim/htop etc.)
}
```

Treat as opaque: pass it from `serialize()` to `hydrate()` / `initialState`
without inspecting it. To persist across reloads, convert the typed arrays to
plain arrays before `JSON.stringify` (see the demo for a reference helper).

## Best Practices

### Font Configuration

Use generic families or system-installed fonts. Web fonts loaded via `@font-face` are loaded automatically via the CSS Font Loading API, but may cause a brief flash of fallback text (FOUT) on first render:

```tsx
// Good: generic family, always available
<Terminal fontFamily="monospace" />

// Good: system font with generic fallback
<Terminal fontFamily="'Menlo', 'Consolas', monospace" />

// Works: web font — loaded async, brief FOUT on first render
<Terminal fontFamily="'Fira Code', monospace" />
```

### COOP/COEP Headers for Worker Support

SharedArrayBuffer (required for Web Worker parsing) needs cross-origin isolation. Without these headers, the terminal falls back to main-thread parsing automatically:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Theme

```tsx
import { DEFAULT_THEME } from "@next_term/core";

// Override specific colors
<Terminal theme={{ background: "#1a1b26", foreground: "#c0caf5" }} />
```

All CSS color formats are supported: `#rgb`, `#rrggbb`, `rgb()`, `hsl()`, `oklch()`, named colors.

## License

MIT
