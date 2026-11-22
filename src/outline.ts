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
  /** For each edge, where along it each bend point sits (0–1 from its start corner, in
   *  order). Left out, the points are evenly spaced. */
  stops?: number[][];
  /** Radial lens distortion: negative undoes barrel distortion, positive pincushion. */
  lens: number;
}

/** Bend points per edge to start with, evenly spaced between the corners. */
export const BENDS = 3;

/** Where along `edge` its bend points sit. */
export const stopsOf = (o: Outline, edge: number): number[] =>
  o.stops?.[edge] ?? o.bends[edge].map((_, i, all) => (i + 1) / (all.length + 1));

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
      stops: [3, 0, 1, 2].map((e) => stopsOf(out, e)),
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
    const stops = stopsOf(o, edge);
    const bends = o.bends[edge].map((off, i): Pt => {
      const t = stops[i];
      return [a[0] + dx * t + nx * off * len, a[1] + dy * t + ny * off * len];
    });
    const [bx, by] = o.corners[(edge + 1) % 4];
    return [a, ...bends, [bx * width, by * height]];
  });
}

/** The bend that puts bend point `index` of `edge` as close as it can get to pixel `p`. */
export function bendToward(o: Outline, edge: number, index: number, p: Pt, width: number, height: number) {
  const { a, dx, dy, len, nx, ny } = edgeFrame(o, edge, width, height);
  const t = stopsOf(o, edge)[index];
  const off = ((p[0] - a[0] - dx * t) * nx + (p[1] - a[1] - dy * t) * ny) / len;
  return clamp(off, -0.5, 0.5);
}

/**
 * A smooth curve through `pts`, from first to last, in at least `steps` pieces shared out
 * between its spans. It's centripetal Catmull-Rom, which doesn't overshoot or loop where
 * points crowd together (as they do near a spine).
 */
export function sampleCurve(pts: Pt[], steps: number): Pt[] {
  const n = pts.length;
  const first: Pt = [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
  const last: Pt = [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
  const ext = [first, ...pts, last];
  const per = Math.max(1, Math.ceil(steps / (n - 1)));
  const lerp = (p: Pt, q: Pt, a: number, b: number, t: number): Pt => {
    const f = b - a > 1e-12 ? (t - a) / (b - a) : 0;
    return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
  };
  const out: Pt[] = [pts[0]];
  for (let i = 0; i < n - 1; i++) {
    const [p0, p1, p2, p3] = [ext[i], ext[i + 1], ext[i + 2], ext[i + 3]];
    const knot = (p: Pt, q: Pt) => Math.max(1e-6, Math.sqrt(Math.hypot(q[0] - p[0], q[1] - p[1])));
    const t1 = knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    for (let s = 1; s <= per; s++) {
      const t = t1 + ((t2 - t1) * s) / per;
      const a1 = lerp(p0, p1, 0, t1, t);
      const a2 = lerp(p1, p2, t1, t2, t);
      const a3 = lerp(p2, p3, t2, t3, t);
      out.push(lerp(lerp(a1, a2, 0, t2, t), lerp(a2, a3, t1, t3, t), t1, t2, t));
    }
  }
  return out;
}

/** The outline slid by (dx, dy), as fractions of the image, as far as it fits in the image. */
export function moveOutline(o: Outline, dx: number, dy: number): Outline {
  const xs = o.corners.map((c) => c[0]);
  const ys = o.corners.map((c) => c[1]);
  const mx = clamp(dx, -Math.min(...xs), 1 - Math.max(...xs));
  const my = clamp(dy, -Math.min(...ys), 1 - Math.max(...ys));
  return { ...o, corners: o.corners.map(([x, y]) => [x + mx, y + my]) as Outline["corners"] };
}

/** Adds a bend point to `edge` at pixel `p`, which should be on (or near) the edge's curve. */
export function addBend(o: Outline, edge: number, p: Pt, width: number, height: number): Outline {
  const { a, dx, dy, len, nx, ny } = edgeFrame(o, edge, width, height);
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len), 0.01, 0.99);
  const off = clamp(((p[0] - a[0]) * nx + (p[1] - a[1]) * ny) / len, -0.5, 0.5);
  const stops = stopsOf(o, edge);
  const at = stops.findIndex((s) => s > t);
  const i = at < 0 ? stops.length : at;
  return withEdge(o, edge, [...o.bends[edge].slice(0, i), off, ...o.bends[edge].slice(i)], [...stops.slice(0, i), t, ...stops.slice(i)]);
}

export function removeBend(o: Outline, edge: number, index: number): Outline {
  const stops = stopsOf(o, edge).filter((_, i) => i !== index);
  return withEdge(o, edge, o.bends[edge].filter((_, i) => i !== index), stops);
}

function withEdge(o: Outline, edge: number, bends: number[], stops: number[]): Outline {
  return {
    ...o,
    bends: o.bends.map((b, e) => (e === edge ? bends : b)),
    stops: o.bends.map((_, e) => (e === edge ? stops : stopsOf(o, e))),
  };
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
