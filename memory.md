# react-term Test Improver. Tests: 984 (main). Issue #6.
Last: 2026-03-23 run 23420316881. Tasks: 2+4+7.
Cmds: npm install / node_modules/.bin/vitest run / biome check --write.
Notes: jsdom no canvas; 1-based CUP; ECH no-shift.
Mock canvas: vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx).
Parser-worker: vi.stubGlobal('postMessage',fn)+window.dispatchEvent(new MessageEvent('message',{data})).
Helpers: packages/core/src/__tests__/helpers.ts.
Open PRs: #44(WebTerminal-28tests) #48(parser-worker-19tests) #51(osc8-19tests-draft)
Backlog: 1.osc133-integration(wait for #49 merge) 2.input-handler-touch(web touch/gesture) 3.react-components(needs dep) 4.render-worker(WebGL-hard)
