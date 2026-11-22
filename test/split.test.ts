import { describe, expect, it } from "vitest";
import { outlineFromRect, type Crop, type Outline, type Pt } from "../src/outline";
import { splitCrop } from "../src/split";
import { buildMapping } from "../src/warp";

const W = 1200;
const H = 800;
const near = (p: Pt, q: Pt, px: number) => expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(px);
const outlineOf = (c: Crop) => (c.kind === "outline" ? c.outline : (expect.fail("expected an outline") as never));

describe("splitCrop", () => {
  it("cuts a rectangle straight down into two rectangles", () => {
    const [l, r] = splitCrop({ kind: "rect", rect: { x: 0.1, y: 0.2, w: 0.8, h: 0.6 } }, { top: 0.5, bottom: 0.5 }, W, H);
    expect(l).toEqual({ kind: "rect", rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.6 } });
    expect(r.kind === "rect" && [r.rect.x, r.rect.w]).toEqual([0.5, 0.4]);
  });

  it("cuts a rectangle along a slanted gutter into two outlines", () => {
    const [l, r] = splitCrop({ kind: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } }, { top: 0.4, bottom: 0.6 }, W, H);
    const lo = outlineOf(l).corners;
    const ro = outlineOf(r).corners;
    [[0, 0], [0.4, 0], [0.6, 1], [0, 1]].forEach((p, i) => near(lo[i], p as Pt, 1e-9));
    [[0.4, 0], [1, 0], [1, 1], [0.6, 1]].forEach((p, i) => near(ro[i], p as Pt, 1e-9));
    expect(outlineOf(l).bends.flat().every((b) => Math.abs(b) < 1e-9)).toBe(true);
  });

  const curled: Outline = {
    corners: [[0.12, 0.1], [0.88, 0.14], [0.9, 0.92], [0.1, 0.88]],
    bends: [[0.01, 0.03, 0.01], [0, 0.01, 0], [-0.01, -0.025, -0.01], [0, -0.01, 0]],
    lens: -0.08,
  };

  it("splits a curled, skewed outline straight down so each half flattens to its half of the whole", () => {
    const m = buildMapping(curled, W, H);
    const [l, r] = splitCrop({ kind: "outline", outline: curled }, { top: 0.5, bottom: 0.5 }, W, H);
    const lm = buildMapping(outlineOf(l), W, H);
    const rm = buildMapping(outlineOf(r), W, H);
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      near(lm.map(0, v), m.map(0, v), 2);
      near(lm.map(1, v), m.map(0.5, v), 2);
      near(rm.map(0, v), m.map(0.5, v), 2);
      near(rm.map(1, v), m.map(1, v), 2);
      // Inside, blending a half's own curved edges differs a little from the whole's: a smooth shift
      // of well under 1% of the width.
      near(lm.map(0.5, v), m.map(0.25, v), 0.005 * W);
    }
  });

  it("follows a slanted gutter through a curled outline", () => {
    // A slanted gutter makes each half a trapezoid on the page, so it's stretched square when
    // flattened; what must hold is that its edges run along the real gutter and page edges.
    const m = buildMapping(curled, W, H);
    const [l] = splitCrop({ kind: "outline", outline: curled }, { top: 0.45, bottom: 0.55 }, W, H);
    const lm = buildMapping(outlineOf(l), W, H);
    const curve = (f: (t: number) => Pt) => Array.from({ length: 2001 }, (_, i) => f(i / 2000));
    const gutter = curve((t) => m.map(0.45 + 0.1 * t, t));
    const leftEdge = curve((t) => m.map(0, t));
    const distance = (p: Pt, line: Pt[]) => Math.min(...line.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])));
    for (const v of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      expect(distance(lm.map(1, v), gutter)).toBeLessThan(2);
      expect(distance(lm.map(0, v), leftEdge)).toBeLessThan(2);
    }
    near(lm.map(1, 0), m.map(0.45, 0), 1e-6);
    near(lm.map(1, 1), m.map(0.55, 1), 1e-6);
  });

  it("keeps the lens with each half", () => {
    const [l] = splitCrop({ kind: "outline", outline: { ...outlineFromRect({ x: 0, y: 0, w: 1, h: 1 }), lens: -0.1 } }, { top: 0.5, bottom: 0.5 }, W, H);
    expect(outlineOf(l).lens).toBe(-0.1);
  });
});
