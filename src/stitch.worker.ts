import { alignPair, blend, compose, inverse, pyramid, toGray, type Alignment, type Gray, type Transform } from "./stitch";

interface Tile {
  blob: Blob;
  width: number;
  height: number;
  /** Decoded only when needed (to line up or join), then kept. A page of one scan never needs it. */
  rgba?: Uint8ClampedArray;
  levels?: Gray[];
}

const tiles = new Map<number, Tile>();

export interface Placed {
  id: number;
  t: Transform;
}

export type StitchRequest =
  | { op: "load"; id: number; blob: Blob; previewSide: number }
  | { op: "place"; id: number; others: Placed[] }
  | { op: "snap"; id: number; t: Transform; partner: Placed }
  | { op: "render"; parts: Placed[] }
  | { op: "drop"; ids: number[] };

const get = (id: number) => {
  const tile = tiles.get(id);
  if (!tile) throw new Error(`scan ${id} isn't loaded`);
  return tile;
};

async function pixels(id: number) {
  const tile = get(id);
  if (!tile.rgba) {
    const bitmap = await createImageBitmap(tile.blob);
    const ctx = new OffscreenCanvas(tile.width, tile.height).getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    tile.rgba = ctx.getImageData(0, 0, tile.width, tile.height).data;
  }
  return { data: tile.rgba, width: tile.width, height: tile.height };
}

async function levels(id: number) {
  const tile = get(id);
  if (!tile.levels) {
    const { data, width, height } = await pixels(id);
    tile.levels = pyramid(toGray(data, width, height));
  }
  return tile.levels;
}

async function handle(req: StitchRequest): Promise<[unknown, Transferable[]]> {
  switch (req.op) {
    case "load": {
      const bitmap = await createImageBitmap(req.blob);
      const { width, height } = bitmap;
      tiles.set(req.id, { blob: req.blob, width, height });
      const s = Math.min(1, req.previewSide / Math.max(width, height));
      const small = new OffscreenCanvas(Math.round(width * s), Math.round(height * s));
      small.getContext("2d")!.drawImage(bitmap, 0, 0, small.width, small.height);
      bitmap.close();
      const preview = small.transferToImageBitmap();
      return [{ width, height, preview }, [preview]];
    }
    case "place": {
      // Line it up against each scan already placed, and keep the best match.
      const mine = await levels(req.id);
      let best: (Alignment & { partner: Placed }) | null = null;
      for (const other of req.others) {
        const found = alignPair(await levels(other.id), mine);
        if (!best || found.score > best.score) best = { ...found, partner: other };
      }
      if (!best) return [{ t: { theta: 0, tx: 0, ty: 0 }, score: null, overlap: 1 }, []];
      return [{ t: compose(best.partner.t, best.t), score: best.score, overlap: best.overlap }, []];
    }
    case "snap": {
      // Search around where it was put by hand, so the nearest good fit wins.
      const found = alignPair(await levels(req.partner.id), await levels(req.id), compose(inverse(req.partner.t), req.t));
      return [{ t: compose(req.partner.t, found.t), score: found.score, overlap: found.overlap }, []];
    }
    case "render": {
      const parts = [];
      for (const p of req.parts) parts.push(await pixels(p.id));
      const out = blend(
        parts,
        req.parts.map((p) => p.t),
      );
      const canvas = new OffscreenCanvas(out.width, out.height);
      canvas.getContext("2d")!.putImageData(new ImageData(out.data as Uint8ClampedArray<ArrayBuffer>, out.width, out.height), 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
      return [{ blob, width: out.width, height: out.height }, []];
    }
    case "drop":
      req.ids.forEach((id) => tiles.delete(id));
      return [null, []];
  }
}

self.onmessage = async (e: MessageEvent<{ seq: number; req: StitchRequest }>) => {
  try {
    const [result, transfer] = await handle(e.data.req);
    self.postMessage({ seq: e.data.seq, result }, { transfer });
  } catch (err) {
    self.postMessage({ seq: e.data.seq, error: String(err) });
  }
};
