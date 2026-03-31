Last: 2026-03-31 run 23779324340. Tasks: 3+4+7.
Tests: 1280→1295. PR: test-assist/web-terminal-mode-sync-resize (15 tests, parser mode sync + resize content preservation).
Previous PRs #68,#71,#74,#75 all merged.
Mock tips: Canvas2DRenderer needs @vitest-environment jsdom. DrawOp[] captures fillStyle at draw time. Touch=plain JS obj. Mouse=on document. WebLinks mock={element,activeGrid,getCellSize}. Scrollback test pattern: (term as unknown as Record<string, ...>) casting for private state. Mode sync: vi.spyOn(InputHandler.prototype, 'setXxx') — import InputHandler statically at top of file.
Backlog: react-components(blocked), render-worker(blocked-WebGL).
