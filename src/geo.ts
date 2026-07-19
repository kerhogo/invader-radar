/** Distance haversine en mètres. */
export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

type Ring = [number, number][];

/** Point dans un anneau (ray casting), coordonnées GeoJSON [lng, lat]. */
function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Point dans une géométrie GeoJSON Polygon/MultiPolygon (trous gérés). */
export function pointInGeometry(lng: number, lat: number, geom: { type: string; coordinates: unknown }): boolean {
  if (geom.type === "Polygon") {
    const polys = geom.coordinates as Ring[];
    if (!inRing(lng, lat, polys[0])) return false;
    for (let i = 1; i < polys.length; i++) if (inRing(lng, lat, polys[i])) return false;
    return true;
  }
  if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates as Ring[][]) {
      if (inRing(lng, lat, poly[0])) {
        let hole = false;
        for (let i = 1; i < poly.length; i++) if (inRing(lng, lat, poly[i])) { hole = true; break; }
        if (!hole) return true;
      }
    }
  }
  return false;
}
