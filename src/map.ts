import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { state, on } from "./state";
import { cityStats, zoneStats, loadZones } from "./data";
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
  map.flyTo({ center: [info.lng, info.lat], zoom: info.zones ? 10.8 : 12.3 });
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
        // les villes avec sous-découpage cèdent la place à la choroplèthe au zoom
        hasZones: !!state.dataset?.cities[c.code]?.zones
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
  // Zoom rapproché : les villes SANS sous-découpage gardent leur bulle
  map.addLayer({
    id: "cities-circle-close", type: "circle", source: "cities", minzoom: Z_BUBBLE_MAX,
    filter: ["!", ["get", "hasZones"]],
    paint: circlePaint()
  });
  map.addLayer({
    id: "cities-label-close", type: "symbol", source: "cities", minzoom: Z_BUBBLE_MAX,
    filter: ["!", ["get", "hasZones"]],
    layout: labelLayout(),
    paint: { "text-color": TEXT_COLOR, "text-halo-color": HALO_COLOR, "text-halo-width": 1.4 }
  });

  for (const layerId of ["cities-circle", "cities-circle-close"]) {
    map.on("click", layerId, ev => {
      const p = ev.features?.[0]?.properties as any;
      if (!p) return;
      openSheet(String(p.name),
        `<div class="stat-row">
           <div class="stat ok"><b>${fmt(Number(p.found))}</b><span>flashés</span></div>
           <div class="stat accent"><b>${fmt(Math.max(0, Number(p.active) - Number(p.found)))}</b><span>restants localisés</span></div>
         </div>
         ${p.hasZones ? `<p class="hint mt">Zoome pour le détail par zone.</p>` : ""}`);
      if (Number(map!.getZoom()) < Z_BUBBLE_MAX) {
        map!.flyTo({ center: (ev.features![0].geometry as any).coordinates, zoom: p.hasZones ? 10.5 : 12.3 });
      }
    });
    map.on("mouseenter", layerId, () => { map!.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layerId, () => { map!.getCanvas().style.cursor = ""; });
  }
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

function centroids(fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  const feats = fc.features
    .filter(f => (f.properties as any).active > 0)
    .map(f => {
      const ring: [number, number][] =
        f.geometry.type === "Polygon" ? (f.geometry.coordinates as any)[0]
        : f.geometry.type === "MultiPolygon" ? (f.geometry.coordinates as any)[0][0] : [];
      let sx = 0, sy = 0;
      for (const [x, y] of ring) { sx += x; sy += y; }
      const n = Math.max(1, ring.length);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [sx / n, sy / n] },
        properties: f.properties
      } as GeoJSON.Feature;
    });
  return { type: "FeatureCollection", features: feats };
}

async function addZones(): Promise<void> {
  if (!map || !state.dataset) return;

  // toutes les villes en parallèle : la carte est complète en une volée réseau
  await Promise.all(Object.entries(state.dataset.cities).map(([code, info]) =>
    info.zones ? addCityZones(code) : Promise.resolve()
  ));
}

async function addCityZones(code: string): Promise<void> {
  if (!map) return;
  {
    for (const [level, [minz, maxz]] of [["z2", Z_MID], ["z1", Z_FINE]] as const) {
      const data = await zoneGeoJSON(code, level);
      if (!data) continue;
      const src = `zones-${code}-${level}`;
      map.addSource(src, { type: "geojson", data });
      map.addSource(`${src}-pts`, { type: "geojson", data: centroids(data) });

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
      map.on("mouseenter", `${src}-fill`, () => { map!.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", `${src}-fill`, () => { map!.getCanvas().style.cursor = ""; });
    }
  }
}

async function updateZones(): Promise<void> {
  if (!map) return;
  for (const src of zoneLayers) {
    const [, code, level] = src.split("-");
    const data = await zoneGeoJSON(code, level as "z1" | "z2");
    if (!data) continue;
    (map.getSource(src) as maplibregl.GeoJSONSource | undefined)?.setData(data);
    (map.getSource(`${src}-pts`) as maplibregl.GeoJSONSource | undefined)?.setData(centroids(data));
  }
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
