import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CropBox, fitFrame } from "./cropbox";
import { openEditor, openSplitter, type EditablePage } from "./editor";
import { FULL, clamp, isFull, rotateRect, type Rect } from "./geometry";
import { initIntake } from "./intake";
import { Loupe } from "./loupe";
import { outlineFromRect, rotateOutline, type Crop, type Outline } from "./outline";
import { OutlineBox } from "./outlinebox";
import { buildPdf } from "./pdf";
import { EXTENSION, packProject, unpackProject } from "./project";
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
  thumbBlob: Blob;
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
const openButton = $<HTMLButtonElement>("open");
const saveButton = $<HTMLButtonElement>("save");
const exportButton = $<HTMLButtonElement>("export");
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
let cursor: Page | null = null; // where the arrow keys are, the moving end of a ⇧-arrow range
/** Pages being dragged to a new place in the list. */
let dragging: Page[] = [];
/** The span the selection buttons last chose from; kept so Odd then Even cover the same pages. */
let heldSpan: Page[] | null = null;
let stream: MediaStream | null = null;
let rotation = Number(load("rotation")) || 0;
let busy = false;
let rendering = 0; // captures still being cropped
let nextPair = 1;
/** Where the open project is saved, if it has been. */
let projectPath: string | null = null;
/** Whether the pages have changed since the project was opened or saved. */
let edited = false;

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
    thumbBlob: result.thumb,
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
  thumbBlob: new Blob(),
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
  markEdited();
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
  return made;
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
  removePages: (made) => removePages(made as Page[]),
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
    markEdited();
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
  cursor = page;
  renderPages();
}

// ---- moving about the pages from the keyboard ----

/** How many thumbnails fit across the list as it's laid out now. */
function columns() {
  const items = [...pageList.children] as HTMLElement[];
  const top = items[0]?.offsetTop;
  return Math.max(1, items.filter((li) => li.offsetTop === top).length);
}

/** Moves the cursor `by` pages; with `extend`, selects from the anchor to there, else just there. */
function moveCursor(by: number, extend: boolean) {
  if (!pages.length) return;
  heldSpan = null;
  const at = cursor ? pages.indexOf(cursor) : -1;
  // With nothing to start from, the first arrow press lands on the first page.
  const next = at < 0 || !selected.size ? pages[0] : pages[Math.min(pages.length - 1, Math.max(0, at + by))];
  if (extend && anchor && selected.size) {
    const [a, b] = [pages.indexOf(anchor), pages.indexOf(next)].sort((m, n) => m - n);
    selected.clear();
    pages.slice(a, b + 1).forEach((p) => selected.add(p));
  } else {
    selected.clear();
    selected.add(next);
    anchor = next;
  }
  cursor = next;
  renderPages();
  pageList.children[pages.indexOf(next)]?.scrollIntoView({ block: "nearest" });
}

/** Moves the selected pages `by` places in the list, keeping any gaps between them. */
function shiftSelected(by: number) {
  if (busy || !selected.size) return;
  const step = Math.sign(by);
  for (let n = 0; n < Math.abs(by); n++) {
    const at = pages.flatMap((p, i) => (selected.has(p) ? [i] : []));
    if (step < 0 ? at[0] === 0 : at[at.length - 1] === pages.length - 1) break; // against the end
    for (const i of step < 0 ? at : at.reverse()) [pages[i], pages[i + step]] = [pages[i + step], pages[i]];
    markEdited();
  }
  renderPages();
  if (cursor) pageList.children[pages.indexOf(cursor)]?.scrollIntoView({ block: "nearest" });
}

/** Puts `moving` (in their present order) just before or after `target`. */
function movePages(moving: Page[], target: Page | null, after: boolean) {
  if (busy || !moving.length || (target && moving.includes(target))) return;
  const rest = pages.filter((p) => !moving.includes(p));
  const at = target ? rest.indexOf(target) + (after ? 1 : 0) : rest.length;
  pages.splice(0, pages.length, ...rest.slice(0, at), ...moving, ...rest.slice(at));
  markEdited();
  renderPages();
}

function clearDropMarks() {
  pageList.querySelectorAll(".drop-before, .drop-after").forEach((li) => li.classList.remove("drop-before", "drop-after"));
}

// Dropping past the last page (not in the gaps between pages) puts the pages at the end.
const pastEnd = (e: DragEvent) => {
  const last = pageList.lastElementChild?.getBoundingClientRect();
  return !!last && e.target === pageList && (e.clientY > last.bottom || (e.clientY >= last.top && e.clientX > last.right));
};
pageList.addEventListener("dragover", (e) => {
  if (dragging.length && pastEnd(e)) e.preventDefault();
});
pageList.addEventListener("drop", (e) => {
  if (!pastEnd(e)) return;
  e.preventDefault();
  movePages(dragging, null, true);
  dragging = [];
});

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
  cursor = anchor;
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
    // Back to the pages, so the keys act on what's now selected (⌘C, ⌘/, arrows…).
    rangeInput.blur();
    setArea("pages");
  } else if (e.key === "Escape") {
    rangeInput.value = "";
    rangeInput.blur();
    renderSelectionTools();
  }
});

function focusRange() {
  setArea("pages");
  rangeInput.focus();
  rangeInput.select();
}

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
      li.classList.toggle("cursor", page === cursor && selected.size > 1);
      li.draggable = true;
      li.addEventListener("dragstart", (e) => {
        // Dragging a selected page brings the rest of the selection along.
        dragging = selected.has(page) ? pages.filter((p) => selected.has(p)) : [page];
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        e.dataTransfer?.setData("text/plain", String(i + 1));
      });
      li.addEventListener("dragend", () => {
        dragging = [];
        clearDropMarks();
      });
      // Which half of the thumbnail the pointer is over says which side to drop on.
      const after = (e: DragEvent) => {
        const r = li.getBoundingClientRect();
        return e.clientX > r.left + r.width / 2;
      };
      li.addEventListener("dragover", (e) => {
        if (!dragging.length || dragging.includes(page)) return;
        e.preventDefault();
        clearDropMarks();
        li.classList.add(after(e) ? "drop-after" : "drop-before");
      });
      li.addEventListener("dragleave", () => li.classList.remove("drop-before", "drop-after"));
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        clearDropMarks();
        movePages(dragging, page, after(e));
        dragging = [];
      });
      const img = document.createElement("img");
      if (page.thumb) img.src = page.thumb;
      img.draggable = false;
      img.title = "Click to select · double-click to view · drag to move";
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
  openButton.disabled = busy || rendering > 0;
  saveButton.disabled = exportButton.disabled = busy || rendering > 0 || pages.length === 0;
  cropSelectedButton.disabled = rotateLeftButton.disabled = rotateRightButton.disabled = busy || selected.size === 0;
  cropSelectedButton.textContent = selected.size > 1 ? `Crop ${selected.size}…` : "Crop…";
  const spreads = pages.filter((p) => selected.has(p) && !p.spread).length;
  splitSelectedButton.disabled = busy || spreads === 0;
  splitSelectedButton.textContent = spreads > 1 ? `Split ${spreads}…` : "Split…";
  unsplitSelectedButton.hidden = !pages.some((p) => selected.has(p) && p.spread);
  unsplitSelectedButton.disabled = busy;
  renderSelectionTools();
  syncMenu(spreads);
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
  return { original: p.original, turn: p.turn, width, height, crop: p.crop, number: pages.indexOf(p) + 1, thumb: p.thumb };
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
        if (!crop || JSON.stringify(crop) === JSON.stringify(page.crop)) continue; // left as it was
        setStatus(`${crop.kind === "outline" ? "Flattening" : "Cropping"} ${i + 1} of ${chosen.length}…`);
        page.crop = crop;
        markEdited();
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
    const first = splits.find((s) => s);
    if (first) {
      store("split", JSON.stringify(first));
      liveSplit.set(first);
    }
    for (const [n, page] of chosen.entries()) {
      const split = splits[n];
      if (!split) continue; // taken out of the edit
      const i = pages.indexOf(page);
      if (i < 0) continue;
      const spread = { pair: nextPair++, whole: page.crop, turn: page.turn };
      const halves = splitCrop(page.crop, split, ...turnedSize(page)).map((half) => ({
        ...newPage(page.original, page.width, page.height, page.turn, half),
        spread,
      }));
      pages.splice(i, 1, ...halves);
      markEdited();
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
    markEdited();
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
  markEdited();
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
  startOver();
});

/** Clears the pages for a new project, so saving can't write them over the one that was open. */
function startOver() {
  removePages([...pages]);
  setProject(null);
}

async function newProject() {
  if (busy) return;
  if (edited && pages.length && !(await invoke<boolean>("confirm_discard"))) return;
  startOver();
}

// ---- projects and exporting ----

function setStatus(text: string) {
  status.textContent = text;
}

const fileName = (path: string) => path.split("/").pop()!;
/** The open project's name, without its extension. */
const projectName = () => projectPath && fileName(projectPath).replace(new RegExp(`\\.${EXTENSION}$`, "i"), "");

function setProject(path: string | null, isEdited = false) {
  projectPath = path;
  edited = isEdited;
  invoke("set_document", { name: projectName(), edited }).catch(() => {});
}

function markEdited() {
  if (!edited) setProject(projectPath, true);
}

const writeFile = (path: string, bytes: Uint8Array) =>
  invoke("write_file", bytes, { headers: { path: encodeURIComponent(path) } });

/**
 * Runs a save, export or open with the page tools held still, then reports how it went.
 * `job` returns the status to show, or null if it was cancelled.
 */
async function hold(job: () => Promise<string | null>, failure: string) {
  if (busy || rendering > 0) return;
  busy = true;
  renderPages();
  let outcome: string | null;
  try {
    outcome = await job();
  } catch (e) {
    outcome = `${failure}: ${e}`;
  }
  busy = false;
  renderPages();
  if (outcome) setStatus(outcome);
}

/** Saves the pages, with everything needed to keep editing them, to the open project or (with `copy`, or if it's new) a file chosen now. */
/** The project file's bytes, with everything needed to keep editing the pages. */
const projectBytes = () => packProject(pages.map((p) => ({ ...p, thumb: p.thumbBlob })));

/** The pages as a PDF. */
const pdfBytes = async () =>
  buildPdf(
    await Promise.all(
      pages.map(async (p) => ({
        jpeg: new Uint8Array(await p.output.arrayBuffer()),
        width: p.outWidth,
        height: p.outHeight,
      })),
    ),
  );

const saveProject = (copy = false) =>
  pages.length > 0 &&
  hold(async () => {
    setStatus("Choosing where to save…");
    const path =
      copy || !projectPath
        ? await invoke<string | null>("choose_save_path", { kind: "project", name: projectName() ?? "Untitled" })
        : projectPath;
    if (!path) return null;
    setStatus("Saving…");
    await writeFile(path, await projectBytes());
    setProject(path);
    return `Saved ${fileName(path)}`;
  }, "Save failed");

const openProject = () =>
  hold(async () => {
    const path = await invoke<string | null>("pick_project");
    if (!path || (edited && !(await invoke<boolean>("confirm_discard")))) return null;
    setStatus("Opening…");
    const loaded = unpackProject(new Uint8Array(await invoke<ArrayBuffer>("read_project", { path })));
    pages.forEach((p) => URL.revokeObjectURL(p.thumb));
    pages.splice(0, pages.length, ...loaded.map((p) => ({ ...p, version: 0, thumb: URL.createObjectURL(p.thumb), thumbBlob: p.thumb })));
    selected.clear();
    anchor = cursor = heldSpan = null;
    nextPair = Math.max(0, ...pages.map((p) => p.spread?.pair ?? 0)) + 1;
    setProject(path);
    return `Opened ${fileName(path)}`;
  }, "Couldn't open the project");

const exportPdf = () =>
  pages.length > 0 &&
  hold(async () => {
    setStatus("Choosing where to export…");
    const path = await invoke<string | null>("choose_save_path", { kind: "pdf", name: projectName() ?? "scan" });
    if (!path) return null;
    setStatus("Building PDF…");
    await writeFile(path, await pdfBytes());
    return `Exported ${pages.length} pages to ${fileName(path)}`;
  }, "Export failed");

const imageExtension = (blob: Blob) => (blob.type === "image/png" ? "png" : "jpg");

/**
 * Gathers everything into a new folder, as InDesign's Package does: the project, its PDF,
 * each original photo or scan (named for the pages it makes), and each finished page.
 */
const packageProject = () =>
  pages.length > 0 &&
  hold(async () => {
    setStatus("Choosing where to package…");
    const folder = await invoke<string | null>("choose_package_path", { name: `${projectName() ?? "Untitled"} Folder` });
    if (!folder) return null;
    const name = fileName(folder).replace(/ Folder$/, "") || "Untitled";
    await invoke("create_package", { path: folder });
    const width = Math.max(3, String(pages.length).length);
    const number = (i: number) => String(i + 1).padStart(width, "0");
    for (const [i, page] of pages.entries()) {
      setStatus(`Packaging page ${i + 1} of ${pages.length}…`);
      await writeFile(`${folder}/Pages/${number(i)}.jpg`, new Uint8Array(await page.output.arrayBuffer()));
    }
    // Halves of a spread share their photo, which is named for the first and last pages it makes.
    const made = new Map<Blob, number[]>();
    pages.forEach((p, i) => made.set(p.original, [...(made.get(p.original) ?? []), i]));
    for (const [original, at] of made) {
      const label = at.length > 1 ? `${number(at[0])}-${number(at[at.length - 1])}` : number(at[0]);
      await writeFile(`${folder}/Originals/${label}.${imageExtension(original)}`, new Uint8Array(await original.arrayBuffer()));
    }
    setStatus("Building PDF…");
    await writeFile(`${folder}/${name}.pdf`, await pdfBytes());
    setStatus("Saving the project…");
    const project = `${folder}/${name}.${EXTENSION}`;
    await writeFile(project, await projectBytes());
    // An untitled project carries on as the packaged one, so its work counts as saved.
    if (!projectPath) setProject(project);
    return `Packaged ${pages.length} pages into ${fileName(folder)}`;
  }, "Package failed");

openButton.addEventListener("click", openProject);
saveButton.addEventListener("click", () => saveProject());
exportButton.addEventListener("click", exportPdf);

// ---- menu ----

const plural = (n: number, one: string, many: string) => (n > 1 ? `${n} ${many}` : one);

let menuState = "";
/** Turns the menu's items on and off, and counts pages in their titles, to match the buttons. */
function syncMenu(spreads: number) {
  const ready = !busy && rendering === 0;
  const s = scope();
  const state = {
    enabled: {
      new: !busy && (pages.length > 0 || projectPath !== null),
      open: ready,
      save: ready && pages.length > 0,
      "save-as": ready && pages.length > 0,
      export: ready && pages.length > 0,
      package: ready && pages.length > 0,
      crop: !cropSelectedButton.disabled,
      split: !splitSelectedButton.disabled,
      "rotate-cw": !rotateRightButton.disabled,
      "rotate-ccw": !rotateLeftButton.disabled,
      "select-even": !!s?.indexes.length,
      "select-odd": !!s?.indexes.length,
      "select-range": pages.length > 0,
      "select-none": selected.size > 0,
    },
    titles: {
      crop: `Crop ${plural(selected.size, "Page", "Pages")}…`,
      split: `Split ${plural(spreads, "Page", "Pages")}…`,
      "rotate-cw": `Rotate ${plural(selected.size, "Page", "Pages")} Clockwise`,
      "rotate-ccw": `Rotate ${plural(selected.size, "Page", "Pages")} Counter-clockwise`,
    },
  };
  const json = JSON.stringify(state);
  if (json === menuState) return;
  menuState = json;
  invoke("set_menu_state", state).catch(() => {});
}

const menuActions: Record<string, () => unknown> = {
  new: newProject,
  open: openProject,
  save: () => saveProject(),
  "save-as": () => saveProject(true),
  export: exportPdf,
  package: packageProject,
  crop: cropSelected,
  split: splitSelected,
  "rotate-cw": () => rotateSelected(1),
  "rotate-ccw": () => rotateSelected(-1),
  // ⌘A in a text field reaches here (the page leaves it alone), so there it selects the text.
  "select-all": () =>
    document.activeElement instanceof HTMLInputElement && document.activeElement.type === "text"
      ? document.activeElement.select()
      : selectIndexes(pages.map((_, i) => i)),
  "select-even": () => selectParity("even"),
  "select-odd": () => selectParity("odd"),
  "select-range": focusRange,
  "select-none": () => selectAll(false),
};

listen<string>("menu", (e) => {
  if (document.querySelector("dialog[open]")) return; // the crop and split editors keep the pages still
  menuActions[e.payload]?.();
});

// ---- keyboard ----

document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return; // dialogs handle their own keys
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && e.code === "KeyS") {
    e.preventDefault();
    saveProject(e.shiftKey);
    return;
  }
  if (cmd && e.code === "KeyO") {
    e.preventDefault();
    openProject();
    return;
  }
  if (cmd && e.code === "KeyE") {
    e.preventDefault();
    exportPdf();
    return;
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
  if (cmd && e.code === "KeyA") {
    e.preventDefault();
    // ⌘A every page, ⌘⇧A the even ones and ⌘⌥A the odd (within the range, if there is one), ⌘⌃A the range itself.
    if (e.metaKey && e.ctrlKey) focusRange();
    else if (e.shiftKey) selectParity("even");
    else if (e.altKey) selectParity("odd");
    else selectIndexes(pages.map((_, i) => i));
    return;
  }
  if (cmd && e.code === "KeyC") {
    e.preventDefault();
    cropSelected();
    return;
  }
  if (cmd && e.code === "Slash") {
    e.preventDefault();
    splitSelected();
    return;
  }
  const arrow = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(), ArrowDown: columns() }[e.key];
  if (arrow && area === "pages" && !(e.target instanceof HTMLSelectElement)) {
    // In the page list: arrows move about, ⇧ selects as it goes, ⌘ moves the selected pages.
    e.preventDefault();
    if (cmd) shiftSelected(arrow);
    else moveCursor(arrow, e.shiftKey);
    return;
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
