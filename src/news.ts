import type { ChangeEntry } from "./types";
import { state, saveSettings } from "./state";
import { loadChangelog } from "./data";
import { escapeHtml } from "./dashboard";
import { STATUS_LABELS } from "./data";

const SPOTTER_URL = "https://www.invader-spotter.art/news.php";
/** Toutes les actualités viennent de la veille communautaire Invader Spotter. */
const sourceLink = `<a href="${SPOTTER_URL}" target="_blank" rel="noopener">Invader Spotter</a>`;

let cache: ChangeEntry[] | null = null;

async function entries(): Promise<ChangeEntry[]> {
  cache ??= (await loadChangelog()).slice().sort((a, b) => b.date.localeCompare(a.date));
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
  const cityName = (code?: string) => (code && state.dataset?.cities[code]?.name) || code || "";

  // Garde-fous d'affichage : jamais deux fois le même événement, et pas plus de
  // MAX_PER_DAY changements par jour — sinon une grosse resynchronisation noie
  // les jours précédents et les actualités de la source.
  const MAX_PER_DAY = 25;
  const seenKeys = new Set<string>();
  const byDate = new Map<string, ChangeEntry[]>();
  const hidden = new Map<string, number>();
  for (const e of list) {
    const key = `${e.date}|${e.type}|${e.id ?? e.text ?? ""}|${e.from ?? ""}|${e.to ?? ""}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    const day = byDate.get(e.date)!;
    if (day.length >= MAX_PER_DAY) {
      hidden.set(e.date, (hidden.get(e.date) ?? 0) + 1);
      continue;
    }
    day.push(e);
  }

  root.innerHTML = [...byDate.entries()].map(([date, items]) => `
    <div class="card">
      <h2>${new Date(date + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}
          ${date > seen ? `<span class="tag">nouveau</span>` : ""}</h2>
      ${items.map(item).join("")}
      ${hidden.get(date) ? `<p class="hint">et ${hidden.get(date)} autres changements de statut ce jour-là</p>` : ""}
    </div>`).join("") + `
    <p class="hint center">Veille communautaire : ${sourceLink}</p>`;

  markSeen();

  function item(e: ChangeEntry): string {
    const zone = e.zone ? ` — ${escapeHtml(e.zone)}` : "";
    if (e.type === "spotter_news") {
      return row("🛰️", escapeHtml(e.text ?? ""), `Source : ${sourceLink}`);
    }
    if (e.type === "new_city") {
      return row("🏙️", `Nouvelle ville invadée : ${escapeHtml(cityName(e.city))}`, `Source : ${sourceLink}`);
    }
    if (e.type === "new_invader") {
      const id = e.id ? ` : <b>${escapeHtml(e.id)}</b>` : "";
      return row("👾", `Nouvel invader à ${escapeHtml(cityName(e.city))}${zone}${id}`,
        `Fraîchement repéré · ${sourceLink}`);
    }
    // Ville (quartier) : XX_00 statut → statut, commentaire + source en dessous
    const from = e.from ? STATUS_LABELS[e.from] : "?";
    const to = e.to ? STATUS_LABELS[e.to] : "?";
    const good = e.to === "ok";
    const place = `${escapeHtml(cityName(e.city))}${e.zone ? ` (${escapeHtml(e.zone)})` : ""}`;
    const id = e.id ? `<b>${escapeHtml(e.id)}</b> ` : "";
    const comment =
      e.to === "ok" ? "De nouveau flashable"
      : e.to === "destroyed" ? "Détruit, retiré des compteurs"
      : e.to === "wrecked" ? "Trop dégradé, non flashable"
      : e.to === "hidden" ? "Momentanément inaccessible"
      : e.to === "damaged" ? "Dégradé mais toujours flashable"
      : "Statut mis à jour";
    return row(good ? "✨" : "⚠️",
      `${place} : ${id}${from} → ${to}`,
      `${comment} · ${sourceLink}`);
  }

  function row(icon: string, title: string, sub: string): string {
    return `
      <div class="row news-item">
        <div class="icon">${icon}</div>
        <div class="grow">
          <div class="title" style="font-size:14.5px;font-weight:500;line-height:1.4">${title}</div>
          <div class="sub">${sub}</div>
        </div>
      </div>`;
  }
}

function markSeen(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (state.settings.lastNewsSeen !== today) saveSettings({ lastNewsSeen: today });
}
