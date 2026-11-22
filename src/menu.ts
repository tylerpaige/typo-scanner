import { invoke } from "@tauri-apps/api/core";

/**
 * The menu bar lists every action, so it's where shortcuts can be learned. Each part of the
 * app (the pages, the scanner, the editor) says which of its items are on and what they're
 * called; items for a part that isn't showing are off, so one key can serve each part.
 */
export interface MenuState {
  enabled: Record<string, boolean>;
  titles?: Record<string, string>;
}

const parts: (() => MenuState)[] = [];
let sent = "";
let timer: number | undefined;

/** Adds a part of the app whose menu items follow its state. */
export function menuPart(state: () => MenuState) {
  parts.push(state);
  refreshMenu();
}

/** Brings the menu up to date with the app, once whatever's happening now has finished. */
export function refreshMenu() {
  if (timer !== undefined) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    const state = { enabled: {}, titles: {} };
    for (const part of parts) {
      const { enabled, titles } = part();
      Object.assign(state.enabled, enabled);
      Object.assign(state.titles, titles);
    }
    const json = JSON.stringify(state);
    if (json === sent) return;
    sent = json;
    invoke("set_menu_state", state).catch(() => {});
  }, 0);
}

// Almost every change follows something done with the keyboard or mouse.
for (const type of ["keydown", "keyup", "click", "dblclick", "pointerup", "change", "focusin", "close"]) document.addEventListener(type, refreshMenu, true);
