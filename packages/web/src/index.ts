export { WebTerminal } from './web-terminal.js';
export type { WebTerminalOptions } from './web-terminal.js';
export { Canvas2DRenderer, build256Palette } from './renderer.js';
export type { IRenderer, RendererOptions } from './renderer.js';
export { WebGLRenderer, GlyphAtlas, createRenderer, hexToFloat4 } from './webgl-renderer.js';
export type { GlyphInfo } from './webgl-renderer.js';
export { calculateFit } from './fit.js';
export { InputHandler } from './input-handler.js';
export type { InputHandlerOptions, SelectionState } from './input-handler.js';
export { WorkerBridge } from './worker-bridge.js';
export { RenderBridge, canUseOffscreenCanvas } from './render-bridge.js';
export type { RenderBridgeOptions } from './render-bridge.js';
export { AccessibilityManager, extractRowText } from './accessibility.js';
export { SharedWebGLContext } from './shared-context.js';
export type { TerminalEntry } from './shared-context.js';

// Addon system
export type { ITerminalAddon } from './addon.js';
export type { HighlightRange } from './renderer.js';
export { SearchAddon } from './addons/search.js';
export type { SearchMatch, SearchOptions } from './addons/search.js';
export { WebLinksAddon } from './addons/web-links.js';
export type { LinkMatch } from './addons/web-links.js';
export { FitAddon } from './addons/fit.js';

// Re-export types from core so consumers don't need to depend on core directly
export type { Theme, CursorState, TerminalOptions } from '@react-term/core';
export { CellGrid, CELL_SIZE, DEFAULT_THEME, extractText, normalizeSelection } from '@react-term/core';
export type { SelectionRange } from '@react-term/core';
