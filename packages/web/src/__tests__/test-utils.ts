/**
 * Shared test utilities for the `@next_term/web` package.
 *
 * Provides a reusable logged mock for `CanvasRenderingContext2D` that records
 * both method calls and the `fillStyle`/`globalAlpha` state that was active at
 * the time of each call.  This lets tests assert on colour-active-when-drawn
 * without complex ordering heuristics.
 */

import type { CursorState } from "@next_term/core";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// CallLog — stateful canvas mock
// ---------------------------------------------------------------------------

/**
 * Ordered record of every canvas operation together with the rendering state
 * that was active when the operation fired.
 */
export interface CallLog {
  /** Operation name + positional arguments. */
  ops: Array<[string, unknown[]]>;
  /** Snapshot of fillStyle/globalAlpha taken at the moment of each op. */
  state: Array<{ fillStyle: unknown; globalAlpha: number }>;
}

/**
 * Create a mock `CanvasRenderingContext2D` (or `OffscreenCanvasRenderingContext2D`)
 * that logs every drawing call via a {@link CallLog}.
 *
 * Also returns a `calls` alias (`log.ops`) for tests that only care about
 * operation names (backward-compatible with the pattern in render-worker-canvas2d.test.ts).
 */
export function createLoggedMockContext(): {
  ctx: CanvasRenderingContext2D;
  log: CallLog;
  calls: CallLog["ops"];
} {
  const log: CallLog = { ops: [], state: [] };
  let fillStyle: unknown = "";
  let globalAlpha = 1;

  const record = (name: string) =>
    vi.fn((...args: unknown[]) => {
      log.ops.push([name, args]);
      log.state.push({ fillStyle, globalAlpha });
    });

  const ctx = {
    clearRect: record("clearRect"),
    fillRect: record("fillRect"),
    fillText: record("fillText"),
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    stroke: record("stroke"),
    setTransform: record("setTransform"),
    measureText: vi.fn(() => ({
      width: 8,
      fontBoundingBoxAscent: 10,
      fontBoundingBoxDescent: 2,
    })),
    font: "",
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: unknown) {
      fillStyle = v;
    },
    strokeStyle: "",
    lineWidth: 1,
    get globalAlpha() {
      return globalAlpha;
    },
    set globalAlpha(v: number) {
      globalAlpha = v;
    },
  } as unknown as CanvasRenderingContext2D;

  return { ctx, log, calls: log.ops };
}

// ---------------------------------------------------------------------------
// HTMLCanvasElement.prototype.getContext installer
// ---------------------------------------------------------------------------

/**
 * Install a logged mock 2D context on `HTMLCanvasElement.prototype.getContext`
 * for the duration of a single test.  The caller is responsible for saving and
 * restoring the original binding (typically via `beforeEach`/`afterEach`).
 *
 * @example
 * ```ts
 * let restoreGetContext: () => void;
 * beforeEach(() => { restoreGetContext = undefined!; });
 * afterEach(() => { restoreGetContext?.(); });
 *
 * it("...", () => {
 *   const { ctx, log, restore } = installLoggedMockGetContext();
 *   restoreGetContext = restore;
 *   // … test logic …
 * });
 * ```
 */
export function installLoggedMockGetContext(): {
  ctx: CanvasRenderingContext2D;
  log: CallLog;
  calls: CallLog["ops"];
  restore: () => void;
} {
  const { ctx, log, calls } = createLoggedMockContext();
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ctx,
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const restore = () => {
    HTMLCanvasElement.prototype.getContext = original;
  };
  return { ctx, log, calls, restore };
}

// ---------------------------------------------------------------------------
// CursorState factory
// ---------------------------------------------------------------------------

/**
 * Build a default {@link CursorState} suitable for use in tests.
 * Pass `overrides` to customise individual fields.
 */
export function makeCursor(overrides?: Partial<CursorState>): CursorState {
  return {
    row: 0,
    col: 0,
    visible: true,
    style: "block",
    wrapPending: false,
    ...overrides,
  };
}
