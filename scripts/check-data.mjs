/**
 * Contrôles d'invariants sur les données générées. Porte de qualité de la CI :
 * exécutée par refresh-data.yml avant le commit et par deploy.yml avant la publication.
 *
 * Les seuils sont des planchers larges : ils attrapent une source tronquée ou un
 * format qui a changé, sans casser le rafraîchissement quand la base grandit
 * (nouvelle ville officielle, nouveaux invaders sans coordonnées).
 *
 * Usage : node scripts/check-data.mjs [uid]
 *   uid (ou variable d'environnement FI_UID) : croise avec la galerie FlashInvaders
 */
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ID_RE, distanceM, pointInGeometry, readJsonIfExists, warn } from "./lib/pipeline.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");
const uid = process.argv.slice(2).find(a => !a.startsWith("-")) ?? process.env.FI_UID;

const STATUSES = ["ok", "damaged", "wrecked", "hidden", "unknown", "destroyed"];
const MIN_ITEMS = 4000;
const MIN_LOCATED = 4000;
const MIN_LOCATED_SHARE = 0.85;
const MAX_UNKNOWN_SHARE = 0.05;
const MIN_CITIES = 80;
const MAX_CHANGELOG = 400;

const readRequired = async file => {
  const json = await readJsonIfExists(join(DATA, file));
  if (!json) throw new Error(`public/data/${file} absent`);
  return json;
};

const ds = await readRequired("invaders.json");
const meta = await readRequired("meta.json");
const changelog = await readRequired("changelog.json");
const items = ds.items;
const byId = new Map(items.map(i => [i.id, i]));
let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✔" : "✘"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

// Statuts par défaut de l'app : ok + damaged + unknown (hidden/wrecked/destroyed exclus)
const activeDefault = i => ["ok", "damaged", "unknown"].includes(i.status);

/* ---------- Forme et volume ---------- */

const badShape = items.filter(i =>
  !ID_RE.test(i.id ?? "") || i.city !== i.id.split("_")[0] || !STATUSES.includes(i.status)
  || (i.lat === undefined) !== (i.lng === undefined)
  || (i.lat !== undefined && !(Math.abs(i.lat) <= 90 && Math.abs(i.lng) <= 180)));
check("Invaders bien formés (id, ville, statut, coordonnées)", badShape.length === 0,
  badShape.length ? badShape.slice(0, 5).map(i => i.id).join(", ") : `${items.length} invaders`);
check("Identifiants uniques", byId.size === items.length, `${items.length - byId.size} doublon(s)`);
check(`Base complète (≥ ${MIN_ITEMS} invaders)`, items.length >= MIN_ITEMS, String(items.length));

// Le socle SIWD porte presque toutes les coordonnées : s'il est perdu ou mal lu,
// seuls ~700 invaders (ceux d'OSM) restent localisés et le radar devient aveugle.
const located = items.filter(i => i.lat !== undefined).length;
check("Invaders localisés (socle SIWD présent)",
  located >= MIN_LOCATED && located / items.length >= MIN_LOCATED_SHARE,
  `${located}/${items.length}`);
const unknown = items.filter(i => i.status === "unknown").length;
check(`Statuts inconnus < ${MAX_UNKNOWN_SHARE * 100} % (statuts Invader Spotter lus)`, unknown / items.length < MAX_UNKNOWN_SHARE, `${unknown}`);
check("Des détruits existent et sont distincts", items.filter(i => i.status === "destroyed").length > 1000);

/* ---------- Paris ---------- */

const pa = items.filter(i => i.city === "PA");
const paActive = pa.filter(activeDefault);
const paLocated = paActive.filter(i => i.lat !== undefined);
const paZoned = paLocated.filter(i => i.z1);

check("Paris présent dans la base", pa.length >= 1400, `${pa.length} invaders PA`);
check("PA_1529/PA_1530 (post-dataset, via OSM) présents", byId.has("PA_1529") && byId.has("PA_1530"));
// ~7 % des « PA » sont en banlieue (hors des 80 quartiers intra-muros) : non zonés, c'est attendu
check("Quartier affecté aux actifs localisés intra-muros de Paris",
  paZoned.length / Math.max(1, paLocated.length) > 0.9,
  `${paZoned.length}/${paLocated.length} zonés (reste = banlieue)`);
const paQuartiers = new Set(paZoned.map(i => i.z1));
check("Nombre de zones parisiennes plausible (quartiers + communes banlieue)", paQuartiers.size >= 60 && paQuartiers.size <= 160, `${paQuartiers.size} zones`);

// Échantillons connus
const pa92 = byId.get("PA_92");
check("PA_92 localisé et zoné", !!pa92 && pa92.lat !== undefined && !!pa92.z1, pa92 ? `${pa92.z1} / ${pa92.z2}` : "absent");
check("PA_1264 marqué intérieur (Musée en Herbe)", byId.get("PA_1264")?.indoor === true);

/* ---------- Villes ---------- */

const cityCodes = Object.keys(ds.cities);
// Borne haute calée sur le référentiel du jour (et non figée) : une nouvelle ville officielle
// ne doit pas bloquer le rafraîchissement. Les rares codes hors référentiel sont ceux de la table curée.
const officialCities = meta.sources?.spotter?.cities;
check("Villes : référentiel officiel, pas de scories",
  cityCodes.length >= MIN_CITIES && (!officialCities || cityCodes.length <= officialCities + 5),
  `${cityCodes.length} villes${officialCities ? ` pour ${officialCities} au référentiel` : ""}`);
const unnamed = cityCodes.filter(code => ds.cities[code].name === code);
console.log(`  (villes sans nom d'affichage : ${unnamed.join(", ") || "aucune"})`);
const orphans = items.filter(i => !ds.cities[i.city]);
console.log(`  (invaders dont la ville n'est pas publiée : ${orphans.map(i => i.id).join(", ") || "aucun"})`);

/* ---------- Zones GeoJSON ---------- */

// Chaque quartier/arrondissement porté par un invader doit exister dans le GeoJSON de sa
// ville : c'est la jointure par nom qu'utilisent la carte et l'accordéon du Tableau.
const zoneFiles = new Set(await readdir(join(DATA, "zones")));
const zoneNames = new Map();
const namesOf = async file => {
  if (!zoneNames.has(file)) {
    const fc = zoneFiles.has(file) ? await readJsonIfExists(join(DATA, "zones", file)) : null;
    zoneNames.set(file, fc ? fc.features.map(f => f.properties?.name) : null);
  }
  return zoneNames.get(file);
};
const zoneProblems = [];
for (const code of cityCodes.filter(c => ds.cities[c].zones)) {
  const cityItems = items.filter(i => i.city === code);
  if (!cityItems.some(i => i.z1)) zoneProblems.push(`${code} déclarée zonée sans aucun invader zoné`);
  for (const level of ["z1", "z2"]) {
    const used = new Set(cityItems.map(i => i[level]).filter(Boolean));
    if (used.size === 0) continue;
    const names = await namesOf(`${code}-${level}.geojson`);
    if (!names) { zoneProblems.push(`${code}-${level}.geojson manquant`); continue; }
    const known = new Set(names);
    const missing = [...used].filter(n => !known.has(n));
    if (missing.length) zoneProblems.push(`${code} ${level} : ${missing.slice(0, 3).join(", ")} absent(s) du GeoJSON`);
    if (known.size !== names.length || known.has("?") || known.has(undefined)) zoneProblems.push(`${code}-${level}.geojson : noms en double ou manquants`);
  }
}
check("Zones des invaders présentes dans les GeoJSON (jointure carte/tableau)", zoneProblems.length === 0, zoneProblems.slice(0, 4).join(" ; "));

const z1 = await namesOf("PA-z1.geojson");
const z2 = await namesOf("PA-z2.geojson");
check("PA-z1 : 80 quartiers + communes de banlieue", (z1?.length ?? 0) >= 110, String(z1?.length ?? "absent"));
check("PA-z2 : 20 arrondissements + communes de banlieue", (z2?.length ?? 0) >= 50, String(z2?.length ?? "absent"));
// borne haute calée sur le GeoJSON : une commune de banlieue ajoutée ne doit pas bloquer le contrôle
const paArrondissements = new Set(pa.filter(i => i.z2).map(i => i.z2));
check("Arrondissements de Paris distincts (20 + communes de banlieue)",
  paArrondissements.size >= 20 && paArrondissements.size <= (z2?.length ?? 0), String(paArrondissements.size));

/* ---------- Contours des villes sans sous-découpage (anti-spoiler) ---------- */

// Au zoom, la carte affiche le contour de la ville à la place d'une bulle posée au milieu de ses
// invaders. Le contour doit exister et rester assez grand pour ne désigner aucun emplacement.
const OUTLINE_MIN_DIAGONAL_M = 2000;
const outlineProblems = [];
const outlinesToRefresh = [];
for (const code of cityCodes.filter(c => ds.cities[c].outline)) {
  const file = `${code}-outline.geojson`;
  const geom = zoneFiles.has(file) ? (await readJsonIfExists(join(DATA, "zones", file)))?.features?.[0]?.geometry : null;
  if (!geom || !/Polygon/.test(geom.type ?? "")) { outlineProblems.push(`${file} manquant ou sans polygone`); continue; }
  if (ds.cities[code].zones) outlineProblems.push(`${code} : contour et sous-découpage à la fois`);
  // chaque morceau du contour compte : un îlot minuscule désignerait ce qu'il entoure
  const pieces = (geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates).map(poly => {
    const lngs = poly[0].map(p => p[0]), lats = poly[0].map(p => p[1]);
    return distanceM(Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs));
  });
  const smallest = Math.min(...pieces);
  if (!(smallest >= OUTLINE_MIN_DIAGONAL_M)) outlineProblems.push(`${code} : morceau de contour de ${Math.round(smallest)} m seulement`);
  const cityLocated = items.filter(i => i.city === code && i.lat !== undefined);
  const inside = cityLocated.filter(i => pointInGeometry(i.lng, i.lat, geom)).length;
  // fetch-zones accepte un contour qui contient la majorité des invaders (ville + communes voisines)
  if (cityLocated.length && inside / cityLocated.length < 0.6) outlinesToRefresh.push(`${code} ${inside}/${cityLocated.length}`);
}
check("Contours de ville présents et assez grands", outlineProblems.length === 0, outlineProblems.slice(0, 4).join(" ; "));
if (outlinesToRefresh.length) warn(`contours à régénérer (fetch-zones.mjs --outlines --force) : la majorité des invaders en est sortie — ${outlinesToRefresh.join(", ")}`);
// Villes qui gardent une bulle au zoom (ni découpage ni contour) : elle ne doit pas tomber sur un invader
const exposed = cityCodes.filter(code => {
  const c = ds.cities[code];
  if (c.zones || c.outline || (!c.lat && !c.lng)) return false;
  return items.some(i => i.city === code && activeDefault(i) && i.lat !== undefined && distanceM(c.lat, c.lng, i.lat, i.lng) < 150);
});
if (exposed.length) warn(`villes sans contour dont la bulle est à moins de 150 m d'un invader actif : ${exposed.join(", ")} — lancer fetch-zones.mjs --outlines`);
else console.log("  (aucune ville sans contour dont la bulle tombe sur un invader)");

/* ---------- Actualités et métadonnées ---------- */

const entries = changelog.entries;
const badEntries = Array.isArray(entries)
  ? entries.filter(e => !/^\d{4}-\d{2}-\d{2}$/.test(e.date ?? "") || !e.type)
  : null;
check("Changelog lisible et daté", Array.isArray(entries) && badEntries.length === 0 && entries.length <= MAX_CHANGELOG,
  Array.isArray(entries) ? `${entries.length} entrées` : "entries absent");
// anti-spoiler : les actualités restent au niveau quartier, jamais de coordonnées
const spoilers = (entries ?? []).filter(e => ["lat", "lng", "lon", "coords", "coordinates"].some(k => k in e));
check("Changelog sans coordonnées (anti-spoiler)", spoilers.length === 0, spoilers.length ? `${spoilers.length} entrée(s)` : "");
check("Horodatages de génération présents", !Number.isNaN(Date.parse(ds.generated)) && !Number.isNaN(Date.parse(meta.generated)));

/* ---------- Croisement galerie officielle (facultatif, local) ---------- */

if (uid) {
  const res = await fetch(`https://api.space-invaders.com/flashinvaders_v3_pas_trop_predictif/api/gallery?uid=${encodeURIComponent(uid)}`);
  const g = res.ok ? await res.json().catch(() => null) : null;
  check("Galerie FlashInvaders lisible pour cet uid", !!g?.invaders, res.ok ? "" : `HTTP ${res.status}`);
  if (g?.invaders) {
    const flashed = Object.keys(g.invaders);
    const missing = flashed.filter(f => !byId.has(f));
    check("Flashs inconnus de la base < 3 %", missing.length / Math.max(1, flashed.length) < 0.03,
      `${missing.length}/${flashed.length} inconnus${missing.length ? " : " + missing.slice(0, 10).join(", ") : ""}`);
    const flashedDestroyed = flashed.filter(f => byId.get(f)?.status === "destroyed").length;
    console.log(`  (flashés aujourd'hui détruits : ${flashedDestroyed} — normal, ils ont été flashés avant destruction)`);
  }
}

console.log(failures === 0 ? "\nTOUS LES CONTRÔLES PASSENT" : `\n${failures} CONTRÔLE(S) EN ÉCHEC`);
process.exit(failures === 0 ? 0 : 1);
