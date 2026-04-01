Last: 2026-04-01 run 23830949697. Tasks: 3+7.
Tests: 1324→1329. PR: test-assist/web-terminal-kitty-flags-sync (5 tests + fix: kitty flags sync in syncParserModes()).
Previous PRs #68,#71,#74,#75,#79 all merged.
Mock tips: Canvas2DRenderer needs @vitest-environment jsdom. DrawOp[] captures fillStyle at draw time. Touch=plain JS obj. Mouse=on document. WebLinks mock={element,activeGrid,getCellSize}. Scrollback test pattern: (term as unknown as Record<string, ...>) casting for private state. Mode sync: vi.spyOn(InputHandler.prototype, 'setXxx') — import InputHandler statically at top of file.
Backlog: react-components(blocked-no-testing-library), render-worker(blocked-WebGL).
