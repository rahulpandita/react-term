export type { Scenario } from "./types.js";

import { ascii } from "./ascii.js";
import { csiCollect, csiLongParams, csiParams, csiSimple } from "./csi.js";
import { cursorMotion } from "./cursor-motion.js";
import { dcsLong, dcsShort } from "./dcs.js";
import { escapeCollect, escapeSimple } from "./escape.js";
import { execute, scrolling } from "./newline.js";
import { oscLong, oscShort } from "./osc.js";
import { realWorld } from "./real-world.js";
import { sgrColor } from "./sgr.js";
import type { Scenario } from "./types.js";
import { unicode } from "./unicode.js";
import {
  vteCursorMotion,
  vteDenseCells,
  vteLightCells,
  vteMediumCells,
  vteScrolling,
  vteScrollingBottomRegion,
  vteScrollingBottomSmallRegion,
  vteScrollingFullscreen,
  vteScrollingTopRegion,
  vteScrollingTopSmallRegion,
  vteUnicode,
} from "./vtebench.js";

export const scenarios: Scenario[] = [
  // xterm-matched scenarios
  ascii(),
  execute(),
  escapeSimple(),
  escapeCollect(),
  csiSimple(),
  csiCollect(),
  csiParams(),
  csiLongParams(),
  oscShort(),
  oscLong(),
  dcsShort(),
  dcsLong(),
  // react-term additional scenarios
  scrolling(),
  sgrColor(),
  unicode(),
  cursorMotion(),
  realWorld(),
  // vtebench scenarios (alacritty/vtebench standard)
  vteDenseCells(),
  vteLightCells(),
  vteMediumCells(),
  vteCursorMotion(),
  vteScrolling(),
  vteScrollingFullscreen(),
  vteScrollingBottomRegion(),
  vteScrollingTopRegion(),
  vteScrollingBottomSmallRegion(),
  vteScrollingTopSmallRegion(),
  vteUnicode(),
];
