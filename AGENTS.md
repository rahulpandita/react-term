You can add this to your repository root as `AGENTS.md` to give AI coding agents quick access to project documentation.

````
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
|Architecture: Off-main-thread architecture, SAB cell grid, worker lifecycle
|  Core-Package: CellGrid, Buffer, BufferSet, VTParser — `@react-term/core`
|  Web-Package: WebTerminal, workers, renderers, addons — `@react-term/web`
|    Web-Package#Addons: SearchAddon, WebLinksAddon, FitAddon usage
|  React-Package: Terminal and TerminalPane components — `@react-term/react`
|  Native-Package: NativeTerminal, Skia renderer, gestures, keyboard — `@react-term/native`
|Getting-Started: Installation, cross-origin isolation, connecting to PTY/WebSocket
|Rendering: WebGL2, Canvas2D, OffscreenCanvas, strategy auto-detection
|Accessibility: ARIA parallel DOM, screen reader support, throttled updates
|Contributing: Monorepo setup, pnpm scripts, tests, Biome, CI pipeline
````

