# react-term Test Improver. Tests: 1004. Issue #6.
Last: 2026-03-20 run 23327821141. Tasks: 3+7. PR created (WebTerminal 28 tests, main-thread path).
Next: tasks 4+5+6. Cmds: npm install / node_modules/.bin/vitest run / biome check --write.
Notes: getFgIndex/getBgIndex/getAttrs for cell attrs; 1-based CUP; ECH no-shift; jsdom no canvas.
Mock canvas: vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx) works for canvas2d tests.
Shared test helpers now in packages/core/src/__tests__/helpers.ts (write/readLineTrimmed/readLineRaw/readScreen/cursor/enc).
Backlog: 1.react-components(needs dep) 2.perf-regression flakiness 3.task5-comments 4.parser-worker unit tests
