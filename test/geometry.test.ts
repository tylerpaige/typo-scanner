import { describe, expect, it } from "vitest";
import { FULL, dragRect, isFull, rotateRect, toPixels } from "../src/geometry";

const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
const close = (a: object, b: object) =>
  Object.entries(b).forEach(([k, v]) => expect((a as Record<string, number>)[k]).toBeCloseTo(v as number));

describe("rotateRect", () => {
  it("turns a quarter clockwise with the image", () => {
    // The top-left corner (0.1, 0.2) ends up at the top-right, 0.2 in from the right edge.
    close(rotateRect(r, 1), { x: 0.4, y: 0.1, w: 0.4, h: 0.3 });
  });
  it("undoes itself", () => {
    close(rotateRect(rotateRect(r, 1), -1), r);
    close(rotateRect(r, 4), r);
    close(rotateRect(rotateRect(r, 2), 2), r);
  });
});

describe("toPixels", () => {
  it("rounds to whole pixels inside the image", () => {
    expect(toPixels(r, 1000, 500)).toEqual({ x: 100, y: 100, w: 300, h: 200 });
    expect(toPixels(FULL, 1000, 500)).toEqual({ x: 0, y: 0, w: 1000, h: 500 });
    expect(toPixels({ x: 0.9999, y: 0, w: 0, h: 0 }, 10, 10)).toEqual({ x: 9, y: 0, w: 1, h: 1 });
  });
});

describe("dragRect", () => {
  it("moves without leaving the image", () => {
    close(dragRect(r, { kind: "move" }, 0.5, 0.5, 0.6, 0.6), { x: 0.2, y: 0.3, w: 0.3, h: 0.4 });
    close(dragRect(r, { kind: "move" }, 0, 0, 1, 1), { x: 0.7, y: 0.6 });
  });
  it("resizes only the dragged sides, and can't flip", () => {
    close(dragRect(r, { kind: "resize", edges: "se" }, 0, 0, 0.1, 0.1), { x: 0.1, y: 0.2, w: 0.4, h: 0.5 });
    close(dragRect(r, { kind: "resize", edges: "w" }, 0, 0, 0.9, 0.9), { x: 0.38, y: 0.2, w: 0.02, h: 0.4 });
  });
  it("draws in any direction", () => {
    close(dragRect(FULL, { kind: "draw" }, 0.8, 0.7, 0.2, 0.3), { x: 0.2, y: 0.3, w: 0.6, h: 0.4 });
  });
  it("knows the full frame", () => {
    expect(isFull(FULL)).toBe(true);
    expect(isFull(r)).toBe(false);
  });
});
