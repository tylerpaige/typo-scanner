import { toPixels } from "./geometry";
import type { Crop } from "./outline";
import { warpImage } from "./warp";

export interface RenderRequest {
  id: number;
  source: Blob | ImageBitmap;
  crop: Crop;
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

const THUMB = 360;

async function render({ source, crop, maxSide = Infinity, skipOutput }: RenderRequest) {
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const sw = Math.round(bitmap.width * scale);
  const sh = Math.round(bitmap.height * scale);
  const src = new OffscreenCanvas(sw, sh);
  const sctx = src.getContext("2d", { willReadFrequently: crop.kind === "outline" })!;
  sctx.drawImage(bitmap, 0, 0, sw, sh);
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
