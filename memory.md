# react-term Test Improver. Tests: 969. Issue #6.
Last: 2026-03-19 run 23278550536. Tasks: 1+2+3+7. PR #35 open (DECSET mode tests).
Next: tasks 4+5+6. Cmds: npm install / node_modules/.bin/vitest run / biome check --write.
Notes: getFgIndex/getBgIndex/getAttrs for cell attrs; 1-based CUP; ECH no-shift; jsdom no canvas.
Shared test helpers now in packages/core/src/__tests__/helpers.ts (write/readLineTrimmed/readLineRaw/readScreen/cursor/enc).
Backlog: 1.WebTerminal(options merge/mode detect, jsdom) 2.react-components(needs dep) 3.task5-comments 4.task6-infra
