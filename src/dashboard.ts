import { state, setGallery } from "./state";
import { fetchGallery, ApiError } from "./api";
import { cityStats, zoneHierarchy } from "./data";
import type { CityStats } from "./data";

const el = () => document.getElementById("view-dashboard")!;
let openCity: string | null = null;      // accordéon exclusif : une seule ville
let openArr: string | null = null;       // et un seul arrondissement dans cette ville
let rowsWired = false;

const CONTINENT_ORDER = ["Europe", "Amérique du Nord", "Amérique du Sud", "Afrique", "Asie", "Océanie", "Espace", "Autres"];

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
      ${played.map(c => cityRow(c, true)).join("") || `<p class="hint">Aucun flash pour l'instant — la chasse commence !</p>`}
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

function cityRow(c: CityStats, showFlag: boolean): string {
  const info = state.dataset?.cities[c.code];
  const denom = c.official ?? c.active;
  const left = Math.max(0, c.active - c.found);
  const pct = denom > 0 ? Math.min(100, Math.round((c.foundTotal / denom) * 100)) : 0;
  const done = denom > 0 && c.foundTotal >= denom;
  const subs: string[] = [`${fmt(left)} restants`];
  if (c.unlocated > 0) subs.push(`${fmt(c.unlocated)} non localisés`);
  const flag = showFlag && info?.flag ? `${info.flag} ` : "";
  const isOpen = openCity === c.code;
  return `
    <div class="row tappable" data-code="${c.code}">
      <div class="grow">
        <div class="title">${flag}${escapeHtml(c.name)}</div>
        <div class="sub">${subs.join(" · ")}</div>
        <div class="progress ${done ? "done" : ""}"><i style="width:${pct}%"></i></div>
      </div>
      <div class="val">${fmt(c.foundTotal)}<span style="color:var(--text-2)">/${fmt(denom)}</span></div>
    </div>
    ${isOpen ? cityDetail(c) : ""}`;
}

function zoneLine(key: string, found: number, active: number, indoorLeft: number, opts: { child?: boolean; toggle?: boolean } = {}): string {
  return `
    <div class="row ${opts.toggle ? "tappable" : ""} ${opts.child ? "quartier" : ""}" ${opts.toggle ? `data-arr="${escapeHtml(key)}"` : ""}>
      <div class="grow">
        <div class="title" style="font-size:14px">${opts.toggle ? "▸ " : ""}${escapeHtml(key)}</div>
        ${indoorLeft ? `<div class="sub">dont ${indoorLeft} en intérieur</div>` : ""}
      </div>
      <div class="val" style="font-size:13.5px">${fmt(found)}<span style="color:var(--text-2)">/${fmt(active)}</span></div>
    </div>`;
}

function cityDetail(c: CityStats): string {
  const tree = zoneHierarchy(c.code);
  const hasChildren = tree.some(n => n.children.length > 0);
  let body: string;

  if (tree.length === 0) {
    body = `<p class="hint">Pas de sous-découpage localisé pour cette ville.</p>`;
  } else if (!hasChildren) {
    // un seul niveau (commune unique) : liste directe
    body = tree.slice(0, 20).map(n => zoneLine(n.key, n.found, n.active, n.indoorLeft)).join("");
  } else {
    // deux niveaux : arrondissements (repliés), quartiers au clic (exclusif)
    body = tree.map(n => {
      const open = openArr === n.key;
      const arr = zoneLine(n.key, n.found, n.active, n.indoorLeft, { toggle: true });
      const kids = open
        ? `<div class="quartiers">${n.children.map(k => zoneLine(k.key, k.found, k.active, k.indoorLeft, { child: true })).join("")
            || `<p class="hint" style="margin-left:12px">Pas de quartier localisé ici.</p>`}</div>`
        : "";
      return arr.replace("▸", open ? "▾" : "▸") + kids;
    }).join("");
  }

  return `
    <div class="city-detail" data-detail="${c.code}">
      ${body}
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
    // clic sur un arrondissement → déplie/replie ses quartiers (exclusif)
    const arr = target.closest<HTMLElement>(".row[data-arr]");
    if (arr) {
      const key = arr.dataset.arr!;
      openArr = openArr === key ? null : key;
      renderDashboard();
      return;
    }
    // clic sur une ville → accordéon exclusif (referme les autres + réinit arrondissement)
    const row = target.closest<HTMLElement>(".row[data-code]");
    if (!row) return;
    const code = row.dataset.code!;
    openCity = openCity === code ? null : code;
    openArr = null;
    renderDashboard();
  });
}

/* ---------- À explorer : liste complète groupée Continent → Pays ---------- */

function grouped(others: CityStats[]): string {
  if (others.length === 0) return `<p class="hint">Tu as flashé partout. Respect. 👾</p>`;
  const byContinent = new Map<string, Map<string, CityStats[]>>();
  for (const c of others) {
    const info = state.dataset?.cities[c.code];
    const cont = info?.continent || "Autres";
    const country = info?.country || "Autres";
    if (!byContinent.has(cont)) byContinent.set(cont, new Map());
    const byCountry = byContinent.get(cont)!;
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country)!.push(c);
  }

  const order = [...CONTINENT_ORDER.filter(cont => byContinent.has(cont)),
    ...[...byContinent.keys()].filter(k => !CONTINENT_ORDER.includes(k))];

  return order.map(cont => {
    const byCountry = byContinent.get(cont)!;
    const countries = [...byCountry.entries()].sort((a, b) => a[0].localeCompare(b[0], "fr"));
    return `
      <div class="group-title">${escapeHtml(cont)}</div>
      ${countries.map(([country, list]) => {
        const flag = state.dataset?.cities[list[0].code]?.flag ?? "";
        return `
          <div class="country-title">${flag ? flag + " " : ""}${escapeHtml(country)}</div>
          ${list.sort((a, b) => b.active - a.active).map(c => cityRow(c, false)).join("")}`;
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
