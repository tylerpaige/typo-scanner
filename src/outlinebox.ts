import { clamp } from "./geometry";
import { BENDS, bendToward, edgePoints, outlineFromRect, sampleCurve, type Outline, type Pt } from "./outline";
import { buildMapping } from "./warp";

const SVG = "http://www.w3.org/2000/svg";
const GRID = 8;

/**
 * The page outline laid over `host`, which should be exactly the size of the image beneath.
 * Drag the corners to fix perspective and the points along each edge to follow a curl
 * (double-click one to straighten it). The grid inside shows how the page will be flattened:
 * when lines of text run along it, the result will be straight.
 */
export class OutlineBox {
  readonly el = document.createElement("div");
  private readonly svg = document.createElementNS(SVG, "svg");
  private readonly shade = document.createElementNS(SVG, "path");
  private readonly grid = document.createElementNS(SVG, "path");
  private readonly edge = document.createElementNS(SVG, "path");
  private readonly corners: HTMLElement[] = [];
  private readonly bends: HTMLElement[][] = [];
  private width = 1;
  private height = 1;
  outline: Outline = outlineFromRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  /** Called when a drag finishes. */
  onChange?: (outline: Outline) => void;

  constructor(host: HTMLElement) {
    this.el.className = "outlinebox";
    this.svg.setAttribute("preserveAspectRatio", "none");
    this.shade.setAttribute("class", "shade");
    this.grid.setAttribute("class", "grid");
    this.edge.setAttribute("class", "edge");
    this.svg.append(this.shade, this.grid, this.edge);
    this.el.append(this.svg);

    for (let e = 0; e < 4; e++) {
      const row: HTMLElement[] = [];
      for (let i = 0; i < BENDS; i++) {
        const handle = this.handle("bend", (p) => {
          const bends = this.outline.bends.map((b) => [...b]);
          bends[e][i] = bendToward(this.outline, e, i, [p[0] * this.width, p[1] * this.height], this.width, this.height);
          return { ...this.outline, bends };
        });
        handle.title = "Drag to follow the page's curve · double-click to straighten";
        handle.addEventListener("dblclick", () => {
          const bends = this.outline.bends.map((b) => [...b]);
          bends[e][i] = 0;
          this.set({ ...this.outline, bends });
          this.onChange?.(this.outline);
        });
        row.push(handle);
      }
      this.bends.push(row);
    }
    for (let c = 0; c < 4; c++) {
      this.corners.push(
        this.handle("corner", (p) => {
          const corners = [...this.outline.corners] as Outline["corners"];
          corners[c] = p;
          return { ...this.outline, corners };
        }),
      );
    }
    host.append(this.el);
  }

  /** The pixel size of the image beneath; the outline's shape depends on its proportions. */
  setSize(width: number, height: number) {
    if (!width || !height || (width === this.width && height === this.height)) return;
    this.width = width;
    this.height = height;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.set(this.outline);
  }

  set(outline: Outline) {
    this.outline = outline;
    const { width: w, height: h } = this;
    const edges = edgePoints(outline, w, h);
    const ring = edges.flatMap((pts) => sampleCurve(pts, 24).slice(0, -1));
    const path = `M${ring.map((p) => p.map((n) => n.toFixed(1)).join(",")).join("L")}Z`;
    this.edge.setAttribute("d", path);
    this.shade.setAttribute("d", `M0,0H${w}V${h}H0Z${path}`);

    let grid = "";
    try {
      const m = buildMapping(outline, w, h);
      const line = (pt: (t: number) => Pt) => {
        const pts = Array.from({ length: 25 }, (_, s) => pt(s / 24));
        return `M${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join("L")}`;
      };
      for (let i = 1; i < GRID; i++) {
        grid += line((t) => m.map(i / GRID, t)) + line((t) => m.map(t, i / GRID));
      }
    } catch {
      // A twisted outline has no sensible grid; the edges still show.
    }
    this.grid.setAttribute("d", grid);

    const place = (el: HTMLElement, [x, y]: Pt) => {
      el.style.left = `${(x / w) * 100}%`;
      el.style.top = `${(y / h) * 100}%`;
    };
    edges.forEach((pts, e) => {
      place(this.corners[e], pts[0]);
      this.bends[e].forEach((el, i) => place(el, pts[i + 1]));
    });
  }

  private handle(kind: string, update: (p: Pt) => Outline) {
    const el = document.createElement("div");
    el.className = `handle ${kind}`;
    el.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.stopPropagation();
      const bounds = this.el.getBoundingClientRect();
      const move = (e: PointerEvent) =>
        this.set(
          update([
            clamp((e.clientX - bounds.left) / bounds.width, 0, 1),
            clamp((e.clientY - bounds.top) / bounds.height, 0, 1),
          ]),
        );
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        this.onChange?.(this.outline);
      };
      el.setPointerCapture(down.pointerId);
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
    this.el.append(el);
    return el;
  }
}
