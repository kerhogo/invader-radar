/**
 * Outils communs aux scripts du pipeline de données (fetch-spotter, build-data, check-data).
 */
import { readFile } from "node:fs/promises";

/** Identifiant officiel d'un invader : code ville en majuscules, tiret bas, numéro (PA_92). */
export const ID_RE = /^[A-Z]+_\d+$/;

export const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

/**
 * Avertissement : annotation visible dans le résumé du run sous GitHub Actions,
 * simple ligne « ! … » ailleurs.
 */
export function warn(message) {
  if (process.env.GITHUB_ACTIONS) {
    const escaped = String(message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::warning::${escaped}`);
  } else {
    console.warn(`! ${message}`);
  }
}

/**
 * Lit un fichier JSON. Renvoie `null` seulement s'il n'existe pas : un fichier
 * illisible (tronqué, marqueurs de conflit…) est une erreur, pas une « première
 * génération » — le confondre effacerait l'historique en silence.
 */
export async function readJsonIfExists(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new Error(`${path} illisible : ${err.message}`);
  }
}

/**
 * Sérialise un objet JSON « une entrée par ligne » pour ses tableaux et ses
 * dictionnaires d'objets de premier niveau (items, cities, entries, features…).
 * Même contenu qu'un JSON compact, mais des diffs git lisibles et des rebases
 * qui ne mettent plus le fichier entier en conflit — pour ~0,2 % de plus une fois gzippé.
 */
export function jsonLines(value) {
  const isDict = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const row = x => JSON.stringify(x) ?? "null"; // comme JSON.stringify : undefined dans un tableau → null
  const parts = Object.entries(value).filter(([, v]) => v !== undefined).map(([key, v]) => {
    const k = JSON.stringify(key) + ":";
    if (Array.isArray(v) && v.length) return `${k}[\n${v.map(row).join(",\n")}\n]`;
    if (isDict(v) && Object.keys(v).length && Object.values(v).every(isDict)) {
      return `${k}{\n${Object.entries(v).map(([kk, vv]) => JSON.stringify(kk) + ":" + JSON.stringify(vv)).join(",\n")}\n}`;
    }
    return k + JSON.stringify(v);
  });
  return `{\n${parts.join(",\n")}\n}\n`;
}

/** Distance en mètres entre deux points (haversine). */
export function distanceM(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Le point est-il dans le polygone (ou multi-polygone) GeoJSON, trous exclus ? */
export function pointInGeometry(lng, lat, geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  return polys.some(poly => inRing(lng, lat, poly[0]) && !poly.slice(1).some(hole => inRing(lng, lat, hole)));
}
