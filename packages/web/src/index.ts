// Re-export types from core so consumers don't need to depend on core directly
export type { CursorState, SelectionRange, TerminalOptions, Theme } from "@next_term/core";
export {
  CELL_SIZE,
  CellGrid,
  DEFAULT_THEME,
  extractText,
  normalizeSelection,
} from "@next_term/core";
export { AccessibilityManager, extractRowText } from "./accessibility.js";
// Addon system
export type { ITerminalAddon } from "./addon.js";
export { FitAddon } from "./addons/fit.js";
export type { SearchMatch, SearchOptions } from "./addons/search.js";
export { SearchAddon } from "./addons/search.js";
export type { LinkMatch } from "./addons/web-links.js";
export { WebLinksAddon } from "./addons/web-links.js";
export { calculateFit } from "./fit.js";
export type { InputHandlerOptions, SelectionState } from "./input-handler.js";
export { InputHandler } from "./input-handler.js";
export { DEFAULT_PARSER_WORKER_COUNT, ParserChannel, ParserPool } from "./parser-pool.js";
export type { RenderBridgeOptions } from "./render-bridge.js";
export { canUseOffscreenCanvas, RenderBridge } from "./render-bridge.js";
export type { HighlightRange, IRenderer, RendererOptions } from "./renderer.js";
export { build256Palette, Canvas2DRenderer } from "./renderer.js";
export type { SharedContext, TerminalEntry } from "./shared-context.js";
export { SharedWebGLContext } from "./shared-context.js";
export { SharedCanvas2DContext } from "./shared-context-canvas2d.js";
export type { WebTerminalOptions } from "./web-terminal.js";
export { WebTerminal } from "./web-terminal.js";
export type { GlyphInfo } from "./webgl-renderer.js";
export { createRenderer, GlyphAtlas, hexToFloat4, WebGLRenderer } from "./webgl-renderer.js";
export { type ColorFloat4, resolveColorFloat } from "./webgl-utils.js";
export { WorkerBridge } from "./worker-bridge.js";
