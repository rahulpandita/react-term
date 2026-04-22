/**
 * Cell attribute bit positions — the per-cell `attrs` byte packed in
 * `CellGrid.data[offset+1]` bits 8–15.
 *
 * Previously each renderer (Canvas2DRenderer, WebGLRenderer, the two worker
 * backends, SharedCanvas2DContext) redeclared these constants at the top of
 * its file. Keeping them in one place ensures they can't drift when the
 * packing scheme changes.
 */

export const ATTR_BOLD = 0x01;
export const ATTR_ITALIC = 0x02;
export const ATTR_UNDERLINE = 0x04;
export const ATTR_STRIKETHROUGH = 0x08;
export const ATTR_INVERSE = 0x40;
