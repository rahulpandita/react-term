import React, { useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import type { Theme } from '@react-term/core';
import { WebTerminal, calculateFit } from '@react-term/web';

export interface TerminalProps {
  cols?: number;
  rows?: number;
  fontSize?: number;
  fontFamily?: string;
  theme?: Partial<Theme>;
  scrollback?: number;
  onData?: (data: Uint8Array) => void;
  onResize?: (size: { cols: number; rows: number }) => void;
  onTitleChange?: (title: string) => void;
  autoFit?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Force main-thread rendering ('main') or use auto-detection ('auto'). */
  renderMode?: 'auto' | 'offscreen' | 'main';
  /** Renderer backend: 'auto', 'webgl', or 'canvas2d'. */
  renderer?: 'auto' | 'webgl' | 'canvas2d';
  /** Whether to use a Web Worker for VT parsing. */
  useWorker?: boolean;
}

export interface TerminalHandle {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  blur(): void;
  fit(): void;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(props, ref) {
  const {
    cols = 80,
    rows = 24,
    fontSize = 16,
    fontFamily = "'Courier New', monospace",
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
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<WebTerminal | null>(null);
  const initialized = useRef(false);

  // Keep callback refs stable to avoid re-creating the terminal
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onTitleChangeRef = useRef(onTitleChange);

  useEffect(() => { onDataRef.current = onData; }, [onData]);
  useEffect(() => { onResizeRef.current = onResize; }, [onResize]);
  useEffect(() => { onTitleChangeRef.current = onTitleChange; }, [onTitleChange]);

  // Expose imperative handle
  useImperativeHandle(ref, () => ({
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
  }), []);

  // Initialize WebTerminal on mount (handles StrictMode double-mount)
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
      theme,
      scrollback,
      renderMode,
      renderer: rendererProp,
      useWorker,
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update theme when it changes
  useEffect(() => {
    if (termRef.current && theme) {
      termRef.current.setTheme(theme);
    }
  }, [theme]);

  // Update font when it changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.setFont(fontSize, fontFamily);
    }
  }, [fontSize, fontFamily]);

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
      vv.addEventListener('resize', doFit);
      vv.addEventListener('scroll', doFit);
    }

    return () => {
      observer.disconnect();
      if (vv) {
        vv.removeEventListener('resize', doFit);
        vv.removeEventListener('scroll', doFit);
      }
      if (rafId !== null) cancelAnimationFrame(rafId);
      // Reset container styles
      if (container) {
        container.style.height = '';
        container.style.marginTop = '';
      }
    };
  }, [autoFit]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={style}
    />
  );
});
