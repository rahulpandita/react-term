import type { ITerminalAddon } from '../addon.js';
import type { WebTerminal } from '../web-terminal.js';
import { calculateFit } from '../fit.js';

/**
 * Addon that fits the terminal to its container element.
 */
export class FitAddon implements ITerminalAddon {
  private terminal: WebTerminal | null = null;

  activate(terminal: WebTerminal): void {
    this.terminal = terminal;
  }

  dispose(): void {
    this.terminal = null;
  }

  /**
   * Calculate the dimensions that would fit the terminal's container.
   * Returns null if the terminal is not attached or dimensions can't be calculated.
   */
  proposeDimensions(): { cols: number; rows: number } | null {
    if (!this.terminal) return null;

    const container = this.terminal.element;
    if (!container) return null;

    const { width, height } = this.terminal.getCellSize();
    if (width <= 0 || height <= 0) return null;

    return calculateFit(container, width, height);
  }

  /**
   * Fit the terminal to its container by resizing.
   */
  fit(): void {
    const dims = this.proposeDimensions();
    if (!dims || !this.terminal) return;

    if (dims.cols !== this.terminal.cols || dims.rows !== this.terminal.rows) {
      this.terminal.resize(dims.cols, dims.rows);
    }
  }
}
