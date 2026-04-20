## Commands (validated)
- test: `npx vitest run` (1764 tests as of 2026-04-20)
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
- Pre-existing lint warnings: 2 `noExplicitAny` in renderer-rendering.test.ts (not ours)
- git commit requires --no-verify (pnpm hook fails in CI environment)
- biome auto-fix: `npx biome check --write <file>` (add --unsafe for template literal fixes)
- Scrollback: compact format (2 words/cell) for non-RGB rows, full (4 words/cell) for RGB rows
- MockWorker in web-terminal.test.ts is simple (no simulateMessage); render-bridge.test.ts and worker-bridge.test.ts have full simulateMessage-capable mocks
- Testing worker-mode WebTerminal paths requires upgrading web-terminal.test.ts MockWorker to support simulateMessage

## Monthly summary issue
- #83: open [Test Improver] Monthly Activity 2026-04

## Completed work
- 2026-04-09: PR #118 (accessibility-edge-cases) merged
- 2026-04-10 run 24225264112: Tasks 3+7, branch test-assist/parser-state-table (+43t), 1580→1623
- 2026-04-16 run 24490999918: Tasks 3+7, branch test-assist/reflow-edge-cases (+8t), 1752→1760
- 2026-04-17 run 24546619174: Tasks 3+7, branch test-assist/reflow-rgb-preservation (+5t), 1764→1769
- 2026-04-18 run 24596072736: Tasks 2+3+7, branch test-assist/xterm-truecolor-sgr (256-color and 24-bit truecolor SGR in xterm-compat, +10t), PR #175
- 2026-04-19 run 24620364049: Tasks 3+7, branch test-assist/ghostty-truecolor-sgr — NO PR created (branch may not exist remotely; only xterm-truecolor-sgr branch found on remote)
- 2026-04-20 run 24647557344: Tasks 5+7, commented on issues #157, #158, #159 (worker-mode testing gaps)

## Open PRs
- #175: xterm-truecolor-sgr (open, mergeable=true, up-to-date with main)

## Backlog
- Implement worker-mode WebTerminal tests (issues #157, #158) - medium complexity, requires MockWorker upgrade
- Implement render-worker syncedOutput tests (issue #159) - high complexity (module-level state)
- ghostty-compat truecolor tests: apparently not completed in 2026-04-19 run; base format changed with #172 merge

## Tasks last run
- Task 5 (Comment issues): 2026-04-20
- Task 7 (Monthly summary): 2026-04-20
- Task 3 (Implement tests): 2026-04-19
- Task 2 (Identify opportunities): 2026-04-18
- Task 4 (Maintain PRs): not recently run (PR #175 is mergeable, no action needed)
- Task 1 (Commands): validated 2026-04-20 (1764 tests)
