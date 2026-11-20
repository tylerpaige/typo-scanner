/** Draws the full-resolution frame with its top-left at the origin, one unit per source pixel. */
export type Painter = (ctx: CanvasRenderingContext2D) => void;

const SIZE = 260; // lens diameter in CSS pixels
const PROBE = 96; // side of the square, in source pixels, that the focus score measures

/**
 * A magnifier that shows the camera's real pixels under the pointer, so you can tell
 * whether text is in focus. It stays where the pointer left it, so it keeps updating
 * while you adjust the camera by hand. Scroll over the preview to change the zoom.
 */
export class Loupe {
  on = false;
  private zoom = 3;
  private u = 0.5;
  private v = 0.5;
  private frameCount = 0;
  private readonly lens = document.createElement("div");
  private readonly canvas = document.createElement("canvas");
  private readonly label = document.createElement("span");
  private readonly probe = document.createElement("canvas");

  constructor(
    private readonly frame: HTMLElement,
    private readonly paint: Painter,
    private readonly size: () => [number, number] | null,
  ) {
    this.lens.className = "loupe";
    this.lens.hidden = true;
    this.lens.append(this.canvas, this.label);
    document.body.append(this.lens);
    this.probe.width = this.probe.height = PROBE;

    frame.addEventListener("pointermove", (e) => {
      const b = frame.getBoundingClientRect();
      this.u = (e.clientX - b.left) / b.width;
      this.v = (e.clientY - b.top) / b.height;
    });
    frame.addEventListener(
      "wheel",
      (e) => {
        if (!this.on) return;
        e.preventDefault();
        this.zoom = Math.min(8, Math.max(1, this.zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
      },
      { passive: false },
    );
  }

  toggle(on = !this.on) {
    this.on = on;
    this.lens.hidden = !on;
  }

  /** Call once per animation frame. */
  draw() {
    const size = this.size();
    if (!this.on || !size) return;
    const [width, height] = size;
    const b = this.frame.getBoundingClientRect();
    this.lens.style.left = `${b.left + this.u * b.width}px`;
    this.lens.style.top = `${b.top + this.v * b.height}px`;

    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(SIZE * dpr);
    if (this.canvas.width !== px) this.canvas.width = this.canvas.height = px;
    const cx = this.u * width;
    const cy = this.v * height;
    const k = this.zoom * dpr;
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, px, px);
    // Show real pixels as hard-edged squares; smoothing would blur away the detail we're judging.
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(k, 0, 0, k, px / 2 - cx * k, px / 2 - cy * k);
    this.paint(ctx);

    if (this.frameCount++ % 6 === 0) {
      const pctx = this.probe.getContext("2d", { willReadFrequently: true })!;
      pctx.setTransform(1, 0, 0, 1, PROBE / 2 - cx, PROBE / 2 - cy);
      this.paint(pctx);
      const score = sharpness(pctx.getImageData(0, 0, PROBE, PROBE).data, PROBE, PROBE);
      this.label.textContent = `${this.zoom.toFixed(1)}× · focus ${Math.round(score)}`;
    }
  }
}

/**
 * How much fine detail an RGBA image has: the standard deviation of its Laplacian.
 * It has no absolute meaning; it goes up as focus improves, so watch for the peak.
 */
export function sharpness(data: Uint8ClampedArray, width: number, height: number): number {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean));
}
