# Typo Scanner

A macOS app for turning printed pages into a PDF. Photograph them with a webcam or an
iPhone (Continuity Camera), or bring in scans from a flatbed scanner. Then crop, flatten,
split and reorder the pages, and export.

## What it does

**Two ways to get pages in**

- **Camera.** A live preview with a crop that applies to every capture. Use a rectangle,
  or a page outline with bend points that flattens a curled page, plus lens correction
  for lines that bow. Split can turn each capture of a spread into two pages. A loupe
  helps with fine adjustments. Press Space to capture.
- **Scanner folder.** Choose the folder your scanner saves into and new scans appear as
  they land. When a page is bigger than the scanner bed, set *Scans per page* and its
  scans are lined up and joined automatically. Pages that don't line up well wait for
  you to check: snap them, view the difference, or nudge them by hand. Scans already in
  the folder can be imported (and the import redone with other settings). HEIC, TIFF,
  JPEG and PNG are all read, and photos stored sideways are turned upright.

**Working with pages**

- Select pages by clicking, with the arrow keys, by range (`3-12, 15`) or by odd/even.
  Drag them, or press ⌘ + arrows, to reorder.
- Crop… and Split… open an editor for the selected pages. Pages can be put in groups that
  each get their own crop or gutter, and ← → compares them.
- Rotate, unsplit, delete.

**Saving**

- **Save** writes a `.typoscan` project that keeps every original photo, so crops can be
  changed later. Double-clicking one in the Finder opens it.
- **Export as PDF** writes the finished pages.
- **Package** gathers the project, the PDF, the originals and each finished page into
  a new folder, as InDesign's Package does.

Every action, with its shortcut, is in the menu bar. Items turn on when the part of
the app they belong to is showing.

## Development

You need macOS, [Rust](https://rustup.rs), Node and pnpm.

```sh
pnpm install
pnpm tauri dev      # run the app, reloading as you edit
pnpm test           # TypeScript tests (vitest)
cd src-tauri && cargo test   # Rust tests
```

To build the app:

```sh
pnpm package        # builds Typo Scanner.app and a .dmg, then opens the .dmg
```

Opening `.typoscan` files from the Finder works only from a built app, after it has been
opened once (or copied to `/Applications`) so macOS knows about it.

### Layout

- `src/`: the app's page (TypeScript, no framework)
  - `main.ts`: the camera, the page list, selection, saving and exporting
  - `intake.ts`: the scanner folder: watching, gathering scans into pages, alignment by hand
  - `editor.ts`: the crop and split editor
  - `stitch.ts`, `stitcher.ts`, `stitch.worker.ts`: lining up and joining scans
  - `outline.ts`, `warp.ts`, `render.ts`: page outlines and flattening
  - `project.ts`: the `.typoscan` format, a ZIP of `project.json` and the images
  - `pdf.ts`: PDF writing
  - `menu.ts`: keeps the menu bar's items in step with the app
- `src-tauri/`: the Rust side. It handles file dialogs and writes, reads and converts
  scans (HEIC through macOS's `sips`), builds the menu bar, and opens projects from the
  Finder.
- `test/`: tests for the page's logic

### App icon

`app-icon.svg` is the design. `app-icon-macos.svg` puts it in the macOS rounded-square
shape. To regenerate the icon set:

```sh
rsvg-convert -w 1024 app-icon-macos.svg -o icon.png && pnpm tauri icon icon.png
```

`pnpm tauri icon` also writes Windows Store, Android and iOS icons, which this app
doesn't use and can be deleted.
