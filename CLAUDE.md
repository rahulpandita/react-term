# CLAUDE.md

## Project
react-term — Modern terminal emulator for React/React Native

## Structure
- `packages/core/` — Cell grid (SAB), VT parser, buffer management
- `packages/web/` — Renderers (Canvas2D, WebGL2), workers, addons
- `packages/react/` — React components (<Terminal>, <TerminalPane>)
- `packages/native/` — React Native components, gesture/keyboard handlers
- `packages/demo/` — Demo app with local echo + PTY server

## Commands
- `pnpm test` — Run all tests (vitest)
- `pnpm --filter @next_term/demo dev` — Start demo
- `pnpm --filter @next_term/demo start` — Start demo + PTY server

## Key patterns
- Cell data: 2 x Uint32 per cell, bit-packed (see core/src/cell-grid.ts)
- Dirty tracking: Int32Array with Atomics (NOT Uint8Array — Atomics requires >=32-bit)
- Default fg=7 (white), default bg=0 (black) — always set in clear/erase operations
- SAB feature detection: `typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated`
- Worker instantiation: `new Worker(new URL('./file.js', import.meta.url), { type: 'module' })`
- Demo Vite config has COOP/COEP headers for SAB support

## Testing
- vitest with jsdom for DOM tests
- Mock Worker/WebGL in tests (no real canvas in test environment)
- All packages share root vitest.config.ts with path aliases
