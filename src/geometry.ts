/** A rectangle in fractions of an image's width and height, so one crop fits images of any size. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const MIN = 0.02;

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export const isFull = (r: Rect) => r.x <= 0.001 && r.y <= 0.001 && r.x + r.w >= 0.999 && r.y + r.h >= 0.999;

/** Turns `r` along with its image, a quarter turn clockwise per step (negative is counterclockwise). */
export function rotateRect(r: Rect, quarterTurns: number): Rect {
  let out = r;
  for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) {
    out = { x: 1 - (out.y + out.h), y: out.x, w: out.h, h: out.w };
  }
  return out;
}

/** Whole pixels covered by `r` in an image of the given size, always at least 1×1. */
export function toPixels(r: Rect, width: number, height: number) {
  const x = clamp(Math.round(r.x * width), 0, width - 1);
  const y = clamp(Math.round(r.y * height), 0, height - 1);
  const w = clamp(Math.round((r.x + r.w) * width) - x, 1, width - x);
  const h = clamp(Math.round((r.y + r.h) * height) - y, 1, height - y);
  return { x, y, w, h };
}

export type DragMode = { kind: "move" } | { kind: "draw" } | { kind: "resize"; edges: string };

/**
 * The rectangle that results from dragging from (sx, sy) to (px, py), both in 0–1.
 * `edges` names the sides a resize moves, as compass letters: "nw", "e", ….
 */
export function dragRect(start: Rect, mode: DragMode, sx: number, sy: number, px: number, py: number): Rect {
  const dx = px - sx;
  const dy = py - sy;
  if (mode.kind === "move") {
    return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
  }
  if (mode.kind === "draw") {
    const x0 = clamp(Math.min(sx, px), 0, 1 - MIN);
    const y0 = clamp(Math.min(sy, py), 0, 1 - MIN);
    return { x: x0, y: y0, w: Math.max(Math.max(sx, px) - x0, MIN), h: Math.max(Math.max(sy, py) - y0, MIN) };
  }
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + start.w;
  let y1 = start.y + start.h;
  if (mode.edges.includes("w")) x0 = clamp(x0 + dx, 0, x1 - MIN);
  if (mode.edges.includes("e")) x1 = clamp(x1 + dx, x0 + MIN, 1);
  if (mode.edges.includes("n")) y0 = clamp(y0 + dy, 0, y1 - MIN);
  if (mode.edges.includes("s")) y1 = clamp(y1 + dy, y0 + MIN, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
