import { distort, edgePoints, sampleCurve, undistort, type Outline, type Pt } from "./outline";

type Matrix = [number, number, number, number, number, number, number, number, number];

/** The perspective transform taking the unit square's corners to `p` (clockwise from top-left). */
function squareToQuad([p0, p1, p2, p3]: Pt[]): Matrix {
  const [x0, y0] = p0;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let g = 0;
  let h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const dx1 = x1 - x2;
    const dx2 = x3 - x2;
    const dy1 = y1 - y2;
    const dy2 = y3 - y2;
    const det = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    C / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
}

function apply(m: Matrix, [x, y]: Pt): Pt {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

const LUT = 512;

/**
 * How far an edge strays from its side of the unit square, as a lookup table over
 * position along that side. `along` is the coordinate that runs along the side.
 */
function profile(pts: Pt[], along: 0 | 1, base: number): Float64Array {
  const curve = sampleCurve(pts, LUT).sort((p, q) => p[along] - q[along]);
  const across = along === 0 ? 1 : 0;
  const out = new Float64Array(LUT + 1);
  let j = 0;
  for (let k = 0; k <= LUT; k++) {
    const t = k / LUT;
    while (j < curve.length - 2 && curve[j + 1][along] < t) j++;
    const [p, q] = [curve[j], curve[j + 1]];
    const span = q[along] - p[along];
    const f = span > 1e-12 ? Math.min(1, Math.max(0, (t - p[along]) / span)) : 0;
    out[k] = p[across] + (q[across] - p[across]) * f - base;
  }
  return out;
}

function lookup(table: Float64Array, t: number): number {
  const x = Math.min(LUT, Math.max(0, t * LUT));
  const i = Math.min(LUT - 1, Math.floor(x));
  return table[i] + (table[i + 1] - table[i]) * (x - i);
}

const arcLength = (pts: Pt[]) =>
  sampleCurve(pts, 64).reduce((sum, p, i, all) => (i ? sum + Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) : 0), 0);

export interface Mapping {
  /** The flattened page's size in pixels. */
  width: number;
  height: number;
  /** For a point on the flattened page (0–1 each way), where it is in the photo, in pixels. */
  map(u: number, v: number): Pt;
  /** The same, with the per-row and per-column terms already worked out; for tight loops. */
  rows: { left: Float64Array; right: Float64Array };
  cols: { top: Float64Array; bottom: Float64Array };
  matrix: Matrix;
}

/**
 * Flattening works in three steps, run backwards from each output pixel:
 * a blend of the four (curved) edges gives a point in a perspective-free square,
 * the corners' perspective transform places it in the undistorted scene,
 * and the lens model puts it where the camera actually recorded it.
 */
export function buildMapping(o: Outline, width: number, height: number): Mapping {
  const edges = edgePoints(o, width, height).map((pts) => pts.map((p) => undistort(p, o.lens, width, height)));
  const matrix = squareToQuad(edges.map((e) => e[0]));
  const back = invert(matrix);
  const pull = (pts: Pt[]) => pts.map((p) => apply(back, p));
  // Pulled back into the square, each edge should hug its side; what's left over is the curl.
  const top = profile(pull(edges[0]), 0, 0);
  const right = profile(pull(edges[1]), 1, 1);
  const bottom = profile(pull(edges[2]).reverse(), 0, 1);
  const left = profile(pull(edges[3]).reverse(), 1, 0);

  const map = (u: number, v: number): Pt => {
    const x = u + (1 - u) * lookup(left, v) + u * lookup(right, v);
    const y = v + (1 - v) * lookup(top, u) + v * lookup(bottom, u);
    return distort(apply(matrix, [x, y]), o.lens, width, height);
  };
  return {
    width: Math.max(1, Math.round((arcLength(edges[0]) + arcLength(edges[2])) / 2)),
    height: Math.max(1, Math.round((arcLength(edges[1]) + arcLength(edges[3])) / 2)),
    map,
    rows: { left, right },
    cols: { top, bottom },
    matrix,
  };
}

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Flattens the page outlined in `src` into a new image. Anything outside the photo is white. */
export function warpImage(src: Pixels, o: Outline): Pixels {
  const m = buildMapping(o, src.width, src.height);
  const W = m.width;
  const H = m.height;
  const out = new Uint8ClampedArray(W * H * 4);
  const [a, b, c, d, e, f, g, h, i] = m.matrix;
  const { data, width: sw, height: sh } = src;
  const cx = sw / 2;
  const cy = sh / 2;
  const k = o.lens / (cx * cx + cy * cy);

  const us = new Float64Array(W);
  const tops = new Float64Array(W);
  const bottoms = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W;
    us[x] = u;
    tops[x] = lookup(m.cols.top, u);
    bottoms[x] = lookup(m.cols.bottom, u);
  }

  let o4 = 0;
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const left = lookup(m.rows.left, v);
    const right = lookup(m.rows.right, v);
    for (let x = 0; x < W; x++, o4 += 4) {
      const u = us[x];
      const qx = u + (1 - u) * left + u * right;
      const qy = v + (1 - v) * tops[x] + v * bottoms[x];
      const w = g * qx + h * qy + i;
      const px = (a * qx + b * qy + c) / w - cx;
      const py = (d * qx + e * qy + f) / w - cy;
      const s = 1 + k * (px * px + py * py);
      // Pixel centres sit at half-pixels.
      const fx = cx + px * s - 0.5;
      const fy = cy + py * s - 0.5;
      if (fx < -0.5 || fy < -0.5 || fx > sw - 0.5 || fy > sh - 0.5) {
        out[o4] = out[o4 + 1] = out[o4 + 2] = out[o4 + 3] = 255;
        continue;
      }
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const tx = Math.max(0, Math.min(1, fx - x0));
      const ty = Math.max(0, Math.min(1, fy - y0));
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = data[i00 + ch] + (data[i10 + ch] - data[i00 + ch]) * tx;
        const bot = data[i01 + ch] + (data[i11 + ch] - data[i01 + ch]) * tx;
        out[o4 + ch] = top + (bot - top) * ty;
      }
      out[o4 + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}
