import { clamp, type Rect } from "./geometry";

export type Pt = [number, number];

/**
 * The page's outline in a photo: four corners (fractions of the image size, clockwise
 * from top-left) and, along each edge, bend points that follow a curled page.
 */
export interface Outline {
  corners: [Pt, Pt, Pt, Pt];
  /** For each edge (top, right, bottom, left), how far each bend point sits off the
   *  straight line, as a fraction of the edge's length. Positive is outward. */
  bends: number[][];
  /** Radial lens distortion: negative undoes barrel distortion, positive pincushion. */
  lens: number;
}

/** Bend points per edge, evenly spaced between the corners. */
export const BENDS = 3;

export type Crop = { kind: "rect"; rect: Rect } | { kind: "outline"; outline: Outline };

export function outlineFromRect(r: Rect, lens = 0): Outline {
  return {
    corners: [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x + r.w, r.y + r.h],
      [r.x, r.y + r.h],
    ],
    bends: [0, 1, 2, 3].map(() => Array(BENDS).fill(0)),
    lens,
  };
}

/** Turns the outline with its image, a quarter turn clockwise per step. */
export function rotateOutline(o: Outline, quarterTurns: number): Outline {
  let out = o;
  for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) {
    const c = out.corners.map(([x, y]) => [1 - y, x] as Pt);
    // What was the page's bottom-left is now its top-left, and each edge moves round one.
    out = {
      corners: [c[3], c[0], c[1], c[2]],
      bends: [out.bends[3], out.bends[0], out.bends[1], out.bends[2]],
      lens: out.lens,
    };
  }
  return out;
}

function edgeFrame(o: Outline, edge: number, width: number, height: number) {
  const [ax, ay] = o.corners[edge];
  const [bx, by] = o.corners[(edge + 1) % 4];
  const a: Pt = [ax * width, ay * height];
  const dx = (bx - ax) * width;
  const dy = (by - ay) * height;
  const len = Math.hypot(dx, dy) || 1;
  // Edges run clockwise, so turning the direction a quarter left points outward.
  return { a, dx, dy, len, nx: dy / len, ny: -dx / len };
}

/** Each edge's points in pixels, clockwise: its start corner, its bend points, its end corner. */
export function edgePoints(o: Outline, width: number, height: number): Pt[][] {
  return [0, 1, 2, 3].map((edge) => {
    const { a, dx, dy, len, nx, ny } = edgeFrame(o, edge, width, height);
    const bends = o.bends[edge].map((off, i): Pt => {
      const t = (i + 1) / (BENDS + 1);
      return [a[0] + dx * t + nx * off * len, a[1] + dy * t + ny * off * len];
    });
    const [bx, by] = o.corners[(edge + 1) % 4];
    return [a, ...bends, [bx * width, by * height]];
  });
}

/** The bend that puts bend point `index` of `edge` as close as it can get to pixel `p`. */
export function bendToward(o: Outline, edge: number, index: number, p: Pt, width: number, height: number) {
  const { a, dx, dy, len, nx, ny } = edgeFrame(o, edge, width, height);
  const t = (index + 1) / (BENDS + 1);
  const off = ((p[0] - a[0] - dx * t) * nx + (p[1] - a[1] - dy * t) * ny) / len;
  return clamp(off, -0.5, 0.5);
}

/** A smooth curve through `pts` (Catmull-Rom), as `steps + 1` points from first to last. */
export function sampleCurve(pts: Pt[], steps: number): Pt[] {
  const n = pts.length;
  const first: Pt = [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
  const last: Pt = [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
  const ext = [first, ...pts, last];
  const out: Pt[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = (s / steps) * (n - 1);
    const i = Math.min(Math.floor(t), n - 2);
    const f = t - i;
    const [p0, p1, p2, p3] = [ext[i], ext[i + 1], ext[i + 2], ext[i + 3]];
    const f2 = f * f;
    const f3 = f2 * f;
    const at = (k: 0 | 1) =>
      0.5 *
      (2 * p1[k] +
        (p2[k] - p0[k]) * f +
        (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f2 +
        (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * f3);
    out.push([at(0), at(1)]);
  }
  return out;
}

/** Where a point of the undistorted scene lands in the photo, with lens strength `k`. */
export function distort([x, y]: Pt, k: number, width: number, height: number): Pt {
  const cx = width / 2;
  const cy = height / 2;
  const dx = x - cx;
  const dy = y - cy;
  const s = 1 + (k * (dx * dx + dy * dy)) / (cx * cx + cy * cy);
  return [cx + dx * s, cy + dy * s];
}

/** The inverse of `distort`. */
export function undistort(p: Pt, k: number, width: number, height: number): Pt {
  const cx = width / 2;
  const cy = height / 2;
  const r2max = cx * cx + cy * cy;
  let [x, y] = p;
  for (let i = 0; i < 20; i++) {
    const s = 1 + (k * ((x - cx) ** 2 + (y - cy) ** 2)) / r2max;
    x = cx + (p[0] - cx) / s;
    y = cy + (p[1] - cy) / s;
  }
  return [x, y];
}
