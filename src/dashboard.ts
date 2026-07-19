import { state, setGallery } from "./state";
import { fetchGallery, ApiError } from "./api";
import { cityStats } from "./data";

const el = () => document.getElementById("view-dashboard")!;

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
  const destroyedTotal = cities.reduce((s, c) => s + c.destroyed, 0);

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

    <div class="card">
      <h2>Mes villes</h2>
      ${played.map(cityRow).join("") || `<p class="hint">Aucun flash pour l'instant — la chasse commence !</p>`}
    </div>

    <div class="card">
      <h2>À explorer</h2>
      ${others.slice(0, 12).map(cityRow).join("")}
      ${others.length > 12 ? `<p class="hint center mt">et ${others.length - 12} autres villes invadées…</p>` : ""}
    </div>

    <p class="hint center">${fmt(destroyedTotal)} invaders détruits sont exclus des compteurs.<br>
    Zones et compteurs = base communautaire ; ta progression = API officielle.</p>
    <button class="btn secondary" id="btn-refresh">Actualiser mes flashs</button>
    <p class="hint center" id="refresh-msg"></p>
  `;

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

function cityRow(c: ReturnType<typeof cityStats>[number]): string {
  const denom = c.official ?? c.active;
  const left = Math.max(0, c.active - c.found);
  const pct = denom > 0 ? Math.min(100, Math.round((c.foundTotal / denom) * 100)) : 0;
  const done = denom > 0 && c.foundTotal >= denom;
  const subs: string[] = [];
  if (c.foundTotal > 0 || c.active > 0) subs.push(`${fmt(left)} restants`);
  if (c.unlocated > 0) subs.push(`${fmt(c.unlocated)} non localisés`);
  return `
    <div class="row">
      <div class="grow">
        <div class="title">${escapeHtml(c.name)}</div>
        <div class="sub">${subs.join(" · ")}</div>
        <div class="progress ${done ? "done" : ""}"><i style="width:${pct}%"></i></div>
      </div>
      <div class="val">${fmt(c.foundTotal)}<span style="color:var(--text-2)">/${fmt(denom)}</span></div>
    </div>`;
}

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
      <p class="hint">Il reste sur ton téléphone, il n'est envoyé qu'à l'API FlashInvaders
      (comme le fait l'app officielle) pour lire ta progression automatiquement.</p>
      <button class="btn" id="btn-uid-save">C'est parti</button>
      <p class="hint center" id="uid-msg"></p>
    </div>`;
}

function wireOnboarding(): void {
  const root = el();
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
