import type { Theme } from "@next_term/core";

export const CATPPUCCIN_MOCHA: Partial<Theme> = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  cursorAccent: "#1e1e2e",
  selectionBackground: "#585b70",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#f5c2e7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#f5c2e7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
};

export const MATRIX_THEME: Partial<Theme> = {
  background: "#04070a",
  foreground: "#c9ffd8",
  cursor: "#00ff41",
  cursorAccent: "#04070a",
  selectionBackground: "#0d3a1c",
  black: "#04070a",
  red: "#ff6b6b",
  green: "#00ff41",
  yellow: "#d7ff5f",
  blue: "#5fd7ff",
  magenta: "#d787ff",
  cyan: "#35d96b",
  white: "#c9ffd8",
  brightBlack: "#4e8a63",
  brightRed: "#ff8f8f",
  brightGreen: "#78ff99",
  brightYellow: "#edff9a",
  brightBlue: "#9ae7ff",
  brightMagenta: "#e7b5ff",
  brightCyan: "#7fffa5",
  brightWhite: "#effff3",
};

/** xterm.js theme (same colors, plain object for xterm's ITheme) */
export const XTERM_THEME = { ...CATPPUCCIN_MOCHA } as Record<string, string>;
export const XTERM_MATRIX_THEME = { ...MATRIX_THEME } as Record<string, string>;
