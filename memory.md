# react-term Test Improver. Tests: 993. Issue #6.
Last: 2026-03-21 run 23371016626. Tasks: 3+7.
Cmds: npm install / node_modules/.bin/vitest run / biome check --write.
Notes: jsdom no canvas; 1-based CUP; ECH no-shift.
Mock canvas: vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx).
Parser-worker: vi.stubGlobal('postMessage',fn)+window.dispatchEvent(new MessageEvent('message',{data})).
Helpers: packages/core/src/__tests__/helpers.ts.
Backlog: 1.react-components(needs dep) 2.perf-regression 3.task5-comments
