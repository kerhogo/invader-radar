/**
 * Génère les sous-découpages administratifs (z1 fin / z2 moyen) pour chaque
 * ville invadée, depuis les limites administratives OSM (Overpass).
 *
 * Pour chaque ville (hors Paris, qui utilise les quartiers officiels opendata) :
 *  - bbox des invaders localisés de la ville (+ marge)
 *  - récupère les relations admin_level 7 à 10 de la bbox
 *  - choisit le niveau le plus fin couvrant ≥ 50 % des invaders comme z1,
 *    et un niveau plus large comme z2 s'il existe
 *  - ne garde que les polygones contenant au moins un invader (fichiers légers)
 *
 * Les fichiers sont écrits dans public/data/zones/ et COMMITÉS : les limites
 * administratives bougent rarement, la CI quotidienne ne relance pas ce script.
 *
 * Usage : node scripts/fetch-zones.mjs [--force] [--city=LY]
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

async function fetchAdmin(bbox) {
  const [s, w, n, e] = bbox;
  const q = `[out:json][timeout:120];rel["boundary"="administrative"]["admin_level"~"^(7|8|9|10)$"](${s},${w},${n},${e});out tags geom;`;
  // Overpass sature vite (429/504) : retry patient avec backoff progressif
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: "data=" + encodeURIComponent(q)
    });
    if (res.ok) return res.json();
    if (attempt >= 4) throw new Error(`Overpass HTTP ${res.status} (après ${attempt} essais)`);
    const wait = 25000 * attempt;
    console.log(`  … HTTP ${res.status}, nouvel essai dans ${wait / 1000}s`);
    await sleep(wait);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const ds = JSON.parse(await readFile(join(ROOT, "public", "data", "invaders.json"), "utf8"));

  const byCity = new Map();
  for (const inv of ds.items) {
    if (inv.lat === undefined) continue;
    (byCity.get(inv.city) ?? byCity.set(inv.city, []).get(inv.city)).push(inv);
  }

  for (const [code, invs] of byCity) {
    if (code === "PA" || invs.length < 8) continue;
    if (onlyCity && code !== onlyCity) continue;

    const z1Path = join(OUT, `${code}-z1.geojson`);
    if (!FORCE) {
      try { await access(z1Path); console.log(`${code} : déjà présent, sauté`); continue; } catch { /* absent */ }
    }

    const lats = invs.map(i => i.lat), lngs = invs.map(i => i.lng);
    const bbox = [
      Math.min(...lats) - 0.03, Math.min(...lngs) - 0.03,
      Math.max(...lats) + 0.03, Math.max(...lngs) + 0.03
    ];

    let gj;
    try {
      gj = osmtogeojson(await fetchAdmin(bbox));
    } catch (err) {
      console.warn(`${code} : Overpass KO (${err.message}), sauté`);
      await sleep(4000);
      continue;
    }

    // groupe par admin_level, ne garde que Polygon/MultiPolygon nommés
    const byLevel = new Map();
    for (const f of gj.features) {
      const p = f.properties ?? {};
      const lvl = Number(p.admin_level);
      const name = p.name;
      if (!name || !lvl || !/Polygon/.test(f.geometry?.type ?? "")) continue;
      (byLevel.get(lvl) ?? byLevel.set(lvl, []).get(lvl)).push(f);
    }

    // score par niveau : couverture des invaders + nombre de polygones utiles
    const scored = [];
    for (const [lvl, feats] of byLevel) {
      const used = new Map(); // feature → nb invaders
      let covered = 0;
      for (const inv of invs) {
        for (const f of feats) {
          if (pointInGeometry(inv.lng, inv.lat, f.geometry)) {
            covered++;
            used.set(f, (used.get(f) ?? 0) + 1);
            break;
          }
        }
      }
      scored.push({ lvl, coverage: covered / invs.length, polys: used.size, feats: [...used.keys()] });
    }
    scored.sort((a, b) => b.lvl - a.lvl); // du plus fin au plus large

    const z1 = scored.find(s => s.coverage >= 0.5 && s.polys >= 2);
    if (!z1) { console.log(`${code} : pas de découpage exploitable (${scored.map(s => `L${s.lvl}:${s.polys}p/${Math.round(s.coverage * 100)}%`).join(" ")})`); await sleep(2500); continue; }
    const z2 = scored.find(s => s.lvl < z1.lvl && s.coverage >= 0.5 && s.polys >= 2);

    const write = async (level, chosen) => {
      const fc = {
        type: "FeatureCollection",
        features: chosen.feats.map(f => ({
          type: "Feature",
          geometry: roundCoords(f.geometry),
          properties: { name: f.properties.name }
        }))
      };
      await writeFile(join(OUT, `${code}-${level}.geojson`), JSON.stringify(fc));
    };
    await write("z1", z1);
    if (z2) await write("z2", z2);
    console.log(`${code} : z1=admin_level ${z1.lvl} (${z1.polys} zones, ${Math.round(z1.coverage * 100)}%)${z2 ? `, z2=admin_level ${z2.lvl} (${z2.polys})` : ""}`);
    await sleep(4000);
  }
  console.log("✔ Zones générées");
}

main().catch(err => { console.error(err); process.exit(1); });
