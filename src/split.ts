import type { Rect } from "./geometry";
import { BENDS, bendToward, type Crop, type Outline, type Pt } from "./outline";
import { buildMapping } from "./warp";

/**
 * Where a spread's gutter runs: across the page's top and bottom edges, each as a
 * fraction of the (cropped or flattened) page's width. Equal means a vertical gutter.
 */
export interface Split {
  top: number;
  bottom: number;
}

export const CENTRE: Split = { top: 0.5, bottom: 0.5 };
export const MIN_SIDE = 0.05;

export const clampSplit = (s: Split): Split => ({
  top: Math.min(1 - MIN_SIDE, Math.max(MIN_SIDE, s.top)),
  bottom: Math.min(1 - MIN_SIDE, Math.max(MIN_SIDE, s.bottom)),
});

/**
 * The crops of a spread's left and right pages. A straight split of a rectangle gives
 * two rectangles; otherwise each half is a page outline, so it's flattened properly.
 * `width` and `height` are the photo's, in pixels.
 */
export function splitCrop(crop: Crop, split: Split, width: number, height: number): [Crop, Crop] {
  if (crop.kind === "rect" && Math.abs(split.top - split.bottom) < 1e-4) {
    const r = crop.rect;
    const left: Rect = { ...r, w: r.w * split.top };
    const right: Rect = { ...r, x: r.x + r.w * split.top, w: r.w * (1 - split.top) };
    return [
      { kind: "rect", rect: left },
      { kind: "rect", rect: right },
    ];
  }
  // Where the page puts (u, v) of its flattened self, in photo pixels.
  const at: (u: number, v: number) => Pt =
    crop.kind === "rect"
      ? (u, v) => [(crop.rect.x + u * crop.rect.w) * width, (crop.rect.y + v * crop.rect.h) * height]
      : buildMapping(crop.outline, width, height).map;
  const lens = crop.kind === "outline" ? crop.outline.lens : 0;
  const gutter = (v: number) => split.top + (split.bottom - split.top) * v;
  return [
    { kind: "outline", outline: subOutline(at, (v) => 0, gutter, lens, width, height) },
    { kind: "outline", outline: subOutline(at, gutter, (v) => 1, lens, width, height) },
  ];
}

/** The outline of the part of a page between two lines running top to bottom, u = left(v) to u = right(v). */
function subOutline(
  at: (u: number, v: number) => Pt,
  left: (v: number) => number,
  right: (v: number) => number,
  lens: number,
  width: number,
  height: number,
): Outline {
  // Each edge, clockwise from the top-left, traced through the page: t runs 0 → 1 along it.
  const edges: ((t: number) => Pt)[] = [
    (t) => at(left(0) + (right(0) - left(0)) * t, 0),
    (t) => at(right(t), t),
    (t) => at(right(1) + (left(1) - right(1)) * t, 1),
    (t) => at(left(1 - t), 1 - t),
  ];
  const norm = ([x, y]: Pt): Pt => [x / width, y / height];
  const outline: Outline = {
    corners: edges.map((edge) => norm(edge(0))) as Outline["corners"],
    bends: [],
    lens,
  };
  outline.bends = edges.map((edge, e) =>
    Array.from({ length: BENDS }, (_, i) => bendToward(outline, e, i, edge((i + 1) / (BENDS + 1)), width, height)),
  );
  return outline;
}
