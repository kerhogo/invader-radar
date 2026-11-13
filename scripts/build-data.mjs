/**
 * Pipeline de données Invader Radar.
 *
 * Fusionne par id (PA_92, NY_12…) :
 *  1. Space Invaders World Database (socle coords/points/statuts, dernière version Vxx publiée)
 *  2. OSM/Overpass (nouveautés, coords manquantes, signaux « intérieur »)
 *  3. Invader Spotter (statuts frais, référentiel des villes, news — cache .cache/spotter.json
 *     produit par scripts/fetch-spotter.mjs)
 *  4. public/data/overrides.json (corrections manuelles)
 * puis affecte chaque invader localisé à ses zones : quartiers et arrondissements
 * d'Open Data Paris, communes de banlieue (zones/PA-suburbs.geojson) et découpages
 * CODE-z1/z2.geojson générés par scripts/fetch-zones.mjs.
 *
 * Produit : public/data/{invaders.json (invaders + villes), changelog.json, meta.json,
 *           zones/PA-z1.geojson, zones/PA-z2.geojson} et rafraîchit les copies datasrc/.
 *
 * Usage : node scripts/build-data.mjs [--offline] [--allow-stale] [--allow-shrink]
 *   --offline      : aucun réseau, lit les copies vendorisées datasrc/ (+ .cache/spotter.json)
 *   --allow-stale  : accepte un cache Invader Spotter absent, périmé ou partiel
 *                    (essai local uniquement — ne jamais committer le résultat)
 *   --allow-shrink : accepte qu'un invader ou une ville déjà publiés disparaissent des sources
 *                    (sans cette option, ils sont reportés de la génération précédente, et
 *                    une disparition de plus de 0,5 % de la base arrête le script)
 */
import { mkdir, readFile, writeFile, access, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ID_RE, distanceM, jsonLines, readJsonIfExists, warn } from "./lib/pipeline.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache");
// Sources réseau vendorisées (committées) : dernier-connu-bon, toujours
// disponible même quand Overpass/opendata sont en panne (504…).
const DATASRC = join(ROOT, "datasrc");
const OUT = join(ROOT, "public", "data");
const UA = "InvaderRadar-DataPipeline/0.1 (projet perso non commercial)";
const OFFLINE = process.argv.includes("--offline");
const ALLOW_STALE = process.argv.includes("--allow-stale");
const ALLOW_SHRINK = process.argv.includes("--allow-shrink");

// Un seul horodatage pour toute la génération (invaders.json, meta.json, changelog)
const GENERATED = new Date().toISOString();
const TODAY = GENERATED.slice(0, 10);

/** Délai maximal d'un téléchargement : au-delà, repli sur la copie vendorisée. */
const FETCH_TIMEOUT_MS = 60_000;
const OVERPASS_TIMEOUT_MS = 200_000; // la requête Overpass s'accorde elle-même 180 s
/** Seuils de vraisemblance des sources : en dessous, le contenu est refusé (repli datasrc/). */
const SIWD_MIN_ROWS = 4000;
const SIWD_MIN_LOCATED_SHARE = 0.9;
const OSM_MIN_NODES = 500;
/** Cache Invader Spotter : âge maximal et part minimale des statuts déjà publiés. */
const SPOTTER_MAX_AGE_DAYS = 2;
const SPOTTER_MIN_SHARE = 0.9;
/** Écart SIWD ↔ OSM au-delà duquel une position mérite un arbitrage manuel (overrides.json). */
const OSM_GAP_M = 100;
/** Distance minimale entre la bulle d'une ville sans découpage ni contour et ses mosaïques. */
const BUBBLE_MIN_DISTANCE_M = 300;
/** Part des invaders publiés qui peut disparaître d'une génération à l'autre sans --allow-shrink. */
const MAX_GONE_SHARE = 0.005;

/* Le dépôt SIWD publie des versions numérotées (V05, V06…). On détecte la plus
   récente à chaque run : rester figé sur une version périmée prive le radar des
   coordonnées des invaders récents (cas PA_1531+ resté aveugle avec la V05). */
const SIWD_MIN_VERSION = 6;
const siwdLabel = v => `V${String(v).padStart(2, "0")}`;
const siwdUrlFor = v => `https://raw.githubusercontent.com/goguelnikov/SpaceInvaders/master/world_space_invaders_${siwdLabel(v)}.json`;

/** Cherche une version plus récente que `known`, sans jamais redescendre en dessous. */
async function latestSiwdVersion(known) {
  let best = known;
  for (let v = known + 1; v <= known + 10; v++) {
    try {
      const res = await fetch(siwdUrlFor(v), {
        method: "HEAD",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) break; // 404 : fin de liste — toute autre erreur : on en reste à la version connue
      best = v;
    } catch { break; } // réseau indisponible : on garde la dernière version connue
  }
  return best;
}
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

/** Pays / drapeau / continent par code ville (groupes du formulaire Invader Spotter). */
const COUNTRY_INFO = (() => {
  const t = {};
  const add = (codes, country, flag, continent) => { for (const c of codes.split(" ")) t[c] = { country, flag, continent }; };
  add("PA VRS TLS MARS LY GRN MPL RN REN LIL BAB AIX AMI AVI BTA CAPF CLR CON CAZ DIJ FTBL FRQ LCT LBR MTB NIM ORLN PAU PRP VLMO NA", "France", "🇫🇷", "Europe");
  add("REUN", "La Réunion (France)", "🇷🇪", "Afrique");
  add("BRL FKF KLN MUN", "Allemagne", "🇩🇪", "Europe");
  add("WN", "Autriche", "🇦🇹", "Europe");
  add("ANVR BXL CHAR RDU", "Belgique", "🇧🇪", "Europe");
  add("BRC BBO MLGA MEN", "Espagne", "🇪🇸", "Europe");
  add("LDN MAN NCL", "Royaume-Uni", "🇬🇧", "Europe");
  add("RA ROM MLN FLR VEN NAP", "Italie", "🇮🇹", "Europe");
  add("AMS NOO RTD", "Pays-Bas", "🇳🇱", "Europe");
  add("FAO PRT2", "Portugal", "🇵🇹", "Europe");
  add("LJU", "Slovénie", "🇸🇮", "Europe");
  add("HALM VSB STK LAP", "Suède", "🇸🇪", "Europe");
  add("ANZR BSL BRN GNV LSN", "Suisse", "🇨🇭", "Europe");
  add("GRU", "Bosnie-Herzégovine", "🇧🇦", "Europe");
  add("IST", "Turquie", "🇹🇷", "Europe");
  add("LA MIA NY SD SF", "États-Unis", "🇺🇸", "Amérique du Nord");
  add("CCU", "Mexique", "🇲🇽", "Amérique du Nord");
  add("SP RIO", "Brésil", "🇧🇷", "Amérique du Sud");
  add("POTI", "Bolivie", "🇧🇴", "Amérique du Sud");
  add("PTI", "Haïti", "🇭🇹", "Amérique du Nord");
  add("HK", "Hong Kong", "🇭🇰", "Asie");
  add("TK", "Japon", "🇯🇵", "Asie");
  add("DHK", "Bangladesh", "🇧🇩", "Asie");
  add("BT", "Bhoutan", "🇧🇹", "Asie");
  add("SL DJN", "Corée du Sud", "🇰🇷", "Asie");
  add("VRN", "Inde", "🇮🇳", "Asie");
  add("ELT", "Israël", "🇮🇱", "Asie");
  add("KAT", "Népal", "🇳🇵", "Asie");
  add("BGK", "Thaïlande", "🇹🇭", "Asie");
  add("MBSA", "Kenya", "🇰🇪", "Afrique");
  add("MRAK RBA CAS", "Maroc", "🇲🇦", "Afrique");
  add("GRTI", "Tanzanie", "🇹🇿", "Afrique");
  add("DJBA", "Tunisie", "🇹🇳", "Afrique");
  add("MLB PRT", "Australie", "🇦🇺", "Océanie");
  add("SPACE", "Espace", "🛰️", "Espace");
  return t;
})();

/* ---------- utilitaires ---------- */

/**
 * Télécharge une source et rafraîchit sa copie vendorisée. En cas de panne, de délai
 * dépassé ou de contenu refusé par `accept`, repli sur la copie (dernier connu bon,
 * présente même en CI). `accept(text)` valide le contenu — en levant une erreur s'il
 * est suspect — et renvoie le texte à vendoriser (forme canonique).
 * Renvoie { text, fresh } : `fresh` est faux quand la copie a servi.
 */
async function fetchCached(name, url, { accept = text => text, timeoutMs = FETCH_TIMEOUT_MS, ...options } = {}) {
  const path = join(DATASRC, name);
  if (!OFFLINE) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": UA, ...(options.headers ?? {}) }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = accept(await res.text());
      // la copie committée n'est réécrite que si le contenu change (pas de commit quotidien à vide)
      const current = await readFile(path, "utf8").catch(() => null);
      if (text !== current) await writeFile(path, text);
      return { text, fresh: true };
    } catch (err) {
      warn(`${name} : ${err.message} — repli sur datasrc/ (dernier connu)`);
    }
  }
  return { text: await readFile(path, "utf8"), fresh: false };
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

function parseSiwd(text) {
  const raw = JSON.parse(stripBom(text));
  if (!Array.isArray(raw)) throw new Error("tableau attendu");
  const items = new Map();
  let located = 0;
  for (const e of raw) {
    const id = String(e.id ?? "").trim().replace(/\s+/g, "");
    if (!ID_RE.test(id)) continue;
    const lat = parseCoord(e.lat);
    const lng = parseCoord(e.lng);
    if (lat !== undefined && lng !== undefined) located++;
    items.set(id, {
      id,
      city: id.split("_")[0],
      lat,
      lng,
      status: normStatus(e.status),
      points: Number(e.points) || 0,
      hint: String(e.hint ?? ""),
      sources: ["siwd"]
    });
  }
  // Une colonne renommée dans une nouvelle version ne lève aucune erreur : elle vide
  // les coordonnées. On refuse donc un contenu qui ne ressemble plus au socle.
  if (items.size < SIWD_MIN_ROWS || located < items.size * SIWD_MIN_LOCATED_SHARE) {
    throw new Error(`contenu suspect (${items.size} invaders dont ${located} localisés)`);
  }
  return items;
}

/** `knownVersion` : dernière version acceptée (meta.json précédent), plancher de la détection. */
async function loadSiwd(knownVersion) {
  const candidate = OFFLINE ? knownVersion : await latestSiwdVersion(knownVersion);
  const { text, fresh } = await fetchCached("siwd.json", siwdUrlFor(candidate), {
    accept: t => { parseSiwd(t); return t; }
  });
  const items = parseSiwd(text);
  // en repli, la copie vendorisée est celle de la dernière version acceptée
  const version = fresh ? candidate : knownVersion;
  console.log(`SIWD : version ${siwdLabel(version)}, ${items.size} invaders`);
  return { items, version, count: items.size };
}

/* ---------- 2. OSM ---------- */

/**
 * Forme vendorisée de la réponse Overpass : les seuls nœuds, triés, un par ligne.
 * L'en-tête (horodatage de la base) changeait le fichier chaque jour sans donnée nouvelle.
 */
function canonicalOsm(text) {
  const data = JSON.parse(text);
  // Overpass répond 200 avec un résultat tronqué quand il dépasse son délai ou sa mémoire
  if (data.remark) throw new Error(`réponse partielle (${data.remark})`);
  const elements = [...(data.elements ?? [])].sort((a, b) => a.id - b.id);
  if (elements.length < OSM_MIN_NODES) throw new Error(`${elements.length} nœuds seulement`);
  return jsonLines({ elements });
}

async function loadOsm() {
  const query = `[out:json][timeout:180];node["artist_name"~"^[Ii]nvader$"];out body;`;
  const { text, fresh } = await fetchCached("osm.json", OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
    timeoutMs: OVERPASS_TIMEOUT_MS,
    accept: canonicalOsm
  });
  const data = JSON.parse(text);
  const nodes = [];
  for (const el of data.elements ?? []) {
    const t = el.tags ?? {};
    const ref = String(t.ref ?? t.name ?? "").trim().replace(/\s+/g, "");
    if (!ID_RE.test(ref)) continue;
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
  return { nodes, fresh };
}

/* ---------- 3. Invader Spotter (cache produit par fetch-spotter.mjs) ---------- */

/**
 * `published` : entrée `sources.spotter` du meta.json précédent. Un cache absent,
 * périmé ou partiel ferait retomber des centaines de statuts sur ceux du socle (2024)
 * et publierait autant de faux changements : refusé, sauf --allow-stale.
 */
async function loadSpotter(published) {
  const raw = await readJsonIfExists(join(CACHE, "spotter.json"));
  const problems = [];
  if (!raw) {
    problems.push("absent");
  } else {
    const count = Object.keys(raw.items ?? {}).length;
    const ageDays = (Date.parse(TODAY) - Date.parse(raw.date)) / 864e5;
    if (!(ageDays <= SPOTTER_MAX_AGE_DAYS)) problems.push(`daté du ${raw.date}`);
    if (published?.date && raw.date < published.date) problems.push(`antérieur à la dernière publication (${published.date})`);
    if (published?.count && count < published.count * SPOTTER_MIN_SHARE) problems.push(`partiel (${count} statuts contre ${published.count} publiés)`);
  }
  if (problems.length) {
    const message = `Cache Invader Spotter ${problems.join(", ")}`;
    if (!ALLOW_STALE) {
      throw new Error(`${message} — lance scripts/fetch-spotter.mjs (ou --allow-stale pour un essai local, à ne pas committer)`);
    }
    warn(`${message} — accepté (--allow-stale)${raw ? "" : " : statuts SIWD/OSM seuls"}`);
  }
  if (raw) console.log(`Invader Spotter : ${Object.keys(raw.items ?? {}).length} statuts (du ${raw.date})`);
  // derogation : cache accepté malgré un défaut (--allow-stale) — les garde-fous de rétrécissement ne bloquent plus
  return { spotter: raw, derogation: problems.length > 0 };
}

/* ---------- Zones Paris ---------- */

const zoneName = p => p.l_qu ?? p.l_ar ?? p.l_aroff ?? p.name ?? "?";

/**
 * Forme vendorisée d'un export Open Data Paris : entités triées par code, une par ligne
 * (l'API les renvoie dans un ordre variable, ce qui « modifiait » le fichier sans raison).
 * Refuse un export incomplet ou dont les colonnes de nom ont changé.
 */
const canonicalZones = (expected, codeOf) => text => {
  const fc = JSON.parse(text);
  const features = [...(fc.features ?? [])];
  if (features.length !== expected) throw new Error(`${features.length} entités au lieu de ${expected}`);
  if (features.some(f => !f.geometry || zoneName(f.properties ?? {}) === "?")) throw new Error("entité sans géométrie ou sans nom");
  return jsonLines({ type: "FeatureCollection", features: sortByCode(features, codeOf) });
};
const sortByCode = (features, codeOf) =>
  [...features].sort((a, b) => Number(codeOf(a.properties)) - Number(codeOf(b.properties)));

async function loadParisZones() {
  const quartierCode = p => p.c_qu, arrondissementCode = p => p.c_ar;
  const quartiers = JSON.parse((await fetchCached("quartiers.geojson", QUARTIERS_URL, { accept: canonicalZones(80, quartierCode) })).text);
  const arrondissements = JSON.parse((await fetchCached("arrondissements.geojson", ARRONDISSEMENTS_URL, { accept: canonicalZones(20, arrondissementCode) })).text);

  // tri appliqué aussi à la lecture : la sortie ne dépend pas de l'ordre de la copie vendorisée
  const clean = (fc, codeOf, extra) => ({
    type: "FeatureCollection",
    features: sortByCode(fc.features, codeOf).map(f => ({
      type: "Feature",
      geometry: roundCoords(f.geometry),
      properties: { name: zoneName(f.properties), ...(extra ? extra(f.properties) : {}) }
    }))
  });

  return {
    z1: clean(quartiers, quartierCode, p => ({ arrt: p.c_ar ?? null })),
    z2: clean(arrondissements, arrondissementCode)
  };
}

/* ---------- Fusion ---------- */

async function main() {
  await mkdir(DATASRC, { recursive: true });
  await mkdir(join(OUT, "zones"), { recursive: true });

  // Génération précédente, dernier connu bon : plancher de version SIWD, fraîcheur du cache
  // Spotter, dates des sources, statuts et invaders à reporter si une source en omet un jour.
  // (absente seulement à la toute première génération)
  const previousMeta = await readJsonIfExists(join(OUT, "meta.json"));
  const previous = await readJsonIfExists(join(OUT, "invaders.json"));
  const prevItems = new Map((previous?.items ?? []).map(i => [i.id, i]));
  const knownSiwd = Math.max(SIWD_MIN_VERSION, Number(previousMeta?.sources?.siwd?.version) || 0);

  // Le cache Spotter est contrôlé avant tout téléchargement : s'il est refusé, rien n'est écrit.
  const { spotter, derogation } = await loadSpotter(previousMeta?.sources?.spotter);
  // Référentiel officiel des villes (Invader Spotter) ; la table curée complète les rares codes absents.
  const ref = spotter?.cities ?? {};
  const knowsOfficial = Object.keys(ref).length > 0;
  const isOfficial = code => !knowsOfficial || !!ref[code] || !!CITY_NAMES[code];
  // Une ville ne quitte pas le référentiel : s'il en manque une déjà publiée, villes.php a été mal lu.
  const lostCities = knowsOfficial
    ? Object.keys(previous?.cities ?? {}).filter(code => previous.cities[code].official && !ref[code])
    : [];
  if (lostCities.length) {
    const message = `ville(s) publiée(s) absente(s) du référentiel du jour (${Object.keys(ref).length} villes) : ${lostCities.join(", ")}`;
    if (!ALLOW_SHRINK && !derogation) {
      throw new Error(`${message} — villes.php mal lu ? (--allow-shrink si Invader Spotter les a vraiment retirées)`);
    }
    warn(message);
  }

  const siwd = await loadSiwd(knownSiwd);
  const items = siwd.items;
  const { nodes: osm, fresh: osmFresh } = await loadOsm();
  const zones = await loadParisZones();

  // Banlieue parisienne (Meudon, Aubervilliers…) : communes générées une fois
  // par scripts/fetch-zones.mjs et commitées, fusionnées aux quartiers ET aux
  // arrondissements pour rester visibles à tous les niveaux de zoom.
  const suburbs = await readJsonIfExists(join(OUT, "zones", "PA-suburbs.geojson"));
  if (suburbs) {
    zones.z1.features.push(...suburbs.features);
    zones.z2.features.push(...suburbs.features);
    console.log(`Banlieue Paris : ${suburbs.features.length} communes fusionnées`);
  } else {
    warn("PA-suburbs.geojson absent — banlieue non zonée (lance scripts/fetch-zones.mjs)");
  }

  let osmNew = 0, osmCoords = 0;
  const gaps = [];
  for (const n of osm) {
    const existing = items.get(n.id);
    if (existing) {
      if (existing.lat === undefined) { existing.lat = n.lat; existing.lng = n.lng; osmCoords++; }
      else if (existing.lng !== undefined) {
        const gap = Math.round(distanceM(existing.lat, existing.lng, n.lat, n.lng));
        if (gap > OSM_GAP_M) gaps.push(`${n.id} ${gap} m`);
      }
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
  // Le socle garde la priorité, mais un écart important signale qu'une des deux sources se trompe
  if (gaps.length) console.log(`Écarts SIWD ↔ OSM > ${OSM_GAP_M} m (à arbitrer dans overrides.json) : ${gaps.join(", ")}`);

  let spotterNoStatus = 0;
  if (spotter) {
    let updated = 0;
    for (const [id, s] of Object.entries(spotter.items)) {
      const inv = items.get(id);
      // Statut illisible côté Spotter : dernier statut publié, à défaut celui du socle —
      // jamais un faux « inconnu », jamais un retour aux statuts de 2024.
      const hasStatus = String(s.status ?? "").trim() !== "";
      if (!hasStatus) spotterNoStatus++;
      const status = hasStatus ? normStatus(s.status) : prevItems.get(id)?.status ?? inv?.status ?? "unknown";
      if (inv) {
        if (inv.status !== status) updated++;
        inv.status = status;
        if (s.points) inv.points = inv.points || Number(s.points) || 0;
        if (s.location && INDOOR_RE.test(s.location)) inv.indoor = true;
        inv.sources.push("spotter");
      } else if (ID_RE.test(id)) {
        items.set(id, {
          id, city: id.split("_")[0], status,
          points: Number(s.points) || 0, hint: s.location ?? "",
          indoor: s.location && INDOOR_RE.test(s.location) ? true : undefined,
          sources: ["spotter"]
        });
      }
    }
    console.log(`Invader Spotter : ${updated} statuts actualisés`);
    if (spotterNoStatus) warn(`Invader Spotter : ${spotterNoStatus} ligne(s) sans statut lisible — dernier statut publié conservé`);
  }

  // Dernier connu bon. Spotter peut omettre un invader un jour (liste écourtée, page vide) :
  //  - s'il reste connu du socle ou d'OSM, son dernier statut publié fait foi, pas celui de 2024 ;
  //  - s'il n'est plus dans aucune source, il est reporté tel quel plutôt que de disparaître
  //    puis d'être ré-annoncé « nouveau » le lendemain (--allow-shrink accepte le retrait).
  let keptStatus = 0;
  for (const inv of items.values()) {
    const before = prevItems.get(inv.id);
    if (before && !inv.sources.includes("spotter") && inv.status !== before.status) { inv.status = before.status; keptStatus++; }
  }
  if (keptStatus) console.log(`Statuts : ${keptStatus} invader(s) sans ligne Spotter aujourd'hui, dernier statut publié conservé`);
  const carried = [];
  if (!ALLOW_SHRINK) {
    for (const [id, p] of prevItems) {
      if (items.has(id) || !isOfficial(p.city)) continue; // une coquille hors référentiel ne se reporte pas
      items.set(id, {
        id, city: p.city, lat: p.lat, lng: p.lng, status: p.status,
        points: p.points ?? 0, hint: "", indoor: p.indoor, sources: ["previous"]
      });
      carried.push(id);
    }
  }
  if (carried.length) {
    warn(`${carried.length} invader(s) absent(s) des sources aujourd'hui, reporté(s) de la génération précédente : ${carried.slice(0, 20).join(", ")}${carried.length > 20 ? "…" : ""}`);
    if (carried.length > prevItems.size * MAX_GONE_SHARE && !derogation) {
      throw new Error(`${carried.length} invaders publiés sur ${prevItems.size} absents des sources — source tronquée ? (--allow-shrink si le retrait est réel)`);
    }
  }

  // Heuristique intérieur sur les hints SIWD
  for (const inv of items.values()) {
    if (!inv.indoor && inv.hint && INDOOR_RE.test(inv.hint)) inv.indoor = true;
  }

  // Overrides manuels (corrections de terrain)
  const overrides = (await readJsonIfExists(join(OUT, "overrides.json"))) ?? {};
  for (const [id, patch] of Object.entries(overrides)) {
    const inv = items.get(id);
    if (inv) Object.assign(inv, patch);
    else warn(`overrides.json : ${id} inconnu de la base, correction ignorée`);
  }
  console.log(`Overrides manuels : ${Object.keys(overrides).length} correction(s)`);

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

  // Sous-découpage des autres villes : vraies frontières administratives
  // (fichiers générés par scripts/fetch-zones.mjs et commités — les limites
  // admin bougent rarement, la CI quotidienne ne les régénère pas)
  const zoneFiles = await readdir(join(OUT, "zones")).catch(() => []);
  const zonedCities = new Set(
    zoneFiles.filter(f => f.endsWith("-z1.geojson")).map(f => f.split("-")[0])
  );
  zonedCities.add("PA");
  for (const code of zonedCities) {
    if (code === "PA") continue; // quartiers officiels + banlieue déjà affectés
    // un fichier illisible est une erreur (la ville resterait déclarée zonée sans l'être)
    const gz1 = await readJsonIfExists(join(OUT, "zones", `${code}-z1.geojson`));
    const gz2 = await readJsonIfExists(join(OUT, "zones", `${code}-z2.geojson`)); // niveau moyen facultatif
    if (!gz1) continue;
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

  // Villes sans sous-découpage : contour de la ville (zones/CODE-outline.geojson, généré par
  // fetch-zones.mjs --outlines). La carte l'affiche au zoom à la place d'une bulle, et son centre
  // remplace la moyenne des positions des invaders — qui, pour une ville de quelques mosaïques,
  // revenait à publier un repère posé dessus.
  const outlineCenters = new Map();
  for (const file of zoneFiles.filter(f => f.endsWith("-outline.geojson"))) {
    const code = file.split("-")[0];
    if (zonedCities.has(code)) continue;
    const geom = (await readJsonIfExists(join(OUT, "zones", file)))?.features?.[0]?.geometry;
    const rings = geom?.type === "Polygon" ? [geom.coordinates[0]]
      : geom?.type === "MultiPolygon" ? geom.coordinates.map(p => p[0]) : [];
    if (!rings.length) throw new Error(`${file} : contour sans polygone`);
    // centre de l'emprise du plus grand polygone (un territoire lointain ne doit pas le déporter)
    let best = null;
    for (const ring of rings) {
      const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
      const b = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      b.area = (b.maxX - b.minX) * (b.maxY - b.minY);
      if (!best || b.area > best.area) best = b;
    }
    outlineCenters.set(code, {
      lat: Math.round(((best.minY + best.maxY) / 2) * 1e5) / 1e5,
      lng: Math.round(((best.minX + best.maxX) / 2) * 1e5) / 1e5,
      // demi-diagonale de l'emprise, en km : la carte charge le contour dès qu'on en approche
      reach: Math.ceil(distanceM(best.minY, best.minX, best.maxY, best.maxX) / 2000)
    });
  }
  if (outlineCenters.size) console.log(`Contours de ville : ${outlineCenters.size}`);

  // Référentiel villes : noms + dénominateurs officiels via Invader Spotter,
  // repli sur la table curée. Seules les villes de l'univers officiel existent ici.
  const cities = {};
  for (const inv of items.values()) {
    (cities[inv.city] ??= { lats: [], lngs: [], count: 0 }).count++;
    if (inv.lat !== undefined) { cities[inv.city].lats.push(inv.lat); cities[inv.city].lngs.push(inv.lng); }
  }
  const citiesOut = {};
  const offReferential = new Set();
  const noCountry = [];
  for (const [code, c] of Object.entries(cities)) {
    if (c.count < 2 && c.lats.length === 0) continue; // scories improbables
    // « villes officielles uniquement » : un code absent du référentiel Invader
    // Spotter et de la table curée est une coquille du dataset (ex. LND vs LDN)
    if (!isOfficial(code)) {
      console.warn(`! ville ignorée (hors référentiel officiel) : ${code} — ${c.count} invader(s)`);
      offReferential.add(code);
      continue;
    }
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    if (!COUNTRY_INFO[code]) noCountry.push(code);
    const geo = COUNTRY_INFO[code] ?? { country: "Ailleurs", flag: "🌍", continent: "Ailleurs" };
    const outline = outlineCenters.get(code);
    let lat = outline ? outline.lat : Math.round(avg(c.lats) * 1e5) / 1e5;
    const lng = outline ? outline.lng : Math.round(avg(c.lngs) * 1e5) / 1e5;
    if (!outline && !zonedCities.has(code) && c.lats.length) {
      // Ni découpage ni contour (ville nouvelle, contour pas encore généré) : sa bulle reste affichée
      // au zoom. Posée au milieu de quelques mosaïques, elle en désignerait une : on l'en écarte,
      // en attendant le contour.
      const tooClose = () => c.lats.some((la, k) => distanceM(lat, lng, la, c.lngs[k]) < BUBBLE_MIN_DISTANCE_M);
      if (tooClose()) {
        for (let step = 0; step < 40 && tooClose(); step++) lat = Math.round((lat + 0.004) * 1e5) / 1e5;
        warn(`${code} : ni découpage ni contour, bulle écartée des mosaïques — lancer « node scripts/fetch-zones.mjs --outlines --city=${code} »`);
      }
    }
    citiesOut[code] = {
      name: ref[code]?.name ?? CITY_NAMES[code] ?? code,
      lat,
      lng,
      count: c.count,
      flag: geo.flag,
      country: geo.country,
      continent: geo.continent,
      ...(ref[code]?.official ? { official: ref[code].official } : {}),
      ...(zonedCities.has(code) ? { zones: true } : {}),
      ...(outline ? { outline: true, reach: outline.reach } : {})
    };
  }

  if (noCountry.length) console.log(`Villes sans pays dans COUNTRY_INFO (classées « Ailleurs ») : ${noCountry.join(", ")}`);

  // Une ville écartée emporte ses invaders : sinon la coquille reste une cible du radar,
  // impossible à flasher (LND_182 doublait LDN_182 au même endroit).
  let dropped = 0;
  for (const inv of [...items.values()]) {
    if (offReferential.has(inv.city)) { items.delete(inv.id); dropped++; }
  }
  if (dropped) console.log(`Hors référentiel : ${dropped} invader(s) retiré(s) avec leur ville`);

  // Changelog : diff avec la génération précédente
  const today = TODAY;
  const changelog = (await readJsonIfExists(join(OUT, "changelog.json"))) ?? { entries: [] };

  if (previous) {
    const prevCities = new Set(previous.items.map(i => i.city));
    // Ne restent ici que les retraits voulus : coquilles hors référentiel, ou tout retrait
    // accepté par --allow-shrink (les autres absents ont été reportés plus haut).
    const gone = [...prevItems.keys()].filter(id => !items.has(id));
    if (gone.length) {
      warn(`${gone.length} invader(s) retiré(s) de la publication : ${gone.slice(0, 20).join(", ")}${gone.length > 20 ? "…" : ""}`);
      if (gone.length > prevItems.size * MAX_GONE_SHARE && !ALLOW_SHRINK && !derogation) {
        throw new Error(`${gone.length} invaders retirés sur ${prevItems.size} — référentiel ou source tronqués ? (--allow-shrink pour l'accepter)`);
      }
    }
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
    // Deuxième génération le même jour (relance après un incident) : `previous` est déjà
    // celle du matin, `fresh` ne contient donc que l'écart depuis. Les événements déjà notés
    // aujourd'hui sont conservés et combinés aux nouveaux, au lieu d'être effacés.
    const isEvent = e => e.type !== "spotter_news";
    const key = e => (e.type === "new_city" ? `city:${e.city}` : `id:${e.id}`);
    const todays = new Map(changelog.entries.filter(e => e.date === today && isEvent(e)).map(e => [key(e), e]));
    for (const e of fresh) {
      const earlier = todays.get(key(e));
      if (!earlier) todays.set(key(e), e);
      else if (earlier.type === "status_change" && e.type === "status_change") {
        // a → b ce matin puis b → c : un seul événement a → c (ou aucun si retour à l'état initial)
        if (earlier.from === e.to) todays.delete(key(e));
        else todays.set(key(e), { ...e, from: earlier.from });
      }
      // sinon l'invader est déjà annoncé « nouveau » aujourd'hui : cette entrée reste la bonne
    }
    // anti-spoiler : les entrées du changelog ne portent jamais de coordonnées
    changelog.entries = [...todays.values(), ...changelog.entries.filter(e => e.date !== today || !isEvent(e))];
    console.log(`Changelog : ${fresh.length} événement(s) depuis la génération précédente, ${todays.size} aujourd'hui`);
  }

  // News Invader Spotter (texte brut, jamais de coordonnées) → onglet Actualités
  if (spotter?.news?.length) {
    const cutoff = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    const seen = new Set(changelog.entries.filter(e => e.type === "spotter_news").map(e => e.date + "|" + e.text));
    const freshNews = spotter.news
      .filter(n => n.date >= cutoff && !seen.has(n.date + "|" + n.text))
      .map(n => ({ date: n.date, type: "spotter_news", text: n.text }));
    changelog.entries = [...freshNews, ...changelog.entries];
    console.log(`News Invader Spotter intégrées : ${freshNews.length}`);
  }

  // Assemblage final. Deux garde-fous :
  //  1. une news qui ne fait que redire un changement de statut déjà listé est
  //     redondante (même événement, deux formulations) → écartée ;
  //  2. quota réservé aux news, sinon un gros lot de changements de statut
  //     (resynchronisation) les évince toutes et la source disparaît de l'onglet.
  {
    const MAX_TOTAL = 400, MAX_NEWS = 120;
    const byDateDesc = (a, b) => b.date.localeCompare(a.date);
    const all = changelog.entries;
    const changedIds = new Set(all.filter(e => e.type === "status_change" && e.id).map(e => e.id));
    const news = all
      .filter(e => e.type === "spotter_news")
      .filter(e => {
        const ids = String(e.text ?? "").match(/[A-Z]{2,5}_\d+/g) ?? [];
        return ids.length === 0 || !ids.every(id => changedIds.has(id));
      })
      .sort(byDateDesc)
      .slice(0, MAX_NEWS);
    const events = all.filter(e => e.type !== "spotter_news").sort(byDateDesc).slice(0, MAX_TOTAL - news.length);
    changelog.entries = [...news, ...events].sort(byDateDesc);
    console.log(`Changelog final : ${events.length} événements + ${news.length} news`);
  }

  // Sorties
  const outItems = [...items.values()]
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))
    .map(({ hint, sources, ...inv }) => inv); // hint/sources restent internes au pipeline

  // Une entrée par ligne : diffs lisibles, rebases sans conflit sur le fichier entier
  const dataset = { generated: GENERATED, items: outItems, cities: citiesOut };
  await writeFile(join(OUT, "invaders.json"), jsonLines(dataset));
  await writeFile(join(OUT, "changelog.json"), jsonLines(changelog));
  await writeFile(join(OUT, "zones", "PA-z1.geojson"), jsonLines(zones.z1));
  await writeFile(join(OUT, "zones", "PA-z2.geojson"), jsonLines(zones.z2));

  // Date OSM = dernier téléchargement réussi : en repli sur la copie vendorisée, on garde l'ancienne
  const osmDate = osmFresh ? TODAY : previousMeta?.sources?.osm?.date ?? TODAY;
  const osmAgeDays = Math.round((Date.parse(TODAY) - Date.parse(osmDate)) / 864e5);
  if (!OFFLINE && osmAgeDays > 7) warn(`OSM/Overpass en repli depuis ${osmAgeDays} jours (dernier téléchargement réussi : ${osmDate})`);

  // Lignes Spotter par ville : fetch-spotter s'y réfère le lendemain pour repérer une liste coupée
  const spotterPerCity = {};
  for (const id of Object.keys(spotter?.items ?? {})) {
    const code = id.split("_")[0];
    spotterPerCity[code] = (spotterPerCity[code] ?? 0) + 1;
  }

  const count = (fn) => outItems.filter(fn).length;
  const meta = {
    generated: GENERATED,
    sources: {
      siwd: { note: `Space Invaders World Database ${siwdLabel(siwd.version)}`, version: siwd.version, count: siwd.count },
      osm: { date: osmDate, note: `${osmNew} nouveaux, ${osmCoords} coords complétées` },
      spotter: spotter
        ? { date: spotter.date, count: Object.keys(spotter.items).length, cities: Object.keys(ref).length, perCity: spotterPerCity }
        : { note: "non disponible" },
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
