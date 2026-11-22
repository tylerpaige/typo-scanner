import { CropBox, HANDLES, fitFrame } from "./cropbox";
import { FULL } from "./geometry";
import { menuPart, refreshMenu } from "./menu";
import { outlineFromRect, type Crop, type Outline } from "./outline";
import { OutlineBox, type Anchor } from "./outlinebox";
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
const toolbar = dialog.querySelector("header")!;
const resetButton = $<HTMLButtonElement>("editor-reset");
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
// The three parts the keyboard works in (⌘E, ⌘L, ⌘B), each focusable as a whole.
dialog.tabIndex = viewport.tabIndex = sidebar.tabIndex = toolbar.tabIndex = -1;

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
  rectBox.setActive(null);
  outlineBox.setActive(null);
  splitBox.setActive(null);
  disarm();
  dialog.showModal();
  // Start in the editor itself; otherwise the first control takes focus and swallows the keys.
  viewport.focus();
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
  refreshMenu();
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
  disarm();
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

/** Moves the chosen pages to the group before or after theirs; past the first or last, into a new one there. */
function shiftGroup(by: -1 | 1) {
  const ids = chosenPages();
  const from = groupOf[index];
  if (!ids.length || !from) return;
  const target = groups[groups.indexOf(from) + by];
  if (target) return moveTo(ids, target);
  // Already a group of their own at the end: nowhere further to go.
  if (pages.every((_, i) => (groupOf[i] === from) === ids.includes(i))) return;
  const group: Group = { shared: from.shared };
  if (by < 0) groups.unshift(group);
  else groups.push(group);
  moveTo(ids, group);
}

// ---- buttons that ask first ----

let armed: { button: HTMLButtonElement; text: string; timer: number } | null = null;

/** The first press turns the button into a red "…?" for three seconds; a second press within them does it. */
function confirmFirst(button: HTMLButtonElement, question: string, action: () => void) {
  if (armed?.button === button) {
    disarm();
    action();
    return;
  }
  disarm();
  armed = { button, text: button.textContent ?? "", timer: window.setTimeout(disarm, 3000) };
  button.textContent = question;
  button.classList.add("confirm");
}

function disarm() {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed.button.textContent = armed.text;
  armed.button.classList.remove("confirm");
  armed = null;
}

const removeChosen = () => {
  const ids = chosenPages();
  if (ids.length) confirmFirst(removeButton, `Remove ${ids.length === 1 ? "page" : `${ids.length} pages`}?`, () => removePages(chosenPages()));
};

newGroupButton.addEventListener("click", () => newGroup(chosenPages()));
removeButton.addEventListener("click", removeChosen);

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
  disarm();
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
  disarm();
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
// the dialog and leave its keys dead; bring it back to the part the button is in.
dialog.addEventListener("click", (e) => {
  const button = e.target instanceof HTMLElement && e.target.closest("button");
  if (button) (sidebar.contains(button) ? sidebar : toolbar.contains(button) ? toolbar : dialog).focus();
});

// ---- keyboard ----

const focusIn = (el: HTMLElement) => el.contains(document.activeElement);

/** The first control in the toolbar that can take focus. */
function focusToolbar() {
  const controls = toolbar.querySelectorAll<HTMLElement>("select, input, button");
  const first = [...controls].find((c) => !(c as HTMLButtonElement).disabled && c.offsetParent !== null);
  (first ?? toolbar).focus();
}

function confirmReset() {
  confirmFirst(resetButton, "Reset?", reset);
}

/** Keys that work wherever the focus is in the dialog. Returns whether it used the key. */
function commandKey(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.code === "KeyE") viewport.focus();
  else if (e.code === "KeyL") focusToolbar();
  else if (e.code === "KeyB" && !sidebar.hidden) sidebar.focus();
  else if (e.key === "Enter") applyButton.disabled || close(true);
  else if (e.code === "KeyR" && e.shiftKey) confirmReset();
  else if (e.code === "KeyP") tool === "crop" && togglePreview();
  else if (e.code === "KeyG" && !sidebar.hidden) newGroup(chosenPages());
  else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !sidebar.hidden) shiftGroup(e.key === "ArrowUp" ? -1 : 1);
  // Moves between pages from anywhere, even a slider or menu, or with a corner or part to move.
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") step(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey);
  else return e.code === "KeyR"; // ⌘R alone would reload the page
  return true;
}

/** Arrow keys as a step across or down the image: one screen pixel, or ten with ⇧. */
function arrowStep(e: KeyboardEvent): [number, number] | null {
  const n = e.shiftKey ? 10 : 1;
  const [dx, dy] = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] }[e.key] ?? [];
  return dx === undefined ? null : [dx / frame.clientWidth, dy / frame.clientHeight];
}

/** Keys for the crop or split itself, with the focus on the image. Returns whether it used the key. */
function stageKey(e: KeyboardEvent): boolean {
  const key = e.key.toLowerCase();
  const by = arrowStep(e);
  if (e.key === "Enter") {
    letGo();
    return true;
  }
  if (tool === "split") {
    const part = ({ t: "top", b: "bottom", l: "line" } as const)[key as "t" | "b" | "l"];
    if (part && !e.shiftKey) splitBox.setActive(part);
    else if (by && by[0] && splitBox.active) {
      splitBox.nudge(by[0] / (rectWidth() || 1));
      commit();
    } else return false;
    return true;
  }
  if (previewing) return false;
  const outline = modeSelect.value === "outline";
  if (key === "r" || key === "o") {
    switchMode(key === "r" ? "rect" : "outline");
    return true;
  }
  const corner = "qwsa".indexOf(key); // clockwise from the top-left, as they sit on the keyboard
  if (corner >= 0 && !e.shiftKey) {
    pickCorner(corner);
    return true;
  }
  if ((key === "z" || key === "x") && !e.shiftKey) {
    nextPoint(key === "x" ? 1 : -1); // x goes clockwise, z back
    return true;
  }
  const box = outline ? outlineBox : rectBox;
  if (by && box.active) {
    box.nudge(...by);
    commit();
    return true;
  }
  return false;
}

/** Lets go of the corner or part, so the arrow keys move between pages again. */
function letGo() {
  splitBox.setActive(null);
  rectBox.setActive(null);
  outlineBox.setActive(null);
}

function switchMode(mode: Crop["kind"]) {
  setMode(mode);
  commit();
  refresh();
}

/** Picks a corner to move, numbered clockwise from the top-left. */
function pickCorner(corner: number) {
  if (modeSelect.value === "outline") outlineBox.setActive({ corner });
  else rectBox.setActive(["nw", "ne", "se", "sw"][corner]);
}

/** Picks the next point to move, clockwise (or back, with -1). */
function nextPoint(by: 1 | -1) {
  if (modeSelect.value === "outline") {
    const ring = outlineBox.anchors();
    const at = ring.findIndex((a) => sameAnchor(a, outlineBox.active));
    outlineBox.setActive(ring[at < 0 ? 0 : (at + by + ring.length) % ring.length]);
  } else {
    const at = HANDLES.indexOf(rectBox.active ?? "");
    rectBox.setActive(HANDLES[at < 0 ? 0 : (at + by + HANDLES.length) % HANDLES.length]);
  }
}

const sameAnchor = (a: Anchor, b: Anchor | null) =>
  !!b && ("corner" in a ? "corner" in b && a.corner === b.corner : "edge" in b && a.edge === b.edge && a.index === b.index);

/** How much of the image's width the page being split spans, so a nudge moves the line about a pixel. */
function rectWidth() {
  const crop = pages[index]?.crop;
  return crop?.kind === "rect" ? crop.rect.w : 1;
}

dialog.addEventListener("keydown", (e) => {
  if (commandKey(e)) {
    e.preventDefault();
    return;
  }
  const t = e.target;
  // Controls keep their own keys.
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return;
  if (t instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;
  if (focusIn(viewport) && !e.metaKey && !e.ctrlKey && !e.altKey && stageKey(e)) {
    e.preventDefault();
    return;
  }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    step(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey);
  } else if ((e.key === "Backspace" || e.key === "Delete") && !sidebar.hidden) {
    e.preventDefault();
    removeChosen();
  } else if (e.key === "Escape") {
    // Handled here, not left to the dialog, so the menu's Cancel doesn't act on it as well.
    e.preventDefault();
    escape();
  }
});

/** Esc cancels the edit, but first takes back a question being asked. */
function escape() {
  if (armed) disarm();
  else close(false);
}

menuPart(() => {
  const open = dialog.open;
  const crop = open && tool === "crop";
  const shaping = crop && !previewing;
  const split = open && tool === "split";
  const several = open && order().length > 1;
  const grouping = open && !sidebar.hidden;
  const active = open && !!(rectBox.active || outlineBox.active || splitBox.active);
  return {
    enabled: {
      "editor-apply": open && !applyButton.disabled,
      "editor-cancel": open,
      "editor-reset": open,
      "editor-preview": crop,
      "editor-previous": several,
      "editor-next": several,
      "editor-pick-previous": several,
      "editor-pick-next": several,
      "editor-new-group": grouping,
      "editor-group-up": grouping,
      "editor-group-down": grouping,
      "editor-remove": grouping && chosenPages().length > 0,
      "editor-rect": shaping,
      "editor-outline": shaping,
      "editor-top-left": shaping,
      "editor-top-right": shaping,
      "editor-bottom-right": shaping,
      "editor-bottom-left": shaping,
      "editor-next-point": shaping,
      "editor-previous-point": shaping,
      "editor-split-top": split,
      "editor-split-bottom": split,
      "editor-split-line": split,
      "editor-let-go": active,
      "editor-focus-image": open,
      "editor-focus-toolbar": open,
      "editor-focus-sidebar": grouping,
    },
    titles: {
      "editor-apply": applyButton.textContent ?? "Apply",
      "editor-preview": previewing ? "Stop Previewing" : "Preview",
    },
  };
});

const menuActions: Record<string, () => unknown> = {
  "editor-apply": () => applyButton.disabled || close(true),
  "editor-cancel": escape,
  "editor-reset": confirmReset,
  "editor-preview": togglePreview,
  "editor-previous": () => step(-1),
  "editor-next": () => step(1),
  "editor-pick-previous": () => step(-1, true),
  "editor-pick-next": () => step(1, true),
  "editor-new-group": () => newGroup(chosenPages()),
  "editor-group-up": () => shiftGroup(-1),
  "editor-group-down": () => shiftGroup(1),
  "editor-remove": removeChosen,
  "editor-rect": () => switchMode("rect"),
  "editor-outline": () => switchMode("outline"),
  "editor-top-left": () => pickCorner(0),
  "editor-top-right": () => pickCorner(1),
  "editor-bottom-right": () => pickCorner(2),
  "editor-bottom-left": () => pickCorner(3),
  "editor-next-point": () => nextPoint(1),
  "editor-previous-point": () => nextPoint(-1),
  "editor-split-top": () => splitBox.setActive("top"),
  "editor-split-bottom": () => splitBox.setActive("bottom"),
  "editor-split-line": () => splitBox.setActive("line"),
  "editor-let-go": letGo,
  "editor-focus-image": () => viewport.focus(),
  "editor-focus-toolbar": focusToolbar,
  "editor-focus-sidebar": () => sidebar.hidden || sidebar.focus(),
};

/** Does what the menu item `id` says, if it's the editor's and the editor is open. Returns whether it did. */
export function editorAction(id: string): boolean {
  const action = dialog.open && menuActions[id];
  if (!action) return false;
  action();
  return true;
}

// Esc in a menu or slider still reaches the dialog; it too first takes back a question being asked.
dialog.addEventListener("cancel", (e) => {
  if (!armed) return;
  e.preventDefault();
  disarm();
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
function reset() {
  if (tool === "split") {
    splitBox.set(CENTRE);
  } else if (modeSelect.value === "outline") {
    outlineBox.set(outlineFromRect(FULL, outlineBox.outline.lens));
  } else {
    rectBox.set(FULL);
  }
  commit();
  if (previewing) refresh();
}
resetButton.addEventListener("click", confirmReset);
$("editor-cancel").addEventListener("click", () => close(false));
applyButton.addEventListener("click", () => close(true));

new ResizeObserver(() => {
  if (dialog.open) fitFrame(frame, viewport, ...shown);
}).observe(viewport);
