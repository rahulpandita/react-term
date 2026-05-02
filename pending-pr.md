## Pending PRs

### Branch: test-assist/canvas2d-backend-attrs (2026-05-02)
Status: PR SUBMITTED via MCP HTTP (create_pull_request called successfully)
Commit: 807fa35
File: packages/web/src/__tests__/render-worker-canvas2d.test.ts
Tests: +13 (1837→1850)
Title: [Test Improver] test(web): Canvas2DBackend attribute, color, and configuration tests

New tests cover:
- ATTR_BOLD → font string contains "700" (fontWeightBold)
- ATTR_ITALIC → font string starts with "italic"
- ATTR_UNDERLINE → stroke() called
- ATTR_STRIKETHROUGH → stroke() called
- ATTR_INVERSE → fg/bg swap produces non-default bg rect with theme.foreground
- Wide cell (ATTR_WIDE=0x80) + underline → lineTo uses 2*cellWidth span
- RGB foreground → fillStyle="rgb(255,128,64)"
- Non-default RGB background → bg fillRect before text with rgb color
- setFont() → updated fontWeightBold (900) appears in bold text render
- setTheme() → new foreground color ("#ff0000") appears in fillText
- syncCanvasSize() → canvas.width and canvas.height updated correctly
- dispose() → render() is a no-op (no fillText called)
- Multi-row selection middle row → full row width (width=80) selected
