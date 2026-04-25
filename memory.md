## Commands (validated)
- test: `npx vitest run` (1850 tests as of 2026-04-25)
- lint: `npm run lint` (biome check packages/)
- typecheck: `npm run typecheck` (tsc -b)
- No coverage pipeline (missing @vitest/coverage-v8)
- npm install required first when vitest not found

## Testing notes
- Test files in packages/*/src/__tests__/*.test.ts
- Cell packing: CELL_SIZE=4 (changed from 2 in #146 truecolor fix), DEFAULT_CELL_W0=0x20|(7<<23), DEFAULT_CELL_W1=0
- Word 0: codepoint[0-20], fg-is-rgb[21], bg-is-rgb[22], fg-index[23-30], dirty[31]
- Word 1: bg-index[0-7], bold[8], italic[9], underline[10], wide[15]
- Word 2: fg RGB (only when fg-is-rgb=1); Word 3: bg RGB (only when bg-is-rgb=1)
- `makeRow(text, cols, wrapped)` helper creates rows with space=default padding
- Pre-existing lint warnings: 2 `noNonNullAssertion` in renderer-rendering.test.ts (not ours)
- git commit requires --no-verify (pnpm hook fails in CI environment)
- biome auto-fix: `npx biome check --write <file>` (add --unsafe for template literal fixes and noNonNullAssertion)
- Scrollback: compact format (2 words/cell) for non-RGB rows, full (4 words/cell) for RGB rows
- MockWorker in web-terminal.test.ts is simple (no simulateMessage); render-bridge.test.ts and worker-bridge.test.ts have full simulateMessage-capable mocks
- Worker-mode WebTerminal flush needs: { type:"flush", isAlternate:bool, cursor:{row,col,visible,style}, bytesProcessed:N, modes:{...} }
- noNonNullAssertion rule: use `?? fallback` instead of `!` — e.g. `"X".codePointAt(0) ?? 0x58`
- Worker-mode MockWorker needs URL stubbed as a CLASS (not plain object) so `new URL(...)` works in WorkerBridge.start()
- URL mock pattern: `class MockURL { static createObjectURL=vi.fn(()=>"blob:mock"); static revokeObjectURL=vi.fn(); constructor(path,base){...} }`
- SharedCanvas2DContext mock: use installLoggedMockGetContext() (tracks fillStyle/globalAlpha at call time) for cursor/highlight assertions
- `vi.restoreAllMocks()` in afterEach is important when spying on window.requestAnimationFrame/cancelAnimationFrame
- Canvas2DBackend: ATTR_WIDE=0x80; wide char needs spacer at col+1 (setCell(row,col+1,0,fgIdx,bgIdx,ATTR_WIDE)); spacer is skipped in render
- Canvas2DBackend: RGB cells use setCell(..., true, false, fgRGB, 0) — fgIsRGB=true, fgRGB=(r<<16)|(g<<8)|b
- Canvas2DBackend: mock context must track fillStyle/globalAlpha at call time (log.state[i]) for reliable assertions

## Monthly summary issue
- #83: open [Test Improver] Monthly Activity 2026-04

## Completed work
- 2026-04-09: PR #118 (accessibility-edge-cases) merged
- 2026-04-10 run 24225264112: Tasks 3+7, branch test-assist/parser-state-table (+43t), 1580→1623
- 2026-04-16 run 24490999918: Tasks 3+7, branch test-assist/reflow-edge-cases (+8t), 1752→1760
- 2026-04-17 run 24546619174: Tasks 3+7, branch test-assist/reflow-rgb-preservation (+5t), 1764→1769
- 2026-04-18 run 24596072736: Tasks 2+3+7, branch test-assist/xterm-truecolor-sgr (256-color and 24-bit truecolor SGR in xterm-compat, +10t), PR #175 (merged)
- 2026-04-19 run 24620364049: Tasks 3+7, branch test-assist/ghostty-truecolor-sgr — NO PR created
- 2026-04-20 run 24647557344: Tasks 5+7, commented on issues #157, #158, #159
- 2026-04-21 run 24702956531: Tasks 3+4+7, branch test-assist/ghostty-truecolor-sgr (+11t ghostty truecolor SGR), PR merged
- 2026-04-22 run 24759063095: Tasks 6+3+7, branch test-assist/web-terminal-worker-mode-30039 — PR NOT created
- 2026-04-23 run 24815638393: Tasks 2+3+7, branch test-assist/worker-flush-viewport-157 (+5t worker-mode onFlush viewport reset) — PR status unknown (not visible in open/closed PRs)
- 2026-04-24 run 24871251214: Tasks 3+7, branch test-assist/shared-canvas2d-coverage (+20t SharedCanvas2DContext) — PR status unknown (not visible in open/closed PRs)
- 2026-04-25 run 24921758917: Tasks 3+7, branch test-assist/canvas2d-backend-attrs (+13t Canvas2DBackend attrs/RGB/wide/selection), 1837→1850

## Open PRs
- PR for test-assist/canvas2d-backend-attrs — just created (number TBD)

## Backlog
- Render-worker syncedOutput tests (issue #159) - high complexity (module-level state)
- Coverage pipeline: add @vitest/coverage-v8 as devDependency (needs issue discussion first, per policy)
- Worker-mode WebTerminal tests: more could be done (render-offscreen path, parserPool mode)
- Issue #158: Worker-mode WebTerminal paths — more tests needed
- SharedCanvas2DContext: palette colors (colorIdx 1-6, 8+), bold/italic in shared context

## Tasks last run
- Task 3 (Implement tests): 2026-04-25 (Canvas2DBackend attrs/RGB/wide/selection +13t)
- Task 7 (Monthly summary): 2026-04-24
- Task 2 (Identify opportunities): 2026-04-23
- Task 5 (Comment issues): 2026-04-20
- Task 6 (Test infrastructure): 2026-04-22
- Task 4 (Maintain PRs): 2026-04-21 (no open PRs at time)
- Task 1 (Commands): validated 2026-04-25 (1850 tests)
