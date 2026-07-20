/**
 * Contrôles d'invariants sur les données générées.
 * Usage : node scripts/check-data.mjs [uid]  (uid : croise avec la galerie FlashInvaders)
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const uid = process.argv[2];

const ds = JSON.parse(await readFile(join(ROOT, "public/data/invaders.json"), "utf8"));
const items = ds.items;
let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✔" : "✘"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

// Statuts par défaut de l'app : ok + damaged + unknown (hidden/wrecked/destroyed exclus)
const activeDefault = i => ["ok", "damaged", "unknown"].includes(i.status);

const pa = items.filter(i => i.city === "PA");
const paActive = pa.filter(activeDefault);
const paLocated = paActive.filter(i => i.lat !== undefined);
const paZoned = paLocated.filter(i => i.z1);

check("Paris présent dans la base", pa.length >= 1400, `${pa.length} invaders PA`);
check("PA_1529/PA_1530 (post-dataset, via OSM) présents", !!items.find(i => i.id === "PA_1529") && !!items.find(i => i.id === "PA_1530"));
// ~7 % des « PA » sont en banlieue (hors des 80 quartiers intra-muros) : non zonés, c'est attendu
check("Quartier affecté aux actifs localisés intra-muros de Paris",
  paZoned.length / Math.max(1, paLocated.length) > 0.9,
  `${paZoned.length}/${paLocated.length} zonés (reste = banlieue)`);

// Σ quartiers = actifs localisés zonés (cohérence des agrégats de la carte)
const byQuartier = new Map();
for (const i of paZoned) byQuartier.set(i.z1, (byQuartier.get(i.z1) ?? 0) + 1);
const sumQ = [...byQuartier.values()].reduce((a, b) => a + b, 0);
check("Σ quartiers == actifs localisés zonés", sumQ === paZoned.length, `${sumQ} vs ${paZoned.length}`);
check("Nombre de zones parisiennes plausible (quartiers + communes banlieue)", byQuartier.size >= 60 && byQuartier.size <= 160, `${byQuartier.size} zones`);

// Échantillons connus
const pa92 = items.find(i => i.id === "PA_92");
check("PA_92 localisé et zoné", !!pa92 && pa92.lat !== undefined && !!pa92.z1, pa92 ? `${pa92.z1} / ${pa92.z2}` : "absent");
const pa1264 = items.find(i => i.id === "PA_1264");
check("PA_1264 marqué intérieur (Musée en Herbe)", !!pa1264 && pa1264.indoor === true);
check("Des détruits existent et sont distincts", items.filter(i => i.status === "destroyed").length > 1000);

// Villes : référentiel officiel uniquement
check("Villes ≤ 90 (référentiel officiel, pas de scories)", Object.keys(ds.cities).length <= 90, `${Object.keys(ds.cities).length} villes`);
const unnamed = Object.entries(ds.cities).filter(([code, c]) => c.name === code);
console.log(`  (villes sans nom d'affichage : ${unnamed.map(([c]) => c).join(", ") || "aucune"})`);

// Zones GeoJSON
const z1 = JSON.parse(await readFile(join(ROOT, "public/data/zones/PA-z1.geojson"), "utf8"));
const z2 = JSON.parse(await readFile(join(ROOT, "public/data/zones/PA-z2.geojson"), "utf8"));
check("PA-z1 : 80 quartiers + communes de banlieue", z1.features.length >= 80, String(z1.features.length));
check("PA-z2 : 20 arrondissements + communes de banlieue", z2.features.length >= 20, String(z2.features.length));

// Croisement galerie officielle
if (uid) {
  const res = await fetch(`https://api.space-invaders.com/flashinvaders_v3_pas_trop_predictif/api/gallery?uid=${uid}`);
  const g = await res.json();
  const flashed = Object.keys(g.invaders);
  const known = new Set(items.map(i => i.id));
  const missing = flashed.filter(f => !known.has(f));
  check("Flashs inconnus de la base < 3 %", missing.length / flashed.length < 0.03,
    `${missing.length}/${flashed.length} inconnus${missing.length ? " : " + missing.slice(0, 10).join(", ") : ""}`);
  const flashedDestroyed = flashed.filter(f => items.find(i => i.id === f)?.status === "destroyed").length;
  console.log(`  (flashés aujourd'hui détruits : ${flashedDestroyed} — normal, ils ont été flashés avant destruction)`);
}

console.log(failures === 0 ? "\nTOUS LES CONTRÔLES PASSENT" : `\n${failures} CONTRÔLE(S) EN ÉCHEC`);
process.exit(failures === 0 ? 0 : 1);
