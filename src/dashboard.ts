import { state, setGallery } from "./state";
import { fetchGallery, ApiError } from "./api";
import { cityStats, zoneStats } from "./data";
import type { CityStats } from "./data";

const el = () => document.getElementById("view-dashboard")!;
const expanded = new Set<string>();
let rowsWired = false;

const CONTINENT_ORDER = ["Europe", "Amérique du Nord", "Amérique du Sud", "Afrique", "Asie", "Océanie", "Espace", "Ailleurs"];

export function renderDashboard(): void {
  const root = el();
  if (!state.dataset) {
    root.innerHTML = `<div class="spin"></div>`;
    return;
  }
  if (!state.settings.uid) {
    root.innerHTML = onboarding();
    wireOnboarding();
    return;
  }

  const g = state.gallery;
  const cities = cityStats().filter(c => c.foundTotal > 0 || c.active > 0);
  const played = cities.filter(c => c.foundTotal > 0);
  const others = cities.filter(c => c.foundTotal === 0);

  root.innerHTML = `
    ${g?.player ? `
    <div class="card">
      <h2>${escapeHtml(g.player.name)}</h2>
      <div class="stat-row">
        <div class="stat accent"><b>${fmt(g.player.si_found)}</b><span>flashés</span></div>
        <div class="stat"><b>${fmt(g.player.score)}</b><span>points</span></div>
        <div class="stat"><b>#${fmt(g.player.rank)}</b><span>rang mondial</span></div>
      </div>
      <p class="hint center">${fmt(g.player.si_found)} / ${fmt(g.totalWorld)} invaders dans le monde · actualisé ${timeAgo(g.fetchedAt)}</p>
    </div>` : ""}

    <button class="btn secondary" id="btn-refresh">Actualiser mes flashs</button>
    <p class="hint center" id="refresh-msg"></p>

    <div class="card">
      <h2>Mes villes</h2>
      ${played.map(c => cityRow(c)).join("") || `<p class="hint">Aucun flash pour l'instant — la chasse commence !</p>`}
    </div>

    <div class="card">
      <h2>À explorer</h2>
      ${grouped(others)}
    </div>
  `;

  wireRows(root);

  root.querySelector<HTMLButtonElement>("#btn-refresh")!.addEventListener("click", async ev => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const msg = root.querySelector<HTMLElement>("#refresh-msg")!;
    btn.disabled = true;
    msg.textContent = "Actualisation…";
    try {
      setGallery(await fetchGallery(state.settings.uid));
    } catch (e) {
      msg.textContent = e instanceof ApiError ? e.message : "Erreur inattendue.";
      btn.disabled = false;
    }
  });
}

/* ---------- Villes ---------- */

function cityRow(c: CityStats): string {
  const info = state.dataset?.cities[c.code];
  const denom = c.official ?? c.active;
  const left = Math.max(0, c.active - c.found);
  const pct = denom > 0 ? Math.min(100, Math.round((c.foundTotal / denom) * 100)) : 0;
  const done = denom > 0 && c.foundTotal >= denom;
  const subs: string[] = [`${fmt(left)} restants`];
  if (c.unlocated > 0) subs.push(`${fmt(c.unlocated)} non localisés`);
  const isOpen = expanded.has(c.code);
  return `
    <div class="row tappable" data-code="${c.code}">
      <div class="grow">
        <div class="title">${info?.flag ?? ""} ${escapeHtml(c.name)}</div>
        <div class="sub">${subs.join(" · ")}</div>
        <div class="progress ${done ? "done" : ""}"><i style="width:${pct}%"></i></div>
      </div>
      <div class="val">${fmt(c.foundTotal)}<span style="color:var(--text-2)">/${fmt(denom)}</span></div>
    </div>
    ${isOpen ? cityDetail(c) : ""}`;
}

function cityDetail(c: CityStats): string {
  const z1 = [...zoneStats(c.code, "z1").values()]
    .map(z => ({ ...z, left: z.active - z.found }))
    .sort((a, b) => b.left - a.left || b.active - a.active);
  const rows = z1.slice(0, 14).map(z => `
    <div class="row">
      <div class="grow">
        <div class="title" style="font-size:14px">${escapeHtml(z.key)}</div>
        ${z.indoorLeft ? `<div class="sub">dont ${z.indoorLeft} en intérieur</div>` : ""}
      </div>
      <div class="val" style="font-size:13.5px">${fmt(z.found)}<span style="color:var(--text-2)">/${fmt(z.active)}</span></div>
    </div>`).join("");
  return `
    <div class="city-detail" data-detail="${c.code}">
      ${rows || `<p class="hint">Pas de sous-découpage localisé pour cette ville.</p>`}
      ${z1.length > 14 ? `<p class="hint">et ${z1.length - 14} autres zones…</p>` : ""}
      <button class="btn secondary" data-map-code="${c.code}" style="margin-top:8px;padding:11px">Voir sur la carte</button>
    </div>`;
}

function wireRows(root: HTMLElement): void {
  if (rowsWired) return; // délégation : un seul écouteur sur la vue, posé une fois
  rowsWired = true;
  root.addEventListener("click", ev => {
    const target = ev.target as HTMLElement;
    const mapBtn = target.closest<HTMLElement>("[data-map-code]");
    if (mapBtn) {
      document.dispatchEvent(new CustomEvent("focus-city", { detail: mapBtn.dataset.mapCode }));
      return;
    }
    const row = target.closest<HTMLElement>(".row[data-code]");
    if (!row) return;
    const code = row.dataset.code!;
    expanded.has(code) ? expanded.delete(code) : expanded.add(code);
    renderDashboard();
  });
}

/* ---------- À explorer : liste complète groupée Continent → Pays ---------- */

function grouped(others: CityStats[]): string {
  if (others.length === 0) return `<p class="hint">Tu as flashé partout. Respect. 👾</p>`;
  const byContinent = new Map<string, Map<string, CityStats[]>>();
  for (const c of others) {
    const info = state.dataset?.cities[c.code];
    const cont = info?.continent ?? "Ailleurs";
    const country = info?.country ?? "Ailleurs";
    if (!byContinent.has(cont)) byContinent.set(cont, new Map());
    const byCountry = byContinent.get(cont)!;
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country)!.push(c);
  }

  return CONTINENT_ORDER.filter(cont => byContinent.has(cont)).map(cont => {
    const byCountry = byContinent.get(cont)!;
    const countries = [...byCountry.entries()].sort((a, b) => a[0].localeCompare(b[0], "fr"));
    return `
      <div class="group-title">${cont}</div>
      ${countries.map(([country, list]) => {
        const flag = state.dataset?.cities[list[0].code]?.flag ?? "";
        return `
          <div class="country-title">${flag} ${escapeHtml(country)}</div>
          ${list.sort((a, b) => b.active - a.active).map(c => cityRow(c)).join("")}`;
      }).join("")}`;
  }).join("");
}

/* ---------- Onboarding ---------- */

function onboarding(): string {
  return `
    <div class="card">
      <h2>Bienvenue, chasseur 👾</h2>
      <p class="hint">Invader Radar t'indique <b>combien</b> d'invaders restent à trouver par quartier
      et autour de toi — <b>jamais où ils sont exactement</b>. L'esprit chasse au trésor est sauf.</p>
      <div class="field">
        <label for="uid-input">Ton identifiant FlashInvaders (uid)</label>
        <input type="text" id="uid-input" placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
               autocomplete="off" autocapitalize="characters" spellcheck="false" />
      </div>
      <button class="btn" id="btn-uid-save">C'est parti</button>
      <button class="btn secondary" id="btn-uid-help" style="margin-top:8px">Comment récupérer mon uid ?</button>
      <p class="hint center" id="uid-msg"></p>
    </div>`;
}

function wireOnboarding(): void {
  const root = el();
  root.querySelector<HTMLButtonElement>("#btn-uid-help")!.addEventListener("click", async () => {
    (await import("./uidHelp")).openUidHelp();
  });
  root.querySelector<HTMLButtonElement>("#btn-uid-save")!.addEventListener("click", async () => {
    const input = root.querySelector<HTMLInputElement>("#uid-input")!;
    const msg = root.querySelector<HTMLElement>("#uid-msg")!;
    const uid = input.value.trim();
    if (uid.length < 8) { msg.textContent = "Cet uid semble trop court."; return; }
    msg.textContent = "Vérification…";
    try {
      const g = await fetchGallery(uid);
      const { saveSettings } = await import("./state");
      saveSettings({ uid });
      setGallery(g);
    } catch (e) {
      msg.textContent = e instanceof ApiError ? e.message : "Erreur inattendue.";
    }
  });
}

/* ---------- utilitaires ---------- */

export function fmt(n: number): string {
  return n.toLocaleString("fr-FR");
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string)
  );
}

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const h = Math.round(mins / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}
