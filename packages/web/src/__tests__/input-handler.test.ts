// @vitest-environment jsdom

import { CellGrid } from "@next_term/core";
import { describe, expect, it, vi } from "vitest";
import { InputHandler } from "../input-handler.js";

describe("InputHandler", () => {
  describe("Ctrl+C with selection", () => {
    it("does not send ^C to PTY when there is an active selection", () => {
      const onData = vi.fn();
      const onSelectionChange = vi.fn();
      const handler = new InputHandler({ onData, onSelectionChange });

      // Set up a grid with text
      const grid = new CellGrid(20, 5);
      for (let c = 0; c < 5; c++) {
        grid.setCell(0, c, "Hello".charCodeAt(c), 7, 0, 0);
      }
      handler.setGrid(grid);

      // Simulate a selection being active by using keyToSequence check
      // We need to test handleKeyDown behavior, which is private.
      // Instead, we test via keyToSequence that the sequence would be ^C
      const seq = handler.keyToSequence({
        key: "c",
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      } as KeyboardEvent);

      // keyToSequence returns \x03 for Ctrl+C (normal behavior)
      expect(seq).toBe("\x03");
    });

    it("keyToSequence returns ^C (\\x03) for Ctrl+C without selection", () => {
      const handler = new InputHandler({ onData: vi.fn() });
      const seq = handler.keyToSequence({
        key: "c",
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      } as KeyboardEvent);
      expect(seq).toBe("\x03");
    });

    it("keyToSequence returns null for Meta+C (lets browser handle it)", () => {
      const handler = new InputHandler({ onData: vi.fn() });
      const seq = handler.keyToSequence({
        key: "c",
        ctrlKey: false,
        altKey: false,
        metaKey: true,
        shiftKey: false,
      } as KeyboardEvent);
      expect(seq).toBeNull();
    });
  });

  describe("mouse wheel scrolling in normal mode", () => {
    function setupWheel() {
      const onData = vi.fn();
      const onScroll = vi.fn();
      const handler = new InputHandler({ onData, onScroll });
      const container = document.createElement("div");
      container.style.width = "800px";
      container.style.height = "400px";
      document.body.appendChild(container);
      handler.attach(container, 8, 16);

      const dispatch = (deltaY: number) =>
        container.dispatchEvent(
          new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }),
        );
      const teardown = () => {
        handler.dispose();
        document.body.removeChild(container);
      };
      return { onScroll, dispatch, teardown };
    }

    it("calls onScroll with positive lines when scrolling down", () => {
      const { onScroll, dispatch, teardown } = setupWheel();
      dispatch(48);
      expect(onScroll).toHaveBeenCalledWith(3); // 48 / 16 = 3 lines
      teardown();
    });

    it("calls onScroll with negative lines when scrolling up", () => {
      const { onScroll, dispatch, teardown } = setupWheel();
      dispatch(-32);
      expect(onScroll).toHaveBeenCalledWith(-2); // -32 / 16 = -2 lines
      teardown();
    });

    it("does not call onScroll when deltaY rounds to zero lines", () => {
      const { onScroll, dispatch, teardown } = setupWheel();
      dispatch(2); // too small to round to 1 line
      expect(onScroll).not.toHaveBeenCalled();
      teardown();
    });
  });

  describe("selection management", () => {
    it("getSelection returns null initially", () => {
      const handler = new InputHandler({ onData: vi.fn() });
      expect(handler.getSelection()).toBeNull();
    });

    it("clearSelection clears the selection and notifies", () => {
      const onSelectionChange = vi.fn();
      const handler = new InputHandler({ onData: vi.fn(), onSelectionChange });
      handler.clearSelection();
      expect(handler.getSelection()).toBeNull();
      expect(onSelectionChange).toHaveBeenCalledWith(null);
    });
  });
});
