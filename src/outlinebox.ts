import { clamp } from "./geometry";
import { addBend, bendToward, edgePoints, moveOutline, outlineFromRect, removeBend, sampleCurve, type Outline, type Pt } from "./outline";
import { buildMapping, type Mapping } from "./warp";

const SVG = "http://www.w3.org/2000/svg";
const GRID = 8;

/** A point the keyboard can move: a corner, or bend point `index` of edge `edge`. */
export type Anchor = { corner: number } | { edge: number; index: number };

/**
 * The page outline laid over `host`, which should be exactly the size of the image beneath.
 * Drag the corners to fix perspective, the points along each edge to follow a curl
 * (double-click one to straighten it), or inside the outline to move all of it. ⇧-click
 * inside adds a point to the top and bottom edges where the dotted line shows; ⌥-click
 * a point removes it and its partner on the opposite edge. The grid inside shows how the
 * page will be flattened: when lines of text run along it, the result will be straight.
 */
export class OutlineBox {
  readonly el = document.createElement("div");
  private readonly svg = document.createElementNS(SVG, "svg");
  private readonly shade = document.createElementNS(SVG, "path");
  private readonly grid = document.createElementNS(SVG, "path");
  private readonly edge = document.createElementNS(SVG, "path");
  private readonly inside = document.createElementNS(SVG, "path");
  private readonly hint = document.createElementNS(SVG, "path");
  private readonly hintDots = [document.createElement("div"), document.createElement("div")];
  private readonly corners: HTMLElement[] = [];
  private bends: HTMLElement[][] = [[], [], [], []];
  private width = 1;
  private height = 1;
  private mapping: Mapping | null = null;
  /** Where the pointer is over the inside of the outline, if it is. */
  private hovering: { x: number; y: number; shift: boolean } | null = null;
  /** The bend point under the pointer, if any. */
  private hoveredBend: { edge: number; index: number; alt: boolean } | null = null;
  outline: Outline = outlineFromRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  /** The point the keyboard moves, if any. */
  active: Anchor | null = null;
  /** Called when a drag finishes. */
  onChange?: (outline: Outline) => void;

  constructor(host: HTMLElement) {
    this.el.className = "outlinebox";
    this.svg.setAttribute("preserveAspectRatio", "none");
    this.shade.setAttribute("class", "shade");
    this.grid.setAttribute("class", "grid");
    this.edge.setAttribute("class", "edge");
    this.inside.setAttribute("class", "inside");
    this.hint.setAttribute("class", "hint");
    this.svg.append(this.shade, this.grid, this.edge, this.inside, this.hint);
    this.el.append(this.svg);
    for (const dot of this.hintDots) {
      dot.className = "hint-dot";
      dot.hidden = true;
      this.el.append(dot);
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

    this.inside.addEventListener("pointermove", (e) => {
      this.hovering = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
      this.showHints();
    });
    this.inside.addEventListener("pointerleave", () => {
      this.hovering = null;
      this.showHints();
    });
    this.inside.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.altKey) return;
      e.stopPropagation();
      if (e.shiftKey) this.addPair(this.pixel(e));
      else this.drag(e);
    });
    // The hints follow the modifier keys, not just the pointer.
    const keys = (e: KeyboardEvent) => {
      if (e.key !== "Shift" && e.key !== "Alt") return;
      if (this.hovering) this.hovering.shift = e.shiftKey;
      if (this.hoveredBend) this.hoveredBend.alt = e.altKey;
      this.showHints();
    };
    window.addEventListener("keydown", keys);
    window.addEventListener("keyup", keys);
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
    this.inside.setAttribute("d", path);
    this.shade.setAttribute("d", `M0,0H${w}V${h}H0Z${path}`);

    let grid = "";
    this.mapping = null;
    try {
      const m = buildMapping(outline, w, h);
      this.mapping = m;
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
    this.makeBends();
    edges.forEach((pts, e) => {
      place(this.corners[e], pts[0]);
      this.bends[e].forEach((el, i) => place(el, pts[i + 1]));
    });
    this.showHints();
    this.setActive(this.active);
  }

  /** Every point, clockwise from the top-left corner: each corner, then the bends along the edge after it. */
  anchors(): Anchor[] {
    return this.outline.bends.flatMap((row, e): Anchor[] => [{ corner: e }, ...row.map((_, index) => ({ edge: e, index }))]);
  }

  setActive(anchor: Anchor | null) {
    // A bend point that's since been removed can't stay active.
    if (anchor && "edge" in anchor && anchor.index >= this.outline.bends[anchor.edge].length) anchor = null;
    this.active = anchor;
    const el = anchor && ("corner" in anchor ? this.corners[anchor.corner] : this.bends[anchor.edge][anchor.index]);
    [...this.corners, ...this.bends.flat()].forEach((h) => h.classList.toggle("kb", h === el));
  }

  /** Moves the active point by (dx, dy), as fractions of the image; a bend point only moves across its edge. */
  nudge(dx: number, dy: number) {
    const a = this.active;
    if (!a) return;
    if ("corner" in a) {
      const corners = [...this.outline.corners] as Outline["corners"];
      const [x, y] = corners[a.corner];
      corners[a.corner] = [clamp(x + dx, 0, 1), clamp(y + dy, 0, 1)];
      this.set({ ...this.outline, corners });
    } else {
      const [x, y] = edgePoints(this.outline, this.width, this.height)[a.edge][a.index + 1];
      const bends = this.outline.bends.map((b) => [...b]);
      bends[a.edge][a.index] = bendToward(this.outline, a.edge, a.index, [x + dx * this.width, y + dy * this.height], this.width, this.height);
      this.set({ ...this.outline, bends });
    }
  }

  /** Makes a handle for each bend point, when the number of them has changed. */
  private makeBends() {
    if (this.bends.every((row, e) => row.length === this.outline.bends[e].length)) return;
    this.bends.flat().forEach((el) => el.remove());
    this.hoveredBend = null;
    this.bends = this.outline.bends.map((row, e) =>
      row.map((_, i) => {
        const handle = this.handle("bend", (p) => {
          const bends = this.outline.bends.map((b) => [...b]);
          bends[e][i] = bendToward(this.outline, e, i, [p[0] * this.width, p[1] * this.height], this.width, this.height);
          return { ...this.outline, bends };
        });
        handle.title = "Drag to follow the page's curve · double-click to straighten · ⌥-click to remove";
        handle.addEventListener("dblclick", () => {
          const bends = this.outline.bends.map((b) => [...b]);
          bends[e][i] = 0;
          this.set({ ...this.outline, bends });
          this.onChange?.(this.outline);
        });
        handle.addEventListener("pointerdown", (down) => {
          if (down.button !== 0 || !down.altKey) return;
          down.stopPropagation();
          this.removePair(e, i);
        });
        handle.addEventListener("pointerenter", (ev) => {
          this.hoveredBend = { edge: e, index: i, alt: ev.altKey };
          this.showHints();
        });
        handle.addEventListener("pointerleave", () => {
          this.hoveredBend = null;
          this.showHints();
        });
        // Before the corners, so they stay on top where they meet.
        this.el.insertBefore(handle, this.corners[0]);
        return handle;
      }),
    );
  }

  /** Pixel position over the image of a pointer event. */
  private pixel(e: { clientX: number; clientY: number }): Pt {
    const r = this.el.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.width, ((e.clientY - r.top) / r.height) * this.height];
  }

  /** Where pixel `p` is on the flattened page (0–1 each way), or null if it's off it. */
  private locate(p: Pt): Pt | null {
    const m = this.mapping;
    if (!m) return null;
    const miss = (u: number, v: number) => {
      const [x, y] = m.map(u, v);
      return (x - p[0]) ** 2 + (y - p[1]) ** 2;
    };
    const N = 24;
    let best: Pt = [0.5, 0.5];
    let bestMiss = Infinity;
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const d = miss(i / N, j / N);
        if (d < bestMiss) [best, bestMiss] = [[i / N, j / N], d];
      }
    }
    // Then home in.
    for (let step = 1 / N; step > 1e-4; ) {
      let moved = false;
      for (const [du, dv] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const q: Pt = [clamp(best[0] + du, 0, 1), clamp(best[1] + dv, 0, 1)];
        const d = miss(...q);
        if (d < bestMiss) [best, bestMiss, moved] = [q, d, true];
      }
      if (!moved) step /= 2;
    }
    return bestMiss < 9 ? best : null; // within 3 pixels
  }

  /** Where a ⇧-click would add points, as a position across the page. */
  private addAt(): number | null {
    if (!this.hovering?.shift) return null;
    return this.locate(this.pixel({ clientX: this.hovering.x, clientY: this.hovering.y }))?.[0] ?? null;
  }

  private addPair(p: Pt) {
    const u = this.locate(p)?.[0];
    if (u === undefined || !this.mapping) return;
    const m = this.mapping;
    this.set(addBend(addBend(this.outline, 0, m.map(u, 0), this.width, this.height), 2, m.map(u, 1), this.width, this.height));
    this.onChange?.(this.outline);
  }

  /** The bend point on the edge opposite that's level with bend `index` of `edge`, if there's one near. */
  private partner(edge: number, index: number): number | null {
    const points = edgePoints(this.outline, this.width, this.height);
    const across = edge % 2 === 0 ? 0 : 1; // top and bottom pair up by u, the sides by v
    const at = this.locate(points[edge][index + 1])?.[across];
    if (at === undefined) return null;
    const opposite = (edge + 2) % 4;
    let best: number | null = null;
    let bestGap = 0.1;
    this.outline.bends[opposite].forEach((_, j) => {
      const there = this.locate(points[opposite][j + 1])?.[across];
      if (there !== undefined && Math.abs(there - at) < bestGap) [best, bestGap] = [j, Math.abs(there - at)];
    });
    return best;
  }

  private removePair(edge: number, index: number) {
    const other = this.partner(edge, index);
    let next = removeBend(this.outline, edge, index);
    if (other !== null) next = removeBend(next, (edge + 2) % 4, other);
    this.set(next);
    this.onChange?.(this.outline);
  }

  private showHints() {
    const u = this.addAt();
    const m = this.mapping;
    this.el.classList.toggle("adding", u !== null);
    if (u === null || !m) {
      this.hint.setAttribute("d", "");
      this.hintDots.forEach((d) => (d.hidden = true));
    } else {
      const pts = Array.from({ length: 25 }, (_, s) => m.map(u, s / 24));
      this.hint.setAttribute("d", `M${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join("L")}`);
      [pts[0], pts[24]].forEach(([x, y], k) => {
        const dot = this.hintDots[k];
        dot.hidden = false;
        dot.style.left = `${(x / this.width) * 100}%`;
        dot.style.top = `${(y / this.height) * 100}%`;
      });
    }
    this.bends.flat().forEach((el) => el.classList.remove("doomed"));
    const b = this.hoveredBend;
    if (b?.alt) {
      this.bends[b.edge][b.index]?.classList.add("doomed");
      const other = this.partner(b.edge, b.index);
      if (other !== null) this.bends[(b.edge + 2) % 4][other]?.classList.add("doomed");
    }
  }

  /** Slides the whole outline with the pointer. */
  private drag(down: PointerEvent) {
    const bounds = this.el.getBoundingClientRect();
    const start = this.outline;
    let moved = false;
    const move = (e: PointerEvent) => {
      moved = true;
      this.set(moveOutline(start, (e.clientX - down.clientX) / bounds.width, (e.clientY - down.clientY) / bounds.height));
    };
    const up = () => {
      this.inside.removeEventListener("pointermove", move);
      this.inside.removeEventListener("pointerup", up);
      this.inside.removeEventListener("pointercancel", up);
      if (moved) this.onChange?.(this.outline);
    };
    this.inside.setPointerCapture(down.pointerId);
    this.inside.addEventListener("pointermove", move);
    this.inside.addEventListener("pointerup", up);
    this.inside.addEventListener("pointercancel", up);
  }

  private handle(kind: string, update: (p: Pt) => Outline) {
    const el = document.createElement("div");
    el.className = `handle ${kind}`;
    el.addEventListener("pointerdown", (down) => {
      if (down.button !== 0 || down.altKey) return; // ⌥-click removes a point instead
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
