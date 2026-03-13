import type { WebTerminal } from "./web-terminal.js";

/**
 * Interface that all terminal addons must implement.
 */
export interface ITerminalAddon {
  activate(terminal: WebTerminal): void;
  dispose(): void;
}
