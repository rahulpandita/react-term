/**
 * TerminalPane — a container component that manages multiple terminal
 * instances in a split-pane layout.
 *
 * All panes share rendering resources via a single SharedWebGLContext,
 * which avoids hitting Chrome's 16-context limit. If WebGL2 initialization
 * fails, panes fall back to independent per-pane rendering.
 *
 * Layout is described as a recursive tree of horizontal / vertical splits.
 */

import type { Theme } from "@next_term/core";
import { DEFAULT_PARSER_WORKER_COUNT, ParserPool, SharedWebGLContext } from "@next_term/web";
import type React from "react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { collectPaneIds, type PaneLayout } from "./pane-layout.js";
import type { TerminalHandle } from "./Terminal.js";
import { Terminal } from "./Terminal.js";

export type { PaneLayout } from "./pane-layout.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TerminalPaneProps {
  layout: PaneLayout;
  onData?: (paneId: string, data: Uint8Array) => void;
  theme?: Partial<Theme>;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  fontWeightBold?: number;
  /** Control whether each pane uses a Web Worker for parsing. Defaults to auto-detect (SAB available). */
  useWorker?: boolean;
  /**
   * Number of shared parser workers. All panes share a pool of this many
   * workers, routed round-robin by the channel id (pane id).
   *
   * - `undefined` (default): `min(navigator.hardwareConcurrency ?? 4, 4)`.
   *   Suitable for multi-pane layouts; at 1–2 panes the unused workers
   *   cost ~1–2 MB RAM each and sit idle.
   * - A positive integer: that exact number of workers.
   * - `0`: disable the shared pool entirely. Each pane gets its own
   *   dedicated worker via `useWorker`, same as a standalone `<Terminal>`.
   *
   * Changing this prop at runtime disposes the current pool and recreates
   * it — which tears down all pane terminal state. Treat it as a
   * mount-time setting in practice.
   */
  parserWorkers?: number;
  className?: string;
  style?: React.CSSProperties;
}

export interface TerminalPaneHandle {
  /** Get the terminal handle for a specific pane by id. */
  getTerminal(paneId: string): TerminalHandle | null;
  /** Get all pane ids. */
  getPaneIds(): string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// (collectPaneIds is imported from ./pane-layout.js)

// ---------------------------------------------------------------------------
// PaneLeaf — renders a single Terminal inside a flex child
// ---------------------------------------------------------------------------

interface PaneLeafProps {
  id: string;
  onData?: (paneId: string, data: Uint8Array) => void;
  theme?: Partial<Theme>;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  fontWeightBold?: number;
  useWorker?: boolean;
  parserPool?: ParserPool | null;
  onRef: (id: string, handle: TerminalHandle | null) => void;
  sharedContext: SharedWebGLContext | null;
}

function PaneLeaf({
  id,
  onData,
  theme,
  fontSize,
  fontFamily,
  fontWeight,
  fontWeightBold,
  useWorker,
  parserPool,
  onRef,
  sharedContext,
}: PaneLeafProps) {
  const termRef = useRef<TerminalHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onRef(id, termRef.current);
    return () => {
      onRef(id, null);
    };
  }, [id, onRef]);

  // Sync viewport position with shared context via ResizeObserver
  useEffect(() => {
    if (!sharedContext || !containerRef.current) return;
    const syncViewport = () => {
      const el = containerRef.current;
      const parent = sharedContext.getCanvas().parentElement;
      if (!el || !parent) return;
      const parentRect = parent.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      sharedContext.setViewport(
        id,
        elRect.left - parentRect.left,
        elRect.top - parentRect.top,
        elRect.width,
        elRect.height,
      );
    };
    // Measure once on mount so panes that are already laid out get a viewport
    syncViewport();
    const observer = new ResizeObserver(syncViewport);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [id, sharedContext]);

  const handleData = useCallback(
    (data: Uint8Array) => {
      onData?.(id, data);
    },
    [id, onData],
  );

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }}>
      <Terminal
        ref={termRef}
        autoFit
        theme={theme}
        fontSize={fontSize}
        fontFamily={fontFamily}
        fontWeight={fontWeight}
        fontWeightBold={fontWeightBold}
        useWorker={useWorker}
        parserPool={parserPool ?? undefined}
        onData={handleData}
        sharedContext={sharedContext ?? undefined}
        paneId={sharedContext || parserPool ? id : undefined}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// PaneNode — recursively renders the layout tree
// ---------------------------------------------------------------------------

interface PaneNodeProps {
  layout: PaneLayout;
  onData?: (paneId: string, data: Uint8Array) => void;
  theme?: Partial<Theme>;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  fontWeightBold?: number;
  useWorker?: boolean;
  parserPool?: ParserPool | null;
  onRef: (id: string, handle: TerminalHandle | null) => void;
  sharedContext: SharedWebGLContext | null;
}

function PaneNode({
  layout,
  onData,
  theme,
  fontSize,
  fontFamily,
  fontWeight,
  fontWeightBold,
  useWorker,
  parserPool,
  onRef,
  sharedContext,
}: PaneNodeProps) {
  if (layout.type === "single") {
    return (
      <PaneLeaf
        id={layout.id}
        onData={onData}
        theme={theme}
        fontSize={fontSize}
        fontFamily={fontFamily}
        fontWeight={fontWeight}
        fontWeightBold={fontWeightBold}
        useWorker={useWorker}
        parserPool={parserPool}
        onRef={onRef}
        sharedContext={sharedContext}
      />
    );
  }

  const isHorizontal = layout.type === "horizontal";
  const children = layout.children;
  const sizes = layout.sizes ?? children.map(() => 1 / children.length);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: isHorizontal ? "row" : "column",
        width: "100%",
        height: "100%",
      }}
    >
      {children.map((child, i) => {
        const basis = `${(sizes[i] ?? 1 / children.length) * 100}%`;
        return (
          <div
            key={child.type === "single" ? child.id : `split-${i}`}
            style={{
              flexBasis: basis,
              flexGrow: 0,
              flexShrink: 0,
              overflow: "hidden",
              position: "relative",
              // Add a small border between panes
              ...(i > 0
                ? isHorizontal
                  ? { borderLeft: "1px solid #444" }
                  : { borderTop: "1px solid #444" }
                : {}),
            }}
          >
            <PaneNode
              layout={child}
              onData={onData}
              theme={theme}
              fontSize={fontSize}
              fontFamily={fontFamily}
              fontWeight={fontWeight}
              fontWeightBold={fontWeightBold}
              useWorker={useWorker}
              parserPool={parserPool}
              onRef={onRef}
              sharedContext={sharedContext}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TerminalPane
// ---------------------------------------------------------------------------

export const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(
  function TerminalPane(props, ref) {
    const {
      layout,
      onData,
      theme,
      fontSize,
      fontFamily,
      fontWeight,
      fontWeightBold,
      useWorker,
      parserWorkers,
      className,
      style,
    } = props;
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalsRef = useRef<Map<string, TerminalHandle>>(new Map());
    const sharedContextRef = useRef<SharedWebGLContext | null>(null);
    const [sharedContext, setSharedContext] = useState<SharedWebGLContext | null>(null);

    // Create the parser pool in a useEffect so StrictMode's double-invoke
    // of lazy initializers can't leak workers. Children render a placeholder
    // until the pool decision is committed (mounted=true), which prevents the
    // first-render race where panes would create per-pane WorkerBridges only
    // to tear them down once the pool arrived.
    const [mounted, setMounted] = useState(false);
    const [parserPool, setParserPool] = useState<ParserPool | null>(null);

    useEffect(() => {
      if (useWorker === false || parserWorkers === 0) {
        setParserPool(null);
        setMounted(true);
        return;
      }
      let pool: ParserPool | null = null;
      try {
        pool = new ParserPool(parserWorkers ?? DEFAULT_PARSER_WORKER_COUNT);
      } catch {
        pool = null;
      }
      setParserPool(pool);
      setMounted(true);
      return () => {
        pool?.dispose();
        setParserPool(null);
        setMounted(false);
      };
    }, [useWorker, parserWorkers]);

    const handleRef = useCallback((id: string, handle: TerminalHandle | null) => {
      if (handle) {
        terminalsRef.current.set(id, handle);
      } else {
        terminalsRef.current.delete(id);
      }
    }, []);

    // Create and manage the shared WebGL context
    // biome-ignore lint/correctness/useExhaustiveDependencies: theme handled via separate setTheme effect
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      let ctx: SharedWebGLContext | null = null;
      try {
        ctx = new SharedWebGLContext({
          fontSize,
          fontFamily,
          theme,
        });

        const canvas = ctx.getCanvas();
        canvas.style.position = "absolute";
        canvas.style.top = "0";
        canvas.style.left = "0";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.pointerEvents = "none";
        canvas.style.zIndex = "1";
        container.appendChild(canvas);

        ctx.init();

        // Sync canvas size with container (debounced via rAF to avoid
        // clearing the canvas on every pixel of a drag-resize)
        const activeCtx = ctx;
        let resizeRafId = 0;
        const ro = new ResizeObserver((entries) => {
          cancelAnimationFrame(resizeRafId);
          resizeRafId = requestAnimationFrame(() => {
            for (const entry of entries) {
              const { width, height } = entry.contentRect;
              activeCtx.syncCanvasSize(width, height);
            }
          });
        });
        ro.observe(container);

        ctx.startRenderLoop();
        sharedContextRef.current = ctx;
        setSharedContext(ctx);

        return () => {
          cancelAnimationFrame(resizeRafId);
          activeCtx.stopRenderLoop();
          activeCtx.dispose();
          ro.disconnect();
          sharedContextRef.current = null;
          setSharedContext(null);
        };
      } catch {
        // WebGL2 init failed — fall back to independent per-pane rendering
        console.warn(
          "[TerminalPane] SharedWebGLContext init failed, falling back to per-pane rendering",
        );
        if (ctx) {
          try {
            ctx.dispose();
          } catch {
            // ignore
          }
        }
        sharedContextRef.current = null;
        setSharedContext(null);
        return;
      }
    }, [fontSize, fontFamily]); // theme handled via separate setTheme effect below

    // Update theme on existing context without recreating GL resources
    useEffect(() => {
      if (sharedContextRef.current && theme) {
        sharedContextRef.current.setTheme(theme);
      }
    }, [theme]);

    useImperativeHandle(
      ref,
      () => ({
        getTerminal(paneId: string): TerminalHandle | null {
          return terminalsRef.current.get(paneId) ?? null;
        },
        getPaneIds(): string[] {
          return collectPaneIds(layout);
        },
      }),
      [layout],
    );

    return (
      <div
        ref={containerRef}
        className={className}
        style={{
          position: "relative",
          overflow: "hidden",
          ...style,
        }}
      >
        {mounted && (
          <PaneNode
            layout={layout}
            onData={onData}
            theme={theme}
            fontSize={fontSize}
            fontFamily={fontFamily}
            fontWeight={fontWeight}
            fontWeightBold={fontWeightBold}
            useWorker={useWorker}
            parserPool={parserPool}
            onRef={handleRef}
            sharedContext={sharedContext}
          />
        )}
      </div>
    );
  },
);
