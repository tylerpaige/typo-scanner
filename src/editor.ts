import { CropBox, fitFrame } from "./cropbox";
import { FULL } from "./geometry";
import { outlineFromRect, type Crop, type Outline } from "./outline";
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
  /** The page's thumbnail, for the sidebar. */
  thumb: string;
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
const sidebar = $("editor-sidebar");
const groupList = $("editor-groups");
const newGroupButton = $<HTMLButtonElement>("editor-new-group");
const removeButton = $<HTMLButtonElement>("editor-remove");
const pickedLabel = $("editor-picked");
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
/** Given each page's new shape, or null for pages taken out of the edit. */
let onApply: (crops: (Crop | null)[]) => void = () => {};
let onSplit: (splits: (Split | null)[]) => void = () => {};
/** Each page's shape when the editor opened. */
let initial: Shape[] = [];

/** Pages that share a shape. Groups sit side by side; they never nest. */
interface Group {
  /** The shape for every page in the group; null until it's first changed. */
  shared: Shape | null;
}
let groups: Group[] = [];
/** Each page's group; null once it's taken out of the edit. */
let groupOf: (Group | null)[] = [];
/** Pages chosen in the sidebar, to regroup or take out. */
let picked = new Set<number>();
let pickAnchor = 0;
/** The pages being dragged between groups. */
let dragging: number[] = [];
let previewing = false;
let previewUrl = "";
let previewToken = 0;
let shown: [number, number] = [1, 1];

/**
 * Crops or flattens one or more pages. With several pages, ←/→ flips between them, and a
 * change goes to every page in the group of the one showing; a page that needs its own crop
 * can go in a group by itself. Until a group's crop is first changed, each of its pages shows
 * (and keeps) the crop it had.
 */
export function openEditor(selected: EditablePage[], fallbackOutline: Outline, apply: (crops: (Crop | null)[]) => void) {
  if (selected.length === 0) return;
  onApply = apply;
  setTool("crop");
  const outlined = selected.find((p) => p.crop.kind === "outline")?.crop;
  outlineBox.set(outlined?.kind === "outline" ? outlined.outline : fallbackOutline);
  begin(selected, selected.map((p) => p.crop));
}

/**
 * Places the gutter of one or more spreads. Each page's own crop shows, and the gutter runs
 * through it, so the same split fits each however it was cropped. Groups of pages can be
 * given their own split the same way as their own crop.
 */
export function openSplitter(selected: EditablePage[], split: Split, apply: (splits: (Split | null)[]) => void) {
  if (selected.length === 0) return;
  onSplit = apply;
  setTool("split");
  begin(selected, selected.map(() => split));
}

function begin(selected: EditablePage[], shapes: Shape[]) {
  pages = selected;
  urls = [];
  initial = shapes;
  const group: Group = { shared: null };
  groups = [group];
  groupOf = selected.map(() => group);
  picked = new Set([0]);
  pickAnchor = 0;
  previewing = false;
  sidebar.hidden = selected.length < 2;
  dialog.showModal();
  // Otherwise the first control takes focus, and it would swallow the shortcut keys.
  dialog.focus();
  show(0);
}

const shapeOf = (i: number): Shape => groupOf[i]?.shared ?? initial[i];
/** The pages still in the edit, in sidebar order: group by group. */
const order = () => groups.flatMap((g) => pages.flatMap((_, i) => (groupOf[i] === g ? [i] : [])));

/** Records a change to the page showing, for its whole group. */
function commit() {
  const shape = tool === "split" ? splitBox.split : current();
  if (groupOf[index]) groupOf[index]!.shared = shape;
  renderScope();
}

function renderScope() {
  const page = pages[index];
  const left = order().length;
  const group = groupOf[index];
  title.textContent = !group
    ? "No pages left in this edit"
    : pages.length > 1
      ? `Page ${page.number}${groups.length > 1 ? ` · group ${groups.indexOf(group) + 1}` : ""} · ← → to compare`
      : `Page ${page.number}`;
  const verb = tool === "split" ? "Split" : "Apply to";
  applyButton.textContent = pages.length === 1 ? (tool === "split" ? "Split" : "Apply") : `${verb} ${left} page${left === 1 ? "" : "s"}`;
  applyButton.disabled = left === 0;
  renderSidebar();
}

// ---- the sidebar: pages in groups ----

function renderSidebar() {
  if (sidebar.hidden) return;
  const sections = groups.map((group, k) => {
    const section = document.createElement("section");
    section.className = "group";
    section.classList.toggle("current", groupOf[index] === group);
    const members = pages.flatMap((_, i) => (groupOf[i] === group ? [i] : []));
    const head = document.createElement("header");
    head.textContent = `Group ${k + 1} · ${members.length} page${members.length === 1 ? "" : "s"}`;
    const list = document.createElement("ol");
    list.append(...members.map(thumbnail));
    section.append(head, list);
    dropTarget(section, (ids) => moveTo(ids, group));
    return section;
  });
  const fresh = document.createElement("div");
  fresh.className = "new-group-drop";
  fresh.textContent = "Drag pages here to start a new group";
  dropTarget(fresh, newGroup);
  groupList.replaceChildren(...sections, fresh);
  const chosen = chosenPages();
  newGroupButton.disabled = removeButton.disabled = chosen.length === 0;
  pickedLabel.textContent = picked.size > 1 ? `${picked.size} picked` : "";
}

function thumbnail(i: number) {
  const li = document.createElement("li");
  li.classList.toggle("current", i === index);
  li.classList.toggle("picked", picked.has(i));
  li.draggable = true;
  li.title = "Click to show · ⌘- or ⇧-click to pick several · drag to another group";
  const im = document.createElement("img");
  im.src = pages[i].thumb;
  im.draggable = false;
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = String(pages[i].number);
  li.append(im, num);
  li.addEventListener("click", (e) => pick(i, e));
  li.addEventListener("dragstart", (e) => {
    // Dragging a picked page takes all the picked pages along.
    dragging = picked.has(i) ? [...picked] : [i];
    e.dataTransfer?.setData("text/plain", dragging.map((d) => pages[d].number).join(","));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragend", () => (dragging = []));
  return li;
}

function dropTarget(el: HTMLElement, onDrop: (ids: number[]) => void) {
  el.addEventListener("dragover", (e) => {
    if (!dragging.length) return;
    e.preventDefault();
    el.classList.add("drop");
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget as Node)) el.classList.remove("drop");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drop");
    const ids = dragging;
    dragging = [];
    if (ids.length) onDrop(ids);
  });
}

function pick(i: number, e: MouseEvent) {
  if (e.shiftKey) {
    const seq = order();
    const [a, b] = [seq.indexOf(pickAnchor), seq.indexOf(i)].sort((m, n) => m - n);
    if (!e.metaKey) picked.clear();
    if (a >= 0) seq.slice(a, b + 1).forEach((j) => picked.add(j));
    else picked.add(i);
  } else if (e.metaKey) {
    if (!picked.delete(i)) picked.add(i);
    pickAnchor = i;
  } else {
    picked = new Set([i]);
    pickAnchor = i;
  }
  show(i);
}

/** The pages the sidebar buttons act on: those picked, else the one showing. */
const chosenPages = () => {
  const inEdit = [...picked].filter((i) => groupOf[i]);
  return inEdit.length ? order().filter((i) => inEdit.includes(i)) : groupOf[index] ? [index] : [];
};

/** Moves pages into `group`, where they take its shape. */
function moveTo(ids: number[], group: Group) {
  ids.forEach((i) => (groupOf[i] = group));
  settle(ids);
}

/** Starts a new group with these pages, beginning with the shape they show now. */
function newGroup(ids: number[]) {
  const from = groupOf[ids[0]];
  const group: Group = { shared: from?.shared ?? null };
  groups.push(group);
  moveTo(ids, group);
}

/** Takes pages out of this edit; they keep their crops (and aren't split). */
function removePages(ids: number[]) {
  ids.forEach((i) => (groupOf[i] = null));
  settle([]);
}

/** Drops emptied groups, and shows a page still in the edit. */
function settle(moved: number[]) {
  groups = groups.filter((g) => groupOf.includes(g));
  const seq = order();
  picked = new Set(moved.filter((i) => groupOf[i]));
  if (!groupOf[index]) {
    // The page showing went: show the next one along that's still here.
    const next = seq.find((i) => i > index) ?? seq[seq.length - 1];
    if (next === undefined) {
      renderScope();
      img.removeAttribute("src");
      return;
    }
    index = next;
  }
  if (!picked.size) picked.add(index);
  pickAnchor = index;
  show(index);
}

newGroupButton.addEventListener("click", () => newGroup(chosenPages()));
removeButton.addEventListener("click", () => removePages(chosenPages()));

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

/** Moves through the pages in sidebar order; `extend` picks every page from the anchor to there. */
function step(by: number, extend = false) {
  const seq = order();
  if (!seq.length) return;
  const at = seq.indexOf(index);
  // Extending stops at the ends rather than wrapping round.
  const next = seq[extend ? Math.min(seq.length - 1, Math.max(0, at + by)) : (at + by + seq.length) % seq.length];
  if (extend) {
    const [a, b] = [seq.indexOf(pickAnchor), seq.indexOf(next)].sort((m, n) => m - n);
    picked = new Set(a >= 0 ? seq.slice(a, b + 1) : [next]);
  } else {
    picked = new Set([next]);
    pickAnchor = next;
  }
  show(next);
}

function show(i: number) {
  index = i;
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
  const shapes = pages.map((_, i) => (groupOf[i] ? shapeOf(i) : null));
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

// Clicked buttons lose focus (so Space can't click them again), which would take it out of
// the dialog and leave its keys dead; bring it back.
dialog.addEventListener("click", (e) => {
  if (e.target instanceof HTMLButtonElement) dialog.focus();
});

dialog.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    step(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey);
  } else if ((e.key === "Backspace" || e.key === "Delete") && pages.length > 1) {
    e.preventDefault();
    removeButton.click();
  } else if (e.key === "Enter") {
    if (applyButton.disabled) return;
    e.preventDefault();
    close(true);
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
previewButton.addEventListener("click", togglePreview);
$("editor-reset").addEventListener("click", () => {
  if (tool === "split") {
    splitBox.set(CENTRE);
  } else if (modeSelect.value === "outline") {
    outlineBox.set(outlineFromRect(FULL, outlineBox.outline.lens));
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
