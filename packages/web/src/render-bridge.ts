/**
 * RenderBridge — main-thread side that manages the render Web Worker.
 *
 * Transfers an OffscreenCanvas to the worker, relays cursor/selection
 * updates, and handles configuration changes (theme, font, resize).
 */

import type { Theme, CursorState } from '@react-term/core';
import type { SelectionRange } from '@react-term/core';
import type {
  RenderWorkerInitMessage,
  RenderWorkerUpdateMessage,
  RenderWorkerResizeMessage,
  RenderWorkerThemeMessage,
  RenderWorkerFontMessage,
  RenderWorkerDisposeMessage,
  RenderWorkerFrameMessage,
} from './render-worker.js';

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

export function canUseOffscreenCanvas(): boolean {
  return (
    typeof OffscreenCanvas !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'
  );
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RenderBridgeOptions {
  fontSize: number;
  fontFamily: string;
  theme: Theme;
  devicePixelRatio?: number;
  /** Called when the worker reports FPS. */
  onFps?: (fps: number) => void;
  /** Called when the worker reports an error. */
  onError?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// RenderBridge
// ---------------------------------------------------------------------------

export class RenderBridge {
  private worker: Worker | null = null;
  private canvas: HTMLCanvasElement;
  private options: RenderBridgeOptions;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: RenderBridgeOptions) {
    this.canvas = canvas;
    this.options = options;
  }

  /**
   * Transfer canvas control to the worker and start rendering.
   */
  start(sharedBuffer: SharedArrayBuffer, cols: number, rows: number): void {
    if (this.disposed) return;

    this.worker = new Worker(
      new URL('./render-worker.ts', import.meta.url),
      { type: 'module' },
    );

    this.worker.addEventListener('message', this.handleWorkerMessage);
    this.worker.addEventListener('error', this.handleWorkerError);

    const offscreen = this.canvas.transferControlToOffscreen();

    const init: RenderWorkerInitMessage = {
      type: 'init',
      canvas: offscreen,
      sharedBuffer,
      cols,
      rows,
      theme: this.options.theme,
      fontSize: this.options.fontSize,
      fontFamily: this.options.fontFamily,
      devicePixelRatio: this.options.devicePixelRatio ??
        (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1),
    };

    this.worker.postMessage(init, [offscreen]);
  }

  /**
   * Send cursor and selection state to the render worker.
   */
  updateCursor(cursor: CursorState): void {
    if (this.disposed || !this.worker) return;

    const msg: RenderWorkerUpdateMessage = {
      type: 'update',
      cursor: {
        row: cursor.row,
        col: cursor.col,
        visible: cursor.visible,
        style: cursor.style,
      },
      selection: null,
    };
    this.worker.postMessage(msg);
  }

  /**
   * Send selection state to the render worker.
   */
  updateSelection(selection: SelectionRange | null): void {
    if (this.disposed || !this.worker) return;

    const msg: RenderWorkerUpdateMessage = {
      type: 'update',
      cursor: { row: 0, col: 0, visible: false, style: 'block' },
      selection: selection
        ? {
            startRow: selection.startRow,
            startCol: selection.startCol,
            endRow: selection.endRow,
            endCol: selection.endCol,
          }
        : null,
    };
    this.worker.postMessage(msg);
  }

  /**
   * Notify the render worker of a terminal resize.
   */
  resize(cols: number, rows: number, sharedBuffer: SharedArrayBuffer): void {
    if (this.disposed || !this.worker) return;

    const msg: RenderWorkerResizeMessage = {
      type: 'resize',
      cols,
      rows,
      sharedBuffer,
    };
    this.worker.postMessage(msg);
  }

  /**
   * Update the render worker's theme.
   */
  setTheme(theme: Theme): void {
    if (this.disposed || !this.worker) return;

    const msg: RenderWorkerThemeMessage = {
      type: 'theme',
      theme,
    };
    this.worker.postMessage(msg);
  }

  /**
   * Update the render worker's font settings.
   */
  setFont(fontSize: number, fontFamily: string): void {
    if (this.disposed || !this.worker) return;

    const msg: RenderWorkerFontMessage = {
      type: 'font',
      fontSize,
      fontFamily,
    };
    this.worker.postMessage(msg);
  }

  /**
   * Tear down the render worker.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.worker) {
      const msg: RenderWorkerDisposeMessage = { type: 'dispose' };
      this.worker.postMessage(msg);
      this.worker.removeEventListener('message', this.handleWorkerMessage);
      this.worker.removeEventListener('error', this.handleWorkerError);
      this.worker.terminate();
      this.worker = null;
    }
  }

  // ---- Internals -----------------------------------------------------------

  private handleWorkerMessage = (event: MessageEvent): void => {
    const msg = event.data;
    if (msg.type === 'frame') {
      this.options.onFps?.(msg.fps);
    } else if (msg.type === 'error') {
      this.options.onError?.(msg.message);
    }
  };

  private handleWorkerError = (event: ErrorEvent): void => {
    this.options.onError?.(`Render worker error: ${event.message}`);
  };
}
