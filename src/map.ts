import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { state, on } from "./state";
import { cityStats, zoneStats, loadZones } from "./data";
import { haversine, pointInGeometry } from "./geo";
import { fmt, escapeHtml } from "./dashboard";

const BASE_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/* Palette choroplèthe alignée sur la DA : navy (à explorer) → ambre → vert. */
const COLOR_EXPR: any = [
  "interpolate", ["linear"], ["get", "pct"],
  0, "#64789a",
  0.5, "#ffb340",
  1, "#30d158"
];
const TEXT_COLOR = "#eaf2ff";
const HALO_COLOR = "#081428";

let map: maplibregl.Map | null = null;
let ready = false;
let pendingFocus: string | null = null;
const zoneLayers = new Set<string>();

/* Seuils de zoom : bulles monde → arrondissements/communes tôt au dézoom → quartiers */
const Z_BUBBLE_MAX = 9.3;
const Z_MID: [number, number] = [9.3, 11.2];
const Z_FINE: [number, number] = [11.2, 24];

/** Centre la carte sur une ville (appelé depuis le dashboard). */
export function focusCity(code: string): void {
  const info = state.dataset?.cities[code];
  if (!info) return;
  if (!map || !ready) { pendingFocus = code; return; }
  if (info.outline) { void fitOutline(code); return; }
  if (!info.lat && !info.lng) return; // aucune position connue pour cette ville
  map.flyTo({ center: [info.lng, info.lat], zoom: info.zones ? 10.8 : 12.3 });
}

/** Cadre la carte sur le contour d'une ville sans sous-découpage. */
async function fitOutline(code: string): Promise<void> {
  const gj = await loadZones(`${code}-outline.geojson`);
  const info = state.dataset?.cities[code];
  if (!map || !info) return;
  void ensureShape(code); // le contour s'affiche même si son centre reste hors champ
  map.resize(); // la vue vient peut-être d'être réaffichée : le cadrage se calcule sur sa taille réelle
  const bounds = new maplibregl.LngLatBounds();
  const walk = (c: any): void => { if (typeof c[0] === "number") bounds.extend(c as [number, number]); else c.forEach(walk); };
  for (const f of gj?.features ?? []) walk(f.geometry.coordinates);
  const camera = bounds.isEmpty() ? undefined : map.cameraForBounds(bounds, { padding: 48, maxZoom: 13 });
  const minZoom = Z_BUBBLE_MAX + 0.3; // en deçà, c'est la bulle qui s'affiche, pas le contour
  if (camera && camera.zoom !== undefined && camera.zoom >= minZoom) {
    map.flyTo({ center: camera.center, zoom: camera.zoom });
    return;
  }
  // contour trop étendu pour tenir à l'écran (une région entière) : on vise son étiquette
  const label = gj?.features?.[0] ? labelPoint(gj.features[0].geometry, true) : null;
  map.flyTo({ center: label ?? [info.lng, info.lat], zoom: minZoom });
}

/** Point d'étiquette d'un polygone : moyenne des sommets de son premier anneau — ou, pour un
    contour de ville (`largest`), de son plus grand morceau, pour ne pas viser un îlot. */
function labelPoint(geometry: GeoJSON.Geometry, largest = false): [number, number] | null {
  const rings: [number, number][][] =
    geometry.type === "Polygon" ? [(geometry.coordinates as any)[0]]
    : geometry.type === "MultiPolygon" ? (geometry.coordinates as any).map((p: any) => p[0]) : [];
  if (!rings.length) return null;
  const ring = largest ? rings.reduce((a, b) => (b.length > a.length ? b : a)) : rings[0];
  let sx = 0, sy = 0;
  for (const [x, y] of ring) { sx += x; sy += y; }
  const n = Math.max(1, ring.length);
  const mean: [number, number] = [sx / n, sy / n];
  if (!largest || pointInGeometry(mean[0], mean[1], { type: "Polygon", coordinates: [ring] })) return mean;
  // contour concave (une baie, un croissant) : la moyenne tombe dehors — centre de l'emprise à la place
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const box: [number, number] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  return pointInGeometry(box[0], box[1], { type: "Polygon", coordinates: [ring] }) ? box : mean;
}

export function show(): void {
  const root = document.getElementById("view-map")!;
  if (!map) {
    root.innerHTML = `
      <div id="map-root"></div>
      <div class="map-overlay-top">
        <div class="map-legend">
          <i style="background:#64789a"></i> à explorer
          <i style="background:#ffb340"></i> en cours
          <i style="background:#30d158"></i> complété
        </div>
      </div>`;
    void initMap();
  } else {
    requestAnimationFrame(() => map!.resize());
  }
}

/* ---------- Fond de carte recoloré « navy sonar » ----------
   dark-matter est trop noir : on remappe chaque couleur du style selon sa
   luminance sur une rampe navy → glace, eau à part. Déterministe et lisible. */

const NAVY_DARK: [number, number, number] = [9, 22, 44];
const NAVY_LIGHT: [number, number, number] = [176, 205, 245];
const WATER: [number, number, number] = [14, 34, 66];

function parseColor(c: string): [number, number, number, number] | null {
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map(x => x + x).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const rgb = c.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const p = rgb[1].split(",").map(s => parseFloat(s));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  return null;
}

function remapColor(c: string, isWater: boolean): string {
  const parsed = parseColor(c);
  if (!parsed) return c;
  const [r, g, b, a] = parsed;
  const lum = Math.pow((0.299 * r + 0.587 * g + 0.114 * b) / 255, 0.82);
  const target = isWater ? WATER : NAVY_LIGHT;
  const base = isWater ? [Math.round(WATER[0] * 0.6), Math.round(WATER[1] * 0.6), Math.round(WATER[2] * 0.6)] : NAVY_DARK;
  const out = base.map((v, i) => Math.round(v + (target[i] - v) * (isWater ? 0.5 + lum * 0.5 : lum)));
  return `rgba(${out[0]}, ${out[1]}, ${out[2]}, ${a})`;
}

function remapValue(v: any, isWater: boolean): any {
  if (typeof v === "string") return remapColor(v, isWater);
  if (v && typeof v === "object" && Array.isArray(v.stops)) {
    return { ...v, stops: v.stops.map(([z, c]: any) => [z, typeof c === "string" ? remapColor(c, isWater) : c]) };
  }
  if (Array.isArray(v)) return v.map(x => (typeof x === "string" && parseColor(x) ? remapColor(x, isWater) : x));
  return v;
}

async function navyStyle(): Promise<any> {
  const res = await fetch(BASE_STYLE);
  const style = await res.json();
  for (const layer of style.layers ?? []) {
    const isWater = /water|ocean|river/i.test(layer.id);
    for (const bag of [layer.paint, layer.layout]) {
      if (!bag) continue;
      for (const key of Object.keys(bag)) {
        if (key.endsWith("-color")) bag[key] = remapValue(bag[key], isWater);
      }
    }
    if (layer.type === "background") {
      layer.paint = { ...(layer.paint ?? {}), "background-color": "rgb(9, 22, 44)" };
    }
  }
  return style;
}

async function initMap(): Promise<void> {
  const style = await navyStyle().catch(() => BASE_STYLE);
  map = new maplibregl.Map({
    container: "map-root",
    style,
    center: [2.34, 48.86],
    zoom: 10.7,
    minZoom: 1.2,
    maxZoom: 15.2, // plafond anti-spoiler : on ne descend jamais au niveau « rue précise »
    attributionControl: { compact: true } as any
  });
  if (import.meta.env.DEV) (window as any).__map = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showAccuracyCircle: false
  }), "bottom-right");

  map.on("load", async () => {
    ready = true;
    addCities();
    await addZones();
    const refresh = () => { if (ready) { updateCities(); void updateZones(); } };
    on("gallery", refresh);
    on("settings", refresh);
    on("dataset", refresh);
    if (pendingFocus) { focusCity(pendingFocus); pendingFocus = null; }
  });
}

/* ---------- Villes (bulles) ---------- */

function citiesGeoJSON(): GeoJSON.FeatureCollection {
  const feats: GeoJSON.Feature[] = [];
  for (const c of cityStats()) {
    if (!c.lat || c.active + c.foundTotal === 0) continue;
    const denom = c.official ?? c.active;
    feats.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lng, c.lat] },
      properties: {
        code: c.code,
        name: c.name,
        found: c.foundTotal,
        active: c.active,
        label: `${c.foundTotal}/${denom}`,
        pct: denom > 0 ? Math.min(1, c.foundTotal / denom) : 0,
        size: Math.sqrt(Math.max(4, c.active)),
        // au zoom, la bulle cède la place à la choroplèthe (ville découpée) ou au contour de la ville
        hasZones: !!state.dataset?.cities[c.code]?.zones,
        hasShape: !!(state.dataset?.cities[c.code]?.zones || state.dataset?.cities[c.code]?.outline)
      }
    });
  }
  return { type: "FeatureCollection", features: feats };
}

function circlePaint(): any {
  return {
    "circle-radius": ["interpolate", ["linear"], ["get", "size"], 2, 8, 40, 26],
    "circle-color": COLOR_EXPR,
    "circle-opacity": 0.85,
    "circle-stroke-width": 2,
    "circle-stroke-color": "rgba(234, 242, 255, 0.85)"
  };
}

function labelLayout(): any {
  return {
    "text-field": ["format",
      ["get", "name"], { "font-scale": 0.9 }, "\n", {},
      ["get", "label"], { "font-scale": 1.05 }],
    "text-font": ["Open Sans Bold"],
    "text-size": 12,
    "text-offset": [0, 1.7],
    "text-allow-overlap": false
  };
}

function addCities(): void {
  if (!map) return;
  map.addSource("cities", { type: "geojson", data: citiesGeoJSON() });

  // Vue monde : toutes les villes jusqu'au seuil du découpage
  map.addLayer({
    id: "cities-circle", type: "circle", source: "cities", maxzoom: Z_BUBBLE_MAX,
    paint: circlePaint()
  });
  map.addLayer({
    id: "cities-label", type: "symbol", source: "cities", maxzoom: Z_BUBBLE_MAX,
    layout: labelLayout(),
    paint: { "text-color": TEXT_COLOR, "text-halo-color": HALO_COLOR, "text-halo-width": 1.4 }
  });
  // Zoom rapproché : seules les villes sans découpage NI contour gardent leur bulle
  map.addLayer({
    id: "cities-circle-close", type: "circle", source: "cities", minzoom: Z_BUBBLE_MAX,
    filter: ["!", ["get", "hasShape"]],
    paint: circlePaint()
  });
  map.addLayer({
    id: "cities-label-close", type: "symbol", source: "cities", minzoom: Z_BUBBLE_MAX,
    filter: ["!", ["get", "hasShape"]],
    layout: labelLayout(),
    paint: { "text-color": TEXT_COLOR, "text-halo-color": HALO_COLOR, "text-halo-width": 1.4 }
  });

  for (const layerId of ["cities-circle", "cities-circle-close"]) {
    map.on("click", layerId, ev => {
      const p = ev.features?.[0]?.properties as any;
      if (!p) return;
      openCitySheet(p);
      if (Number(map!.getZoom()) < Z_BUBBLE_MAX) {
        if (p.hasShape && !p.hasZones) void fitOutline(String(p.code));
        else map!.flyTo({ center: (ev.features![0].geometry as any).coordinates, zoom: p.hasZones ? 10.5 : 12.3 });
      }
    });
    map.on("mouseenter", layerId, () => { map!.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layerId, () => { map!.getCanvas().style.cursor = ""; });
  }
}

/** Fiche d'une ville (bulle ou contour) : mêmes chiffres dans les deux cas. */
function openCitySheet(p: any): void {
  openSheet(String(p.name),
    `<div class="stat-row">
       <div class="stat ok"><b>${fmt(Number(p.found))}</b><span>flashés</span></div>
       <div class="stat accent"><b>${fmt(Math.max(0, Number(p.active) - Number(p.found)))}</b><span>restants localisés</span></div>
     </div>
     ${p.hasZones ? `<p class="hint mt">Zoome pour le détail par zone.</p>` : ""}`);
}

function updateCities(): void {
  (map?.getSource("cities") as maplibregl.GeoJSONSource | undefined)?.setData(citiesGeoJSON());
}

/* ---------- Zones administratives (choroplèthe adaptative) ---------- */

async function zoneGeoJSON(code: string, level: "z1" | "z2"): Promise<GeoJSON.FeatureCollection | null> {
  const gj = await loadZones(`${code}-${level}.geojson`);
  if (!gj) return null;
  const stats = zoneStats(code, level);
  const feats = (gj.features as GeoJSON.Feature[]).map(f => {
    const name = (f.properties as any).name as string;
    const s = stats.get(name);
    const found = s?.found ?? 0;
    const active = s?.active ?? 0;
    return {
      ...f,
      properties: {
        ...f.properties,
        found, active,
        indoorLeft: s?.indoorLeft ?? 0,
        label: active > 0 ? `${found}/${active}` : "",
        pct: active > 0 ? found / active : -1 // -1 = zone sans invader → quasi invisible
      }
    };
  });
  return { type: "FeatureCollection", features: feats };
}

function centroids(fc: GeoJSON.FeatureCollection, largest = false): GeoJSON.FeatureCollection {
  const feats = fc.features
    .filter(f => (f.properties as any).label)
    .map(f => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: labelPoint(f.geometry, largest) ?? [0, 0] },
      properties: f.properties
    }) as GeoJSON.Feature);
  return { type: "FeatureCollection", features: feats };
}

async function addZones(): Promise<void> {
  if (!map || !state.dataset) return;
  // Chargement à la demande : les 45 villes zonées pèsent 8 Mo de GeoJSON.
  // On ne récupère que celles visibles à l'écran, au fil des déplacements.
  await loadVisibleZones();
  map.on("moveend", () => void loadVisibleZones());
}

const loadedZones = new Set<string>();
const loadingZones = new Set<string>();

async function loadVisibleZones(): Promise<void> {
  if (!map || !state.dataset) return;
  if (map.getZoom() < Z_MID[0]) return; // vue monde : seules les bulles servent
  const bounds = map.getBounds();
  const c = map.getCenter();
  const pending: Array<Promise<void>> = [];
  for (const [code, info] of Object.entries(state.dataset.cities)) {
    if (!(info.zones || info.outline)) continue;
    // dans le cadre, ou assez près du centre (cas d'un zoom sur un quartier, où le point
    // « centre-ville » peut être hors champ) — un contour étendu se charge d'aussi loin qu'il porte
    const near = bounds.contains([info.lng, info.lat])
      || haversine(c.lat, c.lng, info.lat, info.lng) < Math.max(25000, (info.reach ?? 0) * 1000);
    if (!near) continue;
    const loading = ensureShape(code);
    if (loading) pending.push(loading);
  }
  await Promise.all(pending);
}

/** Charge une fois les polygones d'une ville (zones, ou contour) ; null si c'est fait ou en cours. */
function ensureShape(code: string): Promise<void> | null {
  const info = state.dataset?.cities[code];
  if (!info || !(info.zones || info.outline) || loadedZones.has(code) || loadingZones.has(code)) return null;
  loadingZones.add(code);
  const job: Promise<boolean> = info.zones ? addCityZones(code).then(() => true) : addCityOutline(code);
  return job.then(done => {
    if (done) loadedZones.add(code); // contour non chargé (réseau) : nouvel essai au prochain déplacement
    loadingZones.delete(code);
  }).catch(() => { loadingZones.delete(code); });
}

/** Couches d'un jeu de polygones : aplat coloré selon l'avancement, liseré, étiquette au centre. */
function addShapeLayers(src: string, data: GeoJSON.FeatureCollection, minz: number, maxz: number, largest = false): void {
  if (!map) return;
  map.addSource(src, { type: "geojson", data });
  map.addSource(`${src}-pts`, { type: "geojson", data: centroids(data, largest) });

  map.addLayer({
    id: `${src}-fill`,
    type: "fill",
    source: src,
    minzoom: minz,
    maxzoom: maxz,
    paint: {
      "fill-color": COLOR_EXPR,
      "fill-opacity": ["case", ["<", ["get", "pct"], 0], 0.05, 0.34]
    }
  });
  map.addLayer({
    id: `${src}-line`,
    type: "line",
    source: src,
    minzoom: minz,
    maxzoom: maxz,
    paint: {
      "line-color": "rgba(160, 195, 245, 0.4)",
      "line-width": 1
    }
  });
  map.addLayer({
    id: `${src}-label`,
    type: "symbol",
    source: `${src}-pts`,
    minzoom: minz,
    maxzoom: maxz,
    layout: {
      "text-field": ["format",
        ["get", "name"], { "font-scale": 0.78 }, "\n", {},
        ["get", "label"], { "font-scale": 1.1 }],
      "text-font": ["Open Sans Bold"],
      "text-size": 13
    },
    paint: {
      "text-color": TEXT_COLOR,
      "text-halo-color": HALO_COLOR,
      "text-halo-width": 1.5
    }
  });
  map.on("mouseenter", `${src}-fill`, () => { map!.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", `${src}-fill`, () => { map!.getCanvas().style.cursor = ""; });
}

/* ---------- Contour des villes sans sous-découpage ----------
   Au zoom, le contour de la ville remplace sa bulle : même rendu qu'une zone, avec les chiffres
   de la ville entière. Une bulle posée au milieu des invaders d'une ville qui n'en compte que
   quelques-uns en donnerait l'emplacement. */

const outlineSources = new Map<string, string>(); // source → code ville

async function outlineGeoJSON(code: string): Promise<GeoJSON.FeatureCollection | null> {
  const gj = await loadZones(`${code}-outline.geojson`);
  const c = cityStats().find(s => s.code === code);
  if (!gj || !c) return null;
  const denom = c.official ?? c.active;
  const shown = c.active + c.foundTotal > 0;
  const feats = (gj.features as GeoJSON.Feature[]).map(f => ({
    ...f,
    properties: {
      code,
      name: c.name,
      found: c.foundTotal,
      active: c.active,
      label: shown ? `${c.foundTotal}/${denom}` : "",
      pct: shown && denom > 0 ? Math.min(1, c.foundTotal / denom) : -1
    }
  }));
  return { type: "FeatureCollection", features: feats };
}

async function addCityOutline(code: string): Promise<boolean> {
  const data = await outlineGeoJSON(code);
  if (!map || !data) return false;
  const src = `outline-${code}`;
  addShapeLayers(src, data, Z_BUBBLE_MAX, 24, true);
  outlineSources.set(src, code);
  map.on("click", `${src}-fill`, ev => {
    const p = ev.features?.[0]?.properties as any;
    if (!p || !p.label) return; // rien à montrer pour cette ville
    // la zone d'une ville découpée voisine, plus fine, garde la main si elle est sous le doigt
    const zoneHere = map!.queryRenderedFeatures(ev.point).some(f =>
      f.layer.id.startsWith("zones-") && f.layer.id.endsWith("-fill") && Number((f.properties as any)?.active) > 0);
    if (!zoneHere) openCitySheet(p);
  });
  return true;
}

async function addCityZones(code: string): Promise<void> {
  if (!map) return;
  {
    for (const [level, [minz, maxz]] of [["z2", Z_MID], ["z1", Z_FINE]] as const) {
      const data = await zoneGeoJSON(code, level);
      if (!data) continue;
      const src = `zones-${code}-${level}`;
      addShapeLayers(src, data, minz, maxz);

      zoneLayers.add(src);
      map.on("click", `${src}-fill`, ev => {
        const p = ev.features?.[0]?.properties as any;
        if (!p || Number(p.active) <= 0) return;
        const left = Number(p.active) - Number(p.found);
        openSheet(String(p.name),
          `<div class="stat-row">
             <div class="stat ok"><b>${fmt(Number(p.found))}</b><span>flashés</span></div>
             <div class="stat accent"><b>${fmt(left)}</b><span>à trouver</span></div>
             <div class="stat warn"><b>${fmt(Number(p.indoorLeft))}</b><span>en intérieur</span></div>
           </div>
           ${left === 0 ? `<p class="hint mt center">Zone complétée — bravo ! 🎉</p>` : ""}`);
      });
    }
  }
}

async function updateZones(): Promise<void> {
  if (!map) return;
  const refresh = (src: string, data: GeoJSON.FeatureCollection | null, largest = false): void => {
    if (!data) return;
    (map!.getSource(src) as maplibregl.GeoJSONSource | undefined)?.setData(data);
    (map!.getSource(`${src}-pts`) as maplibregl.GeoJSONSource | undefined)?.setData(centroids(data, largest));
  };
  for (const src of zoneLayers) {
    const [, code, level] = src.split("-");
    refresh(src, await zoneGeoJSON(code, level as "z1" | "z2"));
  }
  for (const [src, code] of outlineSources) refresh(src, await outlineGeoJSON(code), true);
}

/* ---------- Fiche zone ---------- */

function openSheet(title: string, html: string): void {
  document.querySelector(".zone-sheet")?.remove();
  const sheet = document.createElement("div");
  sheet.className = "zone-sheet";
  sheet.innerHTML = `
    <button class="close" aria-label="Fermer">✕</button>
    <h3>${escapeHtml(title)}</h3>
    ${html}`;
  sheet.querySelector(".close")!.addEventListener("click", () => sheet.remove());
  document.getElementById("view-map")!.appendChild(sheet);
}
