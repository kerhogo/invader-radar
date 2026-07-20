import { state, saveSettings } from "./state";
import { isActive, isFlashed, loadZones, zoneStats } from "./data";
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

function spriteSvg(): string {
  const rects = SPRITE.flatMap((row, y) =>
    [...row].map((c, x) => (c === "X" ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : ""))
  ).join("");
  return `<svg class="radar-core" viewBox="0 0 11 8" fill="#fff" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}

export function show(): void {
  render();
}

export function hide(): void {
  stop(false);
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
        <div class="stat"><b id="c-indoor">–</b><span>dont intérieur</span></div>
        <div class="stat"><b id="c-total">–</b><span>total rayon</span></div>
      </div>

      <div class="hunt-controls">
        <div class="field">
          <label>Rayon de détection : <b id="radius-label">${r} m</b></label>
          <input type="range" id="radius-slider" min="0" max="100" step="1" value="${fromRadius(r)}" />
        </div>
        <button class="btn" id="btn-hunt">Démarrer la chasse</button>
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
  el().querySelector<HTMLButtonElement>("#btn-hunt")!.textContent = "Terminer la chasse";
  setChip("🛰️ Calage GPS…");

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
  }
}

function requestWakeLock(): void {
  (navigator as any).wakeLock?.request("screen")
    .then((l: any) => { wakeLock = l; })
    .catch(() => {});
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

  currentHeat = Number.isFinite(nearest) ? heat(nearest) : 0;
  paint(currentHeat, { toFind, total, indoor });

  const nearestLine = el().querySelector<HTMLElement>("#nearest-line");
  if (nearestLine) {
    nearestLine.textContent = Number.isFinite(nearest) && nearest < 5000
      ? `Le plus proche à trouver : ${fuzzyDistance(nearest)}`
      : "Aucun invader à trouver à moins de 5 km";
  }

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
}

/* ---------- Son « compteur Geiger » ---------- */

function scheduleTick(): void {
  if (!running) return;
  const interval = tickInterval(currentHeat);
  tickTimer = window.setTimeout(() => {
    if (state.settings.sounds && Number.isFinite(interval)) tick();
    scheduleTick();
  }, Number.isFinite(interval) ? interval : 500);
}

function tick(): void {
  if (!audioCtx || audioCtx.state !== "running") return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "square";
  osc.frequency.value = 880 + currentHeat * 880;
  gain.gain.setValueAtTime(0.12, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.06);
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
