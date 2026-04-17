## Commands (validated)
- test: `npm test` (vitest run) — 1769 tests as of 2026-04-17
- lint: `npm run lint` (biome check packages/)
- typecheck: `npm run typecheck` (tsc -b)
- No coverage pipeline (missing @vitest/coverage-v8)
- npx vitest run works when node_modules installed via `npm install`

## Testing notes
- Test files in packages/*/src/__tests__/*.test.ts
- Cell packing: CELL_SIZE=4 (changed from 2 in #146 truecolor fix), DEFAULT_CELL_W0=0x20|(7<<23), DEFAULT_CELL_W1=0
- Word 0: codepoint[0-20], fg-is-rgb[21], bg-is-rgb[22], fg-index[23-30], dirty[31]
- Word 1: bg-index[0-7], bold[8], italic[9], underline[10], wide[15]
- Word 2: fg RGB (only when fg-is-rgb=1); Word 3: bg RGB (only when bg-is-rgb=1)
- `makeRow(text, cols, wrapped)` helper creates rows with space=default padding
- Pre-existing lint warnings: 2 `noExplicitAny` in renderer-rendering.test.ts (not ours)
- git commit requires --no-verify (pnpm hook fails in CI environment)
- biome auto-fix: `npx biome check --write <file>`

## Monthly summary issue
- #83: open [Test Improver] Monthly Activity 2026-04

## Completed work
- 2026-04-09: PR #118 (accessibility-edge-cases) merged
- 2026-04-10 run 24225264112: Tasks 3+7, branch test-assist/parser-state-table (VT500 parser state TABLE transitions, 43t), 1580→1623
- 2026-04-16 run 24490999918: Tasks 3+7, branch test-assist/reflow-edge-cases (reflow edge cases: empty row cursor, dangling wrap, single-col, multi-chunk cursor clamp, +8t), 1752→1760
- 2026-04-17 run 24546619174: Tasks 3+7, branch test-assist/reflow-rgb-preservation (RGB color preservation through reflow join/split, +5t), 1764→1769

## Backlog
- parser-state-table PR: check if still open/merged
- reflow-edge-cases PR: check if still open/merged
- Consider xterm-compat truecolor tests (none currently)
- Consider ghostty-compat truecolor tests (none currently)
