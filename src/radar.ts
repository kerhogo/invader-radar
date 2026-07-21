import { state, saveSettings, setGallery } from "./state";
import { isActive, isFlashed, loadZones, zoneStats } from "./data";
import { fetchGallery } from "./api";
import { haversine, pointInGeometry } from "./geo";
import { heat, heatColor, ringSize, tickInterval } from "./calibration";
import { fmt } from "./dashboard";

const el = () => document.getElementById("view-hunt")!;

let running = false;
let watchId: number | null = null;
let wakeLock: any = null;
let audioCtx: AudioContext | null = null;
let tickTimer: number | null = null;
let currentHeat = 0;
let bestFix: { pos: GeolocationPosition; at: number } | null = null;
let captureState: "none" | "camera" | "refresh" = "none";
let pendingReturn = false;
const trail: Array<{ lat: number; lng: number }> = [];

/* Rayon : curseur logarithmique 3 m → 1 km (précis sur les petites valeurs). */
const R_MIN = 3, R_MAX = 1000;
function toRadius(v: number): number {
  const r = R_MIN * Math.pow(R_MAX / R_MIN, v / 100);
  return r < 20 ? Math.round(r) : r < 100 ? Math.round(r / 5) * 5 : Math.round(r / 10) * 10;
}
function fromRadius(r: number): number {
  const c = Math.min(R_MAX, Math.max(R_MIN, r));
  return Math.round((100 * Math.log(c / R_MIN)) / Math.log(R_MAX / R_MIN));
}

/* Sprite invader pixel-art (dessin maison). */
const SPRITE = [
  "..X.....X..",
  "...X...X...",
  "..XXXXXXX..",
  ".XX.XXX.XX.",
  "XXXXXXXXXXX",
  "X.XXXXXXX.X",
  "X.X.....X.X",
  "...XX.XX..."
];

function spriteSvg(cls = "radar-core"): string {
  const rects = SPRITE.flatMap((row, y) =>
    [...row].map((c, x) => (c === "X" ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : ""))
  ).join("");
  return `<svg class="${cls}" viewBox="0 0 11 8" fill="#fff" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}

const CAMERA_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3l2-2.5h6L17 7h3a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 19H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 7z"/><circle cx="12" cy="12.5" r="3.4"/></svg>`;
const REFRESH_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/></svg>`;

export function show(): void {
  // le DOM du radar est persistant : on ne le reconstruit jamais pendant une chasse
  if (!el().querySelector("#hunt-screen")) render();
}

/** Changer d'onglet ne stoppe PAS la chasse (elle vit jusqu'à « Terminer »). */
export function hide(): void {}

export function isRunning(): boolean {
  return running;
}

function render(): void {
  const r = Math.max(R_MIN, state.settings.radius);
  el().innerHTML = `
    <div id="hunt-screen">
      <div class="hunt-top">
        <span class="gps-chip" id="gps-chip">📡 Radar en veille</span>
      </div>

      <div class="radar-zone">
        <div class="radar-stage" id="radar-stage">
          <div class="radar-pulse" style="animation-delay:0s"></div>
          <div class="radar-pulse" style="animation-delay:1.3s"></div>
          <div class="radar-ring" id="radar-ring"></div>
          ${spriteSvg()}
        </div>
      </div>

      <p class="nearest" id="nearest-line"></p>

      <div class="hunt-counts">
        <div class="stat"><b id="c-tofind">–</b><span>à trouver</span></div>
        <div class="stat" id="stat-indoor" hidden><b id="c-indoor">–</b><span>dont intérieur</span></div>
        <div class="stat"><b id="c-total">–</b><span>total rayon</span></div>
      </div>

      <div class="hunt-controls">
        <div class="field">
          <label>Rayon de détection : <b id="radius-label">${r} m</b></label>
          <input type="range" id="radius-slider" min="0" max="100" step="1" value="${fromRadius(r)}" />
        </div>
        <div class="hunt-actions">
          <button class="btn" id="btn-hunt">Démarrer la chasse</button>
          <button class="btn icon-only" id="btn-capture" hidden aria-label="Flasher"></button>
        </div>
      </div>
    </div>
  `;
  wire();
  paint(0, null);
}

function wire(): void {
  const root = el();
  const slider = root.querySelector<HTMLInputElement>("#radius-slider")!;
  const label = root.querySelector<HTMLElement>("#radius-label")!;

  slider.addEventListener("input", () => {
    label.textContent = `${toRadius(Number(slider.value))} m`;
  });
  slider.addEventListener("change", () => {
    saveSettings({ radius: toRadius(Number(slider.value)) });
    if (bestFix) update(bestFix.pos);
  });
  root.querySelector<HTMLButtonElement>("#btn-hunt")!.addEventListener("click", () => {
    running ? stop(true) : start();
  });
  root.querySelector<HTMLButtonElement>("#btn-capture")!.addEventListener("click", onCapture);
}

function setChip(text: string, warn = false): void {
  const chip = el().querySelector<HTMLElement>("#gps-chip");
  if (chip) { chip.textContent = text; chip.classList.toggle("warn", warn); }
}

function start(): void {
  if (!("geolocation" in navigator)) {
    setChip("⚠️ Géolocalisation indisponible", true);
    return;
  }
  running = true;
  trail.length = 0;
  bestFix = null;
  setCapture("none");
  el().querySelector<HTMLButtonElement>("#btn-hunt")!.textContent = "Terminer la chasse";
  setChip("🛰️ Calage GPS…");
  createWidget();

  // Contexte audio créé dans le geste utilisateur (exigence iOS)
  if (state.settings.sounds && !audioCtx) {
    try { audioCtx = new AudioContext(); } catch { audioCtx = null; }
  }
  audioCtx?.resume().catch(() => {});
  requestWakeLock();

  watchId = navigator.geolocation.watchPosition(onFix, err => {
    setChip(err.code === err.PERMISSION_DENIED
      ? "⚠️ Localisation refusée (Réglages → Safari)"
      : "🛰️ Signal GPS introuvable…", true);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });

  document.addEventListener("visibilitychange", onVisibility);
  scheduleTick();
}

function stop(showSummary: boolean): void {
  if (!running) return;
  running = false;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (tickTimer !== null) { clearTimeout(tickTimer); tickTimer = null; }
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  document.removeEventListener("visibilitychange", onVisibility);
  currentHeat = 0;
  setCapture("none");
  removeWidget();

  const btn = el().querySelector<HTMLButtonElement>("#btn-hunt");
  if (btn) btn.textContent = "Démarrer la chasse";
  setChip("📡 Radar en veille");
  const nearest = el().querySelector<HTMLElement>("#nearest-line");
  if (nearest) nearest.textContent = "";
  paint(0, null);

  if (showSummary && trail.length > 1) void walkSummary();
}

function onVisibility(): void {
  if (document.visibilityState === "visible") {
    requestWakeLock();
    audioCtx?.resume().catch(() => {});
    if (pendingReturn && running) {
      pendingReturn = false;
      setCapture("refresh");
    }
  }
}

function requestWakeLock(): void {
  (navigator as any).wakeLock?.request("screen")
    .then((l: any) => { wakeLock = l; })
    .catch(() => {});
}

/* ---------- Flux capture (< 20 m) ---------- */

function setCapture(mode: "none" | "camera" | "refresh"): void {
  captureState = mode;
  const btn = el().querySelector<HTMLButtonElement>("#btn-capture");
  if (!btn) return;
  btn.hidden = mode === "none";
  btn.disabled = false;
  btn.innerHTML = mode === "refresh" ? REFRESH_SVG : CAMERA_SVG;
  btn.setAttribute("aria-label", mode === "refresh" ? "Actualiser mes flashs" : "Ouvrir FlashInvaders");
}

async function onCapture(): Promise<void> {
  if (captureState === "camera") {
    pendingReturn = true;
    // Meilleur essai : schéma d'URL de l'app officielle (sans effet si non installée)
    location.href = "flashinvaders://";
    return;
  }
  if (captureState === "refresh") {
    // même action que « Actualiser mes flashs » du Tableau : recharge la galerie
    const btn = el().querySelector<HTMLButtonElement>("#btn-capture");
    if (btn) { btn.disabled = true; btn.classList.add("spinning"); }
    try {
      if (state.settings.uid) setGallery(await fetchGallery(state.settings.uid));
    } catch { /* le cache local reste bon */ }
    setCapture("none");
    if (bestFix) update(bestFix.pos); // recompte : l'invader flashé disparaît des « à trouver »
  }
}

/* ---------- Mini-widget (chasse active sur les autres onglets) ---------- */

function createWidget(): void {
  if (document.getElementById("hunt-widget")) return;
  const w = document.createElement("button");
  w.id = "hunt-widget";
  w.innerHTML = `${spriteSvg("hw-sprite")}<span id="hw-text">Radar actif</span>`;
  document.body.appendChild(w);
}

function removeWidget(): void {
  document.getElementById("hunt-widget")?.remove();
}

function updateWidget(t: number, toFind: number | null, distanceText: string): void {
  const w = document.getElementById("hunt-widget");
  if (!w) return;
  w.style.background = heatColor(Math.max(0.06, t));
  const txt = document.getElementById("hw-text");
  if (txt) {
    txt.textContent = toFind === null
      ? "Radar actif"
      : `${fmt(toFind)} à trouver${distanceText ? ` · ${distanceText}` : ""}`;
  }
}

/* ---------- Cœur du radar ---------- */

function targets() {
  const items = state.dataset?.items ?? [];
  const out: Array<{ lat: number; lng: number; flashed: boolean; indoor: boolean }> = [];
  for (const inv of items) {
    if (inv.lat === undefined || inv.lng === undefined || !isActive(inv)) continue;
    out.push({ lat: inv.lat, lng: inv.lng, flashed: isFlashed(inv), indoor: !!inv.indoor });
  }
  return out;
}

/** Distance arrondie pour l'affichage (pas de fausse précision GPS). */
function fuzzyDistance(d: number): string {
  if (d < 5) return "moins de 5 m";
  if (d < 100) return `~${Math.round(d / 5) * 5} m`;
  if (d < 1000) return `~${Math.round(d / 10) * 10} m`;
  return `~${(d / 1000).toFixed(1).replace(".", ",")} km`;
}

/** Le premier fix iOS est souvent grossier (réseau/wifi) : on garde le plus
    précis des 12 dernières secondes, le temps que le GPS se cale. */
function onFix(pos: GeolocationPosition): void {
  if (!running) return;
  const now = Date.now();
  if (!bestFix || pos.coords.accuracy <= bestFix.pos.coords.accuracy || now - bestFix.at > 12000) {
    bestFix = { pos, at: now };
  }
  update(bestFix.pos);
}

function update(pos: GeolocationPosition): void {
  if (!running) return;
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;

  // trace locale pour le bilan de balade (jamais envoyée nulle part)
  const prev = trail[trail.length - 1];
  if (!prev || haversine(prev.lat, prev.lng, lat, lng) > 15) trail.push({ lat, lng });

  const radius = state.settings.radius;
  let nearest = Infinity;
  let total = 0, toFind = 0, indoor = 0;

  for (const t of targets()) {
    const d = haversine(lat, lng, t.lat, t.lng);
    if (d <= radius) {
      total++;
      if (!t.flashed) {
        toFind++;
        if (t.indoor) indoor++;
      }
    }
    if (!t.flashed && d < nearest) nearest = d;
  }

  // Échelle du radar : distance réglable par l'utilisateur (200 m par défaut)
  const scale = state.settings.scaleDistance;
  currentHeat = Number.isFinite(nearest) ? heat(nearest, scale) : 0;

  // Distance : masquée sous l'échelle (chasse au tâtonnement), sauf réglage forcé
  const showDist = state.settings.showDistanceAlways || nearest > scale;
  const distText = Number.isFinite(nearest) && nearest < 5000 ? fuzzyDistance(nearest) : "";
  const nearestLine = el().querySelector<HTMLElement>("#nearest-line");
  if (nearestLine) {
    nearestLine.textContent = !Number.isFinite(nearest) || nearest >= 5000
      ? "Aucun invader à trouver à moins de 5 km"
      : showDist ? `Le plus proche à trouver : ${distText}` : "";
  }

  paint(currentHeat, { toFind, total, indoor });
  updateWidget(currentHeat, toFind, showDist ? distText : "");

  // Flux capture : un invader à portée de flash (hystérésis 25 m / 30 m)
  if (Number.isFinite(nearest) && nearest < 25 && captureState === "none") setCapture("camera");
  else if ((!Number.isFinite(nearest) || nearest > 30) && captureState === "camera") setCapture("none");

  const acc = Math.round(accuracy);
  if (accuracy > 150) setChip(`🛰️ Calage GPS… ±${acc} m`);
  else setChip(`📡 GPS ±${acc} m`, accuracy > Math.max(radius, 15));
}

function paint(t: number, counts: { toFind: number; total: number; indoor: number } | null): void {
  const screen = el().querySelector<HTMLElement>("#hunt-screen");
  if (!screen) return;
  screen.style.setProperty("--hunt-bg", heatColor(t));

  const ring = screen.querySelector<HTMLElement>("#radar-ring")!;
  const pct = ringSize(t) * 100;
  ring.style.width = `${pct}%`;
  ring.style.height = `${pct}%`;
  ring.style.opacity = t <= 0.02 && counts === null ? "0.35" : "1";

  const set = (id: string, v: string) => {
    const n = screen.querySelector<HTMLElement>(id);
    if (n) n.textContent = v;
  };
  set("#c-tofind", counts ? fmt(counts.toFind) : "–");
  set("#c-indoor", counts ? fmt(counts.indoor) : "–");
  set("#c-total", counts ? fmt(counts.total) : "–");
  const indoorStat = screen.querySelector<HTMLElement>("#stat-indoor");
  if (indoorStat) indoorStat.hidden = !counts || counts.indoor === 0;
}

/* ---------- Son « compteur Geiger » + vibrations ---------- */

function scheduleTick(): void {
  if (!running) return;
  const interval = tickInterval(currentHeat);
  tickTimer = window.setTimeout(() => {
    if (Number.isFinite(interval)) {
      if (state.settings.sounds) tick();
      // Vibration API : Android uniquement (iOS web ne l'expose pas)
      if (state.settings.haptics) (navigator as any).vibrate?.(15 + Math.round(currentHeat * 25));
    }
    scheduleTick();
  }, Number.isFinite(interval) ? interval : 500);
}

/* Blip sonar doux : sinusoïde filtrée passe-bas, montée/descente progressives —
   bien plus agréable que le tic carré façon Geiger. La hauteur monte avec la chaleur. */
function tick(): void {
  if (!audioCtx || audioCtx.state !== "running") return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const lp = audioCtx.createBiquadFilter();
  osc.type = "sine";
  const f = 430 + currentHeat * 340;
  osc.frequency.setValueAtTime(f, t0);
  osc.frequency.exponentialRampToValueAtTime(f * 1.5, t0 + 0.11);
  lp.type = "lowpass";
  lp.frequency.value = 1400;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.05 + currentHeat * 0.03, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
  osc.connect(lp).connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.18);
}

/* ---------- Bilan de balade (anti-frustration, niveau zone uniquement) ---------- */

async function walkSummary(): Promise<void> {
  const ds = state.dataset;
  if (!ds) return;

  // Villes plausibles : à moins de 5 km d'un point de la trace
  const visited = new Map<string, Set<string>>(); // ville → zones z1 traversées
  for (const [code, info] of Object.entries(ds.cities)) {
    if (trail.some(p => haversine(p.lat, p.lng, info.lat, info.lng) < 5000)) {
      visited.set(code, new Set());
    }
  }

  for (const code of visited.keys()) {
    const gj = await loadZones(`${code}-z1.geojson`);
    if (!gj) continue;
    for (const p of trail) {
      for (const f of gj.features) {
        if (pointInGeometry(p.lng, p.lat, f.geometry)) {
          visited.get(code)!.add(f.properties.name);
          break;
        }
      }
    }
  }

  const lines: string[] = [];
  for (const [code, zones] of visited) {
    const stats = zoneStats(code, "z1");
    for (const z of zones) {
      const s = stats.get(z);
      if (!s) continue;
      const left = s.active - s.found;
      lines.push(left === 0
        ? `<div class="row"><div class="grow"><div class="title" style="font-size:15px">✅ ${z}</div><div class="sub">Quartier complété, chapeau !</div></div></div>`
        : `<div class="row"><div class="grow"><div class="title" style="font-size:15px">👾 ${z}</div><div class="sub">Encore ${left} à trouver${s.indoorLeft ? ` (dont ${s.indoorLeft} en intérieur)` : ""}</div></div></div>`);
    }
  }

  const screen = el().querySelector<HTMLElement>("#hunt-screen");
  if (!screen || lines.length === 0) return;
  const sheet = document.createElement("div");
  sheet.className = "zone-sheet";
  sheet.innerHTML = `
    <button class="close" aria-label="Fermer">✕</button>
    <h3>Bilan de balade</h3>
    <p class="hint" style="color:rgba(255,255,255,0.8)">Zones traversées pendant cette session :</p>
    ${lines.join("")}
  `;
  sheet.querySelector(".close")!.addEventListener("click", () => sheet.remove());
  screen.appendChild(sheet);
}
