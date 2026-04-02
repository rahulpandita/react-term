// @vitest-environment jsdom
/**
 * Tests for InputHandler mouse protocol and selection:
 *  - mouseup release sequences (vt200 default, SGR 'm' suffix)
 *  - x10 protocol — no release on mouseup
 *  - right-click / middle-click ignored
 *  - mousemove for 'any' protocol (motion on every move)
 *  - mousemove for 'drag' protocol (motion only when button held)
 *  - selection state via onSelectionChange when protocol = 'none'
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputHandler } from "../input-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("InputHandler (mouse protocol and selection)", () => {
  let container: HTMLDivElement;
  let onData: ReturnType<typeof vi.fn>;
  let onSelectionChange: ReturnType<typeof vi.fn>;
  let handler: InputHandler;

  // cellWidth=8, cellHeight=16 — jsdom getBoundingClientRect always returns
  // {left:0, top:0}, so col = floor(clientX / 8), row = floor(clientY / 16).
  const CELL_W = 8;
  const CELL_H = 16;

  beforeEach(() => {
    onData = vi.fn();
    onSelectionChange = vi.fn();
    handler = new InputHandler({ onData, onSelectionChange });
    container = document.createElement("div");
    document.body.appendChild(container);
    handler.attach(container, CELL_W, CELL_H);
  });

  afterEach(() => {
    handler.dispose();
    document.body.removeChild(container);
  });

  // Dispatch helpers.
  // mousedown → container; mousemove / mouseup → document
  // (mirrors InputHandler's addEventListener calls).

  function mouseDown(clientX: number, clientY: number, button = 0): void {
    container.dispatchEvent(
      new MouseEvent("mousedown", { clientX, clientY, button, bubbles: true }),
    );
  }

  function mouseMove(clientX: number, clientY: number, buttons = 0): void {
    document.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY, buttons }));
  }

  function mouseUp(clientX: number, clientY: number): void {
    document.dispatchEvent(new MouseEvent("mouseup", { clientX, clientY }));
  }

  // -------------------------------------------------------------------------
  // mouseup release — vt200 protocol
  // -------------------------------------------------------------------------

  describe("mouseup release (vt200 protocol)", () => {
    it("sends button=3 release on mouseup with default encoding", () => {
      handler.setMouseProtocol("vt200");
      mouseDown(0, 0);
      onData.mockClear();
      mouseUp(0, 0); // col=0, row=0
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // encodeMouseEvent(3, 0, 0): cb=char(35)='#', cx='!', cy='!'
      expect(seq).toBe(`\x1b[M${String.fromCharCode(35)}!!`);
    });

    it("sends SGR release with 'm' suffix on mouseup", () => {
      handler.setMouseProtocol("vt200");
      handler.setMouseEncoding("sgr");
      mouseUp(0, 0); // col=0, row=0
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // encodeMouseEvent(3, 0, 0) SGR: final='m', btn=0 → ESC[<0;1;1m
      expect(seq).toBe("\x1b[<0;1;1m");
    });

    it("encodes release position correctly (col=3, row=2) in SGR", () => {
      handler.setMouseProtocol("vt200");
      handler.setMouseEncoding("sgr");
      mouseUp(3 * CELL_W, 2 * CELL_H); // col=3, row=2
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // encodeMouseEvent(3, 3, 2): ESC[<0;4;3m
      expect(seq).toBe("\x1b[<0;4;3m");
    });
  });

  // -------------------------------------------------------------------------
  // x10 protocol — mousedown works, mouseup does NOT send release
  // -------------------------------------------------------------------------

  describe("x10 protocol (no release)", () => {
    it("sends mousedown sequence for x10", () => {
      handler.setMouseProtocol("x10");
      mouseDown(0, 0);
      expect(onData).toHaveBeenCalledOnce();
    });

    it("does NOT send any sequence on mouseup for x10", () => {
      handler.setMouseProtocol("x10");
      mouseDown(0, 0);
      onData.mockClear();
      mouseUp(0, 0);
      expect(onData).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Right-click / middle-click ignored
  // -------------------------------------------------------------------------

  describe("non-left-button clicks ignored", () => {
    it("does not send sequence for right-click (button=2) with vt200", () => {
      handler.setMouseProtocol("vt200");
      mouseDown(0, 0, 2); // button=2 → right-click
      expect(onData).not.toHaveBeenCalled();
    });

    it("does not send sequence for middle-click (button=1) with vt200", () => {
      handler.setMouseProtocol("vt200");
      mouseDown(0, 0, 1); // button=1 → middle-click
      expect(onData).not.toHaveBeenCalled();
    });

    it("does not send sequence for right-click when protocol is 'none'", () => {
      mouseDown(0, 0, 2);
      expect(onData).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 'any' protocol — sends motion sequence on every mousemove
  // -------------------------------------------------------------------------

  describe("any protocol mousemove", () => {
    it("sends motion sequence on mousemove with default encoding", () => {
      handler.setMouseProtocol("any");
      mouseMove(CELL_W, CELL_H); // col=1, row=1
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // encodeMouseEvent(32, 1, 1): cb=char(64)='@', cx=char(34)='"', cy=char(34)='"'
      expect(seq).toBe(`\x1b[M@${String.fromCharCode(34)}${String.fromCharCode(34)}`);
    });

    it("sends SGR motion sequence on mousemove", () => {
      handler.setMouseProtocol("any");
      handler.setMouseEncoding("sgr");
      mouseMove(2 * CELL_W, CELL_H); // col=2, row=1
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // encodeMouseEvent(32, 2, 1): ESC[<32;3;2M
      expect(seq).toBe("\x1b[<32;3;2M");
    });

    it("sends motion on every move — fires once per mousemove", () => {
      handler.setMouseProtocol("any");
      mouseMove(0, 0);
      mouseMove(CELL_W, 0);
      expect(onData).toHaveBeenCalledTimes(2);
    });

    it("sends motion even without any button held", () => {
      handler.setMouseProtocol("any");
      mouseMove(0, 0, 0); // buttons=0 — no button held
      expect(onData).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // 'drag' protocol — motion only when left button is held
  // -------------------------------------------------------------------------

  describe("drag protocol mousemove", () => {
    it("sends motion sequence when left button is held (buttons=1)", () => {
      handler.setMouseProtocol("drag");
      mouseMove(0, 0, 1); // buttons=1 → left button held
      expect(onData).toHaveBeenCalledOnce();
    });

    it("does NOT send motion when no button is held (buttons=0)", () => {
      handler.setMouseProtocol("drag");
      mouseMove(0, 0, 0); // buttons=0 → no button
      expect(onData).not.toHaveBeenCalled();
    });

    it("sends correct SGR motion sequence for drag (col=1, row=0)", () => {
      handler.setMouseProtocol("drag");
      handler.setMouseEncoding("sgr");
      mouseMove(CELL_W, 0, 1); // col=1, row=0, button held
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // encodeMouseEvent(32, 1, 0): ESC[<32;2;1M
      expect(seq).toBe("\x1b[<32;2;1M");
    });
  });

  // -------------------------------------------------------------------------
  // Selection behavior (protocol = 'none')
  // -------------------------------------------------------------------------

  describe("selection (protocol = 'none')", () => {
    it("mousedown does NOT emit onData", () => {
      mouseDown(0, 0);
      expect(onData).not.toHaveBeenCalled();
    });

    it("mousemove after mousedown fires onSelectionChange with updated range", () => {
      mouseDown(0, 0); // start at col=0, row=0
      mouseMove(2 * CELL_W, CELL_H); // move to col=2, row=1
      expect(onSelectionChange).toHaveBeenCalled();
      const lastSel = onSelectionChange.mock.calls.at(-1)?.[0];
      expect(lastSel).toMatchObject({ startRow: 0, startCol: 0, endRow: 1, endCol: 2 });
    });

    it("mouseup on same cell as mousedown fires onSelectionChange(null)", () => {
      mouseDown(0, 0);
      mouseUp(0, 0); // same position → single click → no selection
      expect(onSelectionChange).toHaveBeenCalledWith(null);
    });

    it("mousemove without prior mousedown does not fire onSelectionChange", () => {
      mouseMove(CELL_W, CELL_H);
      expect(onSelectionChange).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Container-offset coordinate calculation
  //
  // jsdom getBoundingClientRect() always returns {left:0, top:0}.
  // Mock it here to verify that the InputHandler correctly subtracts the
  // container offset when converting screen coordinates to grid cell positions.
  // -------------------------------------------------------------------------

  describe("container-offset mouse coordinate calculation", () => {
    it("translates clientX/clientY correctly when container is offset on the page", () => {
      // Container is at (left=100, top=50) on the page.
      vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
        left: 100,
        top: 50,
        right: 100 + 80 * CELL_W,
        bottom: 50 + 24 * CELL_H,
        width: 80 * CELL_W,
        height: 24 * CELL_H,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      } as DOMRect);

      handler.setMouseProtocol("vt200");
      handler.setMouseEncoding("sgr");

      // Click at screen (140, 82): local x = 140-100 = 40, y = 82-50 = 32
      // col = floor(40 / 8) = 5, row = floor(32 / 16) = 2
      mouseDown(140, 82);
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // SGR press at col=5, row=2: ESC[<0;6;3M
      expect(seq).toBe("\x1b[<0;6;3M");
    });

    it("clamps to col=0, row=0 when click is to the left or above the container", () => {
      vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
        left: 200,
        top: 100,
        right: 200 + 80 * CELL_W,
        bottom: 100 + 24 * CELL_H,
        width: 80 * CELL_W,
        height: 24 * CELL_H,
        x: 200,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect);

      handler.setMouseProtocol("vt200");
      handler.setMouseEncoding("sgr");

      // Click at (50, 30) — both x and y are left/above the container
      // local x = 50-200 = -150, local y = 30-100 = -70 → clamp to col=0, row=0
      mouseDown(50, 30);
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // ESC[<0;1;1M (col=0→1-indexed=1, row=0→1-indexed=1)
      expect(seq).toBe("\x1b[<0;1;1M");
    });

    it("updateCellSize changes are reflected in subsequent mouse coordinate calculations", () => {
      handler.setMouseProtocol("vt200");
      handler.setMouseEncoding("sgr");

      // Change to larger cells (16×20)
      handler.updateCellSize(16, 20);

      // Click at (32, 40): col = floor(32/16) = 2, row = floor(40/20) = 2
      mouseDown(32, 40);
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // ESC[<0;3;3M (col=2→1-indexed=3, row=2→1-indexed=3)
      expect(seq).toBe("\x1b[<0;3;3M");
    });
  });
});
