import { describe, expect, it } from "vitest";
import { addBend, edgePoints, moveOutline, removeBend, rotateOutline, sampleCurve, stopsOf, type Outline, type Pt } from "../src/outline";

const curled: Outline = {
  corners: [[0.1, 0.1], [0.9, 0.12], [0.88, 0.9], [0.12, 0.88]],
  bends: [[0.02, 0.05, 0.02], [0, 0, 0], [-0.02, 0.04, -0.01], [0, 0, 0]],
  lens: 0,
};
const W = 1000;
const H = 800;

/** How far the curve through `b` strays from the one through `a`, at worst. */
const drift = (a: Pt[], b: Pt[]) => {
  const ca = sampleCurve(a, 400);
  return Math.max(...sampleCurve(b, 400).map((p) => Math.min(...ca.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))));
};

describe("adding and removing bend points", () => {
  it("adds a point on the curve where it's asked for, in order, without changing the curve's shape", () => {
    const before = edgePoints(curled, W, H)[0];
    const on = sampleCurve(before, 400)[340]; // well toward the right-hand end
    const after = addBend(curled, 0, on, W, H);
    expect(after.bends[0]).toHaveLength(4);
    expect(stopsOf(after, 0)).toEqual([...stopsOf(after, 0)].sort((a, b) => a - b));
    const pts = edgePoints(after, W, H)[0];
    expect(pts.some((p) => Math.hypot(p[0] - on[0], p[1] - on[1]) < 0.5)).toBe(true);
    expect(drift(before, pts)).toBeLessThan(2);
    // The other edges are untouched.
    expect(edgePoints(after, W, H).slice(1)).toEqual(edgePoints(curled, W, H).slice(1));
  });

  it("removes a point and keeps the rest where they were", () => {
    const more = addBend(curled, 2, edgePoints(curled, W, H)[2][2], W, H);
    const fewer = removeBend(more, 2, 0);
    expect(fewer.bends[2]).toHaveLength(3);
    const kept = edgePoints(more, W, H)[2].filter((_, i) => i !== 1);
    edgePoints(fewer, W, H)[2].forEach((p, i) => {
      expect(p[0]).toBeCloseTo(kept[i][0], 6);
      expect(p[1]).toBeCloseTo(kept[i][1], 6);
    });
  });

  it("turns added points with the outline", () => {
    const more = addBend(curled, 0, sampleCurve(edgePoints(curled, W, H)[0], 100)[90], W, H);
    const back = rotateOutline(rotateOutline(more, 1), -1);
    expect(back.bends).toEqual(more.bends);
    expect(stopsOf(back, 0)).toEqual(stopsOf(more, 0));
  });

  it("draws crowded points without looping", () => {
    // Three points bunched near one end of a gently curved edge.
    const pts: Pt[] = [[0, 0], [700, 10], [720, 30], [740, 15], [1000, 0]];
    const curve = sampleCurve(pts, 200);
    const xs = curve.map((p) => p[0]);
    expect(xs.every((x, i) => i === 0 || x >= xs[i - 1] - 1e-9)).toBe(true);
  });
});

describe("moveOutline", () => {
  it("slides the corners and stops at the image's edge", () => {
    const moved = moveOutline(curled, 0.05, -0.5);
    expect(moved.corners[0][0]).toBeCloseTo(0.15);
    expect(Math.min(...moved.corners.map((c) => c[1]))).toBeCloseTo(0);
    expect(moved.bends).toEqual(curled.bends);
  });
});
