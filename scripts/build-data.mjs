/**
 * Pipeline de données Invader Radar.
 *
 * Fusionne 4 sources par id (PA_92, NY_12…) :
 *  1. Space Invaders World Database (socle coords/points/statuts, figé déc. 2024)
 *  2. OSM/Overpass (nouveautés, coords manquantes, signaux « intérieur »)
 *  3. Invader Spotter (statuts frais — via scripts/fetch-spotter.mjs, cache .cache/spotter.json)
 *  4. overrides.json (corrections manuelles)
 *
 * Produit : public/data/{invaders.json, cities.json intégré, meta.json, changelog.json, zones/*.geojson}
 * Usage : node scripts/build-data.mjs [--offline] (--offline : n'utilise que le cache .cache/)
 */
import { mkdir, readFile, writeFile, access, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache");
const OUT = join(ROOT, "public", "data");
const OFFLINE = process.argv.includes("--offline");

const SIWD_URL = "https://raw.githubusercontent.com/goguelnikov/SpaceInvaders/master/world_space_invaders_V05.json";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const QUARTIERS_URL = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/quartier_paris/exports/geojson";
const ARRONDISSEMENTS_URL = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/arrondissements/exports/geojson";

/** Noms d'affichage des codes villes officiels (fallback : le code lui-même). */
const CITY_NAMES = {
  PA: "Paris", VRS: "Versailles", TLS: "Toulouse", MARS: "Marseille", LY: "Lyon",
  GRN: "Grenoble", MPL: "Montpellier", REN: "Rennes", LIL: "Lille", BAB: "Côte basque (BAB)",
  AIX: "Aix-en-Provence", AVI: "Avignon", CLR: "Clermont-Ferrand", DJN: "Dijon",
  NY: "New York", LA: "Los Angeles", SD: "San Diego", MIA: "Miami", SF: "San Francisco",
  LDN: "Londres", MAN: "Manchester", NCL: "Newcastle", BRT: "Bristol",
  TK: "Tokyo", HK: "Hong Kong", BGK: "Bangkok", KAT: "Katmandou", BT: "Bhoutan",
  ROM: "Rome", RA: "Ravenne", MLN: "Milan", FLR: "Florence", VEN: "Venise", NAP: "Naples",
  BXL: "Bruxelles", AMS: "Amsterdam", RTD: "Rotterdam", GVA: "Genève", LSN: "Lausanne", BSL: "Bâle", BRN: "Berne",
  BLN: "Berlin", KLN: "Cologne", MUN: "Munich", FFK: "Francfort", POT: "Potsdam",
  BCN: "Barcelone", BIL: "Bilbao", MAD: "Madrid", MLG: "Malaga", IBZ: "Ibiza",
  LIS: "Lisbonne", PRT: "Porto", FAO: "Faro",
  VNA: "Vienne", PRG: "Prague", BDP: "Budapest", VAR: "Varsovie", LJU: "Ljubljana", ZAG: "Zagreb",
  IST: "Istanbul", MRK: "Marrakech", RBA: "Rabat", CAS: "Casablanca", DKR: "Dakar",
  MBSA: "Mombasa", DJBA: "Djerba", CAI: "Le Caire",
  PTI: "Port-au-Prince", SP: "São Paulo", RIO: "Rio de Janeiro",
  PER: "Perth", MEL: "Melbourne", SYD: "Sydney", AKL: "Auckland",
  SEO: "Séoul", SHG: "Shanghai", TPE: "Taipei", MAC: "Macao",
  DHA: "Dharamsala", MUM: "Mumbai", DEL: "Delhi", GOA: "Goa",
  ANW: "Anvers", CHA: "Charleroi", MON: "Mons", LUX: "Luxembourg",
  STK: "Stockholm", OSL: "Oslo", CPH: "Copenhague", HEL: "Helsinki",
  MIL: "Milan", EDB: "Édimbourg", DUB: "Dublin", ATH: "Athènes",
  NIM: "Nîmes", MRS: "Marseille", TOU: "Tours", ORL: "Orléans", NAN: "Nantes",
  BOR: "Bordeaux", MTB: "Montauban", PAU: "Pau", BAY: "Bayonne",
  SPACE: "Espace (ISS)", MARSP: "Mars"
};

/* ---------- utilitaires ---------- */

async function fetchCached(name, url, options) {
  const path = join(CACHE, name);
  if (OFFLINE) return readFile(path, "utf8");
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": "InvaderRadar-DataPipeline/0.1 (projet perso non commercial)",
        ...(options?.headers ?? {})
      }
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const text = await res.text();
    await writeFile(path, text);
    return text;
  } catch (err) {
    console.warn(`! ${name} : ${err.message} — tentative via cache`);
    return readFile(path, "utf8"); // échoue si pas de cache : c'est voulu
  }
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseCoord(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

function normStatus(raw) {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("destroyed") || s.includes("détruit")) return "destroyed";
  // « très dégradé » = plus reconnu par l'app FlashInvaders → exclu comme un détruit
  if (s.includes("very damaged") || s.includes("très dégrad") || s.includes("tres degrad")) return "wrecked";
  if (s.includes("damaged") || s.includes("dégrad") || s.includes("degrad")) return "damaged";
  if (s.includes("hidden") || s.includes("caché") || s.includes("cache") || s.includes("non visible")) return "hidden";
  if (s === "ok" || s.includes("visible") || s.includes("good")) return "ok";
  return "unknown";
}

const INDOOR_RE = /(inside|indoor|intérieur|interieur|musée|musee|museum|galerie|gallery|boutique|magasin|\bshop\b|\bstore\b|café|cafe|restaurant|pizzeria|\bbar\b|hôtel|\bhotel\b|centre commercial|\bmall\b|bibliothèque|library|hôpital|hopital|hospital|école|school|université|university|piscine|aquarium|cinéma|cinema|théâtre|theatre|église|church|courtyard|cour intérieure|hall|lobby|métro(?! aérien)|station de métro)/i;

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

/* ---------- 1. SIWD ---------- */

async function loadSiwd() {
  const raw = JSON.parse(stripBom(await fetchCached("siwd.json", SIWD_URL)));
  const items = new Map();
  for (const e of raw) {
    const id = String(e.id ?? "").trim().replace(/\s+/g, "");
    if (!/^[A-Z]+_\d+$/.test(id)) continue;
    items.set(id, {
      id,
      city: id.split("_")[0],
      lat: parseCoord(e.lat),
      lng: parseCoord(e.lng),
      status: normStatus(e.status),
      points: Number(e.points) || 0,
      hint: String(e.hint ?? ""),
      sources: ["siwd"]
    });
  }
  console.log(`SIWD : ${items.size} invaders`);
  return items;
}

/* ---------- 2. OSM ---------- */

async function loadOsm() {
  const query = `[out:json][timeout:180];node["artist_name"~"^[Ii]nvader$"];out body;`;
  const raw = await fetchCached("osm.json", OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query)
  });
  const data = JSON.parse(raw);
  const nodes = [];
  for (const el of data.elements ?? []) {
    const t = el.tags ?? {};
    const ref = String(t.ref ?? t.name ?? "").trim().replace(/\s+/g, "");
    if (!/^[A-Z]+_\d+$/.test(ref)) continue;
    const text = [t.description, t.note, t["addr:place"]].filter(Boolean).join(" ");
    nodes.push({
      id: ref,
      lat: el.lat,
      lng: el.lon,
      indoorSignal: t.indoor === "yes" || t.level !== undefined || INDOOR_RE.test(text),
      text
    });
  }
  console.log(`OSM : ${nodes.length} invaders taggés`);
  return nodes;
}

/* ---------- 3. Invader Spotter (cache produit par fetch-spotter.mjs) ---------- */

async function loadSpotter() {
  try {
    const raw = JSON.parse(await readFile(join(CACHE, "spotter.json"), "utf8"));
    console.log(`Invader Spotter : ${Object.keys(raw.items).length} statuts (du ${raw.date})`);
    return raw;
  } catch {
    console.warn("! Pas de cache Invader Spotter (lance scripts/fetch-spotter.mjs) — statuts SIWD/OSM seuls.");
    return null;
  }
}

/* ---------- Zones Paris ---------- */

async function loadParisZones() {
  const quartiers = JSON.parse(await fetchCached("quartiers.geojson", QUARTIERS_URL));
  const arrondissements = JSON.parse(await fetchCached("arrondissements.geojson", ARRONDISSEMENTS_URL));

  const zoneName = p => p.l_qu ?? p.l_ar ?? p.l_aroff ?? p.name ?? "?";
  const clean = (fc, extra) => ({
    type: "FeatureCollection",
    features: fc.features.map(f => ({
      type: "Feature",
      geometry: roundCoords(f.geometry),
      properties: { name: zoneName(f.properties), ...(extra ? extra(f.properties) : {}) }
    }))
  });

  return {
    z1: clean(quartiers, p => ({ arrt: p.c_ar ?? null })),
    z2: clean(arrondissements)
  };
}

/* ---------- Fusion ---------- */

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(join(OUT, "zones"), { recursive: true });

  const items = await loadSiwd();
  const osm = await loadOsm();
  const spotter = await loadSpotter();
  const zones = await loadParisZones();

  let osmNew = 0, osmCoords = 0;
  for (const n of osm) {
    const existing = items.get(n.id);
    if (existing) {
      if (existing.lat === undefined) { existing.lat = n.lat; existing.lng = n.lng; osmCoords++; }
      if (n.indoorSignal) existing.indoor = true;
      existing.sources.push("osm");
    } else {
      // Nouvel invader mappé après le gel du dataset : considéré actif (fraîchement observé)
      items.set(n.id, {
        id: n.id, city: n.id.split("_")[0], lat: n.lat, lng: n.lng,
        status: "ok", points: 0, hint: n.text, indoor: n.indoorSignal || undefined,
        sources: ["osm"]
      });
      osmNew++;
    }
  }
  console.log(`Fusion OSM : +${osmNew} nouveaux, ${osmCoords} coords complétées`);

  if (spotter) {
    let updated = 0;
    for (const [id, s] of Object.entries(spotter.items)) {
      const inv = items.get(id);
      const status = normStatus(s.status);
      if (inv) {
        if (inv.status !== status) updated++;
        inv.status = status;
        if (s.points) inv.points = inv.points || Number(s.points) || 0;
        if (s.location && INDOOR_RE.test(s.location)) inv.indoor = true;
        inv.sources.push("spotter");
      } else if (/^[A-Z]+_\d+$/.test(id)) {
        items.set(id, {
          id, city: id.split("_")[0], status,
          points: Number(s.points) || 0, hint: s.location ?? "",
          indoor: s.location && INDOOR_RE.test(s.location) ? true : undefined,
          sources: ["spotter"]
        });
      }
    }
    console.log(`Invader Spotter : ${updated} statuts actualisés`);
  }

  // Heuristique intérieur sur les hints SIWD
  for (const inv of items.values()) {
    if (!inv.indoor && inv.hint && INDOOR_RE.test(inv.hint)) inv.indoor = true;
  }

  // Overrides manuels (corrections de terrain)
  try {
    const overrides = JSON.parse(await readFile(join(OUT, "overrides.json"), "utf8"));
    for (const [id, patch] of Object.entries(overrides)) {
      const inv = items.get(id);
      if (inv) Object.assign(inv, patch);
    }
  } catch { /* pas d'overrides : ok */ }

  // Zonage Paris (précalculé → runtime léger)
  let zoned = 0;
  for (const inv of items.values()) {
    if (inv.city !== "PA" || inv.lat === undefined) continue;
    for (const f of zones.z1.features) {
      if (pointInGeometry(inv.lng, inv.lat, f.geometry)) { inv.z1 = f.properties.name; zoned++; break; }
    }
    for (const f of zones.z2.features) {
      if (pointInGeometry(inv.lng, inv.lat, f.geometry)) { inv.z2 = f.properties.name; break; }
    }
  }
  console.log(`Zonage Paris : ${zoned} invaders affectés à un quartier`);

  // Zonage générique : toutes les villes ayant des polygones dans public/data/zones
  // (générés par scripts/fetch-zones.mjs et commités — les limites admin bougent peu)
  const zoneFiles = await readdir(join(OUT, "zones")).catch(() => []);
  const zonedCities = new Set(zoneFiles.filter(f => f.endsWith("-z1.geojson")).map(f => f.split("-")[0]));
  zonedCities.add("PA");
  for (const code of zonedCities) {
    if (code === "PA") continue; // quartiers officiels déjà affectés
    let gz1 = null, gz2 = null;
    try { gz1 = JSON.parse(await readFile(join(OUT, "zones", `${code}-z1.geojson`), "utf8")); } catch { continue; }
    try { gz2 = JSON.parse(await readFile(join(OUT, "zones", `${code}-z2.geojson`), "utf8")); } catch { /* pas de niveau moyen */ }
    let n = 0;
    for (const inv of items.values()) {
      if (inv.city !== code || inv.lat === undefined) continue;
      for (const f of gz1.features) {
        if (pointInGeometry(inv.lng, inv.lat, f.geometry)) { inv.z1 = f.properties.name; n++; break; }
      }
      if (gz2) {
        for (const f of gz2.features) {
          if (pointInGeometry(inv.lng, inv.lat, f.geometry)) { inv.z2 = f.properties.name; break; }
        }
      }
    }
    console.log(`Zonage ${code} : ${n} invaders affectés`);
  }

  // Référentiel villes : noms + dénominateurs officiels via Invader Spotter,
  // repli sur la table curée. Seules les villes de l'univers officiel existent ici.
  const ref = spotter?.cities ?? {};
  const cities = {};
  for (const inv of items.values()) {
    (cities[inv.city] ??= { lats: [], lngs: [], count: 0 }).count++;
    if (inv.lat !== undefined) { cities[inv.city].lats.push(inv.lat); cities[inv.city].lngs.push(inv.lng); }
  }
  const citiesOut = {};
  for (const [code, c] of Object.entries(cities)) {
    if (c.count < 2 && c.lats.length === 0) continue; // scories improbables
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    citiesOut[code] = {
      name: ref[code]?.name ?? CITY_NAMES[code] ?? code,
      lat: Math.round(avg(c.lats) * 1e5) / 1e5,
      lng: Math.round(avg(c.lngs) * 1e5) / 1e5,
      count: c.count,
      ...(ref[code]?.official ? { official: ref[code].official } : {}),
      ...(zonedCities.has(code) ? { zones: true } : {})
    };
  }

  // Changelog : diff avec la génération précédente
  const today = new Date().toISOString().slice(0, 10);
  let previous = null;
  try { previous = JSON.parse(await readFile(join(OUT, "invaders.json"), "utf8")); } catch { /* première génération */ }
  let changelog = { entries: [] };
  try { changelog = JSON.parse(await readFile(join(OUT, "changelog.json"), "utf8")); } catch { /* idem */ }

  if (previous) {
    const prevItems = new Map(previous.items.map(i => [i.id, i]));
    const prevCities = new Set(previous.items.map(i => i.city));
    const fresh = [];
    for (const inv of items.values()) {
      const old = prevItems.get(inv.id);
      if (!old) {
        if (!prevCities.has(inv.city)) {
          fresh.push({ date: today, type: "new_city", city: inv.city });
          prevCities.add(inv.city);
        }
        fresh.push({ date: today, type: "new_invader", id: inv.id, city: inv.city, zone: inv.z1 ?? inv.z2 });
      } else if (old.status !== inv.status) {
        fresh.push({ date: today, type: "status_change", id: inv.id, city: inv.city, zone: inv.z1 ?? inv.z2, from: old.status, to: inv.status });
      }
    }
    // anti-spoiler : les entrées du changelog ne portent jamais de coordonnées
    changelog.entries = [...fresh, ...changelog.entries.filter(e => e.date !== today)].slice(0, 400);
    console.log(`Changelog : ${fresh.length} événements aujourd'hui`);
  }

  // News Invader Spotter (texte brut, jamais de coordonnées) → onglet Quoi de neuf
  if (spotter?.news?.length) {
    const cutoff = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    const seen = new Set(changelog.entries.filter(e => e.type === "spotter_news").map(e => e.date + "|" + e.text));
    const freshNews = spotter.news
      .filter(n => n.date >= cutoff && !seen.has(n.date + "|" + n.text))
      .map(n => ({ date: n.date, type: "spotter_news", text: n.text }));
    changelog.entries = [...freshNews, ...changelog.entries]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 400);
    console.log(`News Invader Spotter intégrées : ${freshNews.length}`);
  }

  // Sorties
  const outItems = [...items.values()]
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))
    .map(({ hint, sources, ...inv }) => inv); // hint/sources restent internes au pipeline

  const dataset = { generated: new Date().toISOString(), items: outItems, cities: citiesOut };
  await writeFile(join(OUT, "invaders.json"), JSON.stringify(dataset));
  await writeFile(join(OUT, "changelog.json"), JSON.stringify(changelog));
  await writeFile(join(OUT, "zones", "PA-z1.geojson"), JSON.stringify(zones.z1));
  await writeFile(join(OUT, "zones", "PA-z2.geojson"), JSON.stringify(zones.z2));

  const count = (fn) => outItems.filter(fn).length;
  const meta = {
    generated: new Date().toISOString(),
    sources: {
      siwd: { note: "Space Invaders World Database V05 (déc. 2024)", count: count(i => true) },
      osm: { date: new Date().toISOString().slice(0, 10), note: `${osmNew} nouveaux, ${osmCoords} coords complétées` },
      spotter: spotter ? { date: spotter.date, count: Object.keys(spotter.items).length } : { note: "non disponible" },
      stats: {
        total: outItems.length,
        actifs: count(i => i.status !== "destroyed" && i.status !== "wrecked"),
        detruits: count(i => i.status === "destroyed" || i.status === "wrecked"),
        localises: count(i => i.lat !== undefined),
        interieur: count(i => i.indoor),
        villes: Object.keys(citiesOut).length
      }
    }
  };
  await writeFile(join(OUT, "meta.json"), JSON.stringify(meta, null, 2));
  console.log("meta:", JSON.stringify(meta.sources.stats));

  // overrides.json : créé vide s'il n'existe pas (pour faciliter les corrections)
  try { await access(join(OUT, "overrides.json")); }
  catch { await writeFile(join(OUT, "overrides.json"), JSON.stringify({ "PA_1264": { "indoor": true } }, null, 2)); }

  console.log("✔ Données générées dans public/data/");
}

main().catch(err => { console.error(err); process.exit(1); });
