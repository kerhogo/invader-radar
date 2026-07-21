import type { ChangeEntry, Dataset, Invader, Meta, Status } from "./types";
import { state, emit } from "./state";

const base = import.meta.env.BASE_URL;

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

export async function loadDataset(): Promise<void> {
  const [ds, meta] = await Promise.all([
    getJSON<Dataset>("data/invaders.json"),
    getJSON<Meta>("data/meta.json").catch(() => null)
  ]);
  state.dataset = ds;
  state.meta = meta;
  emit("dataset");
}

export async function loadChangelog(): Promise<ChangeEntry[]> {
  try {
    const body = await getJSON<{ entries: ChangeEntry[] }>("data/changelog.json");
    return body.entries ?? [];
  } catch {
    return [];
  }
}

const zoneCache = new Map<string, any>();
/** GeoJSON des zones d'une ville (null si la ville n'a pas de découpage fin). */
export async function loadZones(file: string): Promise<any | null> {
  if (zoneCache.has(file)) return zoneCache.get(file);
  try {
    const gj = await getJSON<any>(`data/zones/${file}`);
    zoneCache.set(file, gj);
    return gj;
  } catch {
    zoneCache.set(file, null);
    return null;
  }
}

/** Un invader compte-t-il comme « actif » avec les filtres actuels ? */
export function isActive(inv: Invader): boolean {
  const s = state.settings;
  switch (inv.status) {
    case "ok": return true;
    case "damaged": return s.includeDamaged;
    case "wrecked": return false; // plus reconnu par l'app → non flashable
    case "hidden": return s.includeHidden;
    case "unknown": return s.includeUnknown;
    case "destroyed": return false;
  }
}

export function isFlashed(inv: Invader): boolean {
  return state.flashedSet.has(inv.id);
}

export interface ZoneStats {
  key: string;
  active: number;      // actifs localisés dans la zone
  found: number;       // dont flashés
  indoorLeft: number;  // restants signalés en intérieur
}

/** Agrégats par valeur de zone (z1 ou z2) pour une ville. */
export function zoneStats(city: string, level: "z1" | "z2"): Map<string, ZoneStats> {
  const out = new Map<string, ZoneStats>();
  if (!state.dataset) return out;
  for (const inv of state.dataset.items) {
    if (inv.city !== city || !isActive(inv)) continue;
    const key = inv[level];
    if (!key) continue;
    let z = out.get(key);
    if (!z) { z = { key, active: 0, found: 0, indoorLeft: 0 }; out.set(key, z); }
    z.active++;
    if (isFlashed(inv)) z.found++;
    else if (inv.indoor) z.indoorLeft++;
  }
  return out;
}

export interface ZoneNode extends ZoneStats {
  children: ZoneStats[]; // sous-zones (quartiers d'un arrondissement)
}

/**
 * Hiérarchie à 2 niveaux pour une ville : arrondissements (z2) → quartiers (z1).
 * Les invaders sans z2 (banlieue mono-commune) sont regroupés sous leur z1
 * comme arrondissement racine, pour rester lisibles.
 */
export function zoneHierarchy(city: string): ZoneNode[] {
  const parents = new Map<string, ZoneNode>();
  if (!state.dataset) return [];
  const bump = (z: ZoneStats, inv: Invader) => {
    z.active++;
    if (isFlashed(inv)) z.found++;
    else if (inv.indoor) z.indoorLeft++;
  };
  for (const inv of state.dataset.items) {
    if (inv.city !== city || !isActive(inv)) continue;
    const p = inv.z2 ?? inv.z1;      // arrondissement, sinon la zone elle-même
    if (!p) continue;
    let node = parents.get(p);
    if (!node) { node = { key: p, active: 0, found: 0, indoorLeft: 0, children: [] }; parents.set(p, node); }
    bump(node, inv);
    // quartier (z1) distinct de l'arrondissement → enfant
    if (inv.z1 && inv.z1 !== p) {
      let child = node.children.find(c => c.key === inv.z1);
      if (!child) { child = { key: inv.z1, active: 0, found: 0, indoorLeft: 0 }; node.children.push(child); }
      bump(child, inv);
    }
  }
  const byLeft = (a: ZoneStats, b: ZoneStats) => (b.active - b.found) - (a.active - a.found) || b.active - a.active;
  const list = [...parents.values()].sort(byLeft);
  for (const n of list) n.children.sort(byLeft);
  return list;
}

export interface CityStats {
  code: string;
  name: string;
  lat: number;
  lng: number;
  active: number;        // actifs référencés (base fusionnée)
  found: number;         // flashés parmi les référencés
  foundTotal: number;    // flashés d'après l'API officielle (préfixe)
  official: number | null; // dénominateur officiel si connu (villes visitées)
  unlocated: number;     // actifs sans coordonnées
  destroyed: number;
}

export function cityStats(): CityStats[] {
  const ds = state.dataset;
  if (!ds) return [];
  const byCity = new Map<string, CityStats>();

  for (const [code, info] of Object.entries(ds.cities)) {
    byCity.set(code, {
      code, name: info.name, lat: info.lat, lng: info.lng,
      active: 0, found: 0, foundTotal: 0, official: info.official ?? null, unlocated: 0, destroyed: 0
    });
  }

  for (const inv of ds.items) {
    const c = byCity.get(inv.city);
    if (!c) continue;
    if (inv.status === "destroyed" || inv.status === "wrecked") { c.destroyed++; continue; }
    if (!isActive(inv)) continue;
    c.active++;
    if (isFlashed(inv)) c.found++;
    if (inv.lat === undefined) c.unlocated++;
  }

  // Flashs officiels par préfixe (couvre aussi des invaders absents de la base)
  for (const name of state.flashedSet) {
    const code = name.split("_")[0];
    const c = byCity.get(code);
    if (c) c.foundTotal++;
  }

  // Dénominateurs officiels (uniquement pour les villes visitées, via l'API)
  if (state.gallery) {
    for (const gc of state.gallery.cities) {
      for (const c of byCity.values()) {
        if (c.name.toLowerCase() === gc.name.toLowerCase()) c.official = gc.si_count;
      }
    }
  }

  return [...byCity.values()].sort((a, b) => b.foundTotal - a.foundTotal || b.active - a.active);
}

export const STATUS_LABELS: Record<Status, string> = {
  ok: "OK",
  damaged: "dégradé",
  wrecked: "très dégradé (non flashable)",
  hidden: "caché",
  unknown: "inconnu",
  destroyed: "détruit"
};
