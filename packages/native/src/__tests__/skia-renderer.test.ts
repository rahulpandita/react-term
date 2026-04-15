import type { CursorState, SelectionRange } from "@next_term/core";
import { CellGrid, DEFAULT_THEME } from "@next_term/core";
import { describe, expect, it } from "vitest";
import type { RenderCommand } from "../renderer/SkiaRenderer.js";
import { SkiaRenderer } from "../renderer/SkiaRenderer.js";

function createRenderer() {
  return new SkiaRenderer({
    fontSize: 14,
    fontFamily: "Menlo",
    theme: DEFAULT_THEME,
  });
}

function defaultCursor(): CursorState {
  return { row: 0, col: 0, visible: true, style: "block", wrapPending: false };
}

function findCommands(commands: RenderCommand[], type: string): RenderCommand[] {
  return commands.filter((c) => c.type === type);
}

describe("SkiaRenderer", () => {
  // -----------------------------------------------------------------------
  // Cell size
  // -----------------------------------------------------------------------

  describe("getCellSize", () => {
    it("returns positive dimensions", () => {
      const renderer = createRenderer();
      const { width, height } = renderer.getCellSize();
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    });

    it("updates after setFont", () => {
      const renderer = createRenderer();
      const before = renderer.getCellSize();
      renderer.setFont(28, "Courier");
      const after = renderer.getCellSize();
      expect(after.width).toBeGreaterThan(before.width);
      expect(after.height).toBeGreaterThan(before.height);
    });
  });

  // -----------------------------------------------------------------------
  // Empty grid
  // -----------------------------------------------------------------------

  describe("empty grid", () => {
    it("produces only background rects and cursor for an empty grid", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(4, 2);
      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };

      const commands = renderer.renderFrame(grid, cursor, null);

      // Should have background rects (one per row) but no text commands
      // (grid is filled with spaces, codepoint 0x20)
      const textCmds = findCommands(commands, "text");
      expect(textCmds).toHaveLength(0);

      const rectCmds = findCommands(commands, "rect");
      // At least one rect per row for background
      expect(rectCmds.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -----------------------------------------------------------------------
  // Grid with text
  // -----------------------------------------------------------------------

  describe("grid with text", () => {
    it("produces text commands with correct positions", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(10, 2);

      // Write "Hi" at row 0
      grid.setCell(0, 0, 0x48, 7, 0, 0); // 'H'
      grid.setCell(0, 1, 0x69, 7, 0, 0); // 'i'

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      const textCmds = findCommands(commands, "text");
      expect(textCmds.length).toBeGreaterThanOrEqual(2);

      const hCmd = textCmds.find((c) => c.text === "H");
      const iCmd = textCmds.find((c) => c.text === "i");
      expect(hCmd).toBeDefined();
      expect(iCmd).toBeDefined();

      const cellWidth = renderer.getCellSize().width;
      expect(hCmd?.x).toBe(0);
      expect(iCmd?.x).toBe(cellWidth);
    });
  });

  // -----------------------------------------------------------------------
  // Colored cells
  // -----------------------------------------------------------------------

  describe("colored cells", () => {
    it("uses correct foreground color for indexed colors", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);

      // Red foreground (index 1) on default background
      grid.setCell(0, 0, 0x41, 1, 0, 0); // 'A' with fg=red

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      const textCmds = findCommands(commands, "text");
      const aCmd = textCmds.find((c) => c.text === "A");
      expect(aCmd).toBeDefined();
      expect(aCmd?.color).toBe(DEFAULT_THEME.red);
    });

    it("uses correct background color for non-default bg", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);

      // Default fg, blue background (index 4)
      grid.setCell(0, 0, 0x42, 7, 4, 0); // 'B' with bg=blue

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      const rectCmds = findCommands(commands, "rect");
      // Should have a cell-sized rect with blue color
      const blueRect = rectCmds.find(
        (c) => c.color === DEFAULT_THEME.blue && c.width === renderer.getCellSize().width,
      );
      expect(blueRect).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Cursor
  // -----------------------------------------------------------------------

  describe("cursor", () => {
    it("renders block cursor with opacity", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 2);
      const cursor: CursorState = {
        row: 1,
        col: 2,
        visible: true,
        style: "block",
        wrapPending: false,
      };

      const commands = renderer.renderFrame(grid, cursor, null);

      const { width: cw, height: ch } = renderer.getCellSize();
      const cursorCmd = commands.find(
        (c) =>
          c.type === "rect" &&
          c.color === DEFAULT_THEME.cursor &&
          c.opacity === 0.5 &&
          c.x === 2 * cw &&
          c.y === 1 * ch &&
          c.width === cw &&
          c.height === ch,
      );
      expect(cursorCmd).toBeDefined();
    });

    it("renders underline cursor", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 2);
      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: true,
        style: "underline",
        wrapPending: false,
      };

      const commands = renderer.renderFrame(grid, cursor, null);

      const cursorCmd = commands.find(
        (c) => c.type === "rect" && c.color === DEFAULT_THEME.cursor && c.height === 2,
      );
      expect(cursorCmd).toBeDefined();
    });

    it("renders bar cursor", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 2);
      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: true,
        style: "bar",
        wrapPending: false,
      };

      const commands = renderer.renderFrame(grid, cursor, null);

      const cursorCmd = commands.find(
        (c) => c.type === "rect" && c.color === DEFAULT_THEME.cursor && c.width === 2,
      );
      expect(cursorCmd).toBeDefined();
    });

    it("does not render cursor when not visible", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 2);
      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };

      const commands = renderer.renderFrame(grid, cursor, null);

      const cursorCmd = commands.find(
        (c) => c.type === "rect" && c.color === DEFAULT_THEME.cursor && c.opacity === 0.5,
      );
      expect(cursorCmd).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Selection
  // -----------------------------------------------------------------------

  describe("selection", () => {
    it("renders selection overlay", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(10, 3);
      const cursor = defaultCursor();
      cursor.visible = false;

      const selection: SelectionRange = {
        startRow: 0,
        startCol: 2,
        endRow: 0,
        endCol: 5,
      };

      const commands = renderer.renderFrame(grid, cursor, selection);

      const selectionCmds = commands.filter(
        (c) => c.color === DEFAULT_THEME.selectionBackground && c.opacity === 0.5,
      );
      expect(selectionCmds.length).toBeGreaterThanOrEqual(1);

      const selRect = selectionCmds[0];
      const cellWidth = renderer.getCellSize().width;
      expect(selRect.x).toBe(2 * cellWidth);
      expect(selRect.width).toBe(4 * cellWidth);
    });

    it("does not render selection when null", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 2);
      const cursor = defaultCursor();
      cursor.visible = false;

      const commands = renderer.renderFrame(grid, cursor, null);

      const selectionCmds = commands.filter(
        (c) => c.color === DEFAULT_THEME.selectionBackground && c.opacity === 0.5,
      );
      expect(selectionCmds).toHaveLength(0);
    });

    it("handles multi-row selection", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(10, 4);
      const cursor = defaultCursor();
      cursor.visible = false;

      const selection: SelectionRange = {
        startRow: 1,
        startCol: 3,
        endRow: 3,
        endCol: 6,
      };

      const commands = renderer.renderFrame(grid, cursor, selection);

      const selectionCmds = commands.filter(
        (c) => c.color === DEFAULT_THEME.selectionBackground && c.opacity === 0.5,
      );
      // 3 rows: row 1 (partial), row 2 (full), row 3 (partial)
      expect(selectionCmds).toHaveLength(3);
    });

    it("does not render selection for same-cell start and end", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 2);
      const cursor = defaultCursor();
      cursor.visible = false;

      const selection: SelectionRange = {
        startRow: 1,
        startCol: 2,
        endRow: 1,
        endCol: 2,
      };

      const commands = renderer.renderFrame(grid, cursor, selection);

      const selectionCmds = commands.filter(
        (c) => c.color === DEFAULT_THEME.selectionBackground && c.opacity === 0.5,
      );
      expect(selectionCmds).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Bold / Italic attributes
  // -----------------------------------------------------------------------

  describe("text attributes", () => {
    it("sets bold flag for bold cells", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);

      // Bold attribute: bit 0 of attrs byte
      grid.setCell(0, 0, 0x42, 7, 0, 0x01); // 'B' bold

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      const textCmds = findCommands(commands, "text");
      const bCmd = textCmds.find((c) => c.text === "B");
      expect(bCmd).toBeDefined();
      expect(bCmd?.bold).toBe(true);
      expect(bCmd?.italic).toBe(false);
    });

    it("sets italic flag for italic cells", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);

      // Italic attribute: bit 1 of attrs byte
      grid.setCell(0, 0, 0x49, 7, 0, 0x02); // 'I' italic

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      const textCmds = findCommands(commands, "text");
      const iCmd = textCmds.find((c) => c.text === "I");
      expect(iCmd).toBeDefined();
      expect(iCmd?.italic).toBe(true);
      expect(iCmd?.bold).toBe(false);
    });

    it("renders underline decoration", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);

      // Underline: bit 2
      grid.setCell(0, 0, 0x55, 7, 0, 0x04); // 'U' underline

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      const lineCmds = findCommands(commands, "line");
      expect(lineCmds.length).toBeGreaterThanOrEqual(1);
    });

    it("renders strikethrough decoration", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);

      // Strikethrough: bit 3
      grid.setCell(0, 0, 0x53, 7, 0, 0x08); // 'S' strikethrough

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      const lineCmds = findCommands(commands, "line");
      expect(lineCmds.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Theme changes
  // -----------------------------------------------------------------------

  describe("setTheme", () => {
    it("uses updated theme colors after setTheme", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);
      grid.setCell(0, 0, 0x41, 7, 0, 0); // 'A'

      const newTheme = { ...DEFAULT_THEME, foreground: "#ff0000" };
      renderer.setTheme(newTheme);

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      const textCmds = findCommands(commands, "text");
      const aCmd = textCmds.find((c) => c.text === "A");
      expect(aCmd).toBeDefined();
      expect(aCmd?.color).toBe("#ff0000");
    });
  });

  // -----------------------------------------------------------------------
  // Inverse attribute (SGR 7 / attrs bit 6 = 0x40) — fg and bg swapped
  // -----------------------------------------------------------------------

  describe("inverse attribute (ATTR_INVERSE = 0x40)", () => {
    it("draws text in bg color and bg rect in fg color when inverse is set", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);

      // fgIndex=1 (red palette), bgIndex=0 (default bg), attrs=0x40 (inverse).
      // After swap: text = resolved(bg=0) = theme.background,
      //             bg   = resolved(fg=1) = palette[1] (red).
      grid.setCell(0, 0, 0x41, 1, 0, 0x40); // 'A', fg=red(1), bg=default, inverse

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      const textCmds = findCommands(commands, "text");
      const aCmd = textCmds.find((c) => c.text === "A");
      expect(aCmd).toBeDefined();
      // After inverse the text is drawn using the original background color
      expect(aCmd?.color).toBe(DEFAULT_THEME.background);

      // A per-cell rect with the original fg color (palette[1] = red) must appear
      const rectCmds = findCommands(commands, "rect");
      const fgColorRect = rectCmds.find(
        (c) => c.color !== DEFAULT_THEME.background && c.color !== DEFAULT_THEME.foreground,
      );
      expect(fgColorRect).toBeDefined();
    });

    it("draws text in original bg palette color when inverse + explicit bg", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);

      // fgIndex=7 (default fg), bgIndex=2 (green), attrs=0x40 (inverse).
      // After swap: text = palette[2] (green), bg = theme.foreground.
      grid.setCell(0, 0, 0x42, 7, 2, 0x40); // 'B', fg=default(7), bg=green(2), inverse

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      const textCmds = findCommands(commands, "text");
      const bCmd = textCmds.find((c) => c.text === "B");
      expect(bCmd).toBeDefined();
      // Text color should be palette[2] (green), not the default fg or bg
      expect(bCmd?.color).not.toBe(DEFAULT_THEME.foreground);
      expect(bCmd?.color).not.toBe(DEFAULT_THEME.background);
    });
  });

  // -----------------------------------------------------------------------
  // RGB / true-color cells (isFgRGB / isBgRGB flags in setCell)
  // -----------------------------------------------------------------------

  describe("RGB (true-color) cells", () => {
    it("renders fg RGB color as 'rgb(r,g,b)' string", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);

      // fgIsRGB=true; RGB stored inline in cell word 2
      const fgRGB = (255 << 16) | (128 << 8) | 0; // rgb(255,128,0)
      grid.setCell(0, 0, 0x41, 0, 0, 0, true, false, fgRGB);

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      const textCmds = findCommands(commands, "text");
      const aCmd = textCmds.find((c) => c.text === "A");
      expect(aCmd).toBeDefined();
      expect(aCmd?.color).toBe("rgb(255,128,0)");
    });

    it("renders bg RGB color as a background rect with 'rgb(r,g,b)' color", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);

      // bgIsRGB=true; RGB stored inline in cell word 3
      const bgRGB = (0 << 16) | (0 << 8) | 200; // rgb(0,0,200)
      grid.setCell(0, 0, 0x41, 7, 0, 0, false, true, 0, bgRGB);

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      // A per-cell rect with the RGB background color must appear
      const rectCmds = findCommands(commands, "rect");
      const rgbBgRect = rectCmds.find((c) => c.color === "rgb(0,0,200)");
      expect(rgbBgRect).toBeDefined();
    });

    it("RGB fg + inverse: RGB value becomes background rect; text uses theme.background", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);

      // fgIsRGB=true, attrs=0x40 (inverse).
      // After swap: bg = rgb(200,50,10), text = theme.background.
      const fgRGB2 = (200 << 16) | (50 << 8) | 10; // rgb(200,50,10)
      grid.setCell(0, 0, 0x43, 0, 0, 0x40, true, false, fgRGB2); // 'C', fgIsRGB, inverse

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      // Text uses the original bg (theme.background) after the swap
      const textCmds = findCommands(commands, "text");
      const cCmd = textCmds.find((c) => c.text === "C");
      expect(cCmd).toBeDefined();
      expect(cCmd?.color).toBe(DEFAULT_THEME.background);

      // Background rect uses the original RGB fg color
      const rectCmds = findCommands(commands, "rect");
      const rgbRect = rectCmds.find((c) => c.color === "rgb(200,50,10)");
      expect(rgbRect).toBeDefined();
    });

    it("RGB bg + inverse: text uses RGB bg color; background rect drawn in theme.foreground", () => {
      const renderer = createRenderer();
      const grid = new CellGrid(5, 1);

      // bgIsRGB=true, fgIdx=7 (default fg), attrs=0x40 (inverse).
      // resolveColor(7, false) → theme.foreground
      // resolveColor(0, true)  → rgb(100,200,50) from rgbColors[256+col]
      // After swap: fg = rgb(100,200,50), bg = theme.foreground
      const bgRGB2 = (100 << 16) | (200 << 8) | 50; // rgb(100,200,50)
      grid.setCell(0, 0, 0x44, 7, 0, 0x40, false, true, 0, bgRGB2); // 'D', bgIsRGB, inverse

      const cursor: CursorState = {
        row: 0,
        col: 0,
        visible: false,
        style: "block",
        wrapPending: false,
      };
      const commands = renderer.renderFrame(grid, cursor, null);

      // Text uses the original bg RGB color (swapped to fg)
      const textCmds = findCommands(commands, "text");
      const dCmd = textCmds.find((c) => c.text === "D");
      expect(dCmd).toBeDefined();
      expect(dCmd?.color).toBe("rgb(100,200,50)");

      // Background rect drawn in theme.foreground (swapped from default fg)
      const rectCmds = findCommands(commands, "rect");
      const fgRect = rectCmds.find((c) => c.color === DEFAULT_THEME.foreground);
      expect(fgRect).toBeDefined();
    });
  });
});
