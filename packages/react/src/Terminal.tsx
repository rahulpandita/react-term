import type { ParserModeState, TerminalState, Theme } from "@next_term/core";
import type { ParserPool, SharedContext } from "@next_term/web";
import { calculateFit, WebTerminal } from "@next_term/web";
import type React from "react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface TerminalProps {
  cols?: number;
  rows?: number;
  fontSize?: number;
  fontFamily?: string;
  /** CSS font-weight for normal text (default: 400). */
  fontWeight?: number;
  /** CSS font-weight for bold text (default: 700). */
  fontWeightBold?: number;
  theme?: Partial<Theme>;
  scrollback?: number;
  onData?: (data: Uint8Array) => void;
  onResize?: (size: { cols: number; rows: number }) => void;
  onTitleChange?: (title: string) => void;
  autoFit?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Force main-thread rendering ('main') or use auto-detection ('auto'). */
  renderMode?: "auto" | "offscreen" | "main";
  /** Renderer backend: 'auto', 'webgl', or 'canvas2d'. */
  renderer?: "auto" | "webgl" | "canvas2d";
  /** Whether to use a Web Worker for VT parsing. */
  useWorker?: boolean;
  /** Shared render context (WebGL2 or Canvas2D) for multi-pane rendering. */
  sharedContext?: SharedContext;
  /** Unique identifier for this pane. Required when `sharedContext` or
   *  `parserPool` is provided — it's used as the channel id in both. */
  paneId?: string;
  /** Shared parser worker pool for multi-pane parsing. */
  parserPool?: ParserPool;
  /**
   * Snapshot captured from a previous terminal via `serialize()`. Restored
   * before the first frame is painted — useful for fast remount without a
   * blank flash (e.g. when reparenting panes in a tab/split layout).
   */
  initialState?: TerminalState;
}

export interface TerminalHandle {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  blur(): void;
  fit(): void;
  /** Read all visible grid rows as plain text (for testing/accessibility). */
  getRowTexts?(): string[];
  /** Get current cursor position (for testing). */
  getCursorPosition?(): { row: number; col: number };
  /** Whether the alternate buffer is active (vim, htop, etc.). */
  readonly isAlternateBuffer?: boolean;
  /** Get current parser/input mode state for save/restore. */
  getParserModes?(): ParserModeState;
  /** Current scroll offset (0 = live/bottom, positive = lines scrolled back). */
  readonly scrollOffset?: number;
  /** Apply parser/input modes. See `WebTerminal.setParserModes` for caveats. */
  setParserModes?(modes: ParserModeState): void;
  /** Capture a snapshot of the active buffer + cursor + scrollback + parser modes. */
  serialize?(): TerminalState;
  /** Apply a snapshot produced by `serialize()`. Dimensions must match. */
  hydrate?(state: TerminalState): void;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(props, ref) {
  const {
    cols = 80,
    rows = 24,
    fontSize = 16,
    fontFamily = "'Courier New', monospace",
    fontWeight,
    fontWeightBold,
    theme,
    scrollback = 1000,
    onData,
    onResize,
    onTitleChange,
    autoFit = false,
    className,
    style,
    renderMode,
    renderer: rendererProp,
    useWorker,
    sharedContext,
    paneId,
    parserPool,
    initialState,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<WebTerminal | null>(null);
  const initialized = useRef(false);

  // Keep callback refs stable to avoid re-creating the terminal
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onTitleChangeRef = useRef(onTitleChange);

  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);
  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  // Expose imperative handle
  useImperativeHandle(
    ref,
    () => ({
      write(data: string | Uint8Array) {
        termRef.current?.write(data);
      },
      resize(cols: number, rows: number) {
        termRef.current?.resize(cols, rows);
      },
      focus() {
        termRef.current?.focus();
      },
      blur() {
        termRef.current?.blur();
      },
      fit() {
        const terminal = termRef.current;
        const container = containerRef.current;
        if (!terminal || !container) return;
        const { width, height } = terminal.getCellSize();
        if (width <= 0 || height <= 0) return;
        const { cols: fitCols, rows: fitRows } = calculateFit(container, width, height);
        terminal.resize(fitCols, fitRows);
      },
      getRowTexts() {
        const terminal = termRef.current;
        if (!terminal) return [];
        return terminal.getRowTexts();
      },
      getCursorPosition() {
        const terminal = termRef.current;
        if (!terminal) return { row: 0, col: 0 };
        return terminal.getCursorPosition();
      },
      get isAlternateBuffer() {
        return termRef.current?.isAlternateBuffer ?? false;
      },
      get scrollOffset() {
        return termRef.current?.scrollOffset ?? 0;
      },
      getParserModes() {
        const terminal = termRef.current;
        if (!terminal)
          return {
            applicationCursorKeys: false,
            bracketedPasteMode: false,
            mouseProtocol: "none",
            mouseEncoding: "default",
            sendFocusEvents: false,
          };
        return terminal.getParserModes();
      },
      setParserModes(modes) {
        termRef.current?.setParserModes(modes);
      },
      serialize() {
        const terminal = termRef.current;
        if (!terminal) {
          throw new Error("[Terminal] serialize() called before terminal is mounted");
        }
        return terminal.serialize();
      },
      hydrate(state) {
        const terminal = termRef.current;
        if (!terminal) {
          throw new Error("[Terminal] hydrate() called before terminal is mounted");
        }
        terminal.hydrate(state);
      },
    }),
    [],
  );

  // Initialize WebTerminal on mount (handles StrictMode double-mount).
  // `initialState` is intentionally NOT in the deps array — it's an
  // apply-once-on-mount snapshot; reapplying it on every snapshot identity
  // change would defeat its purpose (a stable "restore the previous session"
  // input, not a controlled value). Callers needing dynamic restore can call
  // the imperative `hydrate()` method instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialState is apply-once on mount
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const container = containerRef.current;
    if (!container) return;

    const terminal = new WebTerminal(container, {
      cols,
      rows,
      fontSize,
      fontFamily,
      fontWeight,
      fontWeightBold,
      theme,
      scrollback,
      renderMode,
      renderer: rendererProp,
      useWorker,
      sharedContext,
      paneId,
      parserPool,
      initialState,
      onData: (data: Uint8Array) => onDataRef.current?.(data),
      onResize: (size: { cols: number; rows: number }) => onResizeRef.current?.(size),
      onTitleChange: (title: string) => onTitleChangeRef.current?.(title),
    });

    termRef.current = terminal;

    return () => {
      termRef.current?.dispose();
      termRef.current = null;
      initialized.current = false;
    };
  }, [
    cols,
    fontFamily,
    fontSize,
    fontWeight,
    fontWeightBold,
    paneId,
    renderMode,
    rendererProp,
    rows,
    scrollback,
    sharedContext,
    theme,
    useWorker,
    parserPool,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update theme when it changes
  useEffect(() => {
    if (termRef.current && theme) {
      termRef.current.setTheme(theme);
    }
  }, [theme]);

  // Update font when it changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.setFont(fontSize, fontFamily, fontWeight, fontWeightBold);
    }
  }, [fontSize, fontFamily, fontWeight, fontWeightBold]);

  // AutoFit: observe container size via ResizeObserver, debounced with rAF.
  // Also listen to visualViewport resize for iOS keyboard show/hide.
  useEffect(() => {
    if (!autoFit) return;

    const container = containerRef.current;
    if (!container) return;

    let rafId: number | null = null;

    const doFit = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const terminal = termRef.current;
        if (!terminal || !container) return;

        // On iOS, when the virtual keyboard is open, visualViewport.height
        // is the visible area above the keyboard. Use it to constrain the
        // container height so the terminal fits the visible viewport.
        // Only update when values actually change to avoid ResizeObserver loop.
        const vv = window.visualViewport;
        if (vv) {
          const newHeight = `${vv.height}px`;
          const newMargin = `${vv.offsetTop}px`;
          if (container.style.height !== newHeight) container.style.height = newHeight;
          if (container.style.marginTop !== newMargin) container.style.marginTop = newMargin;
        }

        const { width, height } = terminal.getCellSize();
        if (width <= 0 || height <= 0) return;
        const { cols: fitCols, rows: fitRows } = calculateFit(container, width, height);
        terminal.resize(fitCols, fitRows);
      });
    };

    const observer = new ResizeObserver(doFit);
    observer.observe(container);

    // Listen for visualViewport resize (keyboard show/hide on iOS/Android)
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", doFit);
      vv.addEventListener("scroll", doFit);
    }

    return () => {
      observer.disconnect();
      if (vv) {
        vv.removeEventListener("resize", doFit);
        vv.removeEventListener("scroll", doFit);
      }
      if (rafId !== null) cancelAnimationFrame(rafId);
      // Reset container styles
      if (container) {
        container.style.height = "";
        container.style.marginTop = "";
      }
    };
  }, [autoFit]);

  return <div ref={containerRef} className={className} style={style} />;
});
