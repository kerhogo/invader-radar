import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { state, on } from "./state";
import { cityStats, zoneStats, loadZones } from "./data";
import { fmt, escapeHtml } from "./dashboard";

const LIGHT_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/* Palette choroplèthe : gris (à explorer) → ambre (en cours) → vert (complété). */
const COLOR_EXPR: any = [
  "interpolate", ["linear"], ["get", "pct"],
  0, "#98989d",
  0.5, "#ff9f0a",
  1, "#34c759"
];

let map: maplibregl.Map | null = null;
let ready = false;
const zoneLayers = new Set<string>();

export function show(): void {
  const root = document.getElementById("view-map")!;
  if (!map) {
    root.innerHTML = `
      <div id="map-root"></div>
      <div class="map-overlay-top">
        <div class="map-legend">
          <i style="background:#98989d"></i> à explorer
          <i style="background:#ff9f0a"></i> en cours
          <i style="background:#34c759"></i> complété
        </div>
      </div>`;
    initMap();
  } else {
    requestAnimationFrame(() => map!.resize());
  }
}

function initMap(): void {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  map = new maplibregl.Map({
    container: "map-root",
    style: dark ? DARK_STYLE : LIGHT_STYLE,
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
  });
}

/* ---------- Villes (bulles monde, zoom éloigné) ---------- */

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
        size: Math.sqrt(Math.max(4, c.active))
      }
    });
  }
  return { type: "FeatureCollection", features: feats };
}

function addCities(): void {
  if (!map) return;
  map.addSource("cities", { type: "geojson", data: citiesGeoJSON() });

  map.addLayer({
    id: "cities-circle",
    type: "circle",
    source: "cities",
    maxzoom: 11,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "size"], 2, 8, 40, 26],
      "circle-color": COLOR_EXPR,
      "circle-opacity": 0.82,
      "circle-stroke-width": 2,
      "circle-stroke-color": "rgba(255,255,255,0.85)"
    }
  });
  map.addLayer({
    id: "cities-label",
    type: "symbol",
    source: "cities",
    maxzoom: 11,
    layout: {
      "text-field": ["format",
        ["get", "name"], { "font-scale": 0.9 }, "\n", {},
        ["get", "label"], { "font-scale": 1.05 }],
      "text-font": ["Open Sans Bold"],
      "text-size": 12,
      "text-offset": [0, 1.7],
      "text-allow-overlap": false
    },
    paint: {
      "text-color": matchMedia("(prefers-color-scheme: dark)").matches ? "#f2f2f7" : "#1c1c1e",
      "text-halo-color": matchMedia("(prefers-color-scheme: dark)").matches ? "#000" : "#fff",
      "text-halo-width": 1.4
    }
  });

  map.on("click", "cities-circle", ev => {
    const p = ev.features?.[0]?.properties as any;
    if (!p) return;
    openSheet(String(p.name),
      `<div class="stat-row">
         <div class="stat ok"><b>${fmt(Number(p.found))}</b><span>flashés</span></div>
         <div class="stat accent"><b>${fmt(Math.max(0, Number(p.active) - Number(p.found)))}</b><span>restants localisés</span></div>
       </div>
       <p class="hint mt">Zoome pour voir le détail par zone quand il existe.</p>`);
    map!.flyTo({ center: (ev.features![0].geometry as any).coordinates, zoom: 11.6 });
  });
  map.on("mouseenter", "cities-circle", () => { map!.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "cities-circle", () => { map!.getCanvas().style.cursor = ""; });
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
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;

  for (const [code, info] of Object.entries(state.dataset.cities)) {
    if (!info.zones) continue;
    for (const [level, minz, maxz] of [["z2", 11, 13.4], ["z1", 13.4, 24]] as const) {
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
          "fill-opacity": ["case", ["<", ["get", "pct"], 0], 0.04, 0.32]
        }
      });
      map.addLayer({
        id: `${src}-line`,
        type: "line",
        source: src,
        minzoom: minz,
        maxzoom: maxz,
        paint: {
          "line-color": dark ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.25)",
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
          "text-color": dark ? "#f2f2f7" : "#1c1c1e",
          "text-halo-color": dark ? "#000" : "#fff",
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
