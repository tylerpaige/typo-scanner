import type { RenderRequest, RenderResult } from "./render.worker";

/** Crops and flattens pages off the main thread, one at a time, in request order. */
const worker = new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module" });
const pending = new Map<number, { resolve: (r: RenderResult) => void; reject: (e: Error) => void }>();
let nextId = 0;

worker.onmessage = (e: MessageEvent<RenderResult & { error?: string }>) => {
  const job = pending.get(e.data.id);
  pending.delete(e.data.id);
  if (e.data.error) job?.reject(new Error(e.data.error));
  else job?.resolve(e.data);
};

export function render(request: Omit<RenderRequest, "id">): Promise<RenderResult> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...request, id }, request.source instanceof ImageBitmap ? [request.source] : []);
  });
}
