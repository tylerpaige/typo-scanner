import { describe, expect, it } from "vitest";
import { FULL } from "../src/geometry";
import {
  bendToward, distort, edgePoints, outlineFromRect, rotateOutline, undistort, type Outline, type Pt,
} from "../src/outline";
import { buildMapping, warpImage } from "../src/warp";

const near = (p: Pt, q: Pt, eps = 1e-6) => {
  expect(p[0]).toBeCloseTo(q[0], -Math.log10(eps));
  expect(p[1]).toBeCloseTo(q[1], -Math.log10(eps));
};

const quad: Outline = {
  corners: [[0.2, 0.1], [0.8, 0.2], [0.9, 0.9], [0.1, 0.8]],
  bends: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
  lens: 0,
};

describe("lens model", () => {
  it("undistort undoes distort", () => {
    for (const k of [-0.2, 0, 0.15]) near(undistort(distort([30, 170], k, 400, 300), k, 400, 300), [30, 170], 1e-4);
  });
  it("leaves the centre alone and pulls corners in for barrel correction", () => {
    near(distort([200, 150], -0.2, 400, 300), [200, 150]);
    expect(distort([0, 0], -0.2, 400, 300)[0]).toBeGreaterThan(0);
  });
});

describe("buildMapping", () => {
  it("puts the page's corners on the outline's corners", () => {
    const m = buildMapping(quad, 1000, 500);
    near(m.map(0, 0), [200, 50]);
    near(m.map(1, 0), [800, 100]);
    near(m.map(1, 1), [900, 450]);
    near(m.map(0, 1), [100, 400]);
  });

  it("finds the page centre where the diagonals cross, as perspective requires", () => {
    // A trapezoid: a rectangle seen from below. Its centre is nearer the short top edge
    // than halfway down, so a plain average of the corners would be wrong.
    const trap: Outline = { ...quad, corners: [[0.3, 0.2], [0.7, 0.2], [0.9, 0.8], [0.1, 0.8]] };
    const [, y] = buildMapping(trap, 100, 100).map(0.5, 0.5);
    // The diagonals (30,20)→(90,80) and (70,20)→(10,80) meet a third of the way along, at y = 40.
    expect(y).toBeCloseTo(40, 6);
  });

  it("follows a bent edge", () => {
    const bent: Outline = { ...outlineFromRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }), bends: [[0, 0.05, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] };
    const mid = edgePoints(bent, 1000, 1000)[0][2];
    near(mid, [500, 100 - 0.05 * 800]);
    near(buildMapping(bent, 1000, 1000).map(0.5, 0), mid, 1e-2);
    // The middle of the page bends with it, by half as much.
    expect(buildMapping(bent, 1000, 1000).map(0.5, 0.5)[1]).toBeCloseTo(500 - 20, 1);
  });

  it("sizes the result from the edge lengths", () => {
    const m = buildMapping(outlineFromRect({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 }), 1000, 600);
    expect([m.width, m.height]).toEqual([500, 300]);
  });
});

describe("outline editing", () => {
  it("rotates with the image and back", () => {
    const o = { ...quad, bends: [[0.1, 0, 0], [0, 0.2, 0], [0, 0, 0.3], [0.4, 0, 0]] };
    const r = rotateOutline(o, 1);
    near(r.corners[0], [1 - 0.8, 0.1]); // the old bottom-left, turned
    expect(r.bends[0]).toEqual(o.bends[3]);
    const back = rotateOutline(r, 3);
    back.corners.forEach((p, i) => near(p, o.corners[i]));
    expect(back.bends).toEqual(o.bends);
  });
  it("bends toward the pointer, measured off the straight edge", () => {
    const o = outlineFromRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    expect(bendToward(o, 0, 1, [500, 60], 1000, 1000)).toBeCloseTo(0.05);
    expect(bendToward(o, 1, 1, [950, 500], 1000, 1000)).toBeCloseTo(50 / 800);
  });
});

describe("warpImage", () => {
  it("returns the image unchanged for a full-frame outline", () => {
    const w = 8, h = 6;
    const data = new Uint8ClampedArray(w * h * 4).map((_, i) => (i * 37) % 251);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const out = warpImage({ data, width: w, height: h }, outlineFromRect(FULL));
    expect([out.width, out.height]).toEqual([w, h]);
    expect([...out.data]).toEqual([...data]);
  });

  it("straightens a skewed square back into a square", () => {
    // Draw a black square on white seen in perspective, then flatten it.
    const S = 200;
    const corners: Pt[] = [[40, 30], [160, 50], [170, 170], [30, 150]];
    const o: Outline = { corners: corners.map(([x, y]) => [x / S, y / S]) as Outline["corners"], bends: quad.bends, lens: 0 };
    const m = buildMapping(o, S, S);
    const data = new Uint8ClampedArray(S * S * 4).fill(255);
    // Paint each source pixel black if it falls in the middle third of the page.
    for (let i = 0; i <= 400; i++)
      for (let j = 0; j <= 400; j++) {
        const [x, y] = m.map(1 / 3 + i / 1200, 1 / 3 + j / 1200);
        data.fill(0, (Math.floor(y) * S + Math.floor(x)) * 4, (Math.floor(y) * S + Math.floor(x)) * 4 + 3);
      }
    const out = warpImage({ data, width: S, height: S }, o);
    const at = (u: number, v: number) => out.data[(Math.floor(v * out.height) * out.width + Math.floor(u * out.width)) * 4];
    expect(at(0.5, 0.5)).toBeLessThan(40);
    expect(at(0.4, 0.4)).toBeLessThan(40);
    expect(at(0.6, 0.6)).toBeLessThan(40);
    expect(at(0.2, 0.5)).toBeGreaterThan(215);
    expect(at(0.5, 0.8)).toBeGreaterThan(215);
  });
});
