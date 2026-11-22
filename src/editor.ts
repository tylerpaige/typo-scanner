import { CropBox, fitFrame } from "./cropbox";
import { FULL } from "./geometry";
import type { Crop, Outline } from "./outline";
import { OutlineBox } from "./outlinebox";
import { render } from "./render";
import { CENTRE, type Split } from "./split";
import { SplitBox } from "./splitbox";

export interface EditablePage {
  original: Blob;
  /** Quarter turns clockwise applied to the original; the crop, width and height are of the turned photo. */
  turn: number;
  width: number;
  height: number;
  crop: Crop;
  number: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dialog = $<HTMLDialogElement>("editor");
const title = $("editor-title");
const viewport = $("editor-viewport");
const frame = $("editor-frame");
const img = $<HTMLImageElement>("editor-img");
const modeSelect = $<HTMLSelectElement>("editor-mode");
const lensTools = $("editor-lens-tools");
const lensInput = $<HTMLInputElement>("editor-lens");
const previewButton = $<HTMLButtonElement>("editor-preview");
const applyButton = $<HTMLButtonElement>("editor-apply");
const scopeGroup = $("editor-scope");
const scopeAllButton = $<HTMLButtonElement>("editor-scope-all");
const scopePageButton = $<HTMLButtonElement>("editor-scope-page");
const rectBox = new CropBox(frame);
const outlineBox = new OutlineBox(frame);
const splitBox = new SplitBox(frame);
rectBox.onChange = outlineBox.onChange = splitBox.onChange = () => commit();
dialog.tabIndex = -1;

/** A crop, or (when splitting) where the gutter runs. */
type Shape = Crop | Split;

let tool: "crop" | "split" = "crop";
let pages: EditablePage[] = [];
let urls: Promise<string>[] = [];
let index = 0;
let onApply: (crops: Crop[]) => void = () => {};
let onSplit: (splits: Split[]) => void = () => {};
/** Each page's shape when the editor opened. */
let initial: Shape[] = [];
/** The shape for every page not adjusted on its own; null until it's first changed. */
let shared: Shape | null = null;
/** Pages adjusted on their own, which no longer follow the shared shape. */
let own = new Map<number, Shape>();
/** Whether changes to a page that still follows the shared shape go to it alone. */
let thisPageOnly = false;
let previewing = false;
let previewUrl = "";
let previewToken = 0;
let shown: [number, number] = [1, 1];

/**
 * Crops or flattens one or more pages. With several pages, ←/→ flips between them: a change
 * made under "All pages" goes to every page not adjusted on its own; under "This page", only
 * to the page showing, which then keeps its own crop. Until the shared crop is first changed,
 * each page shows (and keeps) the crop it had.
 */
export function openEditor(selected: EditablePage[], fallbackOutline: Outline, apply: (crops: Crop[]) => void) {
  if (selected.length === 0) return;
  onApply = apply;
  setTool("crop");
  const outlined = selected.find((p) => p.crop.kind === "outline")?.crop;
  outlineBox.set(outlined?.kind === "outline" ? outlined.outline : fallbackOutline);
  begin(selected, selected.map((p) => p.crop));
  applyButton.textContent = selected.length > 1 ? `Apply to ${selected.length} pages` : "Apply";
}

/**
 * Places the gutter of one or more spreads. Each page's own crop shows, and the gutter runs
 * through it, so the same split fits each however it was cropped. Pages can be given their
 * own split the same way as their own crop.
 */
export function openSplitter(selected: EditablePage[], split: Split, apply: (splits: Split[]) => void) {
  if (selected.length === 0) return;
  onSplit = apply;
  setTool("split");
  begin(selected, selected.map(() => split));
  applyButton.textContent = selected.length > 1 ? `Split ${selected.length} pages` : "Split";
}

function begin(selected: EditablePage[], shapes: Shape[]) {
  pages = selected;
  urls = [];
  initial = shapes;
  shared = null;
  own = new Map();
  thisPageOnly = false;
  previewing = false;
  scopeGroup.hidden = selected.length < 2;
  dialog.showModal();
  // Otherwise the first control takes focus, and it would swallow the shortcut keys.
  dialog.focus();
  show(0);
}

const shapeOf = (i: number): Shape => own.get(i) ?? shared ?? initial[i];
/** Whether changes now go to the page showing alone. */
const pageScope = () => pages.length > 1 && (own.has(index) || thisPageOnly);

/** Records a change to the page showing, for it alone or for all pages following the shared shape. */
function commit() {
  const shape = tool === "split" ? splitBox.split : current();
  if (pageScope()) own.set(index, shape);
  else shared = shape;
  renderScope();
}

function renderScope() {
  const page = pages[index];
  scopeAllButton.classList.toggle("on", !pageScope());
  scopePageButton.classList.toggle("on", pageScope());
  title.textContent =
    pages.length > 1
      ? `Page ${page.number} · ${index + 1} of ${pages.length} selected${own.has(index) ? " · adjusted on its own" : ""} · ← → to compare`
      : `Page ${page.number}`;
}

function setTool(next: typeof tool) {
  tool = next;
  const splitting = next === "split";
  frame.classList.toggle("splitting", splitting);
  splitBox.el.hidden = !splitting;
  modeSelect.hidden = previewButton.hidden = splitting;
  if (splitting) lensTools.hidden = true;
}

function current(): Crop {
  return modeSelect.value === "outline"
    ? { kind: "outline", outline: outlineBox.outline }
    : { kind: "rect", rect: rectBox.rect };
}

function setMode(mode: Crop["kind"]) {
  modeSelect.value = mode;
  rectBox.el.hidden = mode !== "rect";
  outlineBox.el.hidden = mode !== "outline";
  lensTools.hidden = mode !== "outline";
  lensInput.value = String(outlineBox.outline.lens);
}

function show(i: number) {
  index = (i + pages.length) % pages.length;
  const page = pages[index];
  outlineBox.setSize(page.width, page.height);
  if (tool === "split") {
    // Each page's own crop, to split within; it can't be changed here.
    rectBox.el.hidden = page.crop.kind !== "rect";
    outlineBox.el.hidden = page.crop.kind !== "outline";
    if (page.crop.kind === "rect") rectBox.set(page.crop.rect);
    else outlineBox.set(page.crop.outline);
    splitBox.setSize(page.width, page.height);
    splitBox.setCrop(page.crop);
    splitBox.set(shapeOf(index) as Split);
  } else {
    const crop = shapeOf(index) as Crop;
    if (crop.kind === "rect") rectBox.set(crop.rect);
    else outlineBox.set(crop.outline);
    setMode(crop.kind);
  }
  renderScope();
  refresh();
}

/** The photo to draw the crop over, turned the way the page is. */
async function photoUrl(page: EditablePage): Promise<string> {
  if (page.turn === 0) return URL.createObjectURL(page.original);
  const turned = await render({ source: page.original, crop: { kind: "rect", rect: FULL }, turn: page.turn, maxSide: 2400 });
  return URL.createObjectURL(turned.output!);
}

function fit(width: number, height: number) {
  shown = [width, height];
  fitFrame(frame, viewport, width, height);
}

/** Shows the current page: the photo with its overlay, or the rendered result. */
async function refresh() {
  const page = pages[index];
  if (!page || !dialog.open) return;
  previewButton.classList.toggle("on", previewing);
  const token = ++previewToken;
  if (!previewing) {
    frame.classList.remove("previewing");
    fit(page.width, page.height);
    const url = await (urls[index] ??= photoUrl(page));
    if (token === previewToken) img.src = url;
    return;
  }
  const result = await render({ source: page.original, crop: current(), turn: page.turn, maxSide: 1600 });
  if (token !== previewToken || !previewing || !result.output) return;
  URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(result.output);
  img.src = previewUrl;
  frame.classList.add("previewing");
  fit(result.width, result.height);
}

function togglePreview() {
  previewing = !previewing;
  refresh();
}

function close(apply: boolean) {
  const shapes = pages.map((_, i) => shapeOf(i));
  dialog.close();
  if (apply && tool === "split") onSplit(shapes as Split[]);
  else if (apply) onApply(shapes as Crop[]);
}

dialog.addEventListener("close", () => {
  urls.forEach((u) => u?.then(URL.revokeObjectURL));
  urls = [];
  URL.revokeObjectURL(previewUrl);
  previewUrl = "";
  previewing = false;
  previewToken++;
  frame.classList.remove("previewing");
  img.removeAttribute("src");
});

dialog.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    show(index + (e.key === "ArrowLeft" ? -1 : 1));
  } else if (e.key === "Enter") {
    e.preventDefault();
    close(true);
  } else if (pages.length > 1 && (e.key === "a" || e.key === "A")) {
    scopeAllButton.click();
  } else if (pages.length > 1 && (e.key === "t" || e.key === "T")) {
    scopePageButton.click();
  } else if (tool === "crop" && (e.key === "p" || e.key === "P")) {
    togglePreview();
  }
});

modeSelect.addEventListener("change", () => {
  modeSelect.blur();
  setMode(modeSelect.value as Crop["kind"]);
  commit();
  refresh();
});
lensInput.addEventListener("input", () => {
  outlineBox.set({ ...outlineBox.outline, lens: Number(lensInput.value) });
  commit();
  if (previewing) refresh();
});
// "All pages" on a page adjusted on its own puts it back to following the shared shape.
scopeAllButton.addEventListener("click", () => {
  thisPageOnly = false;
  if (own.delete(index)) show(index);
  else renderScope();
});
scopePageButton.addEventListener("click", () => {
  thisPageOnly = true;
  renderScope();
});
previewButton.addEventListener("click", togglePreview);
$("editor-reset").addEventListener("click", () => {
  if (tool === "split") {
    splitBox.set(CENTRE);
  } else if (modeSelect.value === "outline") {
    outlineBox.set({ ...outlineBox.outline, corners: [[0, 0], [1, 0], [1, 1], [0, 1]], bends: outlineBox.outline.bends.map((b) => b.map(() => 0)) });
  } else {
    rectBox.set(FULL);
  }
  commit();
  if (previewing) refresh();
});
$("editor-cancel").addEventListener("click", () => close(false));
applyButton.addEventListener("click", () => close(true));

new ResizeObserver(() => {
  if (dialog.open) fitFrame(frame, viewport, ...shown);
}).observe(viewport);
