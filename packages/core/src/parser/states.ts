// VT500-series parser states (Paul Williams state diagram)
export enum State {
  GROUND = 0,
  ESCAPE = 1,
  ESCAPE_INTERMEDIATE = 2,
  CSI_ENTRY = 3,
  CSI_PARAM = 4,
  CSI_INTERMEDIATE = 5,
  CSI_IGNORE = 6,
  OSC_STRING = 7,
  DCS_ENTRY = 8,
  DCS_PARAM = 9,
  DCS_INTERMEDIATE = 10,
  DCS_PASSTHROUGH = 11,
  DCS_IGNORE = 12,
  SOS_PM_APC_STRING = 13,
}

// Actions performed during transitions
export enum Action {
  NONE = 0,
  PRINT = 1,
  EXECUTE = 2,
  COLLECT = 3,
  PARAM = 4,
  ESC_DISPATCH = 5,
  CSI_DISPATCH = 6,
  HOOK = 7,
  PUT = 8,
  UNHOOK = 9,
  OSC_START = 10,
  OSC_PUT = 11,
  OSC_END = 12,
  CLEAR = 13,
  IGNORE = 14,
}

// Pack action + state into one byte: high nibble = action, low nibble = state
function pack(action: Action, state: State): number {
  return (action << 4) | state;
}

const NUM_STATES = 14;
// Transition table: [state][byte] -> packed(action, nextState)
// 256 byte entries per state
export const TABLE: Uint8Array = buildTable();

function buildTable(): Uint8Array {
  const t = new Uint8Array(NUM_STATES * 256);

  // Helper to fill a range
  function range(state: State, lo: number, hi: number, action: Action, next: State): void {
    const packed = pack(action, next);
    for (let b = lo; b <= hi; b++) {
      t[state * 256 + b] = packed;
    }
  }

  function entry(state: State, b: number, action: Action, next: State): void {
    t[state * 256 + b] = pack(action, next);
  }

  // ----- Anywhere transitions (applied to all states) -----
  for (let s = 0; s < NUM_STATES; s++) {
    // Default: stay in current state, ignore
    range(s as State, 0x00, 0xff, Action.NONE, s as State);

    // CAN, SUB -> GROUND + execute
    entry(s as State, 0x18, Action.EXECUTE, State.GROUND);
    entry(s as State, 0x1a, Action.EXECUTE, State.GROUND);

    // ESC -> ESCAPE (with clear)
    entry(s as State, 0x1b, Action.CLEAR, State.ESCAPE);

    // C1 controls 0x80-0x8f, 0x91-0x97, 0x99, 0x9a -> execute in GROUND
    for (const b of [
      ...Array.from({ length: 0x90 - 0x80 }, (_, i) => 0x80 + i),
      0x91,
      0x92,
      0x93,
      0x94,
      0x95,
      0x96,
      0x97,
      0x99,
      0x9a,
    ]) {
      entry(s as State, b, Action.EXECUTE, State.GROUND);
    }

    // 0x9c (ST) -> GROUND
    entry(s as State, 0x9c, Action.NONE, State.GROUND);

    // DCS (0x90)
    entry(s as State, 0x90, Action.CLEAR, State.DCS_ENTRY);
    // CSI (0x9b)
    entry(s as State, 0x9b, Action.CLEAR, State.CSI_ENTRY);
    // OSC (0x9d)
    entry(s as State, 0x9d, Action.OSC_START, State.OSC_STRING);
    // SOS (0x98), PM (0x9e), APC (0x9f)
    entry(s as State, 0x98, Action.NONE, State.SOS_PM_APC_STRING);
    entry(s as State, 0x9e, Action.NONE, State.SOS_PM_APC_STRING);
    entry(s as State, 0x9f, Action.NONE, State.SOS_PM_APC_STRING);
  }

  // ----- GROUND -----
  // C0 controls
  range(State.GROUND, 0x00, 0x17, Action.EXECUTE, State.GROUND);
  entry(State.GROUND, 0x19, Action.EXECUTE, State.GROUND);
  range(State.GROUND, 0x1c, 0x1f, Action.EXECUTE, State.GROUND);
  // Printable ASCII
  range(State.GROUND, 0x20, 0x7e, Action.PRINT, State.GROUND);
  entry(State.GROUND, 0x7f, Action.EXECUTE, State.GROUND);
  // High bytes (UTF-8 continuation / start bytes) -> print
  range(State.GROUND, 0xa0, 0xff, Action.PRINT, State.GROUND);

  // ----- ESCAPE -----
  range(State.ESCAPE, 0x00, 0x17, Action.EXECUTE, State.ESCAPE);
  entry(State.ESCAPE, 0x19, Action.EXECUTE, State.ESCAPE);
  range(State.ESCAPE, 0x1c, 0x1f, Action.EXECUTE, State.ESCAPE);
  entry(State.ESCAPE, 0x7f, Action.IGNORE, State.ESCAPE);

  // Intermediates
  range(State.ESCAPE, 0x20, 0x2f, Action.COLLECT, State.ESCAPE_INTERMEDIATE);

  // ESC [ -> CSI_ENTRY
  entry(State.ESCAPE, 0x5b, Action.CLEAR, State.CSI_ENTRY);
  // ESC ] -> OSC
  entry(State.ESCAPE, 0x5d, Action.OSC_START, State.OSC_STRING);
  // ESC P -> DCS
  entry(State.ESCAPE, 0x50, Action.CLEAR, State.DCS_ENTRY);
  // ESC X (SOS), ESC ^ (PM), ESC _ (APC)
  entry(State.ESCAPE, 0x58, Action.NONE, State.SOS_PM_APC_STRING);
  entry(State.ESCAPE, 0x5e, Action.NONE, State.SOS_PM_APC_STRING);
  entry(State.ESCAPE, 0x5f, Action.NONE, State.SOS_PM_APC_STRING);

  // Final characters -> dispatch
  range(State.ESCAPE, 0x30, 0x4f, Action.ESC_DISPATCH, State.GROUND);
  range(State.ESCAPE, 0x51, 0x57, Action.ESC_DISPATCH, State.GROUND);
  entry(State.ESCAPE, 0x59, Action.ESC_DISPATCH, State.GROUND);
  entry(State.ESCAPE, 0x5a, Action.ESC_DISPATCH, State.GROUND);
  entry(State.ESCAPE, 0x5c, Action.ESC_DISPATCH, State.GROUND);
  range(State.ESCAPE, 0x60, 0x7e, Action.ESC_DISPATCH, State.GROUND);

  // ----- ESCAPE_INTERMEDIATE -----
  range(State.ESCAPE_INTERMEDIATE, 0x00, 0x17, Action.EXECUTE, State.ESCAPE_INTERMEDIATE);
  entry(State.ESCAPE_INTERMEDIATE, 0x19, Action.EXECUTE, State.ESCAPE_INTERMEDIATE);
  range(State.ESCAPE_INTERMEDIATE, 0x1c, 0x1f, Action.EXECUTE, State.ESCAPE_INTERMEDIATE);
  range(State.ESCAPE_INTERMEDIATE, 0x20, 0x2f, Action.COLLECT, State.ESCAPE_INTERMEDIATE);
  range(State.ESCAPE_INTERMEDIATE, 0x30, 0x7e, Action.ESC_DISPATCH, State.GROUND);
  entry(State.ESCAPE_INTERMEDIATE, 0x7f, Action.IGNORE, State.ESCAPE_INTERMEDIATE);

  // ----- CSI_ENTRY -----
  range(State.CSI_ENTRY, 0x00, 0x17, Action.EXECUTE, State.CSI_ENTRY);
  entry(State.CSI_ENTRY, 0x19, Action.EXECUTE, State.CSI_ENTRY);
  range(State.CSI_ENTRY, 0x1c, 0x1f, Action.EXECUTE, State.CSI_ENTRY);
  entry(State.CSI_ENTRY, 0x7f, Action.IGNORE, State.CSI_ENTRY);

  range(State.CSI_ENTRY, 0x30, 0x39, Action.PARAM, State.CSI_PARAM);
  entry(State.CSI_ENTRY, 0x3b, Action.PARAM, State.CSI_PARAM);
  // Private markers (? > = etc.)
  range(State.CSI_ENTRY, 0x3c, 0x3f, Action.COLLECT, State.CSI_PARAM);
  range(State.CSI_ENTRY, 0x20, 0x2f, Action.COLLECT, State.CSI_INTERMEDIATE);
  range(State.CSI_ENTRY, 0x40, 0x7e, Action.CSI_DISPATCH, State.GROUND);

  // ----- CSI_PARAM -----
  range(State.CSI_PARAM, 0x00, 0x17, Action.EXECUTE, State.CSI_PARAM);
  entry(State.CSI_PARAM, 0x19, Action.EXECUTE, State.CSI_PARAM);
  range(State.CSI_PARAM, 0x1c, 0x1f, Action.EXECUTE, State.CSI_PARAM);
  range(State.CSI_PARAM, 0x30, 0x39, Action.PARAM, State.CSI_PARAM);
  entry(State.CSI_PARAM, 0x3b, Action.PARAM, State.CSI_PARAM);
  range(State.CSI_PARAM, 0x3c, 0x3f, Action.IGNORE, State.CSI_IGNORE);
  range(State.CSI_PARAM, 0x20, 0x2f, Action.COLLECT, State.CSI_INTERMEDIATE);
  range(State.CSI_PARAM, 0x40, 0x7e, Action.CSI_DISPATCH, State.GROUND);
  entry(State.CSI_PARAM, 0x7f, Action.IGNORE, State.CSI_PARAM);

  // ----- CSI_INTERMEDIATE -----
  range(State.CSI_INTERMEDIATE, 0x00, 0x17, Action.EXECUTE, State.CSI_INTERMEDIATE);
  entry(State.CSI_INTERMEDIATE, 0x19, Action.EXECUTE, State.CSI_INTERMEDIATE);
  range(State.CSI_INTERMEDIATE, 0x1c, 0x1f, Action.EXECUTE, State.CSI_INTERMEDIATE);
  range(State.CSI_INTERMEDIATE, 0x20, 0x2f, Action.COLLECT, State.CSI_INTERMEDIATE);
  range(State.CSI_INTERMEDIATE, 0x30, 0x3f, Action.IGNORE, State.CSI_IGNORE);
  range(State.CSI_INTERMEDIATE, 0x40, 0x7e, Action.CSI_DISPATCH, State.GROUND);
  entry(State.CSI_INTERMEDIATE, 0x7f, Action.IGNORE, State.CSI_INTERMEDIATE);

  // ----- CSI_IGNORE -----
  range(State.CSI_IGNORE, 0x00, 0x17, Action.EXECUTE, State.CSI_IGNORE);
  entry(State.CSI_IGNORE, 0x19, Action.EXECUTE, State.CSI_IGNORE);
  range(State.CSI_IGNORE, 0x1c, 0x1f, Action.EXECUTE, State.CSI_IGNORE);
  range(State.CSI_IGNORE, 0x20, 0x3f, Action.IGNORE, State.CSI_IGNORE);
  range(State.CSI_IGNORE, 0x40, 0x7e, Action.NONE, State.GROUND);
  entry(State.CSI_IGNORE, 0x7f, Action.IGNORE, State.CSI_IGNORE);

  // ----- OSC_STRING -----
  // Most bytes are osc_put
  range(State.OSC_STRING, 0x20, 0x7e, Action.OSC_PUT, State.OSC_STRING);
  // BEL terminates OSC
  entry(State.OSC_STRING, 0x07, Action.OSC_END, State.GROUND);
  // ST (0x9c) already handled by anywhere rules
  // Other C0 (except ESC handled by anywhere)
  range(State.OSC_STRING, 0x08, 0x0d, Action.IGNORE, State.OSC_STRING);
  range(State.OSC_STRING, 0x0e, 0x17, Action.IGNORE, State.OSC_STRING);
  entry(State.OSC_STRING, 0x19, Action.IGNORE, State.OSC_STRING);
  range(State.OSC_STRING, 0x1c, 0x1f, Action.IGNORE, State.OSC_STRING);

  // ----- DCS_ENTRY -----
  range(State.DCS_ENTRY, 0x00, 0x17, Action.IGNORE, State.DCS_ENTRY);
  entry(State.DCS_ENTRY, 0x19, Action.IGNORE, State.DCS_ENTRY);
  range(State.DCS_ENTRY, 0x1c, 0x1f, Action.IGNORE, State.DCS_ENTRY);
  range(State.DCS_ENTRY, 0x20, 0x2f, Action.COLLECT, State.DCS_INTERMEDIATE);
  range(State.DCS_ENTRY, 0x30, 0x39, Action.PARAM, State.DCS_PARAM);
  entry(State.DCS_ENTRY, 0x3b, Action.PARAM, State.DCS_PARAM);
  range(State.DCS_ENTRY, 0x3c, 0x3f, Action.COLLECT, State.DCS_PARAM);
  range(State.DCS_ENTRY, 0x40, 0x7e, Action.HOOK, State.DCS_PASSTHROUGH);
  entry(State.DCS_ENTRY, 0x7f, Action.IGNORE, State.DCS_ENTRY);

  // ----- DCS_PARAM -----
  range(State.DCS_PARAM, 0x00, 0x17, Action.IGNORE, State.DCS_PARAM);
  entry(State.DCS_PARAM, 0x19, Action.IGNORE, State.DCS_PARAM);
  range(State.DCS_PARAM, 0x1c, 0x1f, Action.IGNORE, State.DCS_PARAM);
  range(State.DCS_PARAM, 0x20, 0x2f, Action.COLLECT, State.DCS_INTERMEDIATE);
  range(State.DCS_PARAM, 0x30, 0x39, Action.PARAM, State.DCS_PARAM);
  entry(State.DCS_PARAM, 0x3b, Action.PARAM, State.DCS_PARAM);
  range(State.DCS_PARAM, 0x3c, 0x3f, Action.IGNORE, State.DCS_IGNORE);
  range(State.DCS_PARAM, 0x40, 0x7e, Action.HOOK, State.DCS_PASSTHROUGH);
  entry(State.DCS_PARAM, 0x7f, Action.IGNORE, State.DCS_PARAM);

  // ----- DCS_INTERMEDIATE -----
  range(State.DCS_INTERMEDIATE, 0x00, 0x17, Action.IGNORE, State.DCS_INTERMEDIATE);
  entry(State.DCS_INTERMEDIATE, 0x19, Action.IGNORE, State.DCS_INTERMEDIATE);
  range(State.DCS_INTERMEDIATE, 0x1c, 0x1f, Action.IGNORE, State.DCS_INTERMEDIATE);
  range(State.DCS_INTERMEDIATE, 0x20, 0x2f, Action.COLLECT, State.DCS_INTERMEDIATE);
  range(State.DCS_INTERMEDIATE, 0x30, 0x3f, Action.IGNORE, State.DCS_IGNORE);
  range(State.DCS_INTERMEDIATE, 0x40, 0x7e, Action.HOOK, State.DCS_PASSTHROUGH);
  entry(State.DCS_INTERMEDIATE, 0x7f, Action.IGNORE, State.DCS_INTERMEDIATE);

  // ----- DCS_PASSTHROUGH -----
  range(State.DCS_PASSTHROUGH, 0x00, 0x17, Action.PUT, State.DCS_PASSTHROUGH);
  entry(State.DCS_PASSTHROUGH, 0x19, Action.PUT, State.DCS_PASSTHROUGH);
  range(State.DCS_PASSTHROUGH, 0x1c, 0x1f, Action.PUT, State.DCS_PASSTHROUGH);
  range(State.DCS_PASSTHROUGH, 0x20, 0x7e, Action.PUT, State.DCS_PASSTHROUGH);
  entry(State.DCS_PASSTHROUGH, 0x7f, Action.IGNORE, State.DCS_PASSTHROUGH);

  // ----- DCS_IGNORE -----
  range(State.DCS_IGNORE, 0x00, 0x17, Action.IGNORE, State.DCS_IGNORE);
  entry(State.DCS_IGNORE, 0x19, Action.IGNORE, State.DCS_IGNORE);
  range(State.DCS_IGNORE, 0x1c, 0x1f, Action.IGNORE, State.DCS_IGNORE);
  range(State.DCS_IGNORE, 0x20, 0x7f, Action.IGNORE, State.DCS_IGNORE);

  // ----- SOS_PM_APC_STRING -----
  // Everything ignored until ST (handled by anywhere rules via 0x9c and ESC \)
  range(State.SOS_PM_APC_STRING, 0x00, 0x17, Action.IGNORE, State.SOS_PM_APC_STRING);
  entry(State.SOS_PM_APC_STRING, 0x19, Action.IGNORE, State.SOS_PM_APC_STRING);
  range(State.SOS_PM_APC_STRING, 0x1c, 0x1f, Action.IGNORE, State.SOS_PM_APC_STRING);
  range(State.SOS_PM_APC_STRING, 0x20, 0x7f, Action.IGNORE, State.SOS_PM_APC_STRING);

  return t;
}

/** Extract the action from a packed transition byte. */
export function unpackAction(packed: number): Action {
  return (packed >>> 4) as Action;
}

/** Extract the next state from a packed transition byte. */
export function unpackState(packed: number): State {
  return (packed & 0x0f) as State;
}
