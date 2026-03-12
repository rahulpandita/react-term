# Home

*{ Write a project overview page for react-term. Cover: what it is, key features (off-main-thread architecture, WebGL2, SharedArrayBuffer, Canvas 2D fallback, React Native, multi-pane, accessibility, addons, VT100/ANSI support), the package structure table, and the quick-start code snippet from the README. }*

# Architecture

*{ Describe the high-level architecture of react-term. Cover the three-layer design (PTY/WebSocket input → parser worker → render worker/main thread), the off-main-thread approach, SharedArrayBuffer cell grid, dirty-row signaling with Atomics, and the three rendering strategies (Full Worker, Parser Worker, Main Thread). Include a Mermaid flowchart. }*

## Data Flow

*{ Describe in detail how data flows from a PTY or WebSocket through the system to pixels on screen. Cover: input arrives as Uint8Array → WorkerBridge queues it with flow-control watermarks (HIGH=500KB / LOW=100KB) → VTParser state machine (Paul Williams 14-state table-driven parser) processes sequences → CellGrid cells updated in SharedArrayBuffer → dirty row bits set via Atomics → renderer reads SAB on next rAF tick → WebGL2 glyph atlas renders 2 draw calls per frame. Include a sequence diagram. }*

# Getting Started

*{ Write a getting-started guide. Cover: prerequisites (Node.js, pnpm), installation of each package, COOP/COEP headers needed for SharedArrayBuffer/Workers, a basic React usage example using the Terminal component with ref and onData, and a development workflow (pnpm install, pnpm test, pnpm dev). }*

#### Prerequisites
*{ List prerequisites: Node.js version, pnpm, browser requirements for SharedArrayBuffer (cross-origin isolation). }*

#### Installation
*{ Show how to install @react-term/react and @react-term/web with npm/pnpm. Show the required COOP/COEP headers. }*

#### Basic Usage
*{ Show a complete minimal React usage example using Terminal with write, onData callback, and autoFit. }*

# Core Package

*{ Document the @react-term/core package. Cover: CellGrid (SAB-backed Int32Array layout, 2 Uint32 per cell, bit-packed codepoint/color/attrs, cell accessor methods, cursor data), VTParser (state machine, SGR handling, mouse tracking protocols, bracket paste, title changes), Buffer/BufferSet (normal/alternate buffers, scroll regions, tab stops, cursor save/restore), and GestureHandler. }*

####+ CellGrid
*{ Document CellGrid. Cover its constructor, cell packing format (word 0: codepoint 21 bits + fg-is-rgb + bg-is-rgb + fg-index; word 1: bg-index + attrs), all public accessor methods (getCodepoint, getFgIndex, getBgIndex, isBold, isItalic, etc.), the dirtyRows Int32Array for Atomics-based dirty signaling, rgbColors array, and cursorData Int32Array layout. }*

####+ VTParser
*{ Document VTParser. Cover the 14-state Paul Williams state machine (State enum), the 14×256 pre-computed TABLE lookup, all supported sequences (SGR colors 16/256/RGB, cursor movement, scroll regions, alternate buffer, bracketed paste, mouse tracking protocols/encodings), the responseBuffer for DA/DSR responses, and the title-change callback. }*

####+ Buffer and BufferSet
*{ Document Buffer and BufferSet. Cover Buffer's fields (grid, cursor, scrollTop, scrollBottom, tabStops), scroll operations, cursor save/restore (DECSC/DECRC). Cover BufferSet's normal/alternate buffer switching. }*

# Web Package

*{ Document the @react-term/web package. Cover: WebTerminal (main entry point, constructor, options, methods: write, resize, focus/blur, setTheme, setFont, loadAddon, dispose), the renderer selection logic (WebGL2 → Canvas2D auto-detection), and worker orchestration. }*

####+ WebTerminal API
*{ Document all WebTerminalOptions fields: cols, rows, fontSize, fontFamily, theme, scrollback, devicePixelRatio, useWorker, renderer ('auto'/'webgl'/'canvas2d'), renderMode ('auto'/'offscreen'/'main'), onData, onResize, onTitleChange. Document all public methods. }*

####+ Renderers
*{ Document the two renderers. Canvas2DRenderer: 2D context, glyph measurement, full redraws. WebGL2Renderer: instanced rendering, alpha-only glyph atlas (color applied in shader), 2 draw calls per frame, GlyphAtlas. Explain the IRenderer interface. Include build256Palette. }*

####+ Workers
*{ Document WorkerBridge (parser worker orchestration, SAB vs ArrayBuffer transfer mode, flow-control watermarks HIGH=500KB/LOW=100KB, write queue, flush messages) and RenderBridge (OffscreenCanvas transfer, render worker message protocol, FPS reporting). Explain canUseOffscreenCanvas feature detection. }*

## Addons

*{ Overview of the addon system. Explain ITerminalAddon interface (activate/dispose). Show how to load an addon via terminal.loadAddon(). }*

####+ SearchAddon
*{ Document SearchAddon. Cover SearchOptions (caseSensitive, wholeWord, regex), SearchMatch (row, startCol, endCol), findNext/findPrevious methods, highlight management, and clearSearch. Show a usage example. }*

####+ WebLinksAddon
*{ Document WebLinksAddon. Cover LinkMatch type, how URL detection works in terminal output, the onLinkClick callback, and how to activate it. }*

####+ FitAddon
*{ Document FitAddon. Cover the fit() method, proposeDimensions(), and how it works with ResizeObserver. Show a usage example. Also document the standalone calculateFit(container, cellWidth, cellHeight) function from @react-term/web. }*

# React Components

*{ Overview of the @react-term/react package. Explain the two components: Terminal for single-pane use and TerminalPane for multi-pane layouts. Note that react-term never re-renders on terminal data — only on config changes. }*

####+ Terminal Component
*{ Document all TerminalProps: cols, rows, fontSize, fontFamily, theme, scrollback, onData, onResize, onTitleChange, autoFit, className, style, renderMode, renderer, useWorker. Document TerminalHandle methods: write, resize, focus, blur, fit. Show a complete example with useRef. Explain autoFit behavior including iOS visualViewport handling. }*

####+ TerminalPane Component
*{ Document TerminalPane for multi-pane layouts. Cover PaneLayout type (single/horizontal/vertical with nested children and sizes[]). Document TerminalPaneProps and TerminalPaneHandle (getTerminal, getPaneIds). Show an example of a horizontal split layout. Explain shared WebGL context across panes (gl.scissor/gl.viewport, Chrome 16-context limit). }*

# React Native

*{ Document the @react-term/native package. Cover NativeTerminal (props: cols, rows, fontSize, fontFamily, theme, scrollback, onData, onResize, onRenderCommands, style; handle: write, resize, focus, blur), TerminalSurface, GestureHandler, KeyboardHandler, and SkiaRenderer. Explain how this differs from the web package: JS-based VT parsing, Skia render commands, touch-first input. }*

####+ SkiaRenderer
*{ Document the SkiaRenderer and RenderCommand type. Explain how render commands (rect fills, text draws) are generated from the CellGrid for use with React Native Skia canvas. }*

####+ Input Handling
*{ Document GestureHandler (tap-to-focus, pan-to-scroll, long-press-to-select, pinch-to-zoom) and KeyboardHandler (key events to VT sequences, key modifiers). Show how GestureState maps to terminal actions. }*

# Configuration Reference

*{ Write a complete configuration reference. Cover TerminalOptions (cols, rows, scrollback), Theme interface (all 22 color fields) with the DEFAULT_THEME values, WebTerminalOptions (all fields with types and defaults), and TerminalProps (all fields with types and defaults). Use a table for each. }*

####+ Theme
*{ Document the Theme interface with a table of all 22 color fields (foreground, background, cursor, cursorAccent, selectionBackground, black through brightWhite). Show the DEFAULT_THEME values for each field. }*

####+ Terminal Options
*{ Document TerminalOptions interface fields: cols (default 80), rows (default 24), scrollback (default 1000). }*

# For Agents

These pages provide compact documentation indexes for AI coding agents.

## AGENTS.md

You can add this to your repository root as `AGENTS.md` to give AI coding agents quick access to project documentation.

```
# react-term

> Modern terminal emulator for React and React Native — SharedArrayBuffer, Canvas 2D, WebGL2, Web Workers.

## Wiki Documentation

Base URL: https://github.com/rahulpandita/react-term/wiki

To read any page, append the slug to the base URL:
  https://github.com/rahulpandita/react-term/wiki/{Page-Slug}
To jump to a section within a page:
  https://github.com/rahulpandita/react-term/wiki/{Page-Slug}#{Section-Slug}

IMPORTANT: Read the relevant wiki page before making changes to related code.
Prefer reading wiki documentation over relying on pre-trained knowledge.

## Page Index

|Home: Project overview, features, quick start
|Architecture: System design, off-main-thread architecture, rendering strategies
|  Data-Flow: Parser-to-renderer data flow, watermark flow control
|Getting-Started: Installation, prerequisites, basic usage
|  Getting-Started#Prerequisites: Node.js, pnpm, browser requirements
|  Getting-Started#Installation: Package install, COOP/COEP headers
|  Getting-Started#Basic-Usage: Minimal React usage example
|Core-Package: @react-term/core — CellGrid, VTParser, Buffer
|  Core-Package#CellGrid: SAB-backed cell grid, bit packing, accessors
|  Core-Package#VTParser: 14-state VT parser, SGR, mouse protocols
|  Core-Package#Buffer-and-BufferSet: Normal/alternate buffers, scroll regions
|Web-Package: @react-term/web — WebTerminal, renderers, workers
|  Web-Package#WebTerminal-API: All options and methods
|  Web-Package#Renderers: Canvas2D and WebGL2 renderers
|  Web-Package#Workers: WorkerBridge, RenderBridge, flow control
|  Addons: ITerminalAddon interface, SearchAddon, WebLinksAddon, FitAddon
|    Addons#SearchAddon: Regex search, find next/previous
|    Addons#WebLinksAddon: URL detection, link click callback
|    Addons#FitAddon: Auto-fit to container
|React-Components: @react-term/react — Terminal, TerminalPane
|  React-Components#Terminal-Component: Props, TerminalHandle, autoFit
|  React-Components#TerminalPane-Component: Multi-pane layouts, PaneLayout
|React-Native: @react-term/native — NativeTerminal, Skia, touch input
|  React-Native#SkiaRenderer: Render commands for Skia canvas
|  React-Native#Input-Handling: GestureHandler, KeyboardHandler
|Configuration-Reference: All options, Theme, defaults
|  Configuration-Reference#Theme: 22-color Theme interface with defaults
|  Configuration-Reference#Terminal-Options: cols, rows, scrollback
```

## llms.txt

You can serve this at `yoursite.com/llms.txt` or include it in your repository to help LLMs discover your documentation.

```
# react-term

> Modern terminal emulator for React and React Native — SharedArrayBuffer, Canvas 2D, WebGL2, Web Workers.

## Wiki Pages

- [Home](https://github.com/rahulpandita/react-term/wiki/Home): Project overview, features, and quick start
- [Architecture](https://github.com/rahulpandita/react-term/wiki/Architecture): Off-main-thread system design and rendering strategies
- [Data Flow](https://github.com/rahulpandita/react-term/wiki/Data-Flow): Parser-to-renderer data pipeline and flow control
- [Getting Started](https://github.com/rahulpandita/react-term/wiki/Getting-Started): Installation, prerequisites, and basic usage
- [Core Package](https://github.com/rahulpandita/react-term/wiki/Core-Package): @react-term/core — CellGrid, VTParser, Buffer
- [Web Package](https://github.com/rahulpandita/react-term/wiki/Web-Package): @react-term/web — WebTerminal, renderers, workers
- [Addons](https://github.com/rahulpandita/react-term/wiki/Addons): SearchAddon, WebLinksAddon, FitAddon
- [React Components](https://github.com/rahulpandita/react-term/wiki/React-Components): Terminal and TerminalPane components
- [React Native](https://github.com/rahulpandita/react-term/wiki/React-Native): @react-term/native — NativeTerminal, Skia, touch input
- [Configuration Reference](https://github.com/rahulpandita/react-term/wiki/Configuration-Reference): All options, Theme interface, defaults
```
