/**
 * Calibration du radar « chaud/froid » — toutes les constantes de sensibilité
 * sont ici pour pouvoir être révisées facilement après tests terrain.
 *
 * Choix validés avec Hugo : froid jusqu'à ~100 m, montée progressive ensuite,
 * très sensible de ~30 m à ~5 m (limite de précision GPS).
 */

/** Distance (m) au-delà de laquelle le radar est totalement froid. */
export const D_COLD = 100;
/** Distance (m) de chaleur maximale — le radar reste réactif jusqu'à ~3 m. */
export const D_HOT = 3;
/** Pivot de la courbe : à cette distance on est à ~50 % de chaleur. */
export const D_MID = 30;

/** Distance d'échelle par défaut du radar (réglable par l'utilisateur). */
export const DEFAULT_SCALE = 200;

/**
 * Chaleur 0 (froid) → 1 (brûlant), PROPORTIONNELLE à la distance rapportée à
 * l'échelle choisie (« ultra-précise à chaque pas ») : chaque mètre gagné se
 * voit, jusqu'à D_HOT (~3 m) où la chaleur est maximale.
 */
export function heat(distance: number, scale: number = DEFAULT_SCALE): number {
  if (distance >= scale) return 0;
  const d = Math.max(D_HOT, distance);
  return 1 - (d - D_HOT) / Math.max(1, scale - D_HOT);
}

/** Couleur de fond plein écran selon la chaleur (bleu nuit → orange → rouge). */
export function heatColor(t: number): string {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [11, 29, 58]],    // bleu nuit
    [0.45, [63, 63, 116]],  // violet froid
    [0.7, [214, 108, 20]],  // orange
    [1.0, [214, 32, 32]]    // rouge
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const f = hi[0] === lo[0] ? 0 : (t - lo[0]) / (hi[0] - lo[0]);
  const c = lo[1].map((v, i) => Math.round(v + (hi[1][i] - v) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Diamètre de l'anneau (fraction 0–1 de la scène) : se resserre en chauffant. */
export function ringSize(t: number): number {
  return 0.97 - 0.71 * t; // 97 % → 26 % (léger retrait pour ne jamais toucher les bords)
}

/** Intervalle entre deux tics « compteur Geiger » (ms). Infini = silence. */
export function tickInterval(t: number): number {
  if (t <= 0.02) return Infinity;
  return Math.round(1300 - 1180 * t); // 1300 ms → 120 ms
}
