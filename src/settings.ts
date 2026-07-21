import { state, saveSettings, setGallery } from "./state";
import { fetchGallery, ApiError } from "./api";
import { escapeHtml } from "./dashboard";

const el = () => document.getElementById("view-settings")!;

export function renderSettings(): void {
  const s = state.settings;
  const meta = state.meta;
  const freshness = meta?.generated
    ? new Date(meta.generated).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })
    : "—";

  el().innerHTML = `
    <div class="card">
      <h2>Compte</h2>
      <div class="field">
        <label for="s-uid">Identifiant FlashInvaders (uid)</label>
        <input type="text" id="s-uid" value="${escapeHtml(s.uid)}" autocomplete="off" spellcheck="false" />
      </div>
      <button class="btn secondary" id="s-uid-save">Enregistrer et vérifier</button>
      <button class="btn secondary" id="s-uid-help" style="margin-top:8px">Comment récupérer mon uid ?</button>
      <p class="hint center" id="s-uid-msg"></p>
    </div>

    <div class="card">
      <h2>Compteurs</h2>
      ${toggleRow("s-damaged", "Inclure les dégradés", "Mosaïques abîmées mais toujours flashables", s.includeDamaged)}
      ${toggleRow("s-hidden", "Inclure les cachés", "Recouverts (échafaudage, végétation) — momentanément non flashables", s.includeHidden)}
      ${toggleRow("s-unknown", "Inclure les statuts inconnus", "État non confirmé par la communauté", s.includeUnknown)}
      <p class="hint">Les invaders détruits sont toujours exclus.</p>
    </div>

    <div class="card">
      <h2>Chasse</h2>
      <div class="field">
        <label>Distance d'échelle du radar : <b id="s-scale-label">${s.scaleDistance} m</b></label>
        <input type="range" id="s-scale" min="30" max="1000" step="10" value="${s.scaleDistance}" />
        <p class="hint">Portée « du plus froid au plus chaud ». En dessous de cette distance, le radar chauffe et la distance chiffrée se masque.</p>
      </div>
      ${toggleRow("s-sounds", "Sons du radar", "Blip sonar doux dont la cadence s'accélère quand tu chauffes", s.sounds)}
      ${toggleRow("s-haptics", "Vibrations", "Cadence qui s'accélère en approchant (Android — non supporté par iOS web)", s.haptics)}
      ${toggleRow("s-distance", "Toujours afficher la distance", "Sinon elle disparaît sous la distance d'échelle pour garder la chasse au tâtonnement", s.showDistanceAlways)}
    </div>

    <div class="card">
      <h2>À propos</h2>
      <p class="hint">
        Invader Radar ne montre <b>jamais</b> d'emplacement exact — uniquement des compteurs par zone
        et un radar de proximité sans direction. Base de données mise à jour quotidiennement
        (dernière génération : ${freshness}).
      </p>
      <p class="hint">
        Données : communauté <a href="https://github.com/goguelnikov/SpaceInvaders" target="_blank" rel="noopener">Space Invaders World Database</a>,
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> (ODbL),
        statuts <a href="https://www.invader-spotter.art/" target="_blank" rel="noopener">Invader Spotter</a>,
        quartiers <a href="https://opendata.paris.fr" target="_blank" rel="noopener">Open Data Paris</a>.
        Progression : API FlashInvaders. Projet indépendant, non affilié à Invader ni à FlashInvaders.
      </p>
    </div>
  `;

  wire();
}

function toggleRow(id: string, label: string, sub: string, checked: boolean): string {
  return `
    <div class="row">
      <div class="grow">
        <div class="title" style="font-size:15px">${label}</div>
        <div class="sub">${sub}</div>
      </div>
      <label class="switch"><input type="checkbox" id="${id}" ${checked ? "checked" : ""}/><i></i></label>
    </div>`;
}

function wire(): void {
  const root = el();
  root.querySelector<HTMLButtonElement>("#s-uid-help")!.addEventListener("click", async () => {
    (await import("./uidHelp")).openUidHelp();
  });
  const bind = (id: string, key: "includeDamaged" | "includeHidden" | "includeUnknown" | "sounds" | "haptics" | "showDistanceAlways") => {
    root.querySelector<HTMLInputElement>(`#${id}`)!.addEventListener("change", ev => {
      saveSettings({ [key]: (ev.target as HTMLInputElement).checked });
    });
  };
  bind("s-damaged", "includeDamaged");
  bind("s-hidden", "includeHidden");
  bind("s-unknown", "includeUnknown");
  bind("s-sounds", "sounds");
  bind("s-haptics", "haptics");
  bind("s-distance", "showDistanceAlways");

  const scale = root.querySelector<HTMLInputElement>("#s-scale")!;
  const scaleLabel = root.querySelector<HTMLElement>("#s-scale-label")!;
  scale.addEventListener("input", () => { scaleLabel.textContent = `${scale.value} m`; });
  scale.addEventListener("change", () => saveSettings({ scaleDistance: Number(scale.value) }));

  root.querySelector<HTMLButtonElement>("#s-uid-save")!.addEventListener("click", async () => {
    const uid = root.querySelector<HTMLInputElement>("#s-uid")!.value.trim();
    const msg = root.querySelector<HTMLElement>("#s-uid-msg")!;
    if (!uid) { msg.textContent = "uid vide."; return; }
    msg.textContent = "Vérification…";
    try {
      const g = await fetchGallery(uid);
      saveSettings({ uid });
      setGallery(g);
      msg.textContent = `OK — ${g.player?.name ?? "joueur"} · ${g.flashed.length} flashs.`;
    } catch (e) {
      msg.textContent = e instanceof ApiError ? e.message : "Erreur inattendue.";
    }
  });
}
