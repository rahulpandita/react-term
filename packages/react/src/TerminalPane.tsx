/**
 * TerminalPane — a container component that manages multiple terminal
 * instances in a split-pane layout.
 *
 * All panes share rendering resources (e.g. the same WebGL context when
 * using the WebGL backend), which avoids hitting Chrome's 16-context limit.
 *
 * Layout is described as a recursive tree of horizontal / vertical splits.
 */

import type { Theme } from "@react-term/core";
import type React from "react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { TerminalHandle } from "./Terminal.js";
import { Terminal } from "./Terminal.js";

// ---------------------------------------------------------------------------
// Layout types
// ---------------------------------------------------------------------------

export type PaneLayout =
  | { type: "single"; id: string }
  | { type: "horizontal"; children: PaneLayout[]; sizes?: number[] }
  | { type: "vertical"; children: PaneLayout[]; sizes?: number[] };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TerminalPaneProps {
  layout: PaneLayout;
  onData?: (paneId: string, data: Uint8Array) => void;
  theme?: Partial<Theme>;
  fontSize?: number;
  fontFamily?: string;
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

/** Collect all leaf pane ids from a layout tree. */
function collectPaneIds(layout: PaneLayout): string[] {
  if (layout.type === "single") {
    return [layout.id];
  }
  const ids: string[] = [];
  for (const child of layout.children) {
    ids.push(...collectPaneIds(child));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// PaneLeaf — renders a single Terminal inside a flex child
// ---------------------------------------------------------------------------

interface PaneLeafProps {
  id: string;
  onData?: (paneId: string, data: Uint8Array) => void;
  theme?: Partial<Theme>;
  fontSize?: number;
  fontFamily?: string;
  onRef: (id: string, handle: TerminalHandle | null) => void;
}

function PaneLeaf({ id, onData, theme, fontSize, fontFamily, onRef }: PaneLeafProps) {
  const termRef = useRef<TerminalHandle>(null);

  useEffect(() => {
    onRef(id, termRef.current);
    return () => {
      onRef(id, null);
    };
  }, [id, onRef]);

  const handleData = useCallback(
    (data: Uint8Array) => {
      onData?.(id, data);
    },
    [id, onData],
  );

  return (
    <Terminal
      ref={termRef}
      autoFit
      theme={theme}
      fontSize={fontSize}
      fontFamily={fontFamily}
      onData={handleData}
      style={{ width: "100%", height: "100%" }}
    />
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
  onRef: (id: string, handle: TerminalHandle | null) => void;
}

function PaneNode({ layout, onData, theme, fontSize, fontFamily, onRef }: PaneNodeProps) {
  if (layout.type === "single") {
    return (
      <PaneLeaf
        id={layout.id}
        onData={onData}
        theme={theme}
        fontSize={fontSize}
        fontFamily={fontFamily}
        onRef={onRef}
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
              onRef={onRef}
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
    const { layout, onData, theme, fontSize, fontFamily, className, style } = props;
    const terminalsRef = useRef<Map<string, TerminalHandle>>(new Map());

    const handleRef = useCallback((id: string, handle: TerminalHandle | null) => {
      if (handle) {
        terminalsRef.current.set(id, handle);
      } else {
        terminalsRef.current.delete(id);
      }
    }, []);

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
        className={className}
        style={{
          position: "relative",
          overflow: "hidden",
          ...style,
        }}
      >
        <PaneNode
          layout={layout}
          onData={onData}
          theme={theme}
          fontSize={fontSize}
          fontFamily={fontFamily}
          onRef={handleRef}
        />
      </div>
    );
  },
);
