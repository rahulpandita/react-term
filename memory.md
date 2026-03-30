Last: 2026-03-30 run 23727006005. Tasks: 3+4+7.
Tests: 1157→1167. PRs: #68(keyboard), #71(weblinks), #74(canvas2d-rendering), scrollback-viewport(branch).
Mock tips: Canvas2DRenderer needs @vitest-environment jsdom. DrawOp[] captures fillStyle at draw time. Touch=plain JS obj. Mouse=on document. WebLinks mock={element,activeGrid,getCellSize}. Scrollback test pattern: (term as unknown as Record<string, ...>) casting for private state.
Backlog: react-components(blocked), render-worker(blocked-WebGL).
