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
  flag?: string;        // drapeau emoji du pays
  country?: string;
  continent?: string;
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
  type: "new_city" | "new_invader" | "status_change" | "spotter_news";
  id?: string;
  city?: string;
  zone?: string;
  from?: Status;
  to?: Status;
  text?: string;                // spotter_news : texte brut de la news (sans coordonnées)
}

export interface Settings {
  uid: string;
  radius: number;               // rayon chasse en mètres (compteurs "dans le rayon")
  scaleDistance: number;        // distance d'échelle du radar en mètres (défaut 200)
  sounds: boolean;
  haptics: boolean;             // vibrations (Android uniquement — non supporté par iOS web)
  showDistanceAlways: boolean;  // forcer l'affichage de la distance même sous l'échelle
  includeDamaged: boolean;
  includeHidden: boolean;
  includeUnknown: boolean;
  lastNewsSeen: string;         // ISO date
}
