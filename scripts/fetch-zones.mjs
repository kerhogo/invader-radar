/**
 * Génère public/data/zones/PA-suburbs.geojson : les communes de banlieue
 * (Meudon, Aubervilliers, Vincennes…) qui abritent des invaders « PA » situés
 * hors des 80 quartiers intra-muros. Fusionnées ensuite par build-data.mjs
 * dans PA-z1/PA-z2 pour que la banlieue soit visible sur la carte.
 *
 * Les autres villes utilisent des grilles de rectangles générées directement
 * par build-data.mjs (aucun appel réseau).
 *
 * Une seule requête Overpass, résultat commité (les limites bougent rarement).
 * Usage : node scripts/fetch-zones.mjs
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import osmtogeojson from "osmtogeojson";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "data", "zones");
const OVERPASS = "https://overpass-api.de/api/interpreter";
const UA = "InvaderRadar-DataPipeline/0.1 (projet perso non commercial)";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInGeometry(lng, lat, geom) {
  if (geom.type === "Polygon") {
    if (!inRing(lng, lat, geom.coordinates[0])) return false;
    for (let i = 1; i < geom.coordinates.length; i++) if (inRing(lng, lat, geom.coordinates[i])) return false;
    return true;
  }
  if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      if (inRing(lng, lat, poly[0])) {
        let hole = false;
        for (let i = 1; i < poly.length; i++) if (inRing(lng, lat, poly[i])) { hole = true; break; }
        if (!hole) return true;
      }
    }
  }
  return false;
}

function roundCoords(geom, digits = 5) {
  const f = 10 ** digits;
  const walk = c => Array.isArray(c[0]) ? c.map(walk) : [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f];
  return { type: geom.type, coordinates: walk(geom.coordinates) };
}

async function overpass(query) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: "data=" + encodeURIComponent(query)
    });
    if (res.ok) return res.json();
    if (attempt >= 5) throw new Error(`Overpass HTTP ${res.status} (après ${attempt} essais)`);
    const wait = 25000 * attempt;
    console.log(`  … HTTP ${res.status}, nouvel essai dans ${wait / 1000}s`);
    await sleep(wait);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // Quartiers intra-muros (cache du pipeline, sinon opendata)
  let quartiers;
  try {
    quartiers = JSON.parse(await readFile(join(ROOT, ".cache", "quartiers.geojson"), "utf8"));
  } catch {
    const res = await fetch("https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/quartier_paris/exports/geojson", {
      headers: { "User-Agent": UA }
    });
    quartiers = await res.json();
  }

  const ds = JSON.parse(await readFile(join(ROOT, "public", "data", "invaders.json"), "utf8"));
  const pa = ds.items.filter(i => i.city === "PA" && i.lat !== undefined);
  const outside = pa.filter(inv => !quartiers.features.some(f => pointInGeometry(inv.lng, inv.lat, f.geometry)));
  console.log(`Invaders PA hors intra-muros : ${outside.length}/${pa.length}`);
  if (outside.length === 0) return;

  const lats = outside.map(i => i.lat), lngs = outside.map(i => i.lng);
  const bbox = `${Math.min(...lats) - 0.02},${Math.min(...lngs) - 0.02},${Math.max(...lats) + 0.02},${Math.max(...lngs) + 0.02}`;
  console.log(`Requête Overpass communes (bbox ${bbox})…`);
  const gj = osmtogeojson(await overpass(`[out:json][timeout:180];rel["boundary"="administrative"]["admin_level"="8"](${bbox});out tags geom;`));

  const kept = [];
  for (const f of gj.features) {
    const name = f.properties?.name;
    if (!name || name === "Paris" || !/Polygon/.test(f.geometry?.type ?? "")) continue;
    const count = outside.filter(inv => pointInGeometry(inv.lng, inv.lat, f.geometry)).length;
    if (count > 0) kept.push({ f, name, count });
  }
  kept.sort((a, b) => b.count - a.count);
  console.log(`Communes retenues : ${kept.length} — ${kept.slice(0, 8).map(k => `${k.name} (${k.count})`).join(", ")}…`);

  const fc = {
    type: "FeatureCollection",
    features: kept.map(k => ({
      type: "Feature",
      geometry: roundCoords(k.f.geometry),
      properties: { name: k.name }
    }))
  };
  await writeFile(join(OUT, "PA-suburbs.geojson"), JSON.stringify(fc));
  console.log(`✔ PA-suburbs.geojson : ${fc.features.length} communes`);
}

main().catch(err => { console.error(err); process.exit(1); });
