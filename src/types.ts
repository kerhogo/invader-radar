export type Status = "ok" | "damaged" | "wrecked" | "hidden" | "unknown" | "destroyed";

export interface Invader {
  id: string;           // ex. PA_1264
  city: string;         // code ville officiel, ex. PA
  lat?: number;
  lng?: number;
  status: Status;
  points: number;
  indoor?: boolean;     // heuristique multi-sources, corrigeable via overrides
  z1?: string;          // zone fine (quartier) — précalculée au build
  z2?: string;          // zone moyenne (arrondissement/commune)
}

export interface CityInfo {
  name: string;
  lat: number;
  lng: number;
  count: number;        // invaders référencés (base fusionnée)
  official?: number;    // dénominateur officiel (référentiel Invader Spotter)
  zones?: boolean;      // true si des polygones zones/<code>-z1/z2.geojson existent
}

export interface Dataset {
  generated: string;
  items: Invader[];
  cities: Record<string, CityInfo>;
}

export interface Meta {
  generated: string;
  sources: Record<string, { date?: string; count?: number; note?: string }>;
}

export interface GalleryCity { id: number; name: string; si_count: number }

export interface Gallery {
  fetchedAt: string;
  flashed: string[];            // noms officiels, ex. PA_593
  player: { name: string; score: number; rank: number; si_found: number } | null;
  cities: GalleryCity[];        // dénominateurs officiels des villes visitées
  totalWorld: number;
}

export interface ChangeEntry {
  date: string;                 // YYYY-MM-DD
  type: "new_city" | "new_invader" | "status_change";
  id?: string;
  city: string;
  zone?: string;
  from?: Status;
  to?: Status;
}

export interface Settings {
  uid: string;
  radius: number;               // rayon chasse en mètres
  sounds: boolean;
  includeDamaged: boolean;
  includeHidden: boolean;
  includeUnknown: boolean;
  lastNewsSeen: string;         // ISO date
}
