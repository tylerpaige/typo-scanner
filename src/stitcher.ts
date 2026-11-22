import type { Transform } from "./stitch";
import type { Placed, StitchRequest } from "./stitch.worker";

/** Lines up and joins scans off the main thread, one request at a time, in order. */
const worker = new Worker(new URL("./stitch.worker.ts", import.meta.url), { type: "module" });
const pending = new Map<number, { resolve: (r: never) => void; reject: (e: Error) => void }>();
let seq = 0;

worker.onmessage = (e: MessageEvent<{ seq: number; result?: unknown; error?: string }>) => {
  const job = pending.get(e.data.seq);
  pending.delete(e.data.seq);
  if (e.data.error !== undefined) job?.reject(new Error(e.data.error));
  else job?.resolve(e.data.result as never);
};

function send<T>(req: StitchRequest): Promise<T> {
  const n = seq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(n, { resolve: resolve as (r: never) => void, reject });
    worker.postMessage({ seq: n, req });
  });
}

export interface Placement {
  t: Transform;
  /** How well it matches the scan it was lined up against; `null` for the first scan of a page. */
  score: number | null;
  overlap: number;
}

let nextId = 1;

export const stitcher = {
  async load(blob: Blob, previewSide: number) {
    const id = nextId++;
    const r = await send<{ width: number; height: number; preview: ImageBitmap }>({ op: "load", id, blob, previewSide });
    return { id, ...r };
  },
  place: (id: number, others: Placed[]) => send<Placement>({ op: "place", id, others }),
  snap: (id: number, t: Transform, partner: Placed) => send<Placement>({ op: "snap", id, t, partner }),
  render: (parts: Placed[]) => send<{ blob: Blob; width: number; height: number }>({ op: "render", parts }),
  drop: (ids: number[]) => send<null>({ op: "drop", ids }),
};
