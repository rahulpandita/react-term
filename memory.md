## Commands (validated)
- test: `npm test` (vitest run) — 1760 tests as of 2026-04-16
- lint: `npm run lint` (biome check packages/)
- typecheck: `npm run typecheck` (tsc -b)
- No coverage pipeline (missing @vitest/coverage-v8)

## Testing notes
- Test files in packages/*/src/__tests__/*.test.ts
- Cell packing: CELL_SIZE=2, DEFAULT_CELL_W0=0x20|(7<<23), DEFAULT_CELL_W1=0
- `makeRow(text, cols, wrapped)` helper creates rows with space=default padding
- Pre-existing lint warnings: 2 `noExplicitAny` in renderer-rendering.test.ts (not ours)

## Monthly summary issue
- #83: open [Test Improver] Monthly Activity 2026-04

## Completed work
- 2026-04-09: PR #118 (accessibility-edge-cases) merged
- 2026-04-10 run 24225264112: Tasks 3+7, branch test-assist/parser-state-table (VT500 parser state TABLE transitions, 43t), 1580→1623
- 2026-04-16 run 24490999918: Tasks 3+7, branch test-assist/reflow-edge-cases (reflow edge cases: empty row cursor, dangling wrap, single-col, multi-chunk cursor clamp, +8t), 1752→1760

## Backlog
- parser-state-table PR: check if still open/merged
- Check for any CI failures on pending PRs
