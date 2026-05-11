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

/**
 * DEC private-mode + mouse state that's sticky across output (i.e. not reset
 * between writes). Surfaced for save/restore so a remounted terminal reacts
 * to keyboard/mouse the same way the old one did.
 */
export interface ParserModeState {
  readonly applicationCursorKeys: boolean;
  readonly bracketedPasteMode: boolean;
  readonly mouseProtocol: import("./parser/index.js").MouseProtocol;
  readonly mouseEncoding: import("./parser/index.js").MouseEncoding;
  readonly sendFocusEvents: boolean;
}

/**
 * Schema version for `TerminalState`. Bumped when the shape changes
 * incompatibly. The literal type on `TerminalState.version` is derived from
 * this so the runtime check and the compile-time guarantee can't drift.
 */
export const SNAPSHOT_VERSION = 1 as const;

/**
 * Serialized terminal state for save/restore scenarios (e.g. remount without
 * losing grid content, cursor, scrollback, or parser modes). Treat the shape
 * as opaque — pass it from `serialize()` back into `hydrate()` or
 * `initialState` without inspecting internals.
 *
 * Captures the active buffer only — the inactive normal/alternate buffer is
 * not serialized. Intended for fast remount of the visible buffer; callers
 * that need full dual-buffer restore should maintain their own snapshot.
 *
 * In worker-mode terminals, scrollback lives in the parser worker and is not
 * reachable from the main thread — `scrollback` will be empty in that mode.
 * Callers that drive a server-side snapshot replay typically don't need it.
 */
export interface TerminalState {
  /** Bumped if the schema changes so callers can detect incompatible snapshots. */
  readonly version: typeof SNAPSHOT_VERSION;
  readonly cols: number;
  readonly rows: number;
  /** Active grid cell data in full format: length === rows * cols * CELL_SIZE. */
  readonly cells: Uint32Array;
  /** One Int32 per row (0 or 1) indicating soft-wrap. */
  readonly wrapFlags: Int32Array;
  readonly cursor: {
    readonly row: number;
    readonly col: number;
    readonly visible: boolean;
    readonly style: "block" | "underline" | "bar";
  };
  readonly scrollback: {
    readonly rows: readonly Uint32Array[];
    readonly wrap: readonly boolean[];
    readonly compact: readonly boolean[];
  };
  readonly parserModes: ParserModeState;
  readonly isAlternate: boolean;
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
