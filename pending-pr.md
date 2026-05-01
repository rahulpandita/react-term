## Pending PRs (not yet created due to MCP tools being blocked)

### Branch: test-assist/canvas2d-backend-attrs
Commit: a45d053
File: packages/web/src/__tests__/render-worker-canvas2d.test.ts
Tests: +12 (1837→1849)
Title: [Test Improver] test(web): Canvas2DBackend attrs, lifecycle, and color tests

New tests cover:
- ATTR_UNDERLINE → stroke() called
- ATTR_STRIKETHROUGH → stroke() called  
- ATTR_INVERSE → fg/bg swap produces non-default bg rect
- ATTR_BOLD → font string contains "700"
- ATTR_ITALIC → font string starts with "italic"
- Wide cell (ATTR_WIDE=0x80) → fillText called
- RGB foreground → fillStyle="rgb(255,128,64)"
- Non-default RGB background → bg fillRect before text
- setFont() → new fontWeightBold used in render
- setTheme() → new foreground color used for text  
- dispose() → render() is a no-op
- Multi-row selection middle row → full row width selected
