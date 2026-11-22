import { FULL, clamp, dragRect, isFull, type DragMode, type Rect } from "./geometry";

/** The handles, clockwise from the top-left. */
export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/**
 * A crop rectangle laid over `host`, which should be exactly the size of the image beneath.
 * Drag the corners or sides to resize, the middle to move, or outside it to draw a new one.
 */
export class CropBox {
  readonly el = document.createElement("div");
  private readonly box = document.createElement("div");
  rect: Rect = FULL;
  /** The handle the keyboard moves, by its edges ("nw", "e", …), if any. */
  active: string | null = null;
  /** Called when a drag finishes. */
  onChange?: (rect: Rect) => void;

  constructor(host: HTMLElement) {
    this.el.className = "cropbox";
    this.box.className = "crop-rect";
    for (const edges of HANDLES) {
      const handle = document.createElement("div");
      handle.className = `handle ${edges}`;
      handle.dataset.edges = edges;
      this.box.append(handle);
    }
    this.el.append(this.box);
    host.append(this.el);
    this.el.addEventListener("pointerdown", (e) => this.drag(e));
    this.set(FULL);
  }

  set(rect: Rect) {
    this.rect = rect;
    Object.assign(this.box.style, {
      left: `${rect.x * 100}%`,
      top: `${rect.y * 100}%`,
      width: `${rect.w * 100}%`,
      height: `${rect.h * 100}%`,
    });
    this.el.classList.toggle("full", isFull(rect));
  }

  setActive(edges: string | null) {
    this.active = edges;
    this.box.querySelectorAll<HTMLElement>(".handle").forEach((h) => h.classList.toggle("kb", h.dataset.edges === edges));
  }

  /** Moves the active handle by (dx, dy), as fractions of the image. */
  nudge(dx: number, dy: number) {
    if (this.active) this.set(dragRect(this.rect, { kind: "resize", edges: this.active }, 0, 0, dx, dy));
  }

  private drag(down: PointerEvent) {
    if (down.button !== 0) return;
    const target = down.target as HTMLElement;
    // A full-frame crop has no room to move, so dragging inside it draws a new one.
    const mode: DragMode = target.dataset.edges
      ? { kind: "resize", edges: target.dataset.edges }
      : target === this.box && !isFull(this.rect)
        ? { kind: "move" }
        : { kind: "draw" };
    const start = this.rect;
    const bounds = this.el.getBoundingClientRect();
    const point = (e: PointerEvent) => [
      clamp((e.clientX - bounds.left) / bounds.width, 0, 1),
      clamp((e.clientY - bounds.top) / bounds.height, 0, 1),
    ];
    const [sx, sy] = point(down);
    let moved = false;

    const move = (e: PointerEvent) => {
      // A click without a drag shouldn't leave behind a tiny new crop.
      if (!moved && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 4) return;
      moved = true;
      const [px, py] = point(e);
      this.set(dragRect(start, mode, sx, sy, px, py));
    };
    const up = () => {
      this.el.removeEventListener("pointermove", move);
      this.el.removeEventListener("pointerup", up);
      this.el.removeEventListener("pointercancel", up);
      if (moved) this.onChange?.(this.rect);
    };
    this.el.setPointerCapture(down.pointerId);
    this.el.addEventListener("pointermove", move);
    this.el.addEventListener("pointerup", up);
    this.el.addEventListener("pointercancel", up);
  }
}

/** Sizes `frame` to the largest box with the image's proportions that fits inside `viewport`. */
export function fitFrame(frame: HTMLElement, viewport: HTMLElement, width: number, height: number) {
  if (!width || !height) return;
  const scale = Math.min(viewport.clientWidth / width, viewport.clientHeight / height);
  frame.style.width = `${Math.floor(width * scale)}px`;
  frame.style.height = `${Math.floor(height * scale)}px`;
}
