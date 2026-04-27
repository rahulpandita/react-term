## Pending PR: worker-mode flush tests

Branch: test-assist/worker-mode-viewport-flush
Commit message: test(web): worker-mode flush-driven behaviour tests
File: packages/web/src/__tests__/web-terminal-worker-mode.test.ts
Tests: +9 (1837→1846)
Addresses: issues #157, #158 (partial)

### Implementation notes
- File needs `// @vitest-environment jsdom` at top
- URL must be stubbed as a CLASS (not plain object) for WorkerBridge.start()
- Worker stub captures instance in `mockWorkerInstance`
- Tests use `(t as unknown as TermPrivate).viewportOffset = N` to bypass snapToBottom()
- flushMsg() helper builds minimal flush: {type:"flush", cursor:{row,col,visible,style}, isAlternate, bytesProcessed:1, modes:{...DEFAULT_MODES}}

### Comments to post on issues
Issue #157: The non-worker test is tautological — write() calls snapToBottom() before parser runs.
  viewportOffset=0 in makeWorkerFlushHandler at ~line 509 of web-terminal.ts, only runs in worker mode.
  Fix: new web-terminal-worker-mode.test.ts sets viewportOffset directly then fires flush.
  
Issue #158: All existing tests use useWorker:false. Worker-mode paths need MockWorker with simulateMessage.
  New file web-terminal-worker-mode.test.ts covers: applySyncedOutput, isAlternateBuffer, viewportOffset
  via flush. Still missing: parserPool mode, offscreen render path.

Issue #159: render-worker.ts uses module-level state. Hard to test directly.
  Approach: export handleMessage from render-worker.ts and test it with mocked self/requestAnimationFrame.
  Or test Canvas2DBackend stop/start methods directly via render-worker-canvas2d.test.ts.
