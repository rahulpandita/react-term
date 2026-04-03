/**
 * TurboModule spec for the native terminal core.
 *
 * This TypeScript interface defines the contract that a native C++ TurboModule
 * would implement via JSI. The native implementation would handle:
 * - VT parsing on a dedicated native thread
 * - Metal (iOS) / Vulkan (Android) rendering
 * - SharedArrayBuffer-backed cell grid for zero-copy JS access
 *
 * Until the native module is built, the JS-side `NativeTerminal` component
 * uses `@next_term/core`'s BufferSet + VTParser as a fallback.
 */

/**
 * The TurboModule interface. In a full React Native New Architecture setup,
 * this would extend `TurboModule` from `react-native`. We define a standalone
 * interface here so the package can be tested without the RN runtime.
 */
export interface NativeTerminalCoreSpec {
  /**
   * Create a terminal instance. Returns an opaque numeric handle used
   * to identify this terminal in all subsequent calls.
   */
  createTerminal(cols: number, rows: number, scrollback: number): number;

  /** Destroy a terminal instance and free its resources. */
  destroyTerminal(handle: number): void;

  /**
   * Write data to the terminal. The native side performs VT parsing
   * on a background thread and updates the shared cell grid.
   */
  write(handle: number, data: string): void;

  /** Resize the terminal grid. */
  resize(handle: number, cols: number, rows: number): void;

  /** Get the current cursor position and visibility. */
  getCursor(handle: number): { row: number; col: number; visible: boolean };

  /**
   * Get raw cell data for a row (for JS-side rendering fallback).
   * Returns a Uint32Array-compatible ArrayBuffer with CELL_SIZE words per cell.
   */
  getRowCells(handle: number, row: number): ArrayBuffer;

  /**
   * Get a bitmask of dirty rows. Each Int32 element is 1 if the
   * corresponding row needs re-rendering, 0 otherwise.
   */
  getDirtyRows(handle: number): ArrayBuffer;

  /** Clear the dirty flag for a specific row after rendering it. */
  clearDirty(handle: number, row: number): void;

  /**
   * Set the color theme. Keys are Theme property names (e.g. "foreground",
   * "background", "red", etc.) and values are CSS-style color strings.
   */
  setTheme(handle: number, theme: Record<string, string>): void;
}
