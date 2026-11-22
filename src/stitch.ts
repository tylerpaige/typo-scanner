/**
 * Lining up overlapping flatbed scans of one page, and joining them.
 *
 * Scans from one scanner share a scale, so each is placed by a rotation and a shift.
 * A coarse search (phase correlation over a range of angles, both ways up) finds
 * roughly where a scan overlaps another; then a hill-climb on normalised
 * cross-correlation sharpens that at each finer level of an image pyramid.
 */

export type Pt = [number, number];

export interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

/** Maps a tile's pixel coordinates to the page's: rotate by `theta` about the origin, then shift. */
export interface Transform {
  theta: number;
  tx: number;
  ty: number;
}

export const IDENTITY: Transform = { theta: 0, tx: 0, ty: 0 };

// ---- transforms ----

export function apply(t: Transform, [x, y]: Pt): Pt {
  const c = Math.cos(t.theta);
  const s = Math.sin(t.theta);
  return [c * x - s * y + t.tx, s * x + c * y + t.ty];
}

/** `a` after `b`. */
export function compose(a: Transform, b: Transform): Transform {
  const [tx, ty] = apply(a, [b.tx, b.ty]);
  return { theta: a.theta + b.theta, tx, ty };
}

export function inverse(t: Transform): Transform {
  const [tx, ty] = apply({ theta: -t.theta, tx: 0, ty: 0 }, [t.tx, t.ty]);
  return { theta: -t.theta, tx: -tx, ty: -ty };
}

/** `t`, then a turn of `delta` about point `c` (in the output's coordinates). */
export function rotateAbout(t: Transform, delta: number, [cx, cy]: Pt): Transform {
  const [rx, ry] = apply({ theta: delta, tx: 0, ty: 0 }, [cx, cy]);
  return compose({ theta: delta, tx: cx - rx, ty: cy - ry }, t);
}

const scaled = (t: Transform, s: number): Transform => ({ theta: t.theta, tx: t.tx * s, ty: t.ty * s });

/** The integer box covering every tile once placed. */
export function bounds(sizes: { width: number; height: number }[], ts: Transform[]) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  sizes.forEach(({ width: w, height: h }, i) => {
    for (const p of [[0, 0], [w, 0], [w, h], [0, h]] as Pt[]) {
      const [x, y] = apply(ts[i], p);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  });
  const x = Math.floor(x0 + 1e-6);
  const y = Math.floor(y0 + 1e-6);
  return { x, y, width: Math.ceil(x1 - 1e-6) - x, height: Math.ceil(y1 - 1e-6) - y };
}

// ---- images ----

export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Gray {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  return { data, width, height };
}

/** Half the size, each pixel the mean of four. Coordinates halve exactly. */
export function half(g: Gray): Gray {
  const width = g.width >> 1;
  const height = g.height >> 1;
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const r0 = 2 * y * g.width;
    const r1 = r0 + g.width;
    for (let x = 0; x < width; x++) {
      data[y * width + x] = (g.data[r0 + 2 * x] + g.data[r0 + 2 * x + 1] + g.data[r1 + 2 * x] + g.data[r1 + 2 * x + 1]) / 4;
    }
  }
  return { data, width, height };
}

/** The image at full size, then halved repeatedly while the short side stays at least `minSide`. */
export function pyramid(g: Gray, minSide = 24): Gray[] {
  const levels = [g];
  for (let top = g; Math.min(top.width, top.height) / 2 >= minSide; ) {
    top = half(top);
    levels.push(top);
  }
  return levels;
}

/** The value at a point, pixel centres being at half-pixels. Clamps at the edges. */
function bilinear(g: Gray, x: number, y: number): number {
  const fx = Math.min(g.width - 1, Math.max(0, x - 0.5));
  const fy = Math.min(g.height - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(g.width - 1, x0 + 1);
  const y1 = Math.min(g.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const d = g.data;
  const top = d[y0 * g.width + x0] + (d[y0 * g.width + x1] - d[y0 * g.width + x0]) * tx;
  const bot = d[y1 * g.width + x0] + (d[y1 * g.width + x1] - d[y1 * g.width + x0]) * tx;
  return top + (bot - top) * ty;
}

/** How far inside a w×h image a point is; negative outside. */
const depth = (x: number, y: number, w: number, h: number) => Math.min(x, w - x, y, h - y);

// ---- coarse search: phase correlation ----

const twiddles = new Map<number, { cos: Float64Array; sin: Float64Array }>();

/** In-place radix-2 FFT of a power-of-two length. */
function fft(re: Float64Array, im: Float64Array, invert: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  let tw = twiddles.get(n);
  if (!tw) {
    tw = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
    for (let k = 0; k < n / 2; k++) {
      tw.cos[k] = Math.cos((2 * Math.PI * k) / n);
      tw.sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    twiddles.set(n, tw);
  }
  const sign = invert ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = tw.cos[k * step];
        const wi = sign * tw.sin[k * step];
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

function fft2d(re: Float64Array, im: Float64Array, w: number, h: number, invert: boolean) {
  for (let y = 0; y < h; y++) fft(re.subarray(y * w, (y + 1) * w), im.subarray(y * w, (y + 1) * w), invert);
  const cr = new Float64Array(h);
  const ci = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      cr[y] = re[y * w + x];
      ci[y] = im[y * w + x];
    }
    fft(cr, ci, invert);
    for (let y = 0; y < h; y++) {
      re[y * w + x] = cr[y];
      im[y * w + x] = ci[y];
    }
  }
}

const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
const taper = (d: number, width: number) => (d <= 0 ? 0 : d >= width ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * d) / width));
const TAPER = 6;

/** A rotated copy of `g` in its bounding box, with a weight that fades to zero at the image's edges. */
function rotated(g: Gray, theta: number) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const xs = [0, g.width * c, g.width * c - g.height * s, -g.height * s];
  const ys = [0, g.width * s, g.width * s + g.height * c, g.height * c];
  const mx = Math.floor(Math.min(...xs));
  const my = Math.floor(Math.min(...ys));
  const width = Math.ceil(Math.max(...xs)) - mx;
  const height = Math.ceil(Math.max(...ys)) - my;
  const data = new Float32Array(width * height);
  const weight = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const rx = i + 0.5 + mx;
      const ry = j + 0.5 + my;
      const px = c * rx + s * ry;
      const py = -s * rx + c * ry;
      const d = depth(px, py, g.width, g.height);
      if (d <= 0) continue;
      data[j * width + i] = bilinear(g, px, py);
      weight[j * width + i] = taper(d, TAPER);
    }
  }
  return { g: { data, width, height }, weight, mx, my };
}

function edgeWeight(g: Gray) {
  const weight = new Float32Array(g.width * g.height);
  for (let y = 0; y < g.height; y++)
    for (let x = 0; x < g.width; x++) weight[y * g.width + x] = taper(depth(x + 0.5, y + 0.5, g.width, g.height), TAPER);
  return weight;
}

/** The image's spectrum, zero-padded to nw×nh, after removing its mean and fading its edges. */
function spectrum(g: Gray, weight: Float32Array, nw: number, nh: number) {
  let sum = 0;
  let total = 0;
  for (let i = 0; i < g.data.length; i++) {
    sum += g.data[i] * weight[i];
    total += weight[i];
  }
  const mean = total > 0 ? sum / total : 0;
  const re = new Float64Array(nw * nh);
  const im = new Float64Array(nw * nh);
  for (let y = 0; y < g.height; y++)
    for (let x = 0; x < g.width; x++) re[y * nw + x] = (g.data[y * g.width + x] - mean) * weight[y * g.width + x];
  fft2d(re, im, nw, nh, false);
  return { re, im };
}

/**
 * Where `b` best fits over `a`, by phase correlation: b's pixel at p matches a's at p + (dx, dy).
 * With `near`, prefers fits close to that shift (within about `spread` pixels).
 */
function correlate(
  fa: { re: Float64Array; im: Float64Array },
  b: Gray,
  weight: Float32Array,
  nw: number,
  nh: number,
  near?: Pt,
  spread = 1,
) {
  const fb = spectrum(b, weight, nw, nh);
  const n = nw * nh;
  for (let k = 0; k < n; k++) {
    const r = fa.re[k] * fb.re[k] + fa.im[k] * fb.im[k];
    const i = fa.im[k] * fb.re[k] - fa.re[k] * fb.im[k];
    const mag = Math.hypot(r, i) + 1e-9;
    fb.re[k] = r / mag;
    fb.im[k] = i / mag;
  }
  fft2d(fb.re, fb.im, nw, nh, true);
  const shift = (k: number): Pt => {
    const ix = k % nw;
    const iy = Math.floor(k / nw);
    return [ix > nw / 2 ? ix - nw : ix, iy > nh / 2 ? iy - nh : iy];
  };
  const prior = (k: number) => {
    if (!near) return 1;
    const [dx, dy] = shift(k);
    return Math.exp(-((dx - near[0]) ** 2 + (dy - near[1]) ** 2) / (2 * spread * spread));
  };
  let best = 0;
  let bestValue = -Infinity;
  for (let k = 0; k < n; k++) {
    const value = fb.re[k] * prior(k);
    if (value > bestValue) [best, bestValue] = [k, value];
  }
  const [dx, dy] = shift(best);
  return { dx, dy, peak: bestValue / n };
}

const COARSE_ANGLES = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((d) => (d * Math.PI) / 180);

/**
 * Roughly where `b` sits over `a`, both at the same (small) scale, trying either way up.
 * Given a rough placement `near` (say, one made by hand), searches only around it.
 */
export function coarseAlign(a: Gray, b: Gray, near?: Transform): { t: Transform; peak: number } {
  const diag = Math.ceil(Math.hypot(b.width, b.height)) + 2;
  const nw = nextPow2(a.width + diag);
  const nh = nextPow2(a.height + diag);
  const fa = spectrum(a, edgeWeight(a), nw, nh);
  const thetas = near
    ? [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((d) => near.theta + (d * Math.PI) / 180)
    : [0, Math.PI].flatMap((base) => COARSE_ANGLES.map((delta) => base + delta));
  const centre: Pt = [b.width / 2, b.height / 2];
  const spread = 0.15 * Math.max(a.width, a.height);
  let best = { t: IDENTITY, peak: -Infinity };
  for (const theta of thetas) {
    const r = rotated(b, theta);
    // Where `near`, turned to this angle about the scan's centre, would put b's buffer.
    const expected = near && rotateAbout(near, theta - near.theta, apply(near, centre));
    const shift: Pt | undefined = expected && [expected.tx + r.mx, expected.ty + r.my];
    const { dx, dy, peak } = correlate(fa, r.g, r.weight, nw, nh, shift, spread);
    // b's buffer pixel i is the rotated point i + m; it matches a's pixel i + d.
    if (peak > best.peak) best = { t: { theta, tx: dx - r.mx, ty: dy - r.my }, peak };
  }
  return best;
}

// ---- fine search: normalised cross-correlation ----

const SAMPLES = 40000;

/** How well `b`, placed over `a` by `t`, matches it where they overlap (−1 to 1), and how much of `b` overlaps. */
export function match(a: Gray, b: Gray, t: Transform) {
  const stride = Math.max(1, Math.round(Math.sqrt((b.width * b.height) / SAMPLES)));
  const c = Math.cos(t.theta);
  const s = Math.sin(t.theta);
  let n = 0;
  let total = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let y = stride >> 1; y < b.height; y += stride) {
    for (let x = stride >> 1; x < b.width; x += stride) {
      total++;
      const px = x + 0.5;
      const py = y + 0.5;
      if (depth(px, py, b.width, b.height) < 1.5) continue;
      const qx = c * px - s * py + t.tx;
      const qy = s * px + c * py + t.ty;
      if (depth(qx, qy, a.width, a.height) < 1.5) continue;
      const va = bilinear(a, qx, qy);
      const vb = b.data[y * b.width + x];
      n++;
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
  }
  const overlap = total ? n / total : 0;
  if (n < 100) return { score: -1, overlap };
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return { score: va > 1e-6 && vb > 1e-6 ? cov / Math.sqrt(va * vb) : 0, overlap };
}

/** Nudges `t` (in this level's pixels) uphill on `match` until steps are a fraction of a pixel. */
function climb(a: Gray, b: Gray, t: Transform) {
  let best = match(a, b, t).score;
  let step = 2;
  let turn = 2 / Math.max(b.width, b.height);
  const centre: Pt = [b.width / 2, b.height / 2];
  while (step >= 0.125) {
    let improved = false;
    const moves: Transform[] = [
      rotateAbout(t, turn, apply(t, centre)),
      rotateAbout(t, -turn, apply(t, centre)),
      { ...t, tx: t.tx + step },
      { ...t, tx: t.tx - step },
      { ...t, ty: t.ty + step },
      { ...t, ty: t.ty - step },
    ];
    for (const move of moves) {
      const score = match(a, b, move).score;
      if (score > best + 1e-7) {
        best = score;
        t = move;
        improved = true;
      }
    }
    if (!improved) {
      step /= 2;
      turn /= 2;
    }
  }
  return t;
}

export interface Alignment {
  /** Places b's full-size pixels over a's. */
  t: Transform;
  /** How well they match where they overlap, 0–1 in practice; under about 0.5 is suspect. */
  score: number;
  /** The fraction of b that overlaps a. */
  overlap: number;
  /** The coarse search's confidence, for choosing which earlier scan to align against. */
  peak: number;
}

/** The pyramid level the coarse search runs at: the largest no more than `side` pixels long. */
export function coarseLevel(levels: Gray[], side = 200) {
  const i = levels.findIndex((g) => Math.max(g.width, g.height) <= side);
  return i < 0 ? levels.length - 1 : i;
}

/** Refines `t` (full-size pixels) from pyramid level `from` down to full size. */
export function refine(a: Gray[], b: Gray[], t: Transform, from: number): { t: Transform; score: number; overlap: number } {
  let level = scaled(t, 2 ** -from);
  for (let l = from; l >= 0; l--) {
    level = climb(a[l], b[l], level);
    if (l > 0) level = scaled(level, 2);
  }
  return { t: level, ...match(a[0], b[0], level) };
}

/** Where scan `b` overlaps scan `a`: from scratch, or searching around a rough placement `near`. */
export function alignPair(a: Gray[], b: Gray[], near?: Transform): Alignment {
  const l = Math.min(coarseLevel(a), coarseLevel(b), a.length - 1, b.length - 1);
  const coarse = coarseAlign(a[l], b[l], near && scaled(near, 2 ** -l));
  return { ...refine(a, b, scaled(coarse.t, 2 ** l), l), peak: coarse.peak };
}

// ---- joining ----

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Draws the placed tiles into one image. Where they overlap, each pixel favours the
 * tile it's deepest inside, so the seam runs through the middle of the overlap (away
 * from the scanner's shadowed edges), softened over a few pixels. Gaps are white.
 */
export function blend(tiles: Pixels[], ts: Transform[], feather = 6): Pixels {
  const box = bounds(tiles, ts);
  const { width: W, height: H } = box;
  const out = new Uint8ClampedArray(W * H * 4);
  const inv = ts.map(inverse);
  const n = tiles.length;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const ds = new Float64Array(n);
  const cos = inv.map((t) => Math.cos(t.theta));
  const sin = inv.map((t) => Math.sin(t.theta));
  const rgb = [0, 0, 0];

  for (let y = 0; y < H; y++) {
    const qy = box.y + y + 0.5;
    for (let i = 0; i < n; i++) {
      const qx = box.x + 0.5;
      px[i] = cos[i] * qx - sin[i] * qy + inv[i].tx;
      py[i] = sin[i] * qx + cos[i] * qy + inv[i].ty;
    }
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      let dmax = 0;
      for (let i = 0; i < n; i++) {
        if (x > 0) {
          px[i] += cos[i];
          py[i] += sin[i];
        }
        ds[i] = depth(px[i], py[i], tiles[i].width, tiles[i].height);
        if (ds[i] > dmax) dmax = ds[i];
      }
      if (dmax <= 0) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255;
        continue;
      }
      let total = 0;
      rgb[0] = rgb[1] = rgb[2] = 0;
      for (let i = 0; i < n; i++) {
        if (ds[i] <= 0) continue;
        const w = ds[i] === dmax ? 1 : Math.exp((ds[i] - dmax) / feather);
        if (w < 1e-3) continue;
        sampleRgb(tiles[i], px[i], py[i], w, rgb);
        total += w;
      }
      out[o] = rgb[0] / total;
      out[o + 1] = rgb[1] / total;
      out[o + 2] = rgb[2] / total;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

function sampleRgb(t: Pixels, x: number, y: number, w: number, acc: number[]) {
  const fx = Math.min(t.width - 1, Math.max(0, x - 0.5));
  const fy = Math.min(t.height - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(t.width - 1, x0 + 1);
  const y1 = Math.min(t.height - 1, y0 + 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const i00 = (y0 * t.width + x0) * 4;
  const i10 = (y0 * t.width + x1) * 4;
  const i01 = (y1 * t.width + x0) * 4;
  const i11 = (y1 * t.width + x1) * 4;
  const d = t.data;
  for (let c = 0; c < 3; c++) {
    const top = d[i00 + c] + (d[i10 + c] - d[i00 + c]) * ax;
    const bot = d[i01 + c] + (d[i11 + c] - d[i01 + c]) * ax;
    acc[c] += (top + (bot - top) * ay) * w;
  }
}
