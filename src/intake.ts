import { invoke } from "@tauri-apps/api/core";
import { fitFrame } from "./cropbox";
import { menuPart, refreshMenu } from "./menu";
import { IDENTITY, apply, bounds, compose, inverse, rotateAbout, type Pt, type Transform } from "./stitch";
import { stitcher } from "./stitcher";

/**
 * Scanner intake: watches the folder a scanner saves into, gathers each run of scans
 * into a page, lines them up and joins them. A page goes into the page list by itself
 * when every scan matched well; otherwise it waits here to be checked and adjusted.
 */

interface ScanFile {
  path: string;
  size: number;
  modified: number;
}

interface Tile {
  id: number;
  name: string;
  /** The file as read: a page of one scan is just this. */
  blob: Blob;
  /** Brought in on purpose (choosing a folder, or Import), rather than arriving while watching. */
  bulk: boolean;
  width: number;
  height: number;
  preview: ImageBitmap;
  /** Places this scan on the page, relative to the page's first scan. */
  t: Transform;
  /** How well it matched; `null` for the first scan, or once it's been placed by hand. */
  score: number | null;
  overlap: number;
  moved: boolean;
}

export interface IntakeHost {
  /** `turn` is quarter turns clockwise, in degrees, for the page to be shown at. Resolves to the pages made. */
  addPage(image: Blob, width: number, height: number, turn: number): Promise<object[]>;
  /** Takes out pages `addPage` made; ones already gone are skipped. */
  removePages(pages: object[]): void;
}

const GOOD_SCORE = 0.6;
const MIN_OVERLAP = 0.03;
const PREVIEW_SIDE = 1400;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $("intake-view");
const folderButton = $<HTMLButtonElement>("intake-folder");
const pathLabel = $("intake-path");
const importButton = $<HTMLButtonElement>("intake-import");
const redoButton = $<HTMLButtonElement>("intake-redo");
const perPageSelect = $<HTMLSelectElement>("intake-per-page");
const autoInput = $<HTMLInputElement>("intake-auto");
const rotateButton = $<HTMLButtonElement>("intake-rotate");
const viewport = $("intake-viewport");
const frame = $("intake-frame");
const canvas = $<HTMLCanvasElement>("intake-canvas");
const message = $("intake-message");
const tray = $<HTMLOListElement>("intake-tiles");
const status = $("intake-status");
const diffButton = $<HTMLButtonElement>("intake-diff");
const snapButton = $<HTMLButtonElement>("intake-snap");
const discardButton = $<HTMLButtonElement>("intake-discard");
const addButton = $<HTMLButtonElement>("intake-add");

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

let host: IntakeHost;
let active = false;
let folder = load("scan-folder");
let perPage = Number(load("scan-per-page")) || 1;
let auto = load("scan-auto") !== "false";
let turn = Number(load("scan-rotation")) || 0;

/** Every file seen in the folder, with its size at the last look; -1 once taken in or ignored. */
const seen = new Map<string, number>();
let primed = false;
let existing: ScanFile[] = [];
const queue: { file: ScanFile; bulk: boolean }[] = [];
/** The files of the last import, and the pages made from them, so it can be done over with other settings. */
let imported: ScanFile[] = [];
let importedPages: object[] = [];
let reading = false;
const waiting: Tile[] = [];
let group: Tile[] = [];
let selected = -1;
let diff = false;
let note = "";
/** While dragging, the view stays put so the scan moves under the pointer. */
let frozen: ReturnType<typeof bounds> | null = null;

// Every change to the scans goes through here, one at a time.
let chain = Promise.resolve();
function serial(job: () => Promise<void>) {
  chain = chain.then(job).catch((e) => setNote(`Something went wrong: ${e}`)).finally(draw);
  return chain;
}

const fileName = (path: string) => path.split("/").pop() ?? path;
const goodEnough = (t: Tile) => t.score === null || (t.score >= GOOD_SCORE && t.overlap >= MIN_OVERLAP);
const outputTurn = (): Transform => ({ theta: (turn * Math.PI) / 180, tx: 0, ty: 0 });

function setNote(text: string) {
  note = text;
  draw();
}

// ---- watching the folder ----

async function poll() {
  if (!active || !folder) return;
  let files: ScanFile[];
  try {
    files = await invoke<ScanFile[]>("list_scans", { dir: folder });
  } catch (e) {
    setNote(`Can't read the folder: ${e}`);
    return;
  }
  if (!primed) {
    // Scans already there when we start watching are left alone unless imported.
    existing = [...files].sort(byName);
    files.forEach((f) => seen.set(f.path, -1));
    primed = true;
    if (importOnPrime) importExisting();
    importOnPrime = false;
    draw();
    return;
  }
  const fresh: ScanFile[] = [];
  for (const f of files) {
    const last = seen.get(f.path);
    if (last === -1) continue;
    // Take a file once its size has held steady for a second, so the scanner has finished writing it.
    if (last === f.size && f.size > 0) {
      seen.set(f.path, -1);
      fresh.push(f);
    } else {
      seen.set(f.path, f.size);
    }
  }
  if (fresh.length) {
    queue.push(...fresh.sort(byTime).map((file) => ({ file, bulk: false })));
    serial(intake);
  }
}
setInterval(poll, 1000);

const byName = (a: ScanFile, b: ScanFile) => a.path.localeCompare(b.path, undefined, { numeric: true });
const byTime = (a: ScanFile, b: ScanFile) => a.modified - b.modified || byName(a, b);

/** Whether the next look at the folder should take in what's already there. */
let importOnPrime = false;

function watch(path: string, importWhatsThere: boolean) {
  folder = path;
  store("scan-folder", path);
  seen.clear();
  existing = [];
  imported = [];
  importedPages = [];
  primed = false;
  importOnPrime = importWhatsThere;
  poll();
}

// With one scan per page, a folder of photos is already a set of pages, so choosing it takes them all in.
// (Only on choosing: reopening the app shouldn't take them in again.)
folderButton.addEventListener("click", async () => {
  const path = await invoke<string | null>("pick_folder");
  if (path) watch(path, perPage === 1);
});

function importExisting() {
  imported = existing;
  importedPages = [];
  queue.push(...existing.map((file) => ({ file, bulk: true })));
  existing = [];
  serial(intake);
}
importButton.addEventListener("click", importExisting);

/** Takes back the pages the last import made and its scans still here, then imports the same files again. */
function redoImport() {
  // Stop the import under way after the file it's on; whatever it made is taken back below.
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].bulk) queue.splice(i, 1);
  serial(async () => {
    const drop = (tiles: Tile[]) => {
      const gone = tiles.filter((t) => t.bulk);
      stitcher.drop(gone.map((t) => t.id));
      gone.forEach((t) => t.preview.close());
      return tiles.filter((t) => !t.bulk);
    };
    waiting.splice(0, waiting.length, ...drop(waiting));
    group = drop(group);
    selected = group.length - 1;
    host.removePages(importedPages);
    importedPages = [];
    queue.push(...imported.map((file) => ({ file, bulk: true })));
    await intake();
  });
}

// Two clicks when it would take pages back, since there's no undo.
let redoTimer: number | undefined;
redoButton.addEventListener("click", () => {
  if (importedPages.length && !redoButton.classList.contains("confirm")) {
    redoButton.classList.add("confirm");
    redoTimer = window.setTimeout(() => {
      redoButton.classList.remove("confirm");
      draw();
    }, 3000);
    return draw();
  }
  clearTimeout(redoTimer);
  redoButton.classList.remove("confirm");
  redoImport();
});

// ---- assembling pages ----

const READ_AHEAD = 3;

/** Loads queued files in order, filling the page being assembled as each arrives. */
async function intake() {
  // Converting (HEIC especially) happens in Rust, so reading a few files ahead keeps it busy.
  const reads = new Map<ScanFile, Promise<ArrayBuffer>>();
  const read = (file: ScanFile) => {
    let pending = reads.get(file);
    if (!pending) {
      pending = invoke<ArrayBuffer>("read_scan", { path: file.path });
      pending.catch(() => {}); // reported when its turn comes
      reads.set(file, pending);
    }
    return pending;
  };
  const failed: string[] = [];
  let done = 0;
  reading = true;
  try {
    while (queue.length) {
      queue.slice(0, READ_AHEAD).forEach(({ file }) => read(file));
      const total = done + queue.length;
      const { file, bulk } = queue.shift()!;
      setNote(total > 1 ? `Reading ${done + 1} of ${total}…` : `Reading ${fileName(file.path)}…`);
      try {
        const bytes = await read(file);
        // Rust hands back JPEG or PNG; say which, since only a JPEG can go into the PDF as it is.
        const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
        const blob = new Blob([bytes], { type: head[0] === 0xff && head[1] === 0xd8 ? "image/jpeg" : "image/png" });
        const loaded = await stitcher.load(blob, PREVIEW_SIDE);
        waiting.push({ ...loaded, blob, bulk, name: fileName(file.path), t: IDENTITY, score: null, overlap: 1, moved: false });
      } catch (e) {
        failed.push(`${fileName(file.path)} (${e})`);
      }
      reads.delete(file);
      done++;
      await fill();
    }
  } finally {
    reading = false;
  }
  setNote(failed.length ? `Couldn't read ${failed.join(", ")}` : "");
  await fill();
}

/** Moves waiting scans onto the page and lines them up; adds the page when it's full and every scan fits. */
async function fill() {
  for (;;) {
    while (group.length < perPage && waiting.length) {
      const tile = waiting.shift()!;
      await place(tile, group);
      group.push(tile);
      selected = group.length - 1;
      draw();
    }
    // Photos imported on purpose, one per page, have nothing to check, so they go straight in.
    const ready = auto || (perPage === 1 && group.every((t) => t.bulk));
    if (ready && group.length > 0 && group.length >= perPage && group.every(goodEnough)) {
      await addPage();
      continue;
    }
    return;
  }
}

async function place(tile: Tile, others: Tile[]) {
  if (others.length === 0) {
    Object.assign(tile, { t: IDENTITY, score: null, overlap: 1, moved: false });
    return;
  }
  setNote(`Lining up ${tile.name}…`);
  const found = await stitcher.place(tile.id, others.map(({ id, t }) => ({ id, t })));
  Object.assign(tile, found, { moved: false });
  setNote("");
}

async function addPage() {
  if (group.length === 0) return;
  const note = reading ? null : group.length > 1 ? "Joining scans…" : "Adding page…";
  if (note) setNote(note);
  let made: object[];
  if (group.length === 1) {
    // A page of one scan is that scan as it is: nothing to redraw or re-compress, and the turn is the page's own.
    const [tile] = group;
    made = await host.addPage(tile.blob, tile.width, tile.height, turn);
  } else {
    const g = outputTurn();
    const page = await stitcher.render(group.map(({ id, t }) => ({ id, t: compose(g, t) })));
    made = await host.addPage(page.blob, page.width, page.height, 0);
  }
  if (group.some((t) => t.bulk)) importedPages.push(...made);
  discard();
  if (note) setNote("");
}

function discard() {
  stitcher.drop(group.map((t) => t.id));
  group.forEach((t) => t.preview.close());
  group = [];
  selected = -1;
}

async function remove(index: number) {
  const [tile] = group.splice(index, 1);
  stitcher.drop([tile.id]);
  tile.preview.close();
  // Everything after it may have been lined up against it, so line them all up again.
  for (let i = 0; i < group.length; i++) await place(group[i], group.slice(0, i));
  selected = Math.min(selected, group.length - 1);
}

/** The placed scan that overlaps `tile` most, to snap it against. */
function bestPartner(tile: Tile): Tile | null {
  let best: Tile | null = null;
  let bestCount = 0;
  for (const other of group) {
    if (other === tile) continue;
    const back = compose(inverse(other.t), tile.t);
    let count = 0;
    for (let i = 0.5; i < 12; i++)
      for (let j = 0.5; j < 12; j++) {
        const [x, y] = apply(back, [(i / 12) * tile.width, (j / 12) * tile.height]);
        if (x > 0 && y > 0 && x < other.width && y < other.height) count++;
      }
    if (count > bestCount) [best, bestCount] = [other, count];
  }
  return best;
}

async function snap() {
  const tile = group[selected];
  const partner = tile && bestPartner(tile);
  if (!partner) return setNote("Move the scan so it overlaps another, then snap.");
  setNote(`Snapping ${tile.name}…`);
  Object.assign(tile, await stitcher.snap(tile.id, tile.t, { id: partner.id, t: partner.t }), { moved: false });
  setNote("");
}

// ---- drawing ----

function layout() {
  const g = outputTurn();
  const ts = group.map((t) => compose(g, t.t));
  return { ts, box: frozen ?? bounds(group, ts) };
}

function draw() {
  pathLabel.textContent = folder ? fileName(folder) : "No folder chosen";
  pathLabel.title = folder ?? "";
  importButton.hidden = existing.length === 0;
  importButton.textContent = `Import ${existing.length} already there`;
  redoButton.hidden = imported.length === 0;
  redoButton.textContent = redoButton.classList.contains("confirm")
    ? `Remove ${importedPages.length} page${importedPages.length === 1 ? "" : "s"} and redo?`
    : `Redo import at ${perPage} per page`;
  redoButton.title = `Take back the ${imported.length} imported scans and import them again with the settings as they are now`;
  perPageSelect.value = String(perPage);
  autoInput.checked = auto;
  rotateButton.textContent = `Rotate ${turn}°`;
  diffButton.classList.toggle("on", diff);
  snapButton.disabled = group.length < 2 || selected < 0;
  diffButton.disabled = group.length < 2;
  discardButton.disabled = addButton.disabled = group.length === 0;
  addButton.textContent = group.length > 1 ? `Join ${group.length} scans` : "Add page";
  drawTray();
  refreshMenu();

  const queued = queue.length + waiting.length;
  const doubtful = group.filter((t) => !goodEnough(t)).length;
  status.textContent =
    note ||
    [
      group.length && group.length < perPage ? `Scan ${group.length + 1} of ${perPage}` : "",
      doubtful ? `Check the alignment of ${doubtful === 1 ? "the highlighted scan" : `${doubtful} scans`}` : "",
      group.length >= perPage && !doubtful && !auto ? "Ready to add" : "",
      queued ? `${queued} more scan${queued === 1 ? "" : "s"} waiting` : "",
    ]
      .filter(Boolean)
      .join(" · ");

  if (group.length === 0) {
    frame.hidden = true;
    message.hidden = false;
    message.textContent = reading
      ? "Reading…"
      : folder
      ? `Waiting for scans in “${fileName(folder)}”. Scan ${perPage > 1 ? `the ${perPage} parts of a page` : "a page"} and ${perPage > 1 ? "they'll" : "it'll"} appear here.`
      : "Choose the folder your scanner saves into. New scans there will appear here.";
    return;
  }
  message.hidden = true;
  frame.hidden = false;
  const { ts, box } = layout();
  if (!frozen) fitFrame(frame, viewport, box.width, box.height);
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(frame.clientWidth * dpr));
  const h = Math.max(1, Math.round(frame.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const k = w / box.width;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // The selected scan goes on top, so it's the one you see while moving it.
  const order = group.map((_, i) => i).filter((i) => i !== selected);
  if (selected >= 0) order.push(selected);
  const placeOnCanvas = (i: number) => {
    const { theta, tx, ty } = ts[i];
    const c = Math.cos(theta) * k;
    const s = Math.sin(theta) * k;
    ctx.setTransform(c, s, -s, c, k * (tx - box.x), k * (ty - box.y));
  };
  for (const i of order) {
    // Difference shows where the selected scan disagrees with what's beneath: aligned overlap goes black.
    ctx.globalCompositeOperation = diff && i === selected ? "difference" : "source-over";
    placeOnCanvas(i);
    ctx.drawImage(group[i].preview, 0, 0, group[i].width, group[i].height);
  }
  ctx.globalCompositeOperation = "source-over";
  group.forEach((tile, i) => {
    placeOnCanvas(i);
    ctx.lineWidth = (i === selected ? 3 : 1.5) / k;
    ctx.strokeStyle = !goodEnough(tile) ? "#e5484d" : i === selected ? "#2f6fde" : "rgba(128,128,128,0.6)";
    ctx.strokeRect(0, 0, tile.width, tile.height);
  });
}

function drawTray() {
  tray.replaceChildren(
    ...group.map((tile, i) => {
      const li = document.createElement("li");
      li.classList.toggle("selected", i === selected);
      li.classList.toggle("doubtful", !goodEnough(tile));
      const thumb = document.createElement("canvas");
      const s = 56 / Math.max(tile.width, tile.height);
      thumb.width = Math.max(1, Math.round(tile.width * s));
      thumb.height = Math.max(1, Math.round(tile.height * s));
      thumb.getContext("2d")!.drawImage(tile.preview, 0, 0, thumb.width, thumb.height);
      const label = document.createElement("span");
      label.textContent =
        i === 0 ? "1 · base" : tile.moved ? `${i + 1} · by hand` : `${i + 1} · ${Math.round((tile.score ?? 0) * 100)}%`;
      label.title = i === 0 ? "The other scans are lined up to this one" : "How well this scan matches where it overlaps";
      const del = document.createElement("button");
      del.className = "delete";
      del.textContent = "✕";
      del.title = "Remove this scan";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        serial(() => remove(i));
      });
      li.title = tile.name;
      li.append(thumb, label, del);
      li.addEventListener("click", () => {
        selected = i;
        draw();
      });
      return li;
    }),
  );
}

new ResizeObserver(() => active && !frozen && draw()).observe(viewport);

// ---- adjusting by hand ----

/** Moves the selected scan by (dx, dy) on screen, in the output's pixels. */
function nudge(index: number, dx: number, dy: number) {
  const tile = group[index];
  const [x, y] = apply(inverse(outputTurn()), [dx, dy]);
  tile.t = { ...tile.t, tx: tile.t.tx + x, ty: tile.t.ty + y };
  Object.assign(tile, { score: null, moved: true });
}

function turnSelected(degrees: number) {
  const tile = group[selected];
  if (!tile) return;
  tile.t = rotateAbout(tile.t, (degrees * Math.PI) / 180, apply(tile.t, [tile.width / 2, tile.height / 2]));
  Object.assign(tile, { score: null, moved: true });
  draw();
}

canvas.addEventListener("pointerdown", (down) => {
  if (down.button !== 0 || group.length === 0) return;
  const { ts, box } = layout();
  const rect = canvas.getBoundingClientRect();
  const toOutput = (e: PointerEvent): Pt => [
    box.x + ((e.clientX - rect.left) / rect.width) * box.width,
    box.y + ((e.clientY - rect.top) / rect.height) * box.height,
  ];
  const at = toOutput(down);
  const inside = (i: number) => {
    const [x, y] = apply(inverse(ts[i]), at);
    return x > 0 && y > 0 && x < group[i].width && y < group[i].height;
  };
  const top = [selected, ...group.map((_, i) => group.length - 1 - i)].find((i) => i >= 0 && inside(i));
  if (top === undefined) return;
  selected = top;
  frozen = box;
  let last = at;
  canvas.setPointerCapture(down.pointerId);
  const move = (e: PointerEvent) => {
    const p = toOutput(e);
    nudge(selected, p[0] - last[0], p[1] - last[1]);
    last = p;
    draw();
  };
  const up = () => {
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", up);
    frozen = null;
    draw();
  };
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  draw();
});

// ---- controls ----

perPageSelect.addEventListener("change", () => {
  perPageSelect.blur();
  perPage = Number(perPageSelect.value);
  store("scan-per-page", String(perPage));
  serial(fill);
});
autoInput.addEventListener("change", () => {
  auto = autoInput.checked;
  store("scan-auto", String(auto));
  serial(fill);
});
function rotateOutput(by = 90) {
  turn = (((turn + by) % 360) + 360) % 360;
  store("scan-rotation", String(turn));
  draw();
}
rotateButton.addEventListener("click", () => rotateOutput());
diffButton.addEventListener("click", () => {
  diff = !diff;
  draw();
});
snapButton.addEventListener("click", () => serial(snap));
discardButton.addEventListener("click", () =>
  serial(async () => {
    discard();
    await fill();
  }),
);
// Adding by hand takes whatever's there, even short of a full page; then carries on with any waiting scans.
addButton.addEventListener("click", () =>
  serial(async () => {
    await addPage();
    await fill();
  }),
);

/** Handles a key press while the intake is showing; returns whether it did. */
function handleKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement)
    return false;
  const step = e.shiftKey ? 10 : 1;
  switch (e.key) {
    case "Enter":
      addButton.click();
      return true;
    case "d":
    case "D":
      diffButton.click();
      return true;
    case "s":
    case "S":
      if (!snapButton.disabled) snapButton.click();
      return true;
    case "r":
    case "R":
      rotateOutput(e.shiftKey ? -90 : 90);
      return true;
    case "[":
    case "]":
      turnSelected((e.key === "[" ? -1 : 1) * (e.shiftKey ? 1 : 0.1));
      return true;
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown": {
      if (selected < 0) return false;
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      // Arrow keys move by screen pixels, which at this zoom are several of the scan's.
      const { box } = layout();
      const perPixel = box.width / Math.max(1, frame.clientWidth);
      nudge(selected, dx * perPixel, dy * perPixel);
      draw();
      return true;
    }
    case "Tab":
      if (group.length === 0) return false;
      selectScan(e.shiftKey ? -1 : 1);
      return true;
  }
  return false;
}

menuPart(() => {
  const on = active && !document.querySelector("dialog[open]");
  const has = on && group.length > 0;
  const scan = has && selected >= 0;
  return {
    enabled: {
      "choose-folder": on,
      import: on && existing.length > 0,
      "redo-import": on && imported.length > 0,
      "add-page": has,
      "discard-scans": has,
      "next-scan": has,
      "previous-scan": has,
      snap: on && !snapButton.disabled,
      difference: on && !diffButton.disabled,
      "turn-scan-left": scan,
      "turn-scan-right": scan,
      "turn-scan-left-more": scan,
      "turn-scan-right-more": scan,
      "scanner-cw": on,
      "scanner-ccw": on,
    },
    titles: {
      import: existing.length ? `Import ${existing.length} Scans Already There` : "Import Scans Already There",
      "redo-import": `Redo Import at ${perPage} per Page`,
      "add-page": group.length > 1 ? `Join ${group.length} Scans` : "Add Page",
      difference: diff ? "Hide Difference" : "Show Difference",
    },
  };
});

const menuActions: Record<string, () => void> = {
  "choose-folder": () => folderButton.click(),
  import: () => importButton.click(),
  "redo-import": () => redoButton.click(),
  "add-page": () => addButton.click(),
  "discard-scans": () => discardButton.click(),
  "next-scan": () => selectScan(1),
  "previous-scan": () => selectScan(-1),
  snap: () => snapButton.click(),
  difference: () => diffButton.click(),
  "turn-scan-left": () => turnSelected(-0.1),
  "turn-scan-right": () => turnSelected(0.1),
  "turn-scan-left-more": () => turnSelected(-1),
  "turn-scan-right-more": () => turnSelected(1),
  "scanner-cw": () => rotateOutput(90),
  "scanner-ccw": () => rotateOutput(-90),
};

function selectScan(by: number) {
  if (group.length === 0) return;
  selected = (selected + by + group.length) % group.length;
  draw();
}

export function initIntake(h: IntakeHost) {
  host = h;
  return {
    setActive(on: boolean) {
      active = on;
      view.hidden = !on;
      if (on) {
        draw();
        poll();
      }
    },
    handleKey,
    /** Does what the menu item `id` says, if it's one of the scanner's. */
    menuAction: (id: string) => menuActions[id]?.(),
    rotate: (quarters: number) => rotateOutput(quarters * 90),
  };
}
