# @next_term/web

Core web engine for react-term. Use this package directly when you need full control without React, or when building framework-agnostic integrations.

## Install

```bash
npm install @next_term/web @next_term/core
```

## Basic Usage

```ts
import { WebTerminal } from "@next_term/web";

const container = document.getElementById("terminal")!;

const terminal = new WebTerminal(container, {
  cols: 120,
  rows: 36,
  fontSize: 14,
  fontFamily: "monospace",
  scrollback: 5000,
  onData: (data) => ws.send(data),
  onResize: ({ cols, rows }) => ws.send(`\x1b[8;${rows};${cols}t`),
});

// Write data from your backend
ws.onmessage = (e) => terminal.write(new Uint8Array(e.data));

// Fit to container
terminal.fit();

// Clean up
terminal.dispose();
```

## Multi-Pane with Shared Parser Worker Pool

For 9+ pane layouts, use a `ParserPool` to share a small pool of parser workers instead of spawning one per pane. The pool avoids thread oversubscription and reduces `postMessage` overhead.

```ts
import { WebTerminal, SharedWebGLContext, ParserPool } from "@next_term/web";

// Create a pool (default: min(hardwareConcurrency, 4) workers)
const parserPool = new ParserPool();

// Each terminal acquires its own channel from the pool
const term1 = new WebTerminal(pane1, {
  sharedContext: sharedCtx,
  paneId: "pane-1",
  parserPool,
});

const term2 = new WebTerminal(pane2, {
  sharedContext: sharedCtx,
  paneId: "pane-2",
  parserPool,
});

// Clean up
term1.dispose();
term2.dispose();
parserPool.dispose();
```

> **Note**: When using `<TerminalPane>`, the parser pool is created and managed automatically. The `parserWorkers` prop controls pool size (default: `min(hardwareConcurrency, 4)`).

## Multi-Pane with SharedWebGLContext

For multiple terminals on one page, use `SharedWebGLContext` to share a single WebGL context. This avoids Chrome's 16-context limit and is more GPU-efficient.

```ts
import { WebTerminal, SharedWebGLContext } from "@next_term/web";

// 1. Create the shared context
const sharedCtx = new SharedWebGLContext({
  fontSize: 13,
  fontFamily: "monospace",
  theme: { background: "#1e1e2e", foreground: "#cdd6f4" },
});

// 2. Add the shared canvas as an overlay on your container
const overlay = sharedCtx.getCanvas();
overlay.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1";
container.style.position = "relative";
container.appendChild(overlay);

// 3. Initialize the GL context (must be after canvas is in the DOM)
sharedCtx.init();

// 4. Create terminals with the shared context
const term1 = new WebTerminal(pane1, {
  fontSize: 13,
  fontFamily: "monospace",
  sharedContext: sharedCtx,
  paneId: "pane-1",
  useWorker: true,
});

const term2 = new WebTerminal(pane2, {
  fontSize: 13,
  fontFamily: "monospace",
  sharedContext: sharedCtx,
  paneId: "pane-2",
  useWorker: true,
});

// 5. Set viewport positions (CSS pixels, not device pixels)
//    SharedWebGLContext multiplies by devicePixelRatio internally
const containerRect = container.getBoundingClientRect();
const pane1Rect = pane1.getBoundingClientRect();
sharedCtx.setViewport(
  "pane-1",
  pane1Rect.left - containerRect.left,  // CSS pixels
  pane1Rect.top - containerRect.top,    // CSS pixels
  pane1Rect.width,                       // CSS pixels
  pane1Rect.height,                      // CSS pixels
);

// 6. Sync canvas size and start the single render loop
sharedCtx.syncCanvasSize(containerRect.width, containerRect.height);
sharedCtx.startRenderLoop();
```

## Addons

```ts
import { FitAddon, SearchAddon, WebLinksAddon } from "@next_term/web";

// Fit terminal to container
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
fitAddon.fit();

// Search
const searchAddon = new SearchAddon();
terminal.loadAddon(searchAddon);
searchAddon.findNext("error", { caseSensitive: false, regex: true });

// Clickable URLs
const webLinksAddon = new WebLinksAddon();
terminal.loadAddon(webLinksAddon);
```

## Configuration Guide

### Renderer Selection

| Value | Behavior |
|-------|----------|
| `"auto"` (default) | WebGL2 if available and not software-rendered, else Canvas2D |
| `"webgl"` | Force WebGL2 (throws if unavailable) |
| `"canvas2d"` | Force Canvas2D |

Auto-detection excludes software renderers (SwiftShader, llvmpipe) where Canvas2D is faster.

### Render Mode

Controls where **rendering** happens (independent of `useWorker` which controls parsing):

| Value | Rendering | Best for |
|-------|-----------|----------|
| `"auto"` (default) | OffscreenCanvas worker if SAB + OffscreenCanvas available, else main thread | Production |
| `"main"` | Main thread | Debugging, Playwright screenshots |
| `"offscreen"` | OffscreenCanvas worker (throws if unavailable) | Guaranteed off-thread rendering |

### Worker Mode

| `useWorker` | Behavior |
|-------------|----------|
| `true` | VT parser runs in Web Worker via SharedArrayBuffer |
| `false` | VT parser runs on main thread |
| `undefined` (default) | Auto: uses worker when SharedArrayBuffer is available |

## Best Practices

### SharedWebGLContext Viewport Coordinates

`setViewport()` expects **CSS pixels**. The context handles devicePixelRatio multiplication internally. Passing device pixels will result in incorrect positioning.

```ts
// Correct
sharedCtx.setViewport(id, rect.left - parent.left, rect.top - parent.top, rect.width, rect.height);

// Wrong -- double-scaled on HiDPI
sharedCtx.setViewport(id, x * dpr, y * dpr, w * dpr, h * dpr);
```

### Web Font Loading

The terminal automatically loads web fonts declared via `@font-face` using the CSS Font Loading API. The first render may use a fallback font, then re-renders once the web font loads (FOUT behavior).

- Always include a generic fallback: `"'Fira Code', monospace"`
- Generic families (`monospace`, `serif`, `sans-serif`, `system-ui`, `ui-monospace`) are never loaded -- they're always available
- If a font fails to load, the terminal continues with the fallback

### Color Formats

`theme` colors accept any CSS color format:

```ts
const theme = {
  background: "#1e1e2e",           // hex
  foreground: "rgb(205, 214, 244)",// rgb()
  cursor: "oklch(0.8 0.1 330)",    // oklch()
  red: "salmon",                    // named
};
```

### Resize Clamping

`WebTerminal` clamps dimensions to 500 columns x 500 rows. Requests above this are silently clamped. The `onResize` callback fires with the clamped values.

### Cleanup

Always call `dispose()` when removing a terminal:

```ts
terminal.dispose();
// For shared context:
sharedCtx.stopRenderLoop();
sharedCtx.dispose();
```

## Key Exports

```ts
// Terminal
export { WebTerminal, SharedWebGLContext } from "@next_term/web";
export type { WebTerminalOptions } from "@next_term/web";

// Parser Worker Pool
export { ParserPool, ParserChannel, DEFAULT_PARSER_WORKER_COUNT } from "@next_term/web";

// Renderers
export { Canvas2DRenderer, WebGLRenderer, createRenderer } from "@next_term/web";
export type { IRenderer, RendererOptions } from "@next_term/web";

// Addons
export { FitAddon, SearchAddon, WebLinksAddon } from "@next_term/web";

// Utilities
export { calculateFit, InputHandler, WorkerBridge, RenderBridge } from "@next_term/web";
export { AccessibilityManager, GlyphAtlas, hexToFloat4 } from "@next_term/web";

// Re-exported from @next_term/core
export type { Theme, CursorState, TerminalOptions } from "@next_term/web";
export { DEFAULT_THEME, CellGrid } from "@next_term/web";
```

See the full export list in [src/index.ts](src/index.ts).

## License

MIT
