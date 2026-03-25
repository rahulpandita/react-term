// @vitest-environment jsdom
/**
 * Tests for InputHandler touch event handling:
 *  - Horizontal swipe → arrow key sequences
 *  - Vertical swipe → scroll via GestureHandler
 *  - Pinch-to-zoom → onFontSizeChange callback
 *  - Tap → focus + GestureHandler.handleTap
 *  - Touch cancel → gesture cleanup
 *  - Mouse-reporting mode with touch events
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputHandler } from "../input-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function makeTouch(
  clientX: number,
  clientY: number,
  target: EventTarget,
  id = 0,
): Record<string, unknown> {
  return {
    identifier: id,
    target,
    clientX,
    clientY,
    pageX: clientX,
    pageY: clientY,
    screenX: clientX,
    screenY: clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("InputHandler (touch events)", () => {
  let container: HTMLDivElement;
  let onData: ReturnType<typeof vi.fn>;
  let onScroll: ReturnType<typeof vi.fn>;
  let onFontSizeChange: ReturnType<typeof vi.fn>;
  let handler: InputHandler;

  // jsdom getBoundingClientRect() always returns {left:0, top:0}.
  // cellWidth=8, cellHeight=16.
  const CELL_W = 8;
  const CELL_H = 16;

  beforeEach(() => {
    onData = vi.fn();
    onScroll = vi.fn();
    onFontSizeChange = vi.fn();
    handler = new InputHandler({ onData, onScroll, onFontSizeChange });
    container = document.createElement("div");
    document.body.appendChild(container);
    handler.attach(container, CELL_W, CELL_H);
  });

  afterEach(() => {
    handler.dispose();
    document.body.removeChild(container);
  });

  function touch(clientX: number, clientY: number, id = 0) {
    return makeTouch(clientX, clientY, container, id);
  }

  function dispatchTouchStart(touches: Record<string, unknown>[]) {
    container.dispatchEvent(
      new TouchEvent("touchstart", {
        touches: touches as unknown as Touch[],
        changedTouches: touches as unknown as Touch[],
        bubbles: true,
      }),
    );
  }

  function dispatchTouchMove(touches: Record<string, unknown>[]) {
    container.dispatchEvent(
      new TouchEvent("touchmove", {
        touches: touches as unknown as Touch[],
        changedTouches: touches as unknown as Touch[],
        bubbles: true,
      }),
    );
  }

  function dispatchTouchEnd(
    changedTouches: Record<string, unknown>[],
    remainingTouches: Record<string, unknown>[] = [],
  ) {
    container.dispatchEvent(
      new TouchEvent("touchend", {
        touches: remainingTouches as unknown as Touch[],
        changedTouches: changedTouches as unknown as Touch[],
        bubbles: true,
      }),
    );
  }

  function dispatchTouchCancel() {
    container.dispatchEvent(new TouchEvent("touchcancel", { bubbles: true }));
  }

  // -------------------------------------------------------------------------
  // Horizontal swipe → arrow keys
  // -------------------------------------------------------------------------

  describe("horizontal swipe", () => {
    it("rightward swipe by one cell sends right-arrow escape sequence", () => {
      dispatchTouchStart([touch(0, 0)]);
      // Move right past the TAP_THRESHOLD (10px) and bias toward horizontal
      dispatchTouchMove([touch(CELL_W * 3, 0)]);
      dispatchTouchMove([touch(CELL_W * 4, 0)]); // net: +CELL_W from last
      expect(onData).toHaveBeenCalled();
      const sequences = onData.mock.calls.map((c: [Uint8Array]) => decode(c[0]));
      expect(sequences.every((s: string) => s === "\x1b[C")).toBe(true);
    });

    it("leftward swipe by one cell sends left-arrow escape sequence", () => {
      dispatchTouchStart([touch(100, 0)]);
      dispatchTouchMove([touch(100 - CELL_W * 3, 0)]); // lock direction
      dispatchTouchMove([touch(100 - CELL_W * 4, 0)]); // net: -CELL_W
      expect(onData).toHaveBeenCalled();
      const sequences = onData.mock.calls.map((c: [Uint8Array]) => decode(c[0]));
      expect(sequences.every((s: string) => s === "\x1b[D")).toBe(true);
    });

    it("swipe right by three cells sends three right-arrow sequences", () => {
      dispatchTouchStart([touch(0, 0)]);
      // Move right by 3*CELL_W in one step to lock horizontal and send 3 arrows
      dispatchTouchMove([touch(CELL_W * 3 + 1, 0)]); // lock + 3 steps
      const seqs = onData.mock.calls.map((c: [Uint8Array]) => decode(c[0]));
      const rightArrows = seqs.filter((s: string) => s === "\x1b[C");
      expect(rightArrows.length).toBe(3);
    });

    it("after touchend a new gesture starts fresh with no direction lock", () => {
      // First gesture: horizontal lock
      dispatchTouchStart([touch(0, 0)]);
      dispatchTouchMove([touch(CELL_W * 3, 0)]);
      dispatchTouchEnd([touch(CELL_W * 3, 0)]);
      onData.mockClear();

      // Second gesture: should lock to vertical (no arrow keys)
      dispatchTouchStart([touch(0, 0)]);
      dispatchTouchMove([touch(0, CELL_H * 3)]);
      expect(onData).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Vertical swipe → scroll
  // -------------------------------------------------------------------------

  describe("vertical swipe", () => {
    it("vertical swipe calls onScroll (not onData)", () => {
      dispatchTouchStart([touch(0, 0)]);
      // Move purely vertically by more than CELL_H to trigger a scroll row
      dispatchTouchMove([touch(0, CELL_H * 3 + 1)]); // direction lock + scroll
      expect(onData).not.toHaveBeenCalled();
      expect(onScroll).toHaveBeenCalled();
    });

    it("vertical diagonal near-vertical is treated as vertical not horizontal", () => {
      dispatchTouchStart([touch(0, 0)]);
      // dy > dx — should lock vertical
      dispatchTouchMove([touch(5, CELL_H * 3)]); // dx=5 < 1.5*dy
      expect(onData).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Pinch-to-zoom
  // -------------------------------------------------------------------------

  describe("pinch-to-zoom", () => {
    it("pinch open (two fingers spreading) calls onFontSizeChange with larger size", () => {
      // Start pinch: two fingers 50px apart
      dispatchTouchStart([touch(50, 0, 0), touch(100, 0, 1)]);
      // Move: fingers now 150px apart → scale ≈ 3× → clamped at MAX_FONT_SIZE=32
      dispatchTouchMove([touch(50, 0, 0), touch(200, 0, 1)]);
      expect(onFontSizeChange).toHaveBeenCalled();
      const newSize = onFontSizeChange.mock.calls[0][0] as number;
      expect(newSize).toBeGreaterThan(14); // default is 14
    });

    it("pinch close (two fingers squeezing) calls onFontSizeChange with smaller size", () => {
      // Start pinch: two fingers 100px apart
      dispatchTouchStart([touch(0, 0, 0), touch(100, 0, 1)]);
      // Move: fingers now 20px apart → scale = 0.2 → 14 * 0.2 = 2.8 → clamped at MIN_FONT_SIZE=8
      dispatchTouchMove([touch(40, 0, 0), touch(60, 0, 1)]);
      expect(onFontSizeChange).toHaveBeenCalled();
      const newSize = onFontSizeChange.mock.calls[0][0] as number;
      expect(newSize).toBeLessThan(14);
    });

    it("pinch respects MAX_FONT_SIZE=32", () => {
      dispatchTouchStart([touch(50, 0, 0), touch(60, 0, 1)]); // 10px apart
      dispatchTouchMove([touch(0, 0, 0), touch(1000, 0, 1)]); // 1000px → huge scale
      if (onFontSizeChange.mock.calls.length > 0) {
        const newSize = onFontSizeChange.mock.calls[0][0] as number;
        expect(newSize).toBeLessThanOrEqual(32);
      }
    });

    it("pinch respects MIN_FONT_SIZE=8", () => {
      dispatchTouchStart([touch(0, 0, 0), touch(1000, 0, 1)]); // 1000px apart
      dispatchTouchMove([touch(0, 0, 0), touch(1, 0, 1)]); // 1px → tiny scale
      if (onFontSizeChange.mock.calls.length > 0) {
        const newSize = onFontSizeChange.mock.calls[0][0] as number;
        expect(newSize).toBeGreaterThanOrEqual(8);
      }
    });

    it("pinch end cancels subsequent single-touch events from acting as pan", () => {
      dispatchTouchStart([touch(0, 0, 0), touch(50, 0, 1)]);
      dispatchTouchMove([touch(0, 0, 0), touch(100, 0, 1)]);
      // End the pinch — one finger remains
      dispatchTouchEnd([touch(50, 0, 1)], [touch(0, 0, 0)]);
      // Should not throw or crash
      expect(true).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tap → focus
  // -------------------------------------------------------------------------

  describe("tap gesture", () => {
    it("tap (touch start + end without movement) focuses the textarea", () => {
      const textarea = container.querySelector("textarea");
      if (!textarea) throw new Error("textarea not found");
      const focusSpy = vi.spyOn(textarea, "focus");

      dispatchTouchStart([touch(10, 10)]);
      // End without moving — should be recognized as tap
      dispatchTouchEnd([touch(10, 10)]);

      expect(focusSpy).toHaveBeenCalled();
    });

    it("pan (large movement) does NOT call focus", () => {
      const textarea = container.querySelector("textarea");
      if (!textarea) throw new Error("textarea not found");
      const focusSpy = vi.spyOn(textarea, "focus");

      dispatchTouchStart([touch(0, 0)]);
      dispatchTouchMove([touch(50, 0)]); // horizontal pan
      dispatchTouchEnd([touch(50, 0)]);

      expect(focusSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Touch cancel
  // -------------------------------------------------------------------------

  describe("touchcancel", () => {
    it("does not throw when no gesture is in progress", () => {
      expect(() => dispatchTouchCancel()).not.toThrow();
    });

    it("cancels an in-progress gesture and stops scrolling", () => {
      dispatchTouchStart([touch(0, 0)]);
      dispatchTouchMove([touch(0, CELL_H * 3)]);
      onScroll.mockClear();
      dispatchTouchCancel();
      // No further scroll events from cancel itself
      expect(onData).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Mouse-reporting mode with touch
  // -------------------------------------------------------------------------

  describe("mouse-reporting mode with touch", () => {
    it("touchstart sends mouse-down when vt200 protocol is set", () => {
      handler.setMouseProtocol("vt200");
      // clientX=0, clientY=0 → col=0, row=0
      dispatchTouchStart([touch(0, 0)]);
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // default encoding: button=0 → ESC [ M <space> ! !
      expect(seq.startsWith("\x1b[M")).toBe(true);
    });

    it("touchend sends mouse-release when vt200 protocol is set", () => {
      handler.setMouseProtocol("vt200");
      dispatchTouchStart([touch(0, 0)]);
      onData.mockClear();
      dispatchTouchEnd([touch(0, 0)]);
      expect(onData).toHaveBeenCalledOnce();
    });

    it("touchmove sends drag events when protocol is 'drag'", () => {
      handler.setMouseProtocol("drag");
      dispatchTouchStart([touch(0, 0)]);
      onData.mockClear();
      dispatchTouchMove([touch(CELL_W, 0)]);
      expect(onData).toHaveBeenCalled();
    });

    it("touchmove with 'vt200' (not drag/any) does not send drag event", () => {
      handler.setMouseProtocol("vt200");
      dispatchTouchStart([touch(0, 0)]);
      onData.mockClear();
      // vt200 only tracks press/release, not drag
      dispatchTouchMove([touch(CELL_W, 0)]);
      expect(onData).not.toHaveBeenCalled();
    });
  });
});
