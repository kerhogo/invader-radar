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
 *  - villes sans sous-découpage : contour de la ville (--outlines) → zones/CODE-outline.geojson.
 *    C'est la limite administrative de la commune (géocodeur Nominatim d'OpenStreetMap), ou de
 *    l'échelon au-dessus quand les invaders débordent. Au zoom, la carte affiche ce contour à la place d'une bulle posée
 *    au milieu des invaders — qui, pour une ville de quelques mosaïques, valait un repère.
 *
 * Résultats commités (les limites admin bougent rarement) ; la CI quotidienne
 * ne relance pas ce script.
 * Usage : node scripts/fetch-zones.mjs [--force] [--city=XX] [--outlines]
 *   --outlines : ne génère que les contours manquants des villes sans sous-découpage
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

/* ---------- Contour des villes sans sous-découpage ---------- */

/** Part des invaders localisés que le contour doit contenir : on vise 80 %, à défaut la majorité
    (une ville dont quelques mosaïques sont dans la commune voisine garde le contour de la ville). */
const OUTLINE_COVERAGE = [0.8, 0.6];
/** Un contour plus petit désignerait un pâté de maisons : on monte d'un échelon. */
const OUTLINE_MIN_DIAGONAL_M = 2500;
/** Un contour sans commune mesure avec l'étendue des invaders (région, pays entier) n'apprend rien :
    plafond à 120 km (certaines communes sont vastes), ou 8 fois l'étendue des invaders au-delà. */
const OUTLINE_MAX_DIAGONAL_M = 120_000;
const OUTLINE_MAX_SPREAD_FACTOR = 8;
/** Échelons infra-communaux : le contour doit être celui de la ville, pas d'un de ses quartiers. */
const SUBCITY = new Set(["suburb", "borough", "city_district", "quarter", "neighbourhood", "hamlet", "isolated_dwelling", "city_block", "residential"]);
/** Échelons essayés, du plus fin au plus large (paramètre zoom du géocodeur Nominatim) :
    ville ou commune, comté, région, pays. Jamais plus fin que la ville : le contour doit être
    le sien, pas celui d'un quartier. */
const OUTLINE_ZOOMS = [10, 8, 6, 5, 3];
/** Contour cherché par nom. Pour les villes dont aucun invader n'est localisé (STK, LAP —
    l'invasion « Lapland » couvre 12 communes du comté de Norrbotten, en Laponie suédoise), et
    pour celles dont le territoire n'est pas une limite administrative (une île, une presqu'île). */
const OUTLINE_PLACES = {
  STK: "Stockholms kommun, Sverige",
  LAP: "Norrbottens län, Sverige",
  DJBA: "Djerba, Tunisie",
  CAPF: "Lège-Cap-Ferret, France",
  GRTI: "Grumeti Game Reserve, Tanzania",
  // communes que le géocodeur inverse ne propose pas à l'échelon ville
  HALM: "Halmstads kommun, Sverige",
  FAO: "Faro, Portugal",
  VSB: "Gotland, Sverige", // Visby n'a pas de limite propre : l'île
  // villes pour lesquelles le géocodeur inverse proposait l'arrondissement plutôt que la commune
  CHAR: "Charleroi, Belgique",
  ANVR: "Antwerpen, België",
  MBSA: "Mombasa County, Kenya"
};
const NOMINATIM = "https://nominatim.openstreetmap.org";

/** Géocodeur d'OpenStreetMap : une requête par seconde au plus (règle d'usage du service). */
async function nominatim(query) {
  await sleep(1200);
  const res = await fetch(`${NOMINATIM}/${query}`, { headers: { "User-Agent": UA, "Accept-Language": "fr,en" } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json();
}

function distanceM(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

const ringsOf = geom => (geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates).map(poly => poly[0]);
function boundsOf(rings) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) {
    if (x < minLng) minLng = x; if (x > maxLng) maxLng = x;
    if (y < minLat) minLat = y; if (y > maxLat) maxLat = y;
  }
  return { minLng, minLat, maxLng, maxLat, diagonalM: distanceM(minLat, minLng, maxLat, maxLng) };
}

/** Douglas-Peucker itératif : garde la forme, retire les points qui ne se voient pas à l'écran. */
function simplifyRing(ring, tolerance) {
  if (ring.length <= 8) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a];
    const dx = ring[b][0] - ax, dy = ring[b][1] - ay;
    const len2 = dx * dx + dy * dy;
    let worst = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = ring[i][0] - ax, py = ring[i][1] - ay;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d > worst) { worst = d; at = i; }
    }
    if (at > 0 && worst > tolerance) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

/** L'anneau se recoupe-t-il ? (une simplification trop forte peut croiser deux bords voisins) */
function selfIntersects(ring) {
  const n = ring.length - 1;
  const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // voisins par la fermeture de l'anneau
      const p1 = ring[i], p2 = ring[i + 1], p3 = ring[j], p4 = ring[j + 1];
      if (side(p1, p2, p3) * side(p1, p2, p4) < 0 && side(p3, p4, p1) * side(p3, p4, p2) < 0) return true;
    }
  }
  return false;
}

/** Simplifie un anneau ; si le résultat se recoupe, réessaie deux fois plus finement, puis encore.
    Au-delà (côte très découpée), on garde la première version : quelques croisements de bords
    ne se voient pas, alors qu'un contour dix fois plus lourd se paierait à chaque chargement. */
function simplifyRingCleanly(ring, tolerance) {
  const first = simplifyRing(ring, tolerance);
  if (!selfIntersects(first)) return first;
  for (const tol of [tolerance / 2, tolerance / 4]) {
    const finer = simplifyRing(ring, tol);
    if (!selfIntersects(finer)) return finer;
  }
  return first;
}

/** Allège un contour : simplification proportionnée à sa taille, trous retirés, et morceaux trop
    petits écartés QUOI QU'ILS CONTIENNENT — un îlot de 200 m gardé parce qu'il abrite un invader
    le désignerait. Le plus grand morceau est toujours conservé. */
function simplifyOutline(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  const whole = boundsOf(polys.map(p => p[0]));
  const degrees = Math.hypot(whole.maxLng - whole.minLng, whole.maxLat - whole.minLat);
  const tolerance = Math.max(0.00015, degrees / 2500);
  const minPiece = Math.max(whole.diagonalM * 0.03, OUTLINE_MIN_DIAGONAL_M);
  const sized = polys.map(poly => ({ poly, d: boundsOf([poly[0]]).diagonalM })).sort((x, y) => y.d - x.d);
  const kept = sized.filter((p, k) => k === 0 || p.d >= minPiece).map(p => p.poly);
  const coordinates = kept.map(poly => [simplifyRingCleanly(poly[0], tolerance)]);
  return roundCoords(coordinates.length === 1
    ? { type: "Polygon", coordinates: coordinates[0] }
    : { type: "MultiPolygon", coordinates });
}

const outlineFeature = (geometry, name) => ({
  type: "FeatureCollection",
  features: [{ type: "Feature", geometry, properties: { name } }]
});

/** Contour de la ville d'après ses invaders localisés ; null si aucune limite ne convient.
    Le géocodeur inverse donne, pour un point, la limite administrative qui l'englobe à l'échelon
    demandé. On retient la plus petite limite, de niveau ville ou au-dessus, qui contient l'essentiel
    des invaders. `place` : nom à essayer en premier (voir OUTLINE_PLACES). */
async function cityOutline(invs, place) {
  const spread = boundsOf([invs.map(i => [i.lng, i.lat])]).diagonalM;
  const maxDiagonal = Math.max(OUTLINE_MAX_DIAGONAL_M, spread * OUTLINE_MAX_SPREAD_FACTOR);
  const sorted = [...invs].sort((a, b) => a.lat - b.lat || a.lng - b.lng);
  const probes = [...new Set([sorted[Math.floor(sorted.length / 2)], sorted[0], sorted[sorted.length - 1]])];
  const seen = new Set();
  const candidates = [];
  /** Enregistre le candidat s'il est recevable ; vrai s'il contient tous les invaders.
      `curated` : lieu choisi à la main (OUTLINE_PLACES), dispensé du plafond de taille. */
  const consider = (hit, curated = false) => {
    const id = `${hit?.osm_type}/${hit?.osm_id}`;
    if (!hit?.geojson || seen.has(id)) return false;
    seen.add(id);
    if (!/Polygon/.test(hit.geojson.type) || SUBCITY.has(hit.addresstype)) return false;
    const b = boundsOf(ringsOf(hit.geojson));
    if (b.diagonalM < OUTLINE_MIN_DIAGONAL_M || (!curated && b.diagonalM > maxDiagonal)) return false;
    const covered = invs.filter(i => pointInGeometry(i.lng, i.lat, hit.geojson)).length;
    candidates.push({
      name: hit.name || hit.display_name?.split(",")[0] || "?", level: hit.addresstype ?? "?",
      covered, share: covered / invs.length, diagonalM: b.diagonalM, geojson: hit.geojson
    });
    return covered === invs.length;
  };

  let complete = false;
  if (place) {
    // le lieu choisi à la main fait foi dès qu'il contient la majorité des invaders
    complete = consider((await nominatim(`search?format=jsonv2&polygon_geojson=1&limit=1&q=${encodeURIComponent(place)}`))[0], true);
    const curated = candidates[0];
    if (curated && curated.share >= OUTLINE_COVERAGE[OUTLINE_COVERAGE.length - 1]) {
      return { ...curated, fc: outlineFeature(simplifyOutline(curated.geojson), curated.name) };
    }
  }
  // du plus fin au plus large ; dès qu'une limite contient tout, inutile de monter plus haut
  for (const zoom of OUTLINE_ZOOMS) {
    if (complete) break;
    for (const p of probes) {
      complete = consider(await nominatim(`reverse?format=jsonv2&polygon_geojson=1&zoom=${zoom}&lat=${p.lat}&lon=${p.lng}`));
      if (complete) break;
    }
  }
  for (const minShare of OUTLINE_COVERAGE) {
    const best = candidates.filter(c => c.share >= minShare).sort((x, y) => x.diagonalM - y.diagonalM)[0];
    if (best) return { ...best, fc: outlineFeature(simplifyOutline(best.geojson), best.name) };
  }
  return null;
}

/** Contour d'un lieu nommé (villes sans aucun invader localisé). */
async function placeOutline(place) {
  const [hit] = await nominatim(`search?format=jsonv2&polygon_geojson=1&limit=1&q=${encodeURIComponent(place)}`);
  if (!hit?.geojson || !/Polygon/.test(hit.geojson.type)) return null;
  const geometry = simplifyOutline(hit.geojson);
  if (boundsOf(ringsOf(geometry)).diagonalM < OUTLINE_MIN_DIAGONAL_M) return null;
  return { name: hit.name ?? place, fc: outlineFeature(geometry, hit.name ?? place) };
}

async function cityOutlines(ds) {
  const located = new Map();
  for (const inv of ds.items) {
    if (inv.lat === undefined) continue;
    (located.get(inv.city) ?? located.set(inv.city, []).get(inv.city)).push(inv);
  }
  const done = [], failed = [];
  for (const code of Object.keys(ds.cities)) {
    if (code === "PA" || (onlyCity && code !== onlyCity)) continue;
    const exists = async file => { try { await access(join(OUT, file)); return true; } catch { return false; } };
    if (await exists(`${code}-z1.geojson`)) continue; // ville découpée : rien à faire
    const file = `${code}-outline.geojson`;
    if (!FORCE && await exists(file)) { console.log(`${code} : contour déjà présent, sauté`); continue; }
    const invs = located.get(code) ?? [];
    try {
      let found = null;
      if (invs.length) {
        const o = await cityOutline(invs, OUTLINE_PLACES[code]);
        if (o) found = { fc: o.fc, label: `${o.name} (${o.level}, ${o.covered}/${invs.length} invaders dedans)` };
      } else if (OUTLINE_PLACES[code]) {
        const o = await placeOutline(OUTLINE_PLACES[code]);
        if (o) found = { fc: o.fc, label: `${o.name} (par nom)` };
      }
      if (!found) { failed.push(code); console.log(`${code} : pas de contour exploitable`); continue; }
      const text = JSON.stringify(found.fc);
      await writeFile(join(OUT, file), text);
      done.push(code);
      console.log(`${code} : ${found.label} — ${Math.round(text.length / 1024)} Ko`);
    } catch (err) {
      failed.push(code);
      console.warn(`${code} : ${err.message}, sauté`);
    }
  }
  console.log(`✔ Contours : ${done.length} générés${failed.length ? ` ; sans contour : ${failed.join(", ")}` : ""}`);
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

  if (process.argv.includes("--outlines")) { await cityOutlines(ds); return; }

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
