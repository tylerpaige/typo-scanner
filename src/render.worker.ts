import { toPixels } from "./geometry";
import type { Crop } from "./outline";
import { warpImage } from "./warp";

export interface RenderRequest {
  id: number;
  source: Blob | ImageBitmap;
  crop: Crop;
  /** Quarter turns clockwise, in degrees, applied to the photo before cropping. */
  turn?: number;
  /** Scale the photo down to at most this many pixels on its long side first (for previews). */
  maxSide?: number;
  /** Skip encoding the full-size result (when the caller can reuse the original). */
  skipOutput?: boolean;
}

export interface RenderResult {
  id: number;
  output: Blob | null;
  thumb: Blob;
  width: number;
  height: number;
}

const THUMB = 480; // sharp enough for a widened sidebar

async function render({ source, crop, turn = 0, maxSide = Infinity, skipOutput }: RenderRequest) {
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const sideways = turn % 180 !== 0;
  const [sw, sh] = sideways ? [h, w] : [w, h];
  const src = new OffscreenCanvas(sw, sh);
  const sctx = src.getContext("2d", { willReadFrequently: crop.kind === "outline" })!;
  sctx.translate(sw / 2, sh / 2);
  sctx.rotate((turn * Math.PI) / 180);
  sctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  bitmap.close();

  let out: OffscreenCanvas;
  if (crop.kind === "rect") {
    const px = toPixels(crop.rect, sw, sh);
    out = new OffscreenCanvas(px.w, px.h);
    out.getContext("2d")!.drawImage(src, px.x, px.y, px.w, px.h, 0, 0, px.w, px.h);
  } else {
    const flat = warpImage(sctx.getImageData(0, 0, sw, sh), crop.outline);
    out = new OffscreenCanvas(flat.width, flat.height);
    out.getContext("2d")!.putImageData(new ImageData(flat.data as Uint8ClampedArray<ArrayBuffer>, flat.width, flat.height), 0, 0);
  }

  const t = Math.min(1, THUMB / Math.max(out.width, out.height));
  const thumb = new OffscreenCanvas(Math.max(1, Math.round(out.width * t)), Math.max(1, Math.round(out.height * t)));
  thumb.getContext("2d")!.drawImage(out, 0, 0, thumb.width, thumb.height);

  const [output, thumbBlob] = await Promise.all([
    skipOutput ? null : out.convertToBlob({ type: "image/jpeg", quality: 0.92 }),
    thumb.convertToBlob({ type: "image/jpeg", quality: 0.8 }),
  ]);
  return { output, thumb: thumbBlob, width: out.width, height: out.height };
}

self.onmessage = async (e: MessageEvent<RenderRequest>) => {
  try {
    self.postMessage({ id: e.data.id, ...(await render(e.data)) });
  } catch (err) {
    self.postMessage({ id: e.data.id, error: String(err) });
  }
};
