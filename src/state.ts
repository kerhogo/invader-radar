import type { Dataset, Gallery, Meta, Settings } from "./types";

const SETTINGS_KEY = "ir.settings.v1";
const GALLERY_KEY = "ir.gallery.v1";

const defaults: Settings = {
  uid: "",
  radius: 150,
  sounds: true,
  includeDamaged: true,
  includeHidden: false,
  includeUnknown: true,
  lastNewsSeen: "1970-01-01"
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch { /* stockage indisponible → défauts */ }
  return { ...defaults };
}

export const state = {
  settings: loadSettings(),
  dataset: null as Dataset | null,
  meta: null as Meta | null,
  gallery: loadGalleryCache(),
  flashedSet: new Set<string>()
};

if (state.gallery) state.flashedSet = new Set(state.gallery.flashed);

export function saveSettings(patch: Partial<Settings>): void {
  Object.assign(state.settings, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* ignore */ }
  emit("settings");
}

export function setGallery(g: Gallery): void {
  state.gallery = g;
  state.flashedSet = new Set(g.flashed);
  try { localStorage.setItem(GALLERY_KEY, JSON.stringify(g)); } catch { /* ignore */ }
  emit("gallery");
}

function loadGalleryCache(): Gallery | null {
  try {
    const raw = localStorage.getItem(GALLERY_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

/* Mini bus d'événements : les vues se re-rendent quand données/réglages changent. */
type Topic = "settings" | "gallery" | "dataset";
const listeners: Record<Topic, Array<() => void>> = { settings: [], gallery: [], dataset: [] };

export function on(topic: Topic, fn: () => void): void {
  listeners[topic].push(fn);
}

export function emit(topic: Topic): void {
  for (const fn of listeners[topic]) fn();
}
