import "./ui/glass.css";
import { state, on, setGallery } from "./state";
import { loadDataset, loadChangelog } from "./data";
import { fetchGallery } from "./api";
import { renderDashboard } from "./dashboard";
import { renderSettings } from "./settings";
import { renderNews, unseenCount } from "./news";

type ViewName = "dashboard" | "map" | "hunt" | "news" | "settings";
const VIEWS: ViewName[] = ["dashboard", "map", "hunt", "news", "settings"];
const SWIPE_ORDER: ViewName[] = ["dashboard", "map", "hunt", "news"];

const views = document.querySelectorAll<HTMLElement>(".view");
const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
const title = document.getElementById("view-title")!;
const topbar = document.getElementById("topbar")!;

let current: ViewName | "" = "";
let mapModule: { show: () => void; focusCity: (code: string) => void } | null = null;
let huntModule: { show: () => void; hide: () => void; isRunning: () => boolean } | null = null;

async function showView(name: ViewName): Promise<void> {
  if (current === name) return;
  current = name;
  document.body.dataset.view = name;

  for (const v of views) v.classList.toggle("active", v.id === `view-${name}`);
  let activeTab: HTMLButtonElement | null = null;
  for (const t of tabs) {
    const active = t.dataset.view === name;
    t.classList.toggle("active", active);
    if (active) {
      activeTab = t;
      t.classList.remove("pop");
      void t.offsetWidth; // relance l'animation « bulle »
      t.classList.add("pop");
    }
  }
  if (activeTab) moveBubble(activeTab);
  const active = document.getElementById(`view-${name}`)!;
  title.textContent = active.dataset.title ?? "Invader Radar";
  topbar.style.display = name === "map" || name === "hunt" ? "none" : "";

  switch (name) {
    case "dashboard": renderDashboard(); break;
    case "settings": renderSettings(); break;
    case "news": await renderNews(); updateBadge(); break;
    case "map": {
      // MapLibre chargé uniquement à la première ouverture (code-split)
      mapModule ??= await import("./map");
      mapModule.show();
      break;
    }
    case "hunt": {
      huntModule ??= await import("./radar");
      huntModule.show();
      break;
    }
  }
  location.hash = name;
}

for (const t of tabs) {
  t.addEventListener("click", () => showView(t.dataset.view as ViewName));
}
document.getElementById("btn-settings")!.addEventListener("click", () => showView("settings"));

/* Bulle « liquid glass » : posée sous l'onglet actif, et suit le doigt au drag. */
const tabbar = document.getElementById("tabbar")!;
const bubble = document.createElement("span");
bubble.className = "tab-bubble";
tabbar.appendChild(bubble);

function moveBubble(t: HTMLButtonElement, lit = true): void {
  const br = tabbar.getBoundingClientRect();
  const r = t.getBoundingClientRect();
  if (r.width === 0) return; // onglet masqué (avant layout)
  bubble.style.width = `${r.width}px`;
  bubble.style.transform = `translateX(${r.left - br.left}px)`;
  bubble.classList.toggle("lit", lit);
}

(function tabDrag(): void {
  const bar = tabbar;
  let dragging = false;

  const tabAt = (x: number): HTMLButtonElement | null => {
    for (const t of tabs) {
      const r = t.getBoundingClientRect();
      if (x >= r.left && x <= r.right) return t;
    }
    return null;
  };
  bar.addEventListener("touchstart", ev => {
    const t = tabAt(ev.touches[0].clientX);
    if (!t) return;
    dragging = true;
    moveBubble(t);
    bar.classList.add("dragging");
  }, { passive: true });

  bar.addEventListener("touchmove", ev => {
    if (!dragging) return;
    const t = tabAt(ev.touches[0].clientX);
    if (t) moveBubble(t);
  }, { passive: true });

  const end = (ev: TouchEvent): void => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove("dragging");
    const t = tabAt(ev.changedTouches[0].clientX);
    if (t) showView(t.dataset.view as ViewName);
  };
  bar.addEventListener("touchend", end, { passive: true });
  bar.addEventListener("touchcancel", end, { passive: true });
})();

// Le mini-widget « radar actif » ramène à la chasse
document.addEventListener("click", ev => {
  if ((ev.target as HTMLElement).closest("#hunt-widget")) showView("hunt");
});

// Le dashboard peut demander un focus ville sur la carte
document.addEventListener("focus-city", (async (ev: Event) => {
  const code = (ev as CustomEvent<string>).detail;
  await showView("map");
  mapModule?.focusCity(code);
}) as EventListener);

/* ---------- Navigation au glissement latéral ---------- */

let touchStart: { x: number; y: number; ok: boolean } | null = null;

document.getElementById("views")!.addEventListener("touchstart", ev => {
  const t = ev.touches[0];
  const target = ev.target as HTMLElement;
  // pas de swipe sur la carte (pan) ni depuis le curseur de rayon
  const ok = current !== "map" && !target.closest("input[type='range']") && !target.closest(".maplibregl-map");
  touchStart = { x: t.clientX, y: t.clientY, ok };
}, { passive: true });

document.getElementById("views")!.addEventListener("touchend", ev => {
  if (!touchStart?.ok) { touchStart = null; return; }
  const t = ev.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) < 65 || Math.abs(dx) < Math.abs(dy) * 2) return;
  const idx = SWIPE_ORDER.indexOf(current as ViewName);
  if (idx === -1) return;
  const next = SWIPE_ORDER[idx + (dx < 0 ? 1 : -1)];
  if (next) showView(next);
}, { passive: true });

/* ---------- Boot ---------- */

function updateBadge(): void {
  const badge = document.getElementById("news-badge")!;
  const n = unseenCount();
  badge.hidden = n === 0;
  badge.textContent = n > 9 ? "9+" : String(n);
}

async function refreshGallery(): Promise<void> {
  const uid = state.settings.uid;
  if (!uid) return;
  try {
    setGallery(await fetchGallery(uid));
  } catch {
    // silencieux au boot : le cache local reste affiché, l'erreur détaillée
    // apparaît si l'utilisateur actualise manuellement depuis le dashboard.
  }
}

async function boot(): Promise<void> {
  const fromHash = location.hash.replace("#", "") as ViewName;
  // ouverture par défaut : la Chasse (sauf premier lancement sans uid → accueil)
  const initial = VIEWS.includes(fromHash) ? fromHash : state.settings.uid ? "hunt" : "dashboard";
  showView(initial);

  try {
    await loadDataset();
  } catch {
    document.getElementById("view-dashboard")!.innerHTML =
      `<div class="empty"><div class="pixel">👾</div>Impossible de charger la base de données.<br>Réessaie plus tard.</div>`;
    return;
  }
  await loadChangelog(); // met en cache pour le badge
  updateBadge();
  refreshGallery(); // progression toujours à jour, sans action manuelle
}

on("gallery", () => { if (current === "dashboard") renderDashboard(); });
on("dataset", () => { if (current === "dashboard") renderDashboard(); });
on("settings", () => { if (current === "dashboard") renderDashboard(); });

boot();

// PWA — service worker (uniquement en build, pas en dev)
if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  addEventListener("load", () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js").catch(() => {});
  });
}
