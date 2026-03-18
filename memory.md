# react-term Test Improver. Tests: 939. Issue #6.
Last: 2026-03-18 run 23227822687. Tasks: 4+6+7. PR #34 open (helpers.ts extraction).
Next: tasks 1+2+3. Cmds: npm install / node_modules/.bin/vitest run / biome check --write.
Notes: getFgIndex/getBgIndex/getAttrs for cell attrs; 1-based CUP; ECH no-shift; jsdom no canvas.
Shared test helpers now in packages/core/src/__tests__/helpers.ts (write/readLineTrimmed/readLineRaw/readScreen/cursor/enc).
Backlog: 1.WebTerminal 2.react-components(needs dep) 3.task5-comments 4.task6-infra
