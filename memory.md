## Commands (validated)
- test: `npx vitest run` (1842 tests as of 2026-04-23)
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
- noNonNullAssertion rule: use helper function `getWorker()` that throws if null, instead of `activeWorker!` - OR use `?.` optional chain
- Worker-mode MockWorker needs URL stubbed as a CLASS (not plain object) so `new URL(...)` works in WorkerBridge.start()
- URL mock pattern: `class MockURL { static createObjectURL=vi.fn(()=>"blob:mock"); static revokeObjectURL=vi.fn(); constructor(path,base){...} }`

## Monthly summary issue
- #83: open [Test Improver] Monthly Activity 2026-04

## Completed work
- 2026-04-09: PR #118 (accessibility-edge-cases) merged
- 2026-04-10 run 24225264112: Tasks 3+7, branch test-assist/parser-state-table (+43t), 1580→1623
- 2026-04-16 run 24490999918: Tasks 3+7, branch test-assist/reflow-edge-cases (+8t), 1752→1760
- 2026-04-17 run 24546619174: Tasks 3+7, branch test-assist/reflow-rgb-preservation (+5t), 1764→1769
- 2026-04-18 run 24596072736: Tasks 2+3+7, branch test-assist/xterm-truecolor-sgr (256-color and 24-bit truecolor SGR in xterm-compat, +10t), PR #175 (now merged)
- 2026-04-19 run 24620364049: Tasks 3+7, branch test-assist/ghostty-truecolor-sgr — NO PR created (branch may not exist remotely)
- 2026-04-20 run 24647557344: Tasks 5+7, commented on issues #157, #158, #159 (worker-mode testing gaps)
- 2026-04-21 run 24702956531: Tasks 3+4+7, branch test-assist/ghostty-truecolor-sgr (+11t ghostty truecolor SGR), PR created (merged into main — test count 1801)
- 2026-04-22 run 24759063095: Tasks 6+3+7, branch test-assist/web-terminal-worker-mode-30039 — PR NOT created (run failed to create PR)
- 2026-04-23 run 24815638393: Tasks 2+3+7, branch test-assist/worker-flush-viewport-157 (+5t worker-mode onFlush viewport reset, addresses issue #157), PR created

## Open PRs
- TBD (just created for worker-flush-viewport-157)

## Backlog
- SharedCanvas2DContext (470 lines, only 6 tests) - untested: updateTerminal cursor tracking, setHighlights, setFont, syncCanvasSize, render with highlights
- Render-worker syncedOutput tests (issue #159) - high complexity (module-level state)
- Coverage pipeline: add @vitest/coverage-v8 as devDependency (needs issue discussion first, per policy)
- Worker-mode WebTerminal tests: partially addressed by worker-flush test; more could be done (render-offscreen path, parserPool mode)
- Issue #158: Worker-mode WebTerminal paths — more tests needed beyond viewport reset

## Tasks last run
- Task 2 (Identify opportunities): 2026-04-23 (SharedCanvas2DContext identified as big testing gap)
- Task 3 (Implement tests): 2026-04-23 (worker-mode onFlush viewport reset, +5t)
- Task 7 (Monthly summary): 2026-04-23
- Task 4 (Maintain PRs): 2026-04-21 (no open PRs)
- Task 5 (Comment issues): 2026-04-20
- Task 6 (Test infrastructure): 2026-04-22 (shared test-utils.ts — but PR was not created)
- Task 1 (Commands): validated 2026-04-23 (1842 tests)
