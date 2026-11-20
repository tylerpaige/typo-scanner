import { describe, expect, it } from "vitest";
import { sharpness } from "../src/loupe";

function image(size: number, pixel: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) data.fill(pixel(x, y), (y * size + x) * 4, (y * size + x) * 4 + 3);
  return data;
}

describe("sharpness", () => {
  it("scores hard edges above soft ones, and flat as zero", () => {
    const flat = sharpness(image(32, () => 128), 32, 32);
    const soft = sharpness(image(32, (x) => 128 + 100 * Math.sin(x / 4)), 32, 32);
    const hard = sharpness(image(32, (x) => (x % 4 < 2 ? 0 : 255)), 32, 32);
    expect(flat).toBe(0);
    expect(soft).toBeGreaterThan(0);
    expect(hard).toBeGreaterThan(soft * 5);
  });
});
