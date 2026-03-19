# Home

*{ Write a project overview for react-term — a modern terminal emulator for React and React Native. Include a brief description, the key features (off-main-thread VT parser, WebGL2 renderer, SharedArrayBuffer, Canvas 2D fallback, React Native with Skia, multi-pane support, accessibility, addons), a quick-start code example showing the Terminal React component, and the package table from README.md showing @react-term/core, @react-term/web, @react-term/react, @react-term/native. }*

# Architecture

*{ Describe the high-level off-main-thread architecture of react-term. Cover: the three rendering strategies (Full Worker, Parser Worker, Main Thread fallback), the SharedArrayBuffer cell grid shared between the parser and render workers, how dirty row bits trigger renders, and how the main thread handles only DOM events. Include a Mermaid flowchart showing the flow from PTY/WebSocket through the Parser Worker, SharedArrayBuffer, to the Render Worker and canvas element. Reference the source at packages/core/src/cell-grid.ts and packages/web/src/web-terminal.ts. }*

## Core Package

*{ Document the @react-term/core package (packages/core/). Describe CellGrid (the SharedArrayBuffer-backed cell grid, cell packing format with 2×Uint32 per cell, dirty rows tracking, RGB color storage, cursor data), Buffer and BufferSet (scroll regions, tab stops, cursor save/restore, scrollback, alternate screen), VTParser (the VT100/ANSI state machine, including OSC sequence callbacks: clipboard access via OSC 52, indexed-colour palette set/query via OSC 4/104, working-directory reporting via OSC 7, and dynamic color query/set for foreground/background/cursor colors via OSC 10/11/12), and the exported types (CursorState, TerminalOptions, Theme, DirtyState). Include a Mermaid diagram showing the relationships between CellGrid, Buffer, BufferSet, and VTParser. Link to the source files at packages/core/src/. }*

## Web Package

*{ Document the @react-term/web package (packages/web/). Cover: WebTerminal as the main orchestrator, WorkerBridge (parser worker lifecycle, flow control with high/low watermarks, SAB vs Transferable fallback), RenderBridge (OffscreenCanvas render worker, feature detection), Canvas2DRenderer, WebGLRenderer (instanced rendering, glyph atlas, 2 draw calls per frame), InputHandler, AccessibilityManager, SharedWebGLContext (shared context for multi-pane, bypasses Chrome 16-context limit), and the addons system (SearchAddon, WebLinksAddon, FitAddon). Include a Mermaid sequence diagram showing the write data flow from WebTerminal through WorkerBridge to the parser worker and back. Link to packages/web/src/. }*

####+ Addons

*{ Document the three addons in packages/web/src/addons/: SearchAddon (regex text search, highlighted matches), WebLinksAddon (auto-detecting clickable URLs), and FitAddon (auto-sizing cols/rows to container). Show how to load and use each addon via the WebTerminal.loadAddon() API with code examples. }*

## React Package

*{ Document the @react-term/react package (packages/react/). Describe the Terminal component (all props: cols, rows, fontSize, fontFamily, theme, scrollback, onData, onResize, onTitleChange, autoFit, className, style, renderMode, renderer, useWorker) and its TerminalHandle imperative ref (write, resize, focus, blur, fit). Describe TerminalPane for multi-pane split layouts (PaneLayout tree type, horizontal/vertical splits, shared WebGL context), its TerminalPaneHandle (getTerminal, getPaneIds), and a code example for creating a 2-pane split. Link to packages/react/src/. }*

## Native Package

*{ Document the @react-term/native package (packages/native/). Cover: NativeTerminal component (touch-first input, NativeTerminalProps/NativeTerminalHandle), TerminalSurface (low-level rendering surface, TerminalSurfaceProps), GestureHandler (touch gesture recognition, GestureState enum, GestureConfig), KeyboardHandler (hardware keyboard input, KeyModifiers), SkiaRenderer (React Native Skia-based renderer, RenderCommand), and the TurboModule interface (NativeTerminalCoreSpec). Include a diagram showing how the components layer together. Link to packages/native/src/. }*

# Getting Started

*{ Write a complete getting-started guide for react-term. Cover: prerequisites (Node.js, pnpm), installation of @react-term/react and @react-term/web into an existing React project, the minimal Terminal component usage example, configuring cross-origin isolation headers required for SharedArrayBuffer (COOP/COEP), the three rendering strategies and when each is selected automatically, and how to connect to a PTY/WebSocket by handling the onData callback. Include code snippets for installation, configuration, and usage. }*

#### Prerequisites

*{ List the prerequisites for using react-term: Node.js version, pnpm for the monorepo (with the exact command), and browser requirements for SharedArrayBuffer (cross-origin isolation headers). }*

#### Installation

*{ Show how to install react-term packages using npm/yarn/pnpm. Show separate install commands for web (React) and native (React Native) usage. }*

#### Configuration

*{ Explain the COOP/COEP headers required to enable SharedArrayBuffer and full off-main-thread mode. Show example configs for Express, Vite (using vite-plugin-cross-origin-isolation or manual headers), and Next.js (next.config.js headers). }*

# Rendering

*{ Document the rendering subsystem of react-term in depth. Cover: the rendering strategy auto-detection logic (SAB + OffscreenCanvas → Full Worker; SAB only → Parser Worker + main thread WebGL2; fallback → Canvas 2D on main thread), WebGLRenderer details (instanced rendering, alpha-only glyph atlas, draw call budget), Canvas2DRenderer as the universal fallback, the OffscreenCanvas render worker via RenderBridge, SharedWebGLContext for multi-terminal sharing. Include a Mermaid flowchart showing the strategy decision tree. Reference packages/web/src/renderer.ts, packages/web/src/webgl-renderer.ts, and packages/web/src/render-bridge.ts. }*

# Accessibility

*{ Document the accessibility support in react-term. Cover: AccessibilityManager (packages/web/src/accessibility.ts) which maintains a parallel DOM with ARIA attributes, extractRowText utility, screen reader support, how the accessibility tree is kept in sync with terminal output. Include any relevant ARIA roles and attributes used. }*

# Contributing

*{ Write a contributing guide for react-term. Cover: cloning the monorepo, installing dependencies with pnpm, the package workspace structure (packages/core, packages/web, packages/react, packages/native, packages/demo), running tests (pnpm test / vitest), running the demo (pnpm dev), adding new tests, code style expectations. Describe the test layout per package and the vitest configuration. }*

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

|Home: Project overview, features, quick start, and package table
|Architecture: Off-main-thread architecture, rendering strategies, and worker design
|  Core: CellGrid, Buffer, BufferSet, VTParser — the @react-term/core package
|  Web: WebTerminal, renderers, workers, addons — the @react-term/web package
|    Web#Addons: SearchAddon, WebLinksAddon, FitAddon usage
|  React: Terminal and TerminalPane React components — the @react-term/react package
|  Native: NativeTerminal, Skia renderer, gesture/keyboard input — the @react-term/native package
|Getting-Started: Installation, cross-origin isolation, connecting to PTY/WebSocket
|  Getting-Started#Prerequisites: Node.js, pnpm, browser requirements
|  Getting-Started#Installation: npm/yarn/pnpm install commands
|  Getting-Started#Configuration: COOP/COEP headers for SharedArrayBuffer
|Rendering: WebGL2, Canvas2D, OffscreenCanvas, strategy auto-detection
|Accessibility: ARIA, parallel DOM, screen reader support
|Contributing: Monorepo setup, running tests, adding tests, code style
```

## llms.txt

You can serve this at `yoursite.com/llms.txt` or include it in your repository to help LLMs discover your documentation.

```
# react-term

> Modern terminal emulator for React and React Native — SharedArrayBuffer, Canvas 2D, WebGL2, Web Workers.

## Wiki Pages

- [Home](https://github.com/rahulpandita/react-term/wiki/Home): Project overview, features, quick start
- [Architecture](https://github.com/rahulpandita/react-term/wiki/Architecture): Off-main-thread architecture and worker design
- [Core](https://github.com/rahulpandita/react-term/wiki/Core): @react-term/core — CellGrid, Buffer, VTParser
- [Web](https://github.com/rahulpandita/react-term/wiki/Web): @react-term/web — WebTerminal, renderers, workers, addons
- [React](https://github.com/rahulpandita/react-term/wiki/React): @react-term/react — Terminal and TerminalPane components
- [Native](https://github.com/rahulpandita/react-term/wiki/Native): @react-term/native — NativeTerminal, Skia, gestures
- [Getting-Started](https://github.com/rahulpandita/react-term/wiki/Getting-Started): Installation, configuration, connecting to PTY
- [Rendering](https://github.com/rahulpandita/react-term/wiki/Rendering): WebGL2, Canvas2D, OffscreenCanvas rendering strategies
- [Accessibility](https://github.com/rahulpandita/react-term/wiki/Accessibility): ARIA, screen reader support
- [Contributing](https://github.com/rahulpandita/react-term/wiki/Contributing): Monorepo setup, tests, code style
```
