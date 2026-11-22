import type { Crop } from "./outline";

/** The file extension of a saved project. */
export const EXTENSION = "typoscan";
const VERSION = 1;

/** What a project keeps of a page: enough to show it, export it, and edit it again. */
export interface ProjectPage {
  original: Blob;
  width: number;
  height: number;
  turn: number;
  crop: Crop;
  output: Blob;
  outWidth: number;
  outHeight: number;
  thumb: Blob;
  spread?: { pair: number; whole: Crop; turn: number };
}

interface Manifest {
  app: "typo-scanner";
  version: number;
  pages: (Omit<ProjectPage, "original" | "output" | "thumb"> & { original: string; output: string; thumb: string })[];
}

const extensionOf = (type: string) => ({ "image/png": "png", "image/jpeg": "jpg" })[type] ?? "bin";
const typeOf = (name: string) => ({ png: "image/png", jpg: "image/jpeg" })[name.split(".").pop()!] ?? "";

/**
 * Packs the pages into a project file: a ZIP (stored, since the images are already
 * compressed) of `project.json` and every image. Halves of a spread share one original,
 * and an untouched page's output is its original, so each image is stored only once.
 */
export async function packProject(pages: ProjectPage[]): Promise<Uint8Array> {
  const files: { name: string; data: Uint8Array }[] = [];
  const names = new Map<Blob, string>();
  const add = async (blob: Blob, folder: string) => {
    let name = names.get(blob);
    if (!name) {
      name = `${folder}/${names.size + 1}.${extensionOf(blob.type)}`;
      names.set(blob, name);
      files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    return name;
  };
  const manifest: Manifest = { app: "typo-scanner", version: VERSION, pages: [] };
  for (const p of pages) {
    manifest.pages.push({
      width: p.width,
      height: p.height,
      turn: p.turn,
      crop: p.crop,
      outWidth: p.outWidth,
      outHeight: p.outHeight,
      ...(p.spread && { spread: p.spread }),
      original: await add(p.original, "originals"),
      output: await add(p.output, "pages"),
      thumb: await add(p.thumb, "thumbs"),
    });
  }
  const json = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  return zip([{ name: "project.json", data: json }, ...files]);
}

/** Reads a project file back into pages. */
export function unpackProject(bytes: Uint8Array): ProjectPage[] {
  const files = unzip(bytes);
  const json = files.get("project.json");
  if (!json) throw new Error("not a Typo Scanner project");
  const manifest = JSON.parse(new TextDecoder().decode(json)) as Manifest;
  if (manifest.app !== "typo-scanner") throw new Error("not a Typo Scanner project");
  if (manifest.version > VERSION) throw new Error("this project was saved by a newer version of Typo Scanner");
  const blobs = new Map<string, Blob>();
  const blob = (name: string) => {
    if (!blobs.has(name)) {
      const data = files.get(name);
      if (!data) throw new Error(`the project is missing ${name}`);
      blobs.set(name, new Blob([data as Uint8Array<ArrayBuffer>], { type: typeOf(name) }));
    }
    return blobs.get(name)!;
  };
  return manifest.pages.map((p) => ({ ...p, original: blob(p.original), output: blob(p.output), thumb: blob(p.thumb) }));
}

// ---- ZIP, stored only ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const entries = files.map((f) => ({ ...f, path: enc.encode(f.name), crc: crc32(f.data) }));
  const localSize = entries.reduce((n, e) => n + 30 + e.path.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.path.length, 0);
  const total = localSize + centralSize + 22;
  if (total > 0xffffffff || entries.length > 0xffff) throw new Error("the project is too big to save (over 4 GB)");

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (n: number) => (view.setUint16(at, n, true), (at += 2));
  const u32 = (n: number) => (view.setUint32(at, n, true), (at += 4));
  const bytes = (b: Uint8Array) => (out.set(b, at), (at += b.length));

  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(at);
    u32(0x04034b50);
    u16(20); // version needed
    u16(0x0800); // flags: names are UTF-8
    u16(0); // stored
    u16(0);
    u16(0x21); // DOS time and date: 1980-01-01
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.path.length);
    u16(0);
    bytes(e.path);
    bytes(e.data);
  }
  const central = at;
  entries.forEach((e, i) => {
    u32(0x02014b50);
    u16(20); // made by
    u16(20);
    u16(0x0800);
    u16(0);
    u16(0);
    u16(0x21);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.path.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offsets[i]);
    bytes(e.path);
  });
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(centralSize);
  u32(central);
  u16(0);
  return out;
}

/** The files in a stored (uncompressed) ZIP, by name. */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a Typo Scanner project");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const dec = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("the project file is damaged");
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (method !== 0) throw new Error(`can't read ${name}: it's compressed`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    files.set(name, bytes.subarray(start, start + size));
    at += 46 + nameLength + skip;
  }
  return files;
}
