import { invoke } from "@tauri-apps/api/core";
import { CropBox, fitFrame } from "./cropbox";
import { openEditor } from "./editor";
import { FULL, isFull, rotateRect, type Rect } from "./geometry";
import { Loupe } from "./loupe";
import { outlineFromRect, rotateOutline, type Crop, type Outline } from "./outline";
import { OutlineBox } from "./outlinebox";
import { buildPdf } from "./pdf";
import { render } from "./render";

/** A captured photo, kept whole so its crop can be changed later. */
interface Page {
  original: Blob;
  width: number;
  height: number;
  crop: Crop;
  /** The cropped (or flattened) JPEG that goes into the PDF. */
  output: Blob;
  outWidth: number;
  outHeight: number;
  thumb: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const preview = $<HTMLCanvasElement>("preview");
const viewport = $("viewport");
const frame = $("frame");
const cameraSelect = $<HTMLSelectElement>("camera");
const rotateButton = $<HTMLButtonElement>("rotate");
const loupeButton = $<HTMLButtonElement>("loupe");
const cropResetButton = $<HTMLButtonElement>("crop-reset");
const cropModeSelect = $<HTMLSelectElement>("crop-mode");
const lensTools = $("lens-tools");
const lensInput = $<HTMLInputElement>("lens");
const resolution = $("resolution");
const status = $("status");
const clearButton = $<HTMLButtonElement>("clear");
const saveButton = $<HTMLButtonElement>("save");
const cropSelectedButton = $<HTMLButtonElement>("crop-selected");
const selectAllButton = $<HTMLButtonElement>("select-all");
const stage = $("stage");
const message = $("message");
const pageList = $<HTMLOListElement>("pages");
const empty = $("empty");
const viewer = $<HTMLDialogElement>("viewer");

const pages: Page[] = [];
const selected = new Set<Page>();
let anchor: Page | null = null; // where a shift-click range starts
let stream: MediaStream | null = null;
let rotation = Number(load("rotation")) || 0;
let busy = false;
let rendering = 0; // captures still being cropped

// ---- settings ----

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function loadCrop(): Rect {
  try {
    const r = JSON.parse(load("crop") ?? "null");
    if ([r?.x, r?.y, r?.w, r?.h].every((n) => typeof n === "number")) return r;
  } catch {}
  return FULL;
}

function loadOutline(): Outline | null {
  try {
    const o = JSON.parse(load("outline") ?? "null");
    if (o?.corners?.length === 4 && o.bends?.length === 4 && typeof o.lens === "number") return o;
  } catch {}
  return null;
}

// ---- camera ----

async function startCamera(deviceId?: string) {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  showMessage("Starting camera…");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // Ask for far more than any camera offers; WebKit picks the largest mode it has.
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 4096 },
        height: { ideal: 4096 },
      },
    });
  } catch (e) {
    const name = (e as DOMException).name;
    if (deviceId && name === "OverconstrainedError") return startCamera();
    showMessage(
      name === "NotAllowedError"
        ? "Camera access is turned off. Allow it in System Settings → Privacy & Security → Camera, then reopen the app."
        : name === "NotFoundError"
          ? "No camera found. Plug one in, or bring your iPhone near to use Continuity Camera."
          : `Couldn't start the camera: ${(e as Error).message}`,
    );
    await listCameras();
    return;
  }
  const track = stream.getVideoTracks()[0];
  track.addEventListener("ended", () => startCamera());
  const id = track.getSettings().deviceId;
  if (id) store("camera", id);
  video.srcObject = stream;
  await video.play();
  showMessage(null);
  await listCameras();
}

/** Labels are only available once access is granted, so this runs after each start. */
async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === "videoinput");
  const current = stream?.getVideoTracks()[0]?.getSettings().deviceId;
  cameraSelect.replaceChildren(
    ...cameras.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId, false, d.deviceId === current)),
  );
}

cameraSelect.addEventListener("change", () => {
  cameraSelect.blur();
  startCamera(cameraSelect.value);
});

// An iPhone appears and disappears as it comes in and out of range.
navigator.mediaDevices.addEventListener("devicechange", async () => {
  await listCameras();
  if (!stream?.active) startCamera(load("camera") ?? undefined);
});

function showMessage(text: string | null) {
  message.hidden = text === null;
  message.textContent = text ?? "";
  frame.hidden = text !== null;
}

// ---- drawing ----

const hasFrame = () => video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0;

/** The size of the camera frame after rotation. */
function frameSize(): [number, number] {
  const w = video.videoWidth;
  const h = video.videoHeight;
  return rotation % 180 === 0 ? [w, h] : [h, w];
}

/** Draws the current frame, rotated, with its top-left at the origin and one unit per source pixel. */
function paintFrame(ctx: CanvasRenderingContext2D) {
  const [rw, rh] = frameSize();
  ctx.translate(rw / 2, rh / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
}

/** Draws the current frame onto `canvas`, resizing it to fit, at most `maxSide` pixels long. */
function drawFrame(canvas: HTMLCanvasElement, maxSide = Infinity) {
  const [rw, rh] = frameSize();
  const scale = Math.min(1, maxSide / Math.max(rw, rh));
  const cw = Math.round(rw * scale);
  const ch = Math.round(rh * scale);
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== ch) canvas.height = ch;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  paintFrame(ctx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

let fittedTo = "";
function fitPreview(force = false) {
  const key = `${preview.width}×${preview.height}`;
  if (!force && key === fittedTo) return;
  fittedTo = key;
  fitFrame(frame, viewport, preview.width, preview.height);
  liveOutline.setSize(...frameSize());
}
new ResizeObserver(() => fitPreview(true)).observe(viewport);

function renderPreview() {
  if (hasFrame()) {
    drawFrame(preview, 1600);
    fitPreview();
    const size = `${video.videoWidth}×${video.videoHeight}`;
    if (resolution.textContent !== size) resolution.textContent = size;
    loupe.draw();
  }
  requestAnimationFrame(renderPreview);
}

const loupe = new Loupe(frame, paintFrame, () => (hasFrame() ? frameSize() : null));

function toggleLoupe() {
  loupe.toggle();
  loupeButton.classList.toggle("on", loupe.on);
}
loupeButton.addEventListener("click", toggleLoupe);

// ---- live crop: applied to each new capture ----

const liveCrop = new CropBox(frame);
liveCrop.onChange = (rect) => setLiveCrop(rect);
const liveOutline = new OutlineBox(frame);
liveOutline.onChange = (outline) => setLiveOutline(outline);

const DEFAULT_OUTLINE = outlineFromRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });

function setLiveCrop(rect: Rect) {
  liveCrop.set(rect);
  store("crop", JSON.stringify(rect));
  updateCropReset();
}

function setLiveOutline(outline: Outline) {
  liveOutline.set(outline);
  lensInput.value = String(outline.lens);
  store("outline", JSON.stringify(outline));
  updateCropReset();
}

/** Whether the outline's corners or bends have moved; the lens belongs to the camera, so it doesn't count. */
const outlineMoved = (o: Outline) =>
  JSON.stringify([o.corners, o.bends]) !== JSON.stringify([DEFAULT_OUTLINE.corners, DEFAULT_OUTLINE.bends]);

function updateCropReset() {
  cropResetButton.hidden =
    cropModeSelect.value === "outline" ? !outlineMoved(liveOutline.outline) : isFull(liveCrop.rect);
}

// Clears the shape for future captures; pages already taken keep theirs.
cropResetButton.addEventListener("click", () => {
  if (cropModeSelect.value === "outline") setLiveOutline({ ...DEFAULT_OUTLINE, lens: liveOutline.outline.lens });
  else setLiveCrop(FULL);
});

function setCropMode(mode: Crop["kind"]) {
  cropModeSelect.value = mode;
  liveCrop.el.hidden = mode !== "rect";
  liveOutline.el.hidden = mode !== "outline";
  lensTools.hidden = mode !== "outline";
  store("crop-mode", mode);
  updateCropReset();
}
cropModeSelect.addEventListener("change", () => {
  cropModeSelect.blur();
  setCropMode(cropModeSelect.value as Crop["kind"]);
});
lensInput.addEventListener("input", () => liveOutline.set({ ...liveOutline.outline, lens: Number(lensInput.value) }));
lensInput.addEventListener("change", () => setLiveOutline(liveOutline.outline));

/** The crop each new capture starts with. */
const liveCropValue = (): Crop =>
  cropModeSelect.value === "outline"
    ? { kind: "outline", outline: liveOutline.outline }
    : { kind: "rect", rect: liveCrop.rect };

function setRotation(deg: number) {
  const next = ((deg % 360) + 360) % 360;
  // The crop turns with the picture, so it keeps framing the same part of the desk.
  setLiveCrop(rotateRect(liveCrop.rect, (next - rotation) / 90));
  setLiveOutline(rotateOutline(liveOutline.outline, (next - rotation) / 90));
  rotation = next;
  rotateButton.textContent = `Rotate ${rotation}°`;
  store("rotation", String(rotation));
}
rotateButton.addEventListener("click", () => setRotation(rotation + 90));

// ---- pages ----

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG encoding failed"))), "image/jpeg", quality),
  );

/** Re-makes a page's cropped output and thumbnail from its original, off the main thread. */
async function renderPage(page: Page, source?: ImageBitmap) {
  const keepOriginal = page.crop.kind === "rect" && isFull(page.crop.rect);
  const result = await render({ source: source ?? page.original, crop: page.crop, skipOutput: keepOriginal });
  URL.revokeObjectURL(page.thumb);
  Object.assign(page, {
    output: keepOriginal ? page.original : result.output!,
    outWidth: result.width,
    outHeight: result.height,
    thumb: URL.createObjectURL(result.thumb),
  });
}

async function capture() {
  if (!stream?.active || !hasFrame()) return;
  stage.classList.remove("flash");
  void stage.offsetWidth; // restart the animation
  stage.classList.add("flash");

  const full = document.createElement("canvas");
  drawFrame(full);
  const crop = liveCropValue();
  rendering++;
  try {
    const [original, bitmap] = await Promise.all([toBlob(full, 0.92), createImageBitmap(full)]);
    const page: Page = {
      original,
      width: full.width,
      height: full.height,
      crop,
      output: original,
      outWidth: full.width,
      outHeight: full.height,
      thumb: "",
    };
    // Add it straight away so pages stay in the order they were taken.
    pages.push(page);
    renderPages();
    pageList.lastElementChild?.scrollIntoView({ block: "nearest" });
    await renderPage(page, bitmap);
  } catch (e) {
    setStatus(`Capture failed: ${e}`);
  } finally {
    rendering--;
    renderPages();
  }
}

function removePages(doomed: Page[]) {
  for (const page of doomed) {
    const i = pages.indexOf(page);
    if (i < 0) continue;
    pages.splice(i, 1);
    selected.delete(page);
    URL.revokeObjectURL(page.thumb);
  }
  if (anchor && !pages.includes(anchor)) anchor = null;
  renderPages();
}

function select(page: Page, e: MouseEvent) {
  if (e.shiftKey && anchor) {
    const [a, b] = [pages.indexOf(anchor), pages.indexOf(page)].sort((m, n) => m - n);
    if (!e.metaKey) selected.clear();
    pages.slice(a, b + 1).forEach((p) => selected.add(p));
  } else if (e.metaKey) {
    if (!selected.delete(page)) selected.add(page);
    anchor = page;
  } else {
    selected.clear();
    selected.add(page);
    anchor = page;
  }
  renderPages();
}

function selectAll(on = true) {
  pages.forEach((p) => (on ? selected.add(p) : selected.delete(p)));
  renderPages();
}
selectAllButton.addEventListener("click", () => selectAll(selected.size < pages.length));

function renderPages() {
  pageList.replaceChildren(
    ...pages.map((page, i) => {
      const li = document.createElement("li");
      li.classList.toggle("selected", selected.has(page));
      const img = document.createElement("img");
      if (page.thumb) img.src = page.thumb;
      img.title = "Click to select · double-click to view";
      img.addEventListener("click", (e) => select(page, e));
      img.addEventListener("dblclick", () => openViewer(page));
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = String(i + 1);
      const del = document.createElement("button");
      del.className = "delete";
      del.textContent = "✕";
      del.title = "Delete page";
      del.addEventListener("click", () => removePages([page]));
      li.append(img, num, del);
      return li;
    }),
  );
  empty.hidden = pages.length > 0;
  clearButton.disabled = busy || pages.length === 0;
  saveButton.disabled = busy || rendering > 0 || pages.length === 0;
  cropSelectedButton.disabled = busy || selected.size === 0;
  cropSelectedButton.textContent = selected.size > 1 ? `Crop ${selected.size}…` : "Crop…";
  selectAllButton.disabled = pages.length === 0;
  selectAllButton.textContent = pages.length > 0 && selected.size === pages.length ? "Select none" : "Select all";
  resetClear();
  if (!busy) setStatus(pages.length ? `${pages.length} page${pages.length === 1 ? "" : "s"}` : "");
}

function openViewer(page: Page) {
  const img = viewer.querySelector("img")!;
  img.src = URL.createObjectURL(page.output);
  viewer.showModal();
}

viewer.addEventListener("click", () => viewer.close());
viewer.addEventListener("close", () => {
  const img = viewer.querySelector("img")!;
  URL.revokeObjectURL(img.src);
  img.removeAttribute("src");
});

// ---- cropping captured pages ----

function cropSelected() {
  const chosen = pages.filter((p) => selected.has(p));
  if (busy || chosen.length === 0) return;
  openEditor(
    chosen.map((p) => ({ ...p, number: pages.indexOf(p) + 1 })),
    liveOutline.outline,
    async (crop) => {
      busy = true;
      renderPages();
      for (const [i, page] of chosen.entries()) {
        setStatus(`${crop.kind === "outline" ? "Flattening" : "Cropping"} ${i + 1} of ${chosen.length}…`);
        page.crop = crop;
        try {
          await renderPage(page);
        } catch (e) {
          setStatus(`Couldn't crop page ${pages.indexOf(page) + 1}: ${e}`);
        }
      }
      busy = false;
      renderPages();
    },
  );
}
cropSelectedButton.addEventListener("click", cropSelected);

// Clearing takes two clicks, since there's no undo.
let clearTimer: number | undefined;
function resetClear() {
  clearTimeout(clearTimer);
  clearButton.textContent = "Clear";
  clearButton.classList.remove("confirm");
}
clearButton.addEventListener("click", () => {
  if (!clearButton.classList.contains("confirm")) {
    clearButton.textContent = `Delete ${pages.length} pages?`;
    clearButton.classList.add("confirm");
    clearTimer = window.setTimeout(resetClear, 3000);
    return;
  }
  removePages([...pages]);
});

// ---- saving ----

function setStatus(text: string) {
  status.textContent = text;
}

async function save() {
  if (busy || rendering > 0 || pages.length === 0) return;
  busy = true;
  renderPages();
  setStatus("Building PDF…");
  try {
    const pdf = buildPdf(
      await Promise.all(
        pages.map(async (p) => ({
          jpeg: new Uint8Array(await p.output.arrayBuffer()),
          width: p.outWidth,
          height: p.outHeight,
        })),
      ),
    );
    setStatus("Choosing where to save…");
    const path = await invoke<string | null>("save_pdf", pdf);
    busy = false;
    renderPages();
    if (path) setStatus(`Saved ${pages.length} pages to ${path.split("/").pop()}`);
  } catch (e) {
    busy = false;
    renderPages();
    setStatus(`Save failed: ${e}`);
  }
}

saveButton.addEventListener("click", save);

// ---- keyboard ----

document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return; // dialogs handle their own keys
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && e.key === "s") {
    e.preventDefault();
    save();
  } else if (cmd && e.key === "a") {
    e.preventDefault();
    selectAll();
  }
  if (cmd || e.altKey || e.target instanceof HTMLSelectElement) return;
  if (e.key === " ") {
    e.preventDefault();
    if (!e.repeat) capture();
  } else if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    if (busy) return;
    removePages(selected.size ? pages.filter((p) => selected.has(p)) : pages.slice(-1));
  } else if (e.key === "Escape") {
    selectAll(false);
  } else if (e.key === "r" || e.key === "R") {
    setRotation(rotation + (e.shiftKey ? -90 : 90));
  } else if (e.key === "l" || e.key === "L") {
    toggleLoupe();
  } else if (e.key === "o" || e.key === "O") {
    setCropMode(cropModeSelect.value === "outline" ? "rect" : "outline");
  } else if (e.key === "c" || e.key === "C") {
    cropSelected();
  }
});

// Clicking a button leaves it focused, and Space would then click it again.
document.addEventListener("mouseup", () => {
  if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
});
$("capture").addEventListener("click", capture);

setLiveCrop(loadCrop());
setLiveOutline(loadOutline() ?? DEFAULT_OUTLINE);
setCropMode(load("crop-mode") === "outline" ? "outline" : "rect");
setRotation(rotation);
renderPages();
requestAnimationFrame(renderPreview);
startCamera(load("camera") ?? undefined);
