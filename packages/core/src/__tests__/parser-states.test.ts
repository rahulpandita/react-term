/**
 * Unit tests for the VT500 state machine transition TABLE.
 *
 * The TABLE is the foundation of the VTParser: every byte processed by the
 * parser is looked up here. These tests verify that key transitions are
 * correctly encoded in the table so that regressions in the state machine
 * are caught immediately rather than leaking through integration tests.
 */

import { describe, expect, it } from "vitest";
import { Action, State, TABLE, unpackAction, unpackState } from "../parser/states.js";

/** Look up the transition for a given state + byte. */
function transition(state: State, byte: number): { action: Action; next: State } {
  const packed = TABLE[state * 256 + byte];
  return { action: unpackAction(packed), next: unpackState(packed) };
}

describe("unpackAction / unpackState round-trip", () => {
  it("extracts action from high nibble", () => {
    // Action.PRINT = 1 packed with State.GROUND = 0 → 0x10
    const packed = TABLE[State.GROUND * 256 + 0x41]; // 'A' in GROUND → PRINT
    expect(unpackAction(packed)).toBe(Action.PRINT);
  });

  it("extracts state from low nibble", () => {
    const packed = TABLE[State.GROUND * 256 + 0x41];
    expect(unpackState(packed)).toBe(State.GROUND);
  });
});

describe("GROUND state", () => {
  it("printable ASCII (0x20–0x7e) → PRINT, stay in GROUND", () => {
    for (let b = 0x20; b <= 0x7e; b++) {
      const { action, next } = transition(State.GROUND, b);
      expect(action).toBe(Action.PRINT);
      expect(next).toBe(State.GROUND);
    }
  });

  it("high bytes 0xa0–0xff → PRINT, stay in GROUND (UTF-8 continuations)", () => {
    for (let b = 0xa0; b <= 0xff; b++) {
      const { action, next } = transition(State.GROUND, b);
      expect(action).toBe(Action.PRINT);
      expect(next).toBe(State.GROUND);
    }
  });

  it("C0 controls 0x00–0x17 → EXECUTE, stay in GROUND", () => {
    for (let b = 0x00; b <= 0x17; b++) {
      const { action, next } = transition(State.GROUND, b);
      expect(action).toBe(Action.EXECUTE);
      expect(next).toBe(State.GROUND);
    }
  });

  it("0x19 → EXECUTE, stay in GROUND", () => {
    const { action, next } = transition(State.GROUND, 0x19);
    expect(action).toBe(Action.EXECUTE);
    expect(next).toBe(State.GROUND);
  });

  it("0x7f (DEL) → EXECUTE, stay in GROUND", () => {
    const { action, next } = transition(State.GROUND, 0x7f);
    expect(action).toBe(Action.EXECUTE);
    expect(next).toBe(State.GROUND);
  });
});

describe("Anywhere rules (apply to every state)", () => {
  const allStates = Object.values(State).filter((v) => typeof v === "number") as State[];

  it("0x1b (ESC) → CLEAR + ESCAPE from every state", () => {
    for (const s of allStates) {
      const { action, next } = transition(s, 0x1b);
      expect(action).toBe(Action.CLEAR);
      expect(next).toBe(State.ESCAPE);
    }
  });

  it("0x18 (CAN) → EXECUTE + GROUND from every state", () => {
    for (const s of allStates) {
      const { action, next } = transition(s, 0x18);
      expect(action).toBe(Action.EXECUTE);
      expect(next).toBe(State.GROUND);
    }
  });

  it("0x1a (SUB) → EXECUTE + GROUND from every state", () => {
    for (const s of allStates) {
      const { action, next } = transition(s, 0x1a);
      expect(action).toBe(Action.EXECUTE);
      expect(next).toBe(State.GROUND);
    }
  });

  it("0x9c (ST) → NONE + GROUND from most states (except DCS_PASSTHROUGH)", () => {
    // DCS_PASSTHROUGH overrides 0x9c to UNHOOK (to dispatch the DCS handler)
    for (const s of allStates) {
      if (s === State.DCS_PASSTHROUGH) continue;
      const { action, next } = transition(s, 0x9c);
      expect(action).toBe(Action.NONE);
      expect(next).toBe(State.GROUND);
    }
  });

  it("0x9c (ST) in DCS_PASSTHROUGH → UNHOOK + GROUND (dispatches DCS handler)", () => {
    const { action, next } = transition(State.DCS_PASSTHROUGH, 0x9c);
    expect(action).toBe(Action.UNHOOK);
    expect(next).toBe(State.GROUND);
  });

  it("0x9b (C1 CSI) → CLEAR + CSI_ENTRY from every state", () => {
    for (const s of allStates) {
      const { action, next } = transition(s, 0x9b);
      expect(action).toBe(Action.CLEAR);
      expect(next).toBe(State.CSI_ENTRY);
    }
  });

  it("0x9d (C1 OSC) → OSC_START + OSC_STRING from every state", () => {
    for (const s of allStates) {
      const { action, next } = transition(s, 0x9d);
      expect(action).toBe(Action.OSC_START);
      expect(next).toBe(State.OSC_STRING);
    }
  });

  it("0x90 (C1 DCS) → CLEAR + DCS_ENTRY from every state", () => {
    for (const s of allStates) {
      const { action, next } = transition(s, 0x90);
      expect(action).toBe(Action.CLEAR);
      expect(next).toBe(State.DCS_ENTRY);
    }
  });

  it("0x98/0x9e/0x9f (SOS/PM/APC) → SOS_PM_APC_STRING from every state", () => {
    for (const b of [0x98, 0x9e, 0x9f]) {
      for (const s of allStates) {
        const { next } = transition(s, b);
        expect(next).toBe(State.SOS_PM_APC_STRING);
      }
    }
  });
});

describe("ESCAPE state", () => {
  it("0x5b ('[') → CLEAR + CSI_ENTRY (ESC [)", () => {
    const { action, next } = transition(State.ESCAPE, 0x5b);
    expect(action).toBe(Action.CLEAR);
    expect(next).toBe(State.CSI_ENTRY);
  });

  it("0x5d (']') → OSC_START + OSC_STRING (ESC ])", () => {
    const { action, next } = transition(State.ESCAPE, 0x5d);
    expect(action).toBe(Action.OSC_START);
    expect(next).toBe(State.OSC_STRING);
  });

  it("0x50 ('P') → CLEAR + DCS_ENTRY (ESC P)", () => {
    const { action, next } = transition(State.ESCAPE, 0x50);
    expect(action).toBe(Action.CLEAR);
    expect(next).toBe(State.DCS_ENTRY);
  });

  it("0x58/0x5e/0x5f (SOS/PM/APC) → SOS_PM_APC_STRING", () => {
    for (const b of [0x58, 0x5e, 0x5f]) {
      const { next } = transition(State.ESCAPE, b);
      expect(next).toBe(State.SOS_PM_APC_STRING);
    }
  });

  it("final characters 0x30–0x4f → ESC_DISPATCH + GROUND", () => {
    for (let b = 0x30; b <= 0x4f; b++) {
      const { action, next } = transition(State.ESCAPE, b);
      expect(action).toBe(Action.ESC_DISPATCH);
      expect(next).toBe(State.GROUND);
    }
  });

  it("intermediate bytes 0x20–0x2f → COLLECT + ESCAPE_INTERMEDIATE", () => {
    for (let b = 0x20; b <= 0x2f; b++) {
      const { action, next } = transition(State.ESCAPE, b);
      expect(action).toBe(Action.COLLECT);
      expect(next).toBe(State.ESCAPE_INTERMEDIATE);
    }
  });

  it("0x7f → IGNORE, stay in ESCAPE", () => {
    const { action, next } = transition(State.ESCAPE, 0x7f);
    expect(action).toBe(Action.IGNORE);
    expect(next).toBe(State.ESCAPE);
  });
});

describe("CSI_ENTRY state", () => {
  it("digits 0x30–0x39 → PARAM + CSI_PARAM", () => {
    for (let b = 0x30; b <= 0x39; b++) {
      const { action, next } = transition(State.CSI_ENTRY, b);
      expect(action).toBe(Action.PARAM);
      expect(next).toBe(State.CSI_PARAM);
    }
  });

  it("0x3b (';') → PARAM + CSI_PARAM", () => {
    const { action, next } = transition(State.CSI_ENTRY, 0x3b);
    expect(action).toBe(Action.PARAM);
    expect(next).toBe(State.CSI_PARAM);
  });

  it("private markers 0x3c–0x3f → COLLECT + CSI_PARAM", () => {
    for (let b = 0x3c; b <= 0x3f; b++) {
      const { action, next } = transition(State.CSI_ENTRY, b);
      expect(action).toBe(Action.COLLECT);
      expect(next).toBe(State.CSI_PARAM);
    }
  });

  it("final bytes 0x40–0x7e → CSI_DISPATCH + GROUND", () => {
    for (let b = 0x40; b <= 0x7e; b++) {
      const { action, next } = transition(State.CSI_ENTRY, b);
      expect(action).toBe(Action.CSI_DISPATCH);
      expect(next).toBe(State.GROUND);
    }
  });

  it("intermediates 0x20–0x2f → COLLECT + CSI_INTERMEDIATE", () => {
    for (let b = 0x20; b <= 0x2f; b++) {
      const { action, next } = transition(State.CSI_ENTRY, b);
      expect(action).toBe(Action.COLLECT);
      expect(next).toBe(State.CSI_INTERMEDIATE);
    }
  });
});

describe("CSI_PARAM state", () => {
  it("digits 0x30–0x39 → PARAM, stay in CSI_PARAM", () => {
    for (let b = 0x30; b <= 0x39; b++) {
      const { action, next } = transition(State.CSI_PARAM, b);
      expect(action).toBe(Action.PARAM);
      expect(next).toBe(State.CSI_PARAM);
    }
  });

  it("0x3b (';') → PARAM, stay in CSI_PARAM", () => {
    const { action, next } = transition(State.CSI_PARAM, 0x3b);
    expect(action).toBe(Action.PARAM);
    expect(next).toBe(State.CSI_PARAM);
  });

  it("0x3c–0x3f → IGNORE + CSI_IGNORE (invalid mid-param private markers)", () => {
    for (let b = 0x3c; b <= 0x3f; b++) {
      const { action, next } = transition(State.CSI_PARAM, b);
      expect(action).toBe(Action.IGNORE);
      expect(next).toBe(State.CSI_IGNORE);
    }
  });

  it("final bytes 0x40–0x7e → CSI_DISPATCH + GROUND", () => {
    for (let b = 0x40; b <= 0x7e; b++) {
      const { action, next } = transition(State.CSI_PARAM, b);
      expect(action).toBe(Action.CSI_DISPATCH);
      expect(next).toBe(State.GROUND);
    }
  });
});

describe("OSC_STRING state", () => {
  it("0x07 (BEL) → OSC_END + GROUND", () => {
    const { action, next } = transition(State.OSC_STRING, 0x07);
    expect(action).toBe(Action.OSC_END);
    expect(next).toBe(State.GROUND);
  });

  it("printable bytes 0x20–0x7e → OSC_PUT, stay in OSC_STRING", () => {
    for (let b = 0x20; b <= 0x7e; b++) {
      const { action, next } = transition(State.OSC_STRING, b);
      expect(action).toBe(Action.OSC_PUT);
      expect(next).toBe(State.OSC_STRING);
    }
  });
});

describe("DCS_ENTRY state", () => {
  it("final bytes 0x40–0x7e → HOOK + DCS_PASSTHROUGH", () => {
    for (let b = 0x40; b <= 0x7e; b++) {
      const { action, next } = transition(State.DCS_ENTRY, b);
      expect(action).toBe(Action.HOOK);
      expect(next).toBe(State.DCS_PASSTHROUGH);
    }
  });

  it("digits 0x30–0x39 → PARAM + DCS_PARAM", () => {
    for (let b = 0x30; b <= 0x39; b++) {
      const { action, next } = transition(State.DCS_ENTRY, b);
      expect(action).toBe(Action.PARAM);
      expect(next).toBe(State.DCS_PARAM);
    }
  });
});

describe("DCS_PASSTHROUGH state", () => {
  it("printable bytes 0x20–0x7e → PUT, stay in DCS_PASSTHROUGH", () => {
    for (let b = 0x20; b <= 0x7e; b++) {
      const { action, next } = transition(State.DCS_PASSTHROUGH, b);
      expect(action).toBe(Action.PUT);
      expect(next).toBe(State.DCS_PASSTHROUGH);
    }
  });

  it("0x9c (C1 ST) → UNHOOK + GROUND (terminates DCS)", () => {
    const { action, next } = transition(State.DCS_PASSTHROUGH, 0x9c);
    expect(action).toBe(Action.UNHOOK);
    expect(next).toBe(State.GROUND);
  });

  it("C0 controls 0x00–0x17 → PUT, stay in DCS_PASSTHROUGH", () => {
    for (let b = 0x00; b <= 0x17; b++) {
      const { action, next } = transition(State.DCS_PASSTHROUGH, b);
      expect(action).toBe(Action.PUT);
      expect(next).toBe(State.DCS_PASSTHROUGH);
    }
  });

  it("0x7f → IGNORE, stay in DCS_PASSTHROUGH", () => {
    const { action, next } = transition(State.DCS_PASSTHROUGH, 0x7f);
    expect(action).toBe(Action.IGNORE);
    expect(next).toBe(State.DCS_PASSTHROUGH);
  });
});

describe("CSI_IGNORE state", () => {
  it("final bytes 0x40–0x7e → NONE + GROUND (silently absorbed)", () => {
    for (let b = 0x40; b <= 0x7e; b++) {
      const { action, next } = transition(State.CSI_IGNORE, b);
      expect(action).toBe(Action.NONE);
      expect(next).toBe(State.GROUND);
    }
  });

  it("0x20–0x3f → IGNORE, stay in CSI_IGNORE", () => {
    for (let b = 0x20; b <= 0x3f; b++) {
      const { action, next } = transition(State.CSI_IGNORE, b);
      expect(action).toBe(Action.IGNORE);
      expect(next).toBe(State.CSI_IGNORE);
    }
  });
});

describe("SOS_PM_APC_STRING state", () => {
  it("0x20–0x7f → IGNORE, stay in SOS_PM_APC_STRING", () => {
    for (let b = 0x20; b <= 0x7f; b++) {
      const { action, next } = transition(State.SOS_PM_APC_STRING, b);
      expect(action).toBe(Action.IGNORE);
      expect(next).toBe(State.SOS_PM_APC_STRING);
    }
  });
});
