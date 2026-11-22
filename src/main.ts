import { invoke } from "@tauri-apps/api/core";
import { CropBox, fitFrame } from "./cropbox";
import { openEditor, openSplitter, type EditablePage } from "./editor";
import { FULL, clamp, isFull, rotateRect, type Rect } from "./geometry";
import { initIntake } from "./intake";
import { Loupe } from "./loupe";
import { outlineFromRect, rotateOutline, type Crop, type Outline } from "./outline";
import { OutlineBox } from "./outlinebox";
import { buildPdf } from "./pdf";
import { byParity, describe, parseRange, span } from "./selection";
import { render } from "./render";
import { CENTRE, clampSplit, splitCrop, type Split } from "./split";
import { SplitBox } from "./splitbox";

/** A captured photo, kept whole so its crop can be changed later. */
interface Page {
  original: Blob;
  width: number;
  height: number;
  /** Quarter turns clockwise, in degrees, applied before cropping; the crop is of the turned photo. */
  turn: number;
  crop: Crop;
  /** Counts renders, so a slow one finishing late can't overwrite a newer one. */
  version: number;
  /** The cropped (or flattened) JPEG that goes into the PDF. */
  output: Blob;
  outWidth: number;
  outHeight: number;
  thumb: string;
  /** Set on each half of a split spread, so the two can be joined again. */
  spread?: { pair: number; whole: Crop; turn: number };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const preview = $<HTMLCanvasElement>("preview");
const viewport = $("viewport");
const frame = $("frame");
const sourceSelect = $<HTMLSelectElement>("source");
const cameraTools = $("camera-tools");
const cameraView = $("camera-view");
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
const splitButton = $<HTMLButtonElement>("split");
const cropSelectedButton = $<HTMLButtonElement>("crop-selected");
const splitSelectedButton = $<HTMLButtonElement>("split-selected");
const unsplitSelectedButton = $<HTMLButtonElement>("unsplit-selected");
const sidebarResizer = $("sidebar-resizer");
const rotateLeftButton = $<HTMLButtonElement>("rotate-left");
const rotateRightButton = $<HTMLButtonElement>("rotate-right");
const sidebar = $("sidebar");
const selectAllButton = $<HTMLButtonElement>("select-all");
const selectOddButton = $<HTMLButtonElement>("select-odd");
const selectEvenButton = $<HTMLButtonElement>("select-even");
const selectNoneButton = $<HTMLButtonElement>("select-none");
const rangeInput = $<HTMLInputElement>("select-range");
const selectionCount = $("selection-count");
const scopeLabel = $("select-scope");
const stage = $("stage");
const message = $("message");
const pageList = $<HTMLOListElement>("pages");
const empty = $("empty");
const viewer = $<HTMLDialogElement>("viewer");

const pages: Page[] = [];
const selected = new Set<Page>();
let anchor: Page | null = null; // where a shift-click range starts
/** The span the selection buttons last chose from; kept so Odd then Even cover the same pages. */
let heldSpan: Page[] | null = null;
let stream: MediaStream | null = null;
let rotation = Number(load("rotation")) || 0;
let busy = false;
let rendering = 0; // captures still being cropped
let nextPair = 1;

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

function loadSplit(): Split {
  try {
    const s = JSON.parse(load("split") ?? "null");
    if (typeof s?.top === "number" && typeof s.bottom === "number") return clampSplit(s);
  } catch {}
  return CENTRE;
}

function loadOutline(): Outline | null {
  try {
    const o = JSON.parse(load("outline") ?? "null");
    if (o?.corners?.length === 4 && o.bends?.length === 4 && typeof o.lens === "number") return o;
  } catch {}
  return null;
}

// ---- camera ----

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

async function startCamera(deviceId?: string) {
  stopCamera();
  if (sourceSelect.value !== "camera") return;
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
  if (sourceSelect.value === "camera" && !stream?.active) startCamera(load("camera") ?? undefined);
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
  liveSplit.setSize(...frameSize());
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
const liveSplit = new SplitBox(frame);
liveSplit.set(loadSplit());
liveSplit.onChange = (split) => store("split", JSON.stringify(split));

const DEFAULT_OUTLINE = outlineFromRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });

function setLiveCrop(rect: Rect) {
  liveCrop.set(rect);
  store("crop", JSON.stringify(rect));
  updateCropReset();
  liveSplit.setCrop(liveCropValue());
}

function setLiveOutline(outline: Outline) {
  liveOutline.set(outline);
  lensInput.value = String(outline.lens);
  store("outline", JSON.stringify(outline));
  updateCropReset();
  liveSplit.setCrop(liveCropValue());
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
  liveSplit.setCrop(liveCropValue());
}
cropModeSelect.addEventListener("change", () => {
  cropModeSelect.blur();
  setCropMode(cropModeSelect.value as Crop["kind"]);
});
lensInput.addEventListener("input", () => {
  liveOutline.set({ ...liveOutline.outline, lens: Number(lensInput.value) });
  liveSplit.setCrop(liveCropValue());
});
lensInput.addEventListener("change", () => setLiveOutline(liveOutline.outline));

/** The crop each new capture starts with. */
const liveCropValue = (): Crop =>
  cropModeSelect.value === "outline"
    ? { kind: "outline", outline: liveOutline.outline }
    : { kind: "rect", rect: liveCrop.rect };

/** With split on, each capture becomes a spread's two pages. */
function setSplitting(on: boolean) {
  liveSplit.el.hidden = !on;
  splitButton.classList.toggle("on", on);
  store("split-on", on ? "1" : "");
}
splitButton.addEventListener("click", () => setSplitting(!splitButton.classList.contains("on")));

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
  const version = ++page.version;
  // The PDF embeds JPEGs as they are, so an untouched JPEG needn't be re-encoded.
  const keepOriginal =
    page.original.type === "image/jpeg" && page.turn === 0 && page.crop.kind === "rect" && isFull(page.crop.rect);
  const result = await render({ source: source ?? page.original, crop: page.crop, turn: page.turn, skipOutput: keepOriginal });
  if (version !== page.version) return; // changed again while this was rendering
  URL.revokeObjectURL(page.thumb);
  Object.assign(page, {
    output: keepOriginal ? page.original : result.output!,
    outWidth: result.width,
    outHeight: result.height,
    thumb: URL.createObjectURL(result.thumb),
  });
}

const newPage = (original: Blob, width: number, height: number, turn: number, crop: Crop): Page => ({
  original,
  width,
  height,
  turn,
  crop,
  version: 0,
  output: original,
  outWidth: width,
  outHeight: height,
  thumb: "",
});

/** The photo's size once turned, which is what its crop is measured against. */
const turnedSize = (p: { width: number; height: number; turn: number }): [number, number] =>
  p.turn % 180 === 0 ? [p.width, p.height] : [p.height, p.width];

/**
 * Adds a page from a whole photo or scan (or, given a split, the two pages of a spread),
 * then crops it in the background. `sources` are decoded copies of the photo, one per page.
 */
async function addPage(
  original: Blob,
  width: number,
  height: number,
  crop: Crop,
  { sources = [], turn = 0, split }: { sources?: ImageBitmap[]; turn?: number; split?: Split } = {},
) {
  const whole = newPage(original, width, height, turn, crop);
  let made = [whole];
  if (split) {
    const spread = { pair: nextPair++, whole: crop, turn };
    made = splitCrop(crop, split, ...turnedSize(whole)).map((half) => ({
      ...newPage(original, width, height, turn, half),
      spread,
    }));
  }
  // Add them straight away so pages stay in the order they were taken.
  pages.push(...made);
  rendering += made.length;
  renderPages();
  pageList.lastElementChild?.scrollIntoView({ block: "nearest" });
  await Promise.all(
    made.map((page, i) =>
      renderPage(page, sources[i]).finally(() => {
        rendering--;
        renderPages();
      }),
    ),
  );
}

async function capture() {
  if (!stream?.active || !hasFrame()) return;
  stage.classList.remove("flash");
  void stage.offsetWidth; // restart the animation
  stage.classList.add("flash");

  const full = document.createElement("canvas");
  drawFrame(full);
  const crop = liveCropValue();
  const split = liveSplit.el.hidden ? undefined : liveSplit.split;
  rendering++; // until the page is in the list, so a save can't miss it
  try {
    const [original, ...sources] = await Promise.all([
      toBlob(full, 0.92),
      ...Array.from({ length: split ? 2 : 1 }, () => createImageBitmap(full)),
    ]);
    await addPage(original as Blob, full.width, full.height, crop, { sources: sources as ImageBitmap[], split });
  } catch (e) {
    setStatus(`Capture failed: ${e}`);
  } finally {
    rendering--;
    renderPages();
  }
}

// ---- sources ----

const intake = initIntake({
  addPage: (image, width, height, turn) => addPage(image, width, height, { kind: "rect", rect: FULL }, { turn }),
});

function setSource(source: string) {
  sourceSelect.value = source;
  const camera = source === "camera";
  cameraTools.hidden = !camera;
  cameraView.hidden = !camera;
  intake.setActive(!camera);
  store("source", source);
  if (camera) {
    startCamera(load("camera") ?? undefined);
  } else {
    // Let go of the camera (and the iPhone) while scanning.
    stopCamera();
    if (loupe.on) toggleLoupe();
  }
}
sourceSelect.addEventListener("change", () => {
  sourceSelect.blur();
  setSource(sourceSelect.value);
});

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
  heldSpan = null;
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

/**
 * The pages the selection buttons choose from: the typed range; else, with two or more
 * pages selected, everything from the first selected to the last; else every page.
 */
function scope(): { indexes: number[]; from: "range" | "span" | "all" } | null {
  if (rangeInput.value.trim()) {
    const indexes = parseRange(rangeInput.value, pages.length);
    return indexes && { indexes, from: "range" };
  }
  const held = heldSpan?.map((p) => pages.indexOf(p)).filter((i) => i >= 0);
  const within = held?.length ? held : span(pages.flatMap((p, i) => (selected.has(p) ? [i] : [])));
  return within ? { indexes: within, from: "span" } : { indexes: pages.map((_, i) => i), from: "all" };
}

function selectIndexes(indexes: number[], from?: Page[]) {
  setArea("pages");
  selected.clear();
  indexes.forEach((i) => selected.add(pages[i]));
  anchor = pages[indexes[0]] ?? null;
  heldSpan = from ?? null;
  renderPages();
}

function selectAll(on = true) {
  if (!on) return selectIndexes([]);
  const s = scope();
  if (s) selectIndexes(s.indexes, s.from === "span" ? s.indexes.map((i) => pages[i]) : undefined);
}

function selectParity(parity: "odd" | "even") {
  const s = scope();
  if (s) selectIndexes(byParity(s.indexes, parity), s.from === "span" ? s.indexes.map((i) => pages[i]) : undefined);
}

selectAllButton.addEventListener("click", () => selectAll());
selectOddButton.addEventListener("click", () => selectParity("odd"));
selectEvenButton.addEventListener("click", () => selectParity("even"));
selectNoneButton.addEventListener("click", () => selectAll(false));
rangeInput.addEventListener("input", renderSelectionTools);
rangeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    selectAll();
  } else if (e.key === "Escape") {
    rangeInput.value = "";
    rangeInput.blur();
    renderSelectionTools();
  }
});

function renderSelectionTools() {
  const s = scope();
  rangeInput.classList.toggle("invalid", s === null);
  const none = pages.length === 0 || !s || s.indexes.length === 0;
  selectAllButton.disabled = selectOddButton.disabled = selectEvenButton.disabled = none;
  selectNoneButton.disabled = selected.size === 0;
  selectionCount.textContent = selected.size ? `${selected.size} of ${pages.length} selected` : "";
  scopeLabel.textContent =
    pages.length === 0
      ? ""
      : !s
        ? "Use page numbers, like 3-12, 15, 20-"
        : s.from === "all"
          ? "Choosing from every page"
          : s.indexes.length
            ? `Choosing from ${s.from === "span" ? "the selected span, " : ""}pages ${describe(s.indexes)}`
            : "No pages in that range";
}

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
  cropSelectedButton.disabled = rotateLeftButton.disabled = rotateRightButton.disabled = busy || selected.size === 0;
  cropSelectedButton.textContent = selected.size > 1 ? `Crop ${selected.size}…` : "Crop…";
  const spreads = pages.filter((p) => selected.has(p) && !p.spread).length;
  splitSelectedButton.disabled = busy || spreads === 0;
  splitSelectedButton.textContent = spreads > 1 ? `Split ${spreads}…` : "Split…";
  unsplitSelectedButton.hidden = !pages.some((p) => selected.has(p) && p.spread);
  unsplitSelectedButton.disabled = busy;
  renderSelectionTools();
  resetClear();
  if (!busy) {
    const count = pages.length ? `${pages.length} page${pages.length === 1 ? "" : "s"}` : "";
    setStatus(rendering > 0 ? `${count} · updating…` : count);
  }
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

function editable(p: Page): EditablePage {
  const [width, height] = turnedSize(p);
  return { original: p.original, turn: p.turn, width, height, crop: p.crop, number: pages.indexOf(p) + 1 };
}

function cropSelected() {
  const chosen = pages.filter((p) => selected.has(p));
  if (busy || chosen.length === 0) return;
  openEditor(
    chosen.map(editable),
    liveOutline.outline,
    async (crops) => {
      busy = true;
      renderPages();
      for (const [i, page] of chosen.entries()) {
        const crop = crops[i];
        if (JSON.stringify(crop) === JSON.stringify(page.crop)) continue; // left as it was
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

// ---- splitting spreads ----

/** Opens the gutter for the selected pages that aren't already halves of a spread. */
function splitSelected() {
  const chosen = pages.filter((p) => selected.has(p) && !p.spread);
  if (busy || chosen.length === 0) return;
  openSplitter(chosen.map(editable), loadSplit(), (splits) => {
    // The first page's split becomes the one new splits start from.
    store("split", JSON.stringify(splits[0]));
    liveSplit.set(splits[0]);
    for (const [n, page] of chosen.entries()) {
      const split = splits[n];
      const i = pages.indexOf(page);
      if (i < 0) continue;
      const spread = { pair: nextPair++, whole: page.crop, turn: page.turn };
      const halves = splitCrop(page.crop, split, ...turnedSize(page)).map((half) => ({
        ...newPage(page.original, page.width, page.height, page.turn, half),
        spread,
      }));
      pages.splice(i, 1, ...halves);
      selected.delete(page);
      halves.forEach((h) => selected.add(h));
      if (anchor === page) anchor = halves[0];
      URL.revokeObjectURL(page.thumb);
      rerender(halves, "split");
    }
    heldSpan = null;
    renderPages();
  });
}
splitSelectedButton.addEventListener("click", splitSelected);

/** Joins each selected half back to its partner, as the page it was before splitting. */
function unsplitSelected() {
  if (busy) return;
  const pairs = new Set(pages.filter((p) => selected.has(p) && p.spread).map((p) => p.spread!.pair));
  for (const pair of pairs) {
    const halves = pages.filter((p) => p.spread?.pair === pair);
    const [keep, ...rest] = halves;
    const { whole, turn } = keep.spread!;
    // The halves may have been turned since; turn the whole page's crop to match.
    keep.crop = rotateCrop(whole, (keep.turn - turn) / 90);
    delete keep.spread;
    removePages(rest);
    selected.add(keep);
    rerender([keep], "join");
  }
  renderPages();
}
unsplitSelectedButton.addEventListener("click", unsplitSelected);

/** Re-renders pages in the background, keeping saving off until they're done. */
function rerender(chosen: Page[], verb: string) {
  for (const page of chosen) {
    rendering++;
    renderPage(page)
      .catch((e) => setStatus(`Couldn't ${verb} page ${pages.indexOf(page) + 1}: ${e}`))
      .finally(() => {
        rendering--;
        renderPages();
      });
  }
}

// ---- rotating captured pages ----

const rotateCrop = (crop: Crop, quarters: number): Crop =>
  crop.kind === "rect"
    ? { kind: "rect", rect: rotateRect(crop.rect, quarters) }
    : { kind: "outline", outline: rotateOutline(crop.outline, quarters) };

function rotatePages(chosen: Page[], quarters: number) {
  if (busy || chosen.length === 0) return;
  for (const page of chosen) {
    page.turn = (((page.turn + quarters * 90) % 360) + 360) % 360;
    // The crop turns with the page, so it keeps framing the same part of it.
    page.crop = rotateCrop(page.crop, quarters);
  }
  rerender(chosen, "rotate");
  renderPages();
}

const rotateSelected = (quarters: number) => rotatePages(pages.filter((p) => selected.has(p)), quarters);
rotateLeftButton.addEventListener("click", () => rotateSelected(-1));
rotateRightButton.addEventListener("click", () => rotateSelected(1));

/** Which part of the window ⌘R turns: the selected pages, or the camera or scanner view. */
let area: "pages" | "stage" = "stage";
function setArea(next: "pages" | "stage") {
  area = next;
  sidebar.classList.toggle("active", next === "pages");
}
sidebar.addEventListener("pointerdown", () => setArea("pages"));

// ---- sidebar width ----

const SIDEBAR_WIDTH = 224;
function setSidebarWidth(width: number) {
  const max = Math.max(SIDEBAR_WIDTH, window.innerWidth - 360); // leave room for the stage
  sidebar.style.width = `${Math.round(clamp(width, 200, max))}px`;
}
sidebarResizer.addEventListener("pointerdown", (down) => {
  if (down.button !== 0) return;
  down.preventDefault();
  const start = sidebar.offsetWidth;
  const move = (e: PointerEvent) => setSidebarWidth(start + down.clientX - e.clientX);
  const up = () => {
    sidebarResizer.classList.remove("dragging");
    sidebarResizer.removeEventListener("pointermove", move);
    sidebarResizer.removeEventListener("pointerup", up);
    sidebarResizer.removeEventListener("pointercancel", up);
    store("sidebar-width", String(sidebar.offsetWidth));
  };
  sidebarResizer.classList.add("dragging");
  sidebarResizer.setPointerCapture(down.pointerId);
  sidebarResizer.addEventListener("pointermove", move);
  sidebarResizer.addEventListener("pointerup", up);
  sidebarResizer.addEventListener("pointercancel", up);
});
sidebarResizer.addEventListener("dblclick", () => {
  setSidebarWidth(SIDEBAR_WIDTH);
  store("sidebar-width", String(SIDEBAR_WIDTH));
});
window.addEventListener("resize", () => setSidebarWidth(sidebar.offsetWidth));
stage.addEventListener("pointerdown", () => setArea("stage"));

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
  }
  if (cmd && e.code === "KeyR") {
    // ⌘R turns right and ⌘⇧R left, whichever part of the window you're working in.
    e.preventDefault();
    const quarters = e.shiftKey ? -1 : 1;
    if (area === "pages" && selected.size) rotateSelected(quarters);
    else if (sourceSelect.value === "camera") setRotation(rotation + quarters * 90);
    else intake.rotate(quarters);
    return;
  }
  // Typing in a text field: leave its keys alone (⌘A selects its text, Space types a space).
  if (e.target instanceof HTMLInputElement && e.target.type === "text") return;
  if (cmd && e.key === "a") {
    e.preventDefault();
    selectIndexes(pages.map((_, i) => i));
  }
  if (cmd || e.altKey || e.target instanceof HTMLSelectElement) return;
  const camera = sourceSelect.value === "camera";
  if (!camera && intake.handleKey(e)) {
    e.preventDefault();
    return;
  }
  if (e.key === " ") {
    e.preventDefault();
    if (!e.repeat) capture();
  } else if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    if (busy) return;
    removePages(selected.size ? pages.filter((p) => selected.has(p)) : pages.slice(-1));
  } else if (e.key === "Escape") {
    selectAll(false);
  } else if (camera && (e.key === "r" || e.key === "R")) {
    setRotation(rotation + (e.shiftKey ? -90 : 90));
  } else if (camera && (e.key === "l" || e.key === "L")) {
    toggleLoupe();
  } else if (camera && (e.key === "o" || e.key === "O")) {
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

setSidebarWidth(Number(load("sidebar-width")) || SIDEBAR_WIDTH);
setSplitting(load("split-on") === "1");
setLiveCrop(loadCrop());
setLiveOutline(loadOutline() ?? DEFAULT_OUTLINE);
setCropMode(load("crop-mode") === "outline" ? "outline" : "rect");
setRotation(rotation);
renderPages();
requestAnimationFrame(renderPreview);
setSource(load("source") === "scanner" ? "scanner" : "camera");
