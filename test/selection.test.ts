import { describe as group, expect, it } from "vitest";
import { byParity, describe, parseRange, span } from "../src/selection";

group("parseRange", () => {
  it("reads single pages, ranges and open ends", () => {
    expect(parseRange("3", 10)).toEqual([2]);
    expect(parseRange("3-5, 8", 10)).toEqual([2, 3, 4, 7]);
    expect(parseRange("8-", 10)).toEqual([7, 8, 9]);
    expect(parseRange("-2", 10)).toEqual([0, 1]);
    expect(parseRange("2–4 9", 10)).toEqual([1, 2, 3, 8]);
    expect(parseRange("4-6,5-7", 10)).toEqual([3, 4, 5, 6]);
  });
  it("stops at the last page", () => {
    expect(parseRange("8-20", 10)).toEqual([7, 8, 9]);
    expect(parseRange("12", 10)).toEqual([]);
  });
  it("rejects nonsense", () => {
    for (const bad of ["", "abc", "5-3", "0", "1-2-3", "3x"]) expect(parseRange(bad, 10)).toBeNull();
  });
});

group("selection helpers", () => {
  it("describes runs", () => expect(describe([0, 1, 2, 4, 6, 7])).toBe("1–3, 5, 7–8"));
  it("spans a selection", () => {
    expect(span([7, 2, 4])).toEqual([2, 3, 4, 5, 6, 7]);
    expect(span([3])).toBeNull();
  });
  it("picks odd and even page numbers", () => {
    expect(byParity([2, 3, 4, 5, 6], "odd")).toEqual([2, 4, 6]); // pages 3, 5, 7
    expect(byParity([2, 3, 4, 5, 6], "even")).toEqual([3, 5]);
  });
});
