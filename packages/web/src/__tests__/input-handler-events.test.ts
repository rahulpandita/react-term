// @vitest-environment jsdom
/**
 * Tests for InputHandler DOM event handling:
 *  - Bracketed paste mode (setBracketedPasteMode)
 *  - Focus/blur sequences (setSendFocusEvents / mode 1004)
 *  - Mouse event encoding (default vs SGR, wheel scroll)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputHandler } from "../input-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode a Uint8Array passed to the onData spy into a plain string. */
function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Build a synthetic ClipboardEvent whose clipboardData.getData() returns `text`. */
function makePasteEvent(text: string): ClipboardEvent {
  const evt = new Event("paste") as ClipboardEvent;
  Object.defineProperty(evt, "clipboardData", {
    get: () => ({ getData: (_type: string) => text }),
  });
  return evt;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("InputHandler (DOM events)", () => {
  let container: HTMLDivElement;
  let onData: ReturnType<typeof vi.fn>;
  let handler: InputHandler;

  // cellWidth=8, cellHeight=16 — used to compute col/row from clientX/clientY.
  // jsdom's getBoundingClientRect() always returns {left:0, top:0, …},
  // so clientX / cellWidth  =  col  and  clientY / cellHeight  =  row.
  const CELL_W = 8;
  const CELL_H = 16;

  beforeEach(() => {
    onData = vi.fn();
    handler = new InputHandler({ onData });
    container = document.createElement("div");
    document.body.appendChild(container);
    handler.attach(container, CELL_W, CELL_H);
  });

  afterEach(() => {
    handler.dispose();
    document.body.removeChild(container);
  });

  function getTextarea(): HTMLTextAreaElement {
    const ta = container.querySelector("textarea");
    if (!ta) throw new Error("textarea not found");
    return ta;
  }

  // -------------------------------------------------------------------------
  // Bracketed paste mode
  // -------------------------------------------------------------------------

  describe("bracketed paste mode", () => {
    it("sends plain text when bracketed paste is disabled", () => {
      getTextarea().dispatchEvent(makePasteEvent("hello"));
      expect(onData).toHaveBeenCalledOnce();
      expect(decode(onData.mock.calls[0][0])).toBe("hello");
    });

    it("wraps text in ESC[200~/ESC[201~ when bracketed paste is enabled", () => {
      handler.setBracketedPasteMode(true);
      getTextarea().dispatchEvent(makePasteEvent("hello"));
      expect(onData).toHaveBeenCalledOnce();
      expect(decode(onData.mock.calls[0][0])).toBe("\x1b[200~hello\x1b[201~");
    });

    it("sends plain text again after disabling bracketed paste", () => {
      handler.setBracketedPasteMode(true);
      handler.setBracketedPasteMode(false);
      getTextarea().dispatchEvent(makePasteEvent("world"));
      expect(decode(onData.mock.calls[0][0])).toBe("world");
    });

    it("preserves newlines in pasted text when bracketed paste is enabled", () => {
      handler.setBracketedPasteMode(true);
      getTextarea().dispatchEvent(makePasteEvent("line1\nline2"));
      expect(decode(onData.mock.calls[0][0])).toBe("\x1b[200~line1\nline2\x1b[201~");
    });
  });

  // -------------------------------------------------------------------------
  // Focus / blur events (mode 1004)
  // -------------------------------------------------------------------------

  describe("focus events (mode 1004)", () => {
    it("does not send any sequence on focus when sendFocusEvents is false", () => {
      getTextarea().dispatchEvent(new Event("focus"));
      expect(onData).not.toHaveBeenCalled();
    });

    it("does not send any sequence on blur when sendFocusEvents is false", () => {
      getTextarea().dispatchEvent(new Event("blur"));
      expect(onData).not.toHaveBeenCalled();
    });

    it("sends ESC[I on textarea focus when sendFocusEvents is true", () => {
      handler.setSendFocusEvents(true);
      getTextarea().dispatchEvent(new Event("focus"));
      expect(onData).toHaveBeenCalledOnce();
      expect(decode(onData.mock.calls[0][0])).toBe("\x1b[I");
    });

    it("sends ESC[O on textarea blur when sendFocusEvents is true", () => {
      handler.setSendFocusEvents(true);
      getTextarea().dispatchEvent(new Event("blur"));
      expect(onData).toHaveBeenCalledOnce();
      expect(decode(onData.mock.calls[0][0])).toBe("\x1b[O");
    });
  });

  // -------------------------------------------------------------------------
  // Mouse event encoding
  //
  // getMouseCellPos() computes:
  //   col = Math.floor((clientX - rect.left) / cellWidth)
  //   row = Math.floor((clientY - rect.top)  / cellHeight)
  //
  // jsdom's getBoundingClientRect() always returns {left:0, top:0, …}.
  // With CELL_W=8, CELL_H=16:
  //   clientX=0 → col=0,  clientX=8 → col=1
  //   clientY=0 → row=0,  clientY=16 → row=1
  // -------------------------------------------------------------------------

  describe("mouse event encoding", () => {
    function mouseDown(clientX: number, clientY: number, button = 0): void {
      container.dispatchEvent(
        new MouseEvent("mousedown", { clientX, clientY, button, bubbles: true }),
      );
    }

    it("does not send any sequence on mousedown when protocol is 'none'", () => {
      mouseDown(0, 0);
      expect(onData).not.toHaveBeenCalled();
    });

    it("sends default X10 encoding for mouse-down with vt200 protocol at (0,0)", () => {
      handler.setMouseProtocol("vt200");
      mouseDown(0, 0); // col=0, row=0
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // encodeMouseEvent(button=0, col=0, row=0):
      //   cb = char(0+32)=char(32)=' ',  cx = char(0+1+32)=char(33)='!',  cy = char(0+1+32)='!'
      expect(seq).toBe(`\x1b[M ${String.fromCharCode(33)}${String.fromCharCode(33)}`);
    });

    it("sends SGR encoding for mouse-down with vt200+sgr at column 5, row 3", () => {
      handler.setMouseProtocol("vt200");
      handler.setMouseEncoding("sgr");
      mouseDown(5 * CELL_W, 3 * CELL_H); // col=5, row=3
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // encodeMouseEvent(button=0, col=5, row=3): ESC[<0;6;4M
      expect(seq).toBe("\x1b[<0;6;4M");
    });

    it("wheel up sends button 64 in default encoding", () => {
      handler.setMouseProtocol("vt200");
      container.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -1, clientX: 0, clientY: 0, bubbles: true }),
      );
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // encodeMouseEvent(button=64, col=0, row=0):
      //   cb = char(64+32)=char(96)='`',  cx='!', cy='!'
      expect(seq).toBe(`\x1b[M${String.fromCharCode(96)}!!`);
    });

    it("wheel down sends button 65 in SGR encoding", () => {
      handler.setMouseProtocol("vt200");
      handler.setMouseEncoding("sgr");
      container.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 1, clientX: 0, clientY: 0, bubbles: true }),
      );
      expect(onData).toHaveBeenCalledOnce();
      const seq = decode(onData.mock.calls[0][0]);
      // encodeMouseEvent(button=65, col=0, row=0): ESC[<65;1;1M
      expect(seq).toBe("\x1b[<65;1;1M");
    });
  });
});
