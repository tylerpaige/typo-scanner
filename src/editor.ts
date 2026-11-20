import { CropBox, fitFrame } from "./cropbox";
import { FULL } from "./geometry";
import type { Crop, Outline } from "./outline";
import { OutlineBox } from "./outlinebox";
import { render } from "./render";

export interface EditablePage {
  original: Blob;
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
const rectBox = new CropBox(frame);
const outlineBox = new OutlineBox(frame);
dialog.tabIndex = -1;

let pages: EditablePage[] = [];
let urls: string[] = [];
let index = 0;
let onApply: (crop: Crop) => void = () => {};
let previewing = false;
let previewUrl = "";
let previewToken = 0;
let shown: [number, number] = [1, 1];

/**
 * Crops or flattens one or more pages with a single shape. With several pages, ←/→ flips
 * between them under the same shape, to check it suits every one.
 */
export function openEditor(selected: EditablePage[], fallbackOutline: Outline, apply: (crop: Crop) => void) {
  if (selected.length === 0) return;
  pages = selected;
  urls = [];
  onApply = apply;
  const crop = selected[0].crop;
  rectBox.set(crop.kind === "rect" ? crop.rect : FULL);
  outlineBox.set(crop.kind === "outline" ? crop.outline : fallbackOutline);
  previewing = false;
  setMode(crop.kind);
  applyButton.textContent = selected.length > 1 ? `Apply to ${selected.length} pages` : "Apply";
  dialog.showModal();
  // Otherwise the first control takes focus, and it would swallow the shortcut keys.
  dialog.focus();
  show(0);
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
  refresh();
}

function show(i: number) {
  index = (i + pages.length) % pages.length;
  const page = pages[index];
  urls[index] ??= URL.createObjectURL(page.original);
  outlineBox.setSize(page.width, page.height);
  title.textContent =
    pages.length > 1
      ? `Page ${page.number} · ${index + 1} of ${pages.length} selected · ← → to compare`
      : `Page ${page.number}`;
  refresh();
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
    img.src = urls[index];
    fit(page.width, page.height);
    return;
  }
  const result = await render({ source: page.original, crop: current(), maxSide: 1600 });
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
  const crop = current();
  dialog.close();
  if (apply) onApply(crop);
}

dialog.addEventListener("close", () => {
  urls.forEach((u) => u && URL.revokeObjectURL(u));
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
  } else if (e.key === "p" || e.key === "P") {
    togglePreview();
  }
});

modeSelect.addEventListener("change", () => {
  modeSelect.blur();
  setMode(modeSelect.value as Crop["kind"]);
});
lensInput.addEventListener("input", () => {
  outlineBox.set({ ...outlineBox.outline, lens: Number(lensInput.value) });
  if (previewing) refresh();
});
previewButton.addEventListener("click", togglePreview);
$("editor-reset").addEventListener("click", () => {
  if (modeSelect.value === "outline") {
    outlineBox.set({ ...outlineBox.outline, corners: [[0, 0], [1, 0], [1, 1], [0, 1]], bends: outlineBox.outline.bends.map((b) => b.map(() => 0)) });
  } else {
    rectBox.set(FULL);
  }
  if (previewing) refresh();
});
$("editor-cancel").addEventListener("click", () => close(false));
applyButton.addEventListener("click", () => close(true));

new ResizeObserver(() => {
  if (dialog.open) fitFrame(frame, viewport, ...shown);
}).observe(viewport);
