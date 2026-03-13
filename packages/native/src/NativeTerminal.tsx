/**
 * NativeTerminal — React Native terminal component.
 *
 * Uses @react-term/core's BufferSet + VTParser for terminal emulation, and
 * the SkiaRenderer to generate declarative render commands. Touch input is
 * handled by GestureHandler; keyboard input by KeyboardHandler via a hidden
 * TextInput equivalent.
 *
 * Architecture:
 * - Core VT parsing runs in JS (same as web, could be moved to a JSI thread)
 * - SkiaRenderer produces RenderCommand[] for a Skia Canvas
 * - GestureHandler translates touch events to terminal actions
 * - KeyboardHandler translates key events to VT sequences
 */

import type { SelectionRange, Theme } from "@react-term/core";
import { BufferSet, DEFAULT_THEME, VTParser } from "@react-term/core";
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { GestureHandler } from "./input/GestureHandler.js";
import { KeyboardHandler } from "./input/KeyboardHandler.js";
import type { RenderCommand } from "./renderer/SkiaRenderer.js";
import { SkiaRenderer } from "./renderer/SkiaRenderer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NativeTerminalProps {
  cols?: number;
  rows?: number;
  fontSize?: number;
  fontFamily?: string;
  theme?: Partial<Theme>;
  scrollback?: number;
  onData?: (data: Uint8Array) => void;
  onResize?: (size: { cols: number; rows: number }) => void;
  /** Called each frame with render commands for the Skia Canvas. */
  onRenderCommands?: (commands: RenderCommand[]) => void;
  style?: Record<string, unknown>;
}

export interface NativeTerminalHandle {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  blur(): void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_FONT_FAMILY = "Menlo";
const DEFAULT_SCROLLBACK = 1000;

function mergeTheme(partial?: Partial<Theme>): Theme {
  if (!partial) return { ...DEFAULT_THEME };
  return { ...DEFAULT_THEME, ...partial };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const NativeTerminal = forwardRef<NativeTerminalHandle, NativeTerminalProps>(
  function NativeTerminal(props, ref) {
    const {
      cols = DEFAULT_COLS,
      rows = DEFAULT_ROWS,
      fontSize = DEFAULT_FONT_SIZE,
      fontFamily = DEFAULT_FONT_FAMILY,
      theme: themeProp,
      scrollback = DEFAULT_SCROLLBACK,
      onData,
      onResize,
      onRenderCommands,
      style,
    } = props;

    // Stable refs for callbacks
    const onDataRef = useRef(onData);
    const onResizeRef = useRef(onResize);
    const onRenderCommandsRef = useRef(onRenderCommands);

    useEffect(() => {
      onDataRef.current = onData;
    }, [onData]);
    useEffect(() => {
      onResizeRef.current = onResize;
    }, [onResize]);
    useEffect(() => {
      onRenderCommandsRef.current = onRenderCommands;
    }, [onRenderCommands]);

    // Core state
    const bufferSetRef = useRef<BufferSet | null>(null);
    const parserRef = useRef<VTParser | null>(null);
    const rendererRef = useRef<SkiaRenderer | null>(null);
    const gestureHandlerRef = useRef<GestureHandler | null>(null);
    const keyboardHandlerRef = useRef<KeyboardHandler | null>(null);

    const [_focused, setFocused] = useState(false);
    const [selection, setSelection] = useState<SelectionRange | null>(null);

    const encoder = useRef(new TextEncoder());
    const theme = mergeTheme(themeProp);
    const initialized = useRef(false);
    const rafRef = useRef<number | null>(null);

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    useEffect(() => {
      if (initialized.current) return;
      initialized.current = true;

      // Create core terminal
      const bufferSet = new BufferSet(cols, rows, scrollback);
      const parser = new VTParser(bufferSet);
      bufferSetRef.current = bufferSet;
      parserRef.current = parser;

      // Create renderer
      const renderer = new SkiaRenderer({
        fontSize,
        fontFamily,
        theme,
      });
      rendererRef.current = renderer;

      const { width: cellWidth, height: cellHeight } = renderer.getCellSize();

      // Create keyboard handler
      const keyboard = new KeyboardHandler((data) => {
        onDataRef.current?.(data);
      });
      keyboardHandlerRef.current = keyboard;

      // Create gesture handler
      const gesture = new GestureHandler(cellWidth, cellHeight, {
        onScroll: (deltaRows) => {
          // Scrollback navigation would go here
          void deltaRows;
        },
        onTap: (_row, _col) => {
          // Could place cursor or activate links
        },
        onDoubleTap: (_row, _col) => {
          // Word selection
        },
        onLongPress: (_row, _col) => {
          // Selection mode
        },
        onPinch: (_scale) => {
          // Font size adjustment
        },
        onSelectionChange: (sel) => {
          setSelection(sel);
        },
      });
      gestureHandlerRef.current = gesture;

      // Start render loop
      const renderLoop = () => {
        if (!bufferSetRef.current || !rendererRef.current) return;

        const grid = bufferSetRef.current.active.grid;
        let hasDirty = false;
        for (let r = 0; r < grid.rows; r++) {
          if (grid.isDirty(r)) {
            hasDirty = true;
            break;
          }
        }

        if (hasDirty) {
          const cursor = bufferSetRef.current.active.cursor;
          const commands = rendererRef.current.renderFrame(grid, cursor, selection);
          onRenderCommandsRef.current?.(commands);

          // Clear dirty flags
          for (let r = 0; r < grid.rows; r++) {
            grid.clearDirty(r);
          }
        }

        rafRef.current = requestAnimationFrame(renderLoop);
      };
      rafRef.current = requestAnimationFrame(renderLoop);

      return () => {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        bufferSetRef.current = null;
        parserRef.current = null;
        rendererRef.current = null;
        gestureHandlerRef.current = null;
        keyboardHandlerRef.current = null;
        initialized.current = false;
      };
    }, [cols, fontFamily, fontSize, rows, scrollback, selection, theme]); // eslint-disable-line react-hooks/exhaustive-deps

    // Update theme
    useEffect(() => {
      rendererRef.current?.setTheme(mergeTheme(themeProp));
    }, [themeProp]);

    // Update font
    useEffect(() => {
      rendererRef.current?.setFont(fontSize, fontFamily);
      if (gestureHandlerRef.current && rendererRef.current) {
        const { width, height } = rendererRef.current.getCellSize();
        gestureHandlerRef.current.updateCellSize(width, height);
      }
    }, [fontSize, fontFamily]);

    // -----------------------------------------------------------------------
    // Imperative handle
    // -----------------------------------------------------------------------

    const focus = useCallback(() => setFocused(true), []);
    const blur = useCallback(() => setFocused(false), []);

    useImperativeHandle(
      ref,
      () => ({
        write(data: string | Uint8Array) {
          if (!parserRef.current) return;
          const bytes = typeof data === "string" ? encoder.current.encode(data) : data;
          parserRef.current.write(bytes);
        },

        resize(newCols: number, newRows: number) {
          if (!Number.isFinite(newCols) || !Number.isFinite(newRows) || newCols < 2 || newRows < 1)
            return;

          const bufferSet = new BufferSet(newCols, newRows, scrollback);
          const parser = new VTParser(bufferSet);
          bufferSetRef.current = bufferSet;
          parserRef.current = parser;

          onResizeRef.current?.({ cols: newCols, rows: newRows });
        },

        focus,
        blur,
      }),
      [scrollback, focus, blur],
    );

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    const cellSize = rendererRef.current?.getCellSize() ?? {
      width: Math.ceil(fontSize * 0.6),
      height: Math.ceil(fontSize * 1.2),
    };
    const surfaceWidth = cols * cellSize.width;
    const surfaceHeight = rows * cellSize.height;

    return React.createElement("RCTView", {
      style: {
        width: surfaceWidth,
        height: surfaceHeight,
        backgroundColor: theme.background,
        overflow: "hidden",
        ...style,
      },
      accessibilityLabel: "Terminal",
      accessibilityRole: "text",
    });
  },
);
