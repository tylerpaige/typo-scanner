import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crc32, packProject, unpackProject, unzip, zip, type ProjectPage } from "../src/project";

const jpeg = (fill: number) => new Blob([new Uint8Array(64).fill(fill)], { type: "image/jpeg" });
const bytesOf = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips files, including UTF-8 names", () => {
    const files = [
      { name: "a.txt", data: new TextEncoder().encode("hello") },
      { name: "folder/é.bin", data: new Uint8Array([0, 1, 2, 255]) },
    ];
    const read = unzip(zip(files));
    expect([...read.keys()]).toEqual(["a.txt", "folder/é.bin"]);
    expect([...read.get("folder/é.bin")!]).toEqual([0, 1, 2, 255]);
  });

  it("writes a ZIP that unzip(1) accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "typoscan-"));
    const file = join(dir, "t.zip");
    writeFileSync(file, zip([{ name: "x/y.txt", data: new TextEncoder().encode("hi") }]));
    execFileSync("unzip", ["-tq", file]);
    expect(execFileSync("unzip", ["-p", file, "x/y.txt"]).toString()).toBe("hi");
    expect(unzip(new Uint8Array(readFileSync(file))).size).toBe(1);
  });
});

describe("project", () => {
  it("keeps every page's edits and stores shared images once", async () => {
    const original = jpeg(1);
    const whole = { kind: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } } as const;
    const spread = { pair: 3, whole, turn: 90 };
    const pages: ProjectPage[] = [
      { original, width: 40, height: 30, turn: 90, crop: { kind: "rect", rect: { x: 0, y: 0, w: 0.5, h: 1 } }, output: jpeg(2), outWidth: 15, outHeight: 40, thumb: jpeg(3), spread },
      { original, width: 40, height: 30, turn: 90, crop: { kind: "rect", rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }, output: jpeg(4), outWidth: 15, outHeight: 40, thumb: jpeg(5), spread },
      { original: jpeg(6), width: 10, height: 10, turn: 0, crop: whole, output: undefined!, outWidth: 10, outHeight: 10, thumb: jpeg(7) },
    ];
    pages[2].output = pages[2].original;

    const packed = await packProject(pages);
    // project.json, two originals, two outputs (the third is its original), three thumbs.
    expect(unzip(packed).size).toBe(8);

    const back = unpackProject(packed);
    expect(back.map(({ original, output, thumb, ...rest }) => rest)).toEqual(
      pages.map(({ original, output, thumb, ...rest }) => rest),
    );
    expect(back[0].original).toBe(back[1].original);
    expect(back[2].output).toBe(back[2].original);
    expect(back[0].original.type).toBe("image/jpeg");
    expect(await bytesOf(back[1].output)).toEqual(await bytesOf(pages[1].output));
  });

  it("refuses files that aren't projects", () => {
    expect(() => unpackProject(new Uint8Array(100))).toThrow(/not a Typo Scanner project/);
    expect(() => unpackProject(zip([{ name: "other.txt", data: new Uint8Array(1) }]))).toThrow(/not a Typo Scanner project/);
  });
});
