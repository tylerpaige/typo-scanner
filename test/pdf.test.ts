import { describe, expect, it } from "vitest";
import { buildPdf } from "../src/pdf";

const fakeJpeg = (n: number) => new Uint8Array(n).fill(0xff);
const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

describe("buildPdf", () => {
  const pages = [
    { jpeg: fakeJpeg(100), width: 3000, height: 4000 },
    { jpeg: fakeJpeg(50), width: 600, height: 300 },
  ];
  const pdf = buildPdf(pages);
  const text = latin1(pdf);

  it("points every xref entry at its object", () => {
    const xrefAt = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const entries = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(2 + pages.length * 3);
    entries.forEach((offset, i) => expect(text.slice(offset)).toMatch(new RegExp(`^${i + 1} 0 obj\\n`)));
  });

  it("sizes pages at 300dpi and embeds the JPEG bytes untouched", () => {
    expect(text).toContain("/MediaBox [0 0 720 960]");
    expect(text).toContain("/Width 600 /Height 300");
    expect(text).toContain("/Count 2");
    expect(text).toContain("/Length 100 >>\nstream\n" + "\xff".repeat(100) + "\nendstream");
  });
});
