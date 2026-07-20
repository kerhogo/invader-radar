/**
 * Génère les sous-découpages par VRAIES frontières administratives (comme Paris)
 * pour chaque ville invadée, depuis OSM/Overpass :
 *  - villes hors Paris : niveaux admin 7–10, choix du plus fin qui couvre bien
 *    la ville (z1) + un niveau plus large (z2) → zones/CODE-z1/z2.geojson
 *  - Paris : communes de banlieue abritant des invaders PA hors intra-muros
 *    → zones/PA-suburbs.geojson (fusionné par build-data dans PA-z1/z2)
 *
 * IMPORTANT : requête `out geom` (géométrie complète). L'ancienne forme
 * `out tags geom` renvoyait des géométries partielles → osmtogeojson retombait
 * sur des bounding boxes (rectangles illisibles). Un garde-fou rejette
 * désormais tout polygone rectangulaire suspect.
 *
 * Résultats commités (les limites admin bougent rarement) ; la CI quotidienne
 * ne relance pas ce script. Usage : node scripts/fetch-zones.mjs [--force] [--city=XX]
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import osmtogeojson from "osmtogeojson";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "data", "zones");
const OVERPASS = "https://overpass-api.de/api/interpreter";
const UA = "InvaderRadar-DataPipeline/0.1 (projet perso non commercial)";
const FORCE = process.argv.includes("--force");
const onlyCity = process.argv.find(a => a.startsWith("--city="))?.split("=")[1];
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

/** Détecte le rectangle-artefact (repli bbox d'osmtogeojson) : anneau de 5 points
    strictement aligné sur les axes. Une vraie frontière a des dizaines de points. */
function isBboxArtifact(geom) {
  const rings = geom.type === "Polygon" ? [geom.coordinates[0]]
    : geom.type === "MultiPolygon" ? geom.coordinates.map(p => p[0]) : [];
  return rings.every(ring => {
    if (ring.length > 6) return false;
    const lngs = new Set(ring.map(c => c[0].toFixed(6)));
    const lats = new Set(ring.map(c => c[1].toFixed(6)));
    return lngs.size <= 2 && lats.size <= 2;
  });
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

/** Relations admin de la bbox → features GeoJSON propres (vraies frontières). */
async function adminFeatures(bbox, levels) {
  const q = `[out:json][timeout:180];rel["boundary"="administrative"]["admin_level"~"^(${levels})$"](${bbox});out geom;`;
  const gj = osmtogeojson(await overpass(q));
  const out = [];
  let artifacts = 0;
  for (const f of gj.features) {
    const p = f.properties ?? {};
    if (!p.name || !/Polygon/.test(f.geometry?.type ?? "")) continue;
    if (isBboxArtifact(f.geometry)) { artifacts++; continue; }
    out.push(f);
  }
  if (artifacts) console.log(`  (${artifacts} géométries bbox rejetées)`);
  return out;
}

async function cityZones(code, invs) {
  const lats = invs.map(i => i.lat), lngs = invs.map(i => i.lng);
  const bbox = `${Math.min(...lats) - 0.03},${Math.min(...lngs) - 0.03},${Math.max(...lats) + 0.03},${Math.max(...lngs) + 0.03}`;
  const feats = await adminFeatures(bbox, "7|8|9|10");

  const byLevel = new Map();
  for (const f of feats) {
    const lvl = Number(f.properties.admin_level);
    if (!lvl) continue;
    (byLevel.get(lvl) ?? byLevel.set(lvl, []).get(lvl)).push(f);
  }

  const scored = [];
  for (const [lvl, group] of byLevel) {
    const used = new Set();
    let covered = 0;
    for (const inv of invs) {
      for (const f of group) {
        if (pointInGeometry(inv.lng, inv.lat, f.geometry)) { covered++; used.add(f); break; }
      }
    }
    scored.push({ lvl, coverage: covered / invs.length, feats: [...used] });
  }
  scored.sort((a, b) => b.lvl - a.lvl);

  const z1 = scored.find(s => s.coverage >= 0.5 && s.feats.length >= 2);
  if (!z1) return null;
  const z2 = scored.find(s => s.lvl < z1.lvl && s.coverage >= 0.5 && s.feats.length >= 2);

  const fc = chosen => ({
    type: "FeatureCollection",
    features: chosen.feats.map(f => ({
      type: "Feature",
      geometry: roundCoords(f.geometry),
      properties: { name: f.properties.name }
    }))
  });
  return { z1: fc(z1), z1lvl: z1.lvl, z2: z2 ? fc(z2) : null, z2lvl: z2?.lvl };
}

async function parisSuburbs(ds) {
  let quartiers;
  try {
    quartiers = JSON.parse(await readFile(join(ROOT, ".cache", "quartiers.geojson"), "utf8"));
  } catch {
    const res = await fetch("https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/quartier_paris/exports/geojson", { headers: { "User-Agent": UA } });
    quartiers = await res.json();
  }
  const pa = ds.items.filter(i => i.city === "PA" && i.lat !== undefined);
  const outside = pa.filter(inv => !quartiers.features.some(f => pointInGeometry(inv.lng, inv.lat, f.geometry)));
  console.log(`PA : ${outside.length} invaders hors intra-muros`);
  if (outside.length === 0) return;

  const lats = outside.map(i => i.lat), lngs = outside.map(i => i.lng);
  const bbox = `${Math.min(...lats) - 0.02},${Math.min(...lngs) - 0.02},${Math.max(...lats) + 0.02},${Math.max(...lngs) + 0.02}`;
  const feats = await adminFeatures(bbox, "8");

  const kept = feats
    .filter(f => f.properties.name !== "Paris")
    .map(f => ({ f, count: outside.filter(inv => pointInGeometry(inv.lng, inv.lat, f.geometry)).length }))
    .filter(k => k.count > 0)
    .sort((a, b) => b.count - a.count);

  await writeFile(join(OUT, "PA-suburbs.geojson"), JSON.stringify({
    type: "FeatureCollection",
    features: kept.map(k => ({ type: "Feature", geometry: roundCoords(k.f.geometry), properties: { name: k.f.properties.name } }))
  }));
  console.log(`✔ PA-suburbs : ${kept.length} communes (${kept.slice(0, 5).map(k => k.f.properties.name).join(", ")}…)`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const ds = JSON.parse(await readFile(join(ROOT, "public", "data", "invaders.json"), "utf8"));

  if (!onlyCity || onlyCity === "PA") await parisSuburbs(ds);

  const byCity = new Map();
  for (const inv of ds.items) {
    if (inv.city === "PA" || inv.lat === undefined) continue;
    (byCity.get(inv.city) ?? byCity.set(inv.city, []).get(inv.city)).push(inv);
  }

  for (const [code, invs] of byCity) {
    if (invs.length < 8) continue;
    if (onlyCity && code !== onlyCity) continue;
    if (!FORCE) {
      try { await access(join(OUT, `${code}-z1.geojson`)); console.log(`${code} : déjà présent, sauté`); continue; } catch { /* absent */ }
    }
    await sleep(4000);
    let z;
    try {
      z = await cityZones(code, invs);
    } catch (err) {
      console.warn(`${code} : ${err.message}, sauté`);
      continue;
    }
    if (!z) { console.log(`${code} : pas de découpage exploitable`); continue; }
    await writeFile(join(OUT, `${code}-z1.geojson`), JSON.stringify(z.z1));
    if (z.z2) await writeFile(join(OUT, `${code}-z2.geojson`), JSON.stringify(z.z2));
    console.log(`${code} : z1=L${z.z1lvl} (${z.z1.features.length} zones)${z.z2 ? `, z2=L${z.z2lvl} (${z.z2.features.length})` : ""}`);
  }
  console.log("✔ Zones générées");
}

main().catch(err => { console.error(err); process.exit(1); });
