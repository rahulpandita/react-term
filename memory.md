## Commands (validated)
- test: `npx vitest run` (1846 tests as of 2026-04-27)
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
- MockWorker in web-terminal.test.ts is simple (no simulateMessage)
- Worker-mode tests: use separate file with full MockWorker (see web-terminal-worker-mode.test.ts pattern)
- Worker-mode MockWorker pattern: class with addEventListener/removeEventListener/simulateMessage, URL stubbed as CLASS
- Worker-mode WebTerminal flush: { type:"flush", isAlternate:bool, cursor:{row,col,visible,style}, bytesProcessed:N, modes:{...} }
- noNonNullAssertion rule: use `?? fallback` instead of `!`
- URL mock pattern: class MockURL { static createObjectURL=vi.fn(()=>"blob:mock"); static revokeObjectURL=vi.fn(); constructor(path,base){...} }
- SharedCanvas2DContext mock: use installLoggedMockGetContext() (tracks fillStyle/globalAlpha at call time)
- `vi.restoreAllMocks()` in afterEach is important when spying on window.requestAnimationFrame/cancelAnimationFrame
- Worker-mode viewportOffset: set directly via (t as unknown as TermPrivate).viewportOffset to bypass snapToBottom()
- applySyncedOutput idempotency: `if (synced === this._syncedOutput) return` — repeated same-value flushes are no-ops

## Monthly summary issue
- #83: open [Test Improver] Monthly Activity 2026-04

## Completed work
- 2026-04-09: PR #118 (accessibility-edge-cases) merged
- 2026-04-10 run 24225264112: Tasks 3+7, branch test-assist/parser-state-table (+43t), 1580→1623
- 2026-04-16 run 24490999918: Tasks 3+7, branch test-assist/reflow-edge-cases (+8t), 1752→1760
- 2026-04-17 run 24546619174: Tasks 3+7, branch test-assist/reflow-rgb-preservation (+5t), 1764→1769
- 2026-04-18 run 24596072736: Tasks 2+3+7, branch test-assist/xterm-truecolor-sgr (+10t), PR #175 (merged)
- 2026-04-21 run 24702956531: Tasks 3+4+7, branch test-assist/ghostty-truecolor-sgr (+11t ghostty truecolor SGR), PR merged
- 2026-04-26 run 24947668353: Tasks 3+7, branch test-assist/canvas2d-rendering-attrs (intended +17t, but PR may not have been created - test count back to 1837 on next run)
- 2026-04-27 run 24975760516: Tasks 3+5+7, branch test-assist/worker-mode-viewport-flush (+9t worker-mode flush behavior), 1837→1846; commented on #157, #158, #159

## Open PRs
- test-assist/worker-mode-viewport-flush — created 2026-04-27 (number TBD)

## Backlog
- Render-worker syncedOutput tests (issue #159) - high complexity (module-level state), worker needs module-level handleMessage exported or test harness
- Coverage pipeline: add @vitest/coverage-v8 as devDependency (needs issue discussion first, per policy)
- Canvas2DBackend: more worker-mode paths (parserPool, offscreen render)
- Issue #158: Worker-mode WebTerminal tests - partial coverage via web-terminal-worker-mode.test.ts; more paths remain (parserPool mode, offscreen rendering path)

## Tasks last run (2026-04-27)
- Task 3 (Implement tests): 2026-04-27 (worker-mode flush +9t)
- Task 5 (Comment issues): 2026-04-27 (commented on #157, #158, #159)
- Task 7 (Monthly summary): 2026-04-27
- Task 2 (Identify opportunities): 2026-04-23
- Task 6 (Test infrastructure): 2026-04-22
- Task 4 (Maintain PRs): 2026-04-26 (no open PRs to maintain)
- Task 1 (Commands): validated 2026-04-27 (1846 tests)
