import { describe, expect, it } from "vitest";
import {
  IDENTITY, alignPair, apply, blend, bounds, compose, inverse, pyramid, rotateAbout, toGray,
  type Pixels, type Pt, type Transform,
} from "../src/stitch";

/** A fake printed page: blocks, rules and lots of small "letters", on white. */
function page(width: number, height: number, seed = 1): Pixels {
  let state = seed;
  const rand = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const rect = (x: number, y: number, w: number, h: number, v: number) => {
    for (let j = Math.max(0, y); j < Math.min(height, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(width, x + w); i++) data.fill(v, (j * width + i) * 4, (j * width + i) * 4 + 3);
  };
  for (let k = 0; k < 6; k++) rect(rand() * width, rand() * height, 20 + rand() * 80, 20 + rand() * 80, 100 + rand() * 100);
  for (let line = 20; line < height - 20; line += 14) {
    for (let x = 20; x < width - 20; x += 5 + rand() * 6) if (rand() > 0.15) rect(x, line, 2 + rand() * 4, 5 + rand() * 4, rand() * 60);
  }
  return { data, width, height };
}

/** A scan of part of `src`: its pixel p shows src at t(p). Off the page is white. */
function scan(src: Pixels, width: number, height: number, t: Transform): Pixels {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [qx, qy] = apply(t, [x + 0.5, y + 0.5]);
      const i = Math.floor(qx);
      const j = Math.floor(qy);
      if (i < 0 || j < 0 || i >= src.width || j >= src.height) continue;
      data.set(src.data.subarray((j * src.width + i) * 4, (j * src.width + i) * 4 + 4), (y * width + x) * 4);
    }
  return { data, width, height };
}

const pyr = (p: Pixels) => pyramid(toGray(p.data, p.width, p.height));
const deg = (d: number) => (d * Math.PI) / 180;

describe("transforms", () => {
  it("compose, invert and rotate consistently", () => {
    const a = { theta: 0.3, tx: 5, ty: -2 };
    const b = { theta: -1.1, tx: 1, ty: 7 };
    const p: Pt = [3, 4];
    const [x, y] = apply(compose(a, b), p);
    const [ex, ey] = apply(a, apply(b, p));
    expect(x).toBeCloseTo(ex);
    expect(y).toBeCloseTo(ey);
    const back = apply(inverse(a), apply(a, p));
    expect(back[0]).toBeCloseTo(3);
    expect(back[1]).toBeCloseTo(4);
    const turned = rotateAbout(a, 0.5, apply(a, p));
    expect(apply(turned, p)[0]).toBeCloseTo(apply(a, p)[0]);
  });
  it("bounds a 180° turn", () => {
    expect(bounds([{ width: 10, height: 4 }], [{ theta: Math.PI, tx: 10, ty: 4 }])).toEqual({ x: 0, y: 0, width: 10, height: 4 });
  });
});

describe("alignPair", () => {
  const src = page(480, 720);
  const top = scan(src, 480, 430, IDENTITY);

  for (const [name, theta] of [["the same way up", deg(1.3)], ["turned around", Math.PI + deg(-2.2)]] as const) {
    it(`finds a second scan ${name}`, () => {
      // The bottom scan's centre shows the page at (240, 520): an overlap of about 140 rows.
      const [rx, ry] = apply({ theta, tx: 0, ty: 0 }, [240, 200]);
      const truth = { theta, tx: 240 - rx, ty: 520 - ry };
      const bottom = scan(src, 480, 400, truth);
      const found = alignPair(pyr(top), pyr(bottom));
      expect(found.score).toBeGreaterThan(0.8);
      expect(found.overlap).toBeGreaterThan(0.2);
      // Every corner of the scan lands within a pixel of where it should.
      for (const p of [[0, 0], [480, 0], [480, 400], [0, 400]] as Pt[]) {
        const [x, y] = apply(found.t, p);
        const [ex, ey] = apply(truth, p);
        expect(Math.hypot(x - ex, y - ey)).toBeLessThan(1);
      }
    });
  }

  it("snaps from a rough placement made by hand", () => {
    const theta = Math.PI + deg(0.8);
    const [rx, ry] = apply({ theta, tx: 0, ty: 0 }, [240, 200]);
    const truth = { theta, tx: 240 - rx, ty: 520 - ry };
    const bottom = scan(src, 480, 400, truth);
    // Dropped 40px off and turned 1.5° the wrong way.
    const rough = rotateAbout({ ...truth, tx: truth.tx + 30, ty: truth.ty - 26 }, deg(-1.5), [240, 520]);
    const found = alignPair(pyr(top), pyr(bottom), rough);
    expect(found.score).toBeGreaterThan(0.8);
    const [x, y] = apply(found.t, [0, 0]);
    const [ex, ey] = apply(truth, [0, 0]);
    expect(Math.hypot(x - ex, y - ey)).toBeLessThan(1);
  });

  it("scores scans that don't overlap as poor", () => {
    const other = scan(page(480, 720, 99), 480, 400, IDENTITY);
    expect(alignPair(pyr(top), pyr(other)).score).toBeLessThan(0.4);
  });
});

describe("blend", () => {
  it("rebuilds the page from two placed scans", () => {
    const src = page(200, 300, 7);
    const top = scan(src, 200, 180, IDENTITY);
    const theta = Math.PI;
    const truth = { theta, tx: 200, ty: 300 }; // the bottom 180 rows, upside down
    const bottom = scan(src, 200, 180, truth);
    const out = blend([top, bottom], [IDENTITY, truth]);
    expect([out.width, out.height]).toEqual([200, 300]);
    let diff = 0;
    for (let i = 0; i < out.data.length; i += 4) diff += Math.abs(out.data[i] - src.data[i]);
    expect(diff / (200 * 300)).toBeLessThan(1);
  });
});
