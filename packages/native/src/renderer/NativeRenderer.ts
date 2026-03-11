/**
 * Interface for the native Metal / Vulkan renderer.
 *
 * This defines the contract that a platform-specific native renderer would
 * implement via JSI. The native renderer reads directly from the SharedArrayBuffer
 * cell grid for zero-copy rendering.
 *
 * On iOS: Metal-backed CAMetalLayer
 * On Android: Vulkan or OpenGL ES surface
 *
 * Until the native renderer is built, the SkiaRenderer (JS fallback) is used.
 */

import type { Theme, SelectionRange } from '@react-term/core';

export interface NativeRendererConfig {
  /** Font size in device-independent points. */
  fontSize: number;
  /** Monospace font family name. */
  fontFamily: string;
  /** Terminal color theme. */
  theme: Theme;
  /** Device pixel ratio for high-DPI rendering. */
  devicePixelRatio: number;
}

export interface INativeRenderer {
  /**
   * Initialize the native renderer with a SharedArrayBuffer-backed grid.
   * The buffer layout matches @react-term/core's CellGrid packing.
   */
  attach(buffer: SharedArrayBuffer, cols: number, rows: number): void;

  /** Trigger a frame render. The native side reads dirty rows from the SAB. */
  render(): void;

  /** Update grid dimensions (re-allocates internal structures). */
  resize(cols: number, rows: number, buffer: SharedArrayBuffer): void;

  /** Update the color theme. */
  setTheme(theme: Theme): void;

  /** Update font settings. */
  setFont(fontSize: number, fontFamily: string): void;

  /** Update selection overlay. */
  setSelection(selection: SelectionRange | null): void;

  /** Get measured cell dimensions from the native text engine. */
  getCellSize(): { width: number; height: number };

  /** Release native resources. */
  dispose(): void;
}
