export enum DirtyState {
  NONE = 0,
  PARTIAL = 1,
  FULL = 2,
}

export interface CursorState {
  row: number;
  col: number;
  visible: boolean;
  style: "block" | "underline" | "bar";
  /** True when a char was printed at the last column; wrap deferred until next print. */
  wrapPending: boolean;
}

export interface TerminalOptions {
  cols: number;
  rows: number;
  scrollback: number;
  theme?: Theme;
}

export interface Theme {
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface SelectionState {
  anchor: { row: number; col: number } | null;
  focus: { row: number; col: number } | null;
}

export const DEFAULT_THEME: Theme = {
  foreground: "#d4d4d4",
  background: "#1e1e1e",
  cursor: "#d4d4d4",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};
