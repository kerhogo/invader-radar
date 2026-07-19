import "./ui/glass.css";
import { state, on, setGallery } from "./state";
import { loadDataset, loadChangelog } from "./data";
import { fetchGallery } from "./api";
import { renderDashboard } from "./dashboard";
import { renderSettings } from "./settings";
import { renderNews, unseenCount } from "./news";

type ViewName = "dashboard" | "map" | "hunt" | "news" | "settings";

const views = document.querySelectorAll<HTMLElement>(".view");
const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
const title = document.getElementById("view-title")!;
const topbar = document.getElementById("topbar")!;

let current: ViewName | "" = "";
let mapModule: { show: () => void } | null = null;
let huntModule: { show: () => void; hide: () => void } | null = null;

async function showView(name: ViewName): Promise<void> {
  if (current === name) return;
  if (current === "hunt" && huntModule) huntModule.hide();
  current = name;

  for (const v of views) v.classList.toggle("active", v.id === `view-${name}`);
  for (const t of tabs) t.classList.toggle("active", t.dataset.view === name);
  const active = document.getElementById(`view-${name}`)!;
  title.textContent = active.dataset.title ?? "Invader Radar";
  topbar.style.display = "";

  switch (name) {
    case "dashboard": renderDashboard(); break;
    case "settings": renderSettings(); break;
    case "news": await renderNews(); updateBadge(); break;
    case "map": {
      topbar.style.display = "none";
      // MapLibre chargé uniquement à la première ouverture (code-split)
      mapModule ??= await import("./map");
      mapModule.show();
      break;
    }
    case "hunt": {
      topbar.style.display = "none";
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
  const initial = (location.hash.replace("#", "") || "dashboard") as ViewName;
  showView(["dashboard", "map", "hunt", "news", "settings"].includes(initial) ? initial : "dashboard");

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
