# react-term Test Improver. Tests: 1003. Issue #6.
Last: 2026-03-22 run 23394867733. Tasks: 3+4+7.
Cmds: npm install / node_modules/.bin/vitest run / biome check --write.
Notes: jsdom no canvas; 1-based CUP; ECH no-shift.
Mock canvas: vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx).
Parser-worker: vi.stubGlobal('postMessage',fn)+window.dispatchEvent(new MessageEvent('message',{data})).
Helpers: packages/core/src/__tests__/helpers.ts.
Backlog: 1.react-components(needs dep) 2.perf-regression 3.render-worker(WebGL-hard)
Open PRs: #44(WebTerminal-28tests) #48(parser-worker-19tests) osc8-branch(19tests)
