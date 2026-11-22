import type { Crop, Pt } from "./outline";
import { CENTRE, clampSplit, type Split } from "./split";
import { buildMapping } from "./warp";

const SVG = "http://www.w3.org/2000/svg";

/**
 * A spread's gutter, drawn through the page's crop or outline over `host` (which should be
 * exactly the size of the image beneath). Drag its ends to match a slanted gutter, or its
 * middle to move it.
 */
export class SplitBox {
  readonly el = document.createElement("div");
  private readonly svg = document.createElementNS(SVG, "svg");
  private readonly line = document.createElementNS(SVG, "path");
  private readonly grip = document.createElementNS(SVG, "path");
  private readonly ends: Record<"top" | "middle" | "bottom", HTMLElement>;
  private width = 1;
  private height = 1;
  private crop: Crop = { kind: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } };
  private at: (u: number, v: number) => Pt = (u, v) => [u, v];
  split: Split = CENTRE;
  /** Called when a drag finishes. */
  onChange?: (split: Split) => void;

  constructor(host: HTMLElement) {
    this.el.className = "splitbox";
    this.svg.setAttribute("preserveAspectRatio", "none");
    this.line.setAttribute("class", "gutter");
    this.grip.setAttribute("class", "grip");
    this.svg.append(this.line, this.grip);
    this.el.append(this.svg);
    const move = (p: Pt, start: Split, from: Pt) => {
      const shift = this.nearestU(0.5, p) - this.nearestU(0.5, from);
      return { top: start.top + shift, bottom: start.bottom + shift };
    };
    this.ends = {
      top: this.handle("top", (p, start) => ({ ...start, top: this.nearestU(0, p) })),
      middle: this.handle("middle", move),
      bottom: this.handle("bottom", (p, start) => ({ ...start, bottom: this.nearestU(1, p) })),
    };
    // The line itself moves the split too.
    this.grip.addEventListener("pointerdown", (e) => this.drag(this.grip, e, move));
    host.append(this.el);
  }

  setSize(width: number, height: number) {
    if (!width || !height || (width === this.width && height === this.height)) return;
    this.width = width;
    this.height = height;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.setCrop(this.crop);
  }

  /** The crop or outline the gutter runs through. */
  setCrop(crop: Crop) {
    this.crop = crop;
    const { width: w, height: h } = this;
    if (crop.kind === "rect") {
      const r = crop.rect;
      this.at = (u, v) => [(r.x + u * r.w) * w, (r.y + v * r.h) * h];
    } else {
      try {
        this.at = buildMapping(crop.outline, w, h).map;
      } catch {
        // A twisted outline: leave the line where it was.
      }
    }
    this.set(this.split);
  }

  set(split: Split) {
    this.split = clampSplit(split);
    const { top, bottom } = this.split;
    const pts = Array.from({ length: 25 }, (_, i) => this.at(top + ((bottom - top) * i) / 24, i / 24));
    const d = `M${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join("L")}`;
    this.line.setAttribute("d", d);
    this.grip.setAttribute("d", d);
    const place = (el: HTMLElement, [x, y]: Pt) => {
      el.style.left = `${(x / this.width) * 100}%`;
      el.style.top = `${(y / this.height) * 100}%`;
    };
    place(this.ends.top, pts[0]);
    place(this.ends.middle, pts[12]);
    place(this.ends.bottom, pts[24]);
  }

  /** The point across the page, at height `v`, that's nearest pixel `p`. */
  private nearestU(v: number, p: Pt): number {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i <= 200; i++) {
      const [x, y] = this.at(i / 200, v);
      const d = (x - p[0]) ** 2 + (y - p[1]) ** 2;
      if (d < bestDistance) [best, bestDistance] = [i / 200, d];
    }
    return best;
  }

  private handle(kind: string, update: (p: Pt, start: Split, from: Pt) => Split) {
    const el = document.createElement("div");
    el.className = `handle split-${kind}`;
    el.title = kind === "middle" ? "Drag to move the split" : "Drag to slant the split";
    el.addEventListener("pointerdown", (down) => this.drag(el, down, update));
    this.el.append(el);
    return el;
  }

  private drag(el: Element, down: PointerEvent, update: (p: Pt, start: Split, from: Pt) => Split) {
    if (down.button !== 0) return;
    down.stopPropagation();
    const bounds = this.el.getBoundingClientRect();
    const toPixels = (e: PointerEvent): Pt => [
      ((e.clientX - bounds.left) / bounds.width) * this.width,
      ((e.clientY - bounds.top) / bounds.height) * this.height,
    ];
    const start = this.split;
    const from = toPixels(down);
    const move = (e: Event) => this.set(update(toPixels(e as PointerEvent), start, from));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      this.onChange?.(this.split);
    };
    el.setPointerCapture(down.pointerId);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }
}
