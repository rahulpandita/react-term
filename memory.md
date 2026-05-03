## Commands
- test: `npx vitest run` (1849 tests 2026-05-03)
- lint: `npm run lint` (biome check packages/)
- typecheck: `npm run typecheck` (tsc -b)
- npm install required first; git commit --no-verify

## Testing notes
- Test files: packages/*/src/__tests__/*.test.ts
- CELL_SIZE=4, DEFAULT_CELL_W0=0x20|(7<<23)
- W0: cp[0-20],fg-rgb[21],bg-rgb[22],fg-idx[23-30],dirty[31]; W1: bg-idx[0-7],bold[8],italic[9],ul[10],wide[15]
- W2: fg RGB (when fg-is-rgb=1); W3: bg RGB (when bg-is-rgb=1)
- biome auto-fix: `npx biome check --write <file>` (--unsafe for noNonNullAssertion)
- noNonNullAssertion: use `?.` not `!.`
- web test utils: packages/web/src/__tests__/test-utils.ts (createLoggedMockContext, installLoggedMockGetContext, makeCursor)
- SharedCanvas2DContext mock: install BEFORE new SharedCanvas2DContext() → cellWidth=8, cellHeight=12 (from mock measureText)
- CellGrid: fresh grid has all rows clean; first render forceAll=true
- DEFAULT_THEME: fg="#d4d4d4", bg="#1e1e1e", cursor="#d4d4d4"
- rgb() format: "rgb(255,128,64)" (no spaces)
- vi.restoreAllMocks() in afterEach important for rAF spies
- Worker-mode: use separate file with full MockWorker; flush={type:"flush",isAlternate,cursor,bytesProcessed,modes}
- render-worker.ts tests: @vitest-environment node, stub self, vi.resetModules()+dynamic import() per test
- applySyncedOutput: idempotent if same synced value
- Canvas2DBackend: ATTR_WIDE=0x80, ATTR_INVERSE=0x40, ATTR_BOLD=0x01,0x02,0x04,0x08
- SAB feature: `typeof SharedArrayBuffer!=='undefined'&&crossOriginIsolated`

## Monthly summary
- #188: May 2026 — open (updated 2026-05-03)

## Completed work (recent)
- 2026-05-03 run 25269292706: Tasks 6+2+7, test-assist/shared-canvas2d-context-tests (+12t shared util+SharedCanvas2DContext), 1837→1849, PR created
- 2026-05-02 run 25243104305: Tasks 3+7, test-assist/canvas2d-backend-attrs (+13t Canvas2DBackend attrs), 1837→1850, PR created
- 2026-04-30: Task 4+7, render-worker message handler (+13t)
- 2026-04-29: Task 3+7, render-worker-synced-output (+11t)
- 2026-04-28: Task 3+7, worker-mode flush (+10t)

## Backlog
- render-worker-canvas2d.test.ts: refactor to use shared test-utils.ts (low priority)
- Coverage pipeline: @vitest/coverage-v8 (needs issue discussion)
- Issue #158: Worker-mode WebTerminal parserPool/offscreen paths
- Issue #156: WebGL context restore regression test

## Tasks last run (2026-05-03)
- Task 6: 2026-05-03 (shared test-utils.ts + SharedCanvas2DContext +12t)
- Task 2: 2026-05-03 (opportunities documented)
- Task 7: 2026-05-03 (#188 updated)
- Task 5: 2026-04-27
- Task 4: 2026-04-30
- Task 3: 2026-05-02
- Task 1: 2026-05-03 (1849 tests)
