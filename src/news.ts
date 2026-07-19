import type { ChangeEntry } from "./types";
import { state, saveSettings } from "./state";
import { loadChangelog } from "./data";
import { escapeHtml } from "./dashboard";
import { STATUS_LABELS } from "./data";

let cache: ChangeEntry[] | null = null;

async function entries(): Promise<ChangeEntry[]> {
  cache ??= await loadChangelog();
  return cache;
}

/** Nombre d'entrées plus récentes que la dernière consultation (pour le badge). */
export function unseenCount(): number {
  if (!cache) return 0;
  const seen = state.settings.lastNewsSeen;
  return cache.filter(e => e.date > seen).length;
}

export async function renderNews(): Promise<void> {
  const root = document.getElementById("view-news")!;
  const list = await entries();

  if (list.length === 0) {
    root.innerHTML = `<div class="empty"><div class="pixel">👾</div>
      Rien à signaler pour l'instant.<br>Les nouveautés et changements de statut apparaîtront ici, ville par ville.</div>`;
    markSeen();
    return;
  }

  const seen = state.settings.lastNewsSeen;
  const cityName = (code: string) => state.dataset?.cities[code]?.name ?? code;

  const byDate = new Map<string, ChangeEntry[]>();
  for (const e of list.slice(0, 120)) {
    (byDate.get(e.date) ?? byDate.set(e.date, []).get(e.date)!).push(e);
  }

  root.innerHTML = [...byDate.entries()].map(([date, items]) => `
    <div class="card">
      <h2>${new Date(date + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}
          ${date > seen ? `<span class="tag">nouveau</span>` : ""}</h2>
      ${items.map(item).join("")}
    </div>`).join("");

  markSeen();

  function item(e: ChangeEntry): string {
    const zone = e.zone ? ` — ${escapeHtml(e.zone)}` : "";
    if (e.type === "new_city") {
      return row("🏙️", `Nouvelle ville invadée : ${escapeHtml(cityName(e.city))}`, "Le monde s'agrandit !");
    }
    if (e.type === "new_invader") {
      return row("👾", `Nouvel invader à ${escapeHtml(cityName(e.city))}${zone}`,
        "Fraîchement repéré par la communauté");
    }
    const from = e.from ? STATUS_LABELS[e.from] : "?";
    const to = e.to ? STATUS_LABELS[e.to] : "?";
    const good = e.to === "ok";
    return row(good ? "✨" : "⚠️",
      `${escapeHtml(cityName(e.city))}${zone} : ${from} → ${to}`,
      good ? "De nouveau flashable !" : "Statut mis à jour par la communauté");
  }

  function row(icon: string, title: string, sub: string): string {
    return `
      <div class="row news-item">
        <div class="icon">${icon}</div>
        <div class="grow">
          <div class="title" style="font-size:15px">${title}</div>
          <div class="sub">${sub}</div>
        </div>
      </div>`;
  }
}

function markSeen(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (state.settings.lastNewsSeen !== today) saveSettings({ lastNewsSeen: today });
}
