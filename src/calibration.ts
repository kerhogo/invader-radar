/**
 * Calibration du radar « chaud/froid » — toutes les constantes de sensibilité
 * sont ici pour pouvoir être révisées facilement après tests terrain.
 *
 * Choix validés avec Hugo : froid jusqu'à ~100 m, montée progressive ensuite,
 * très sensible de ~30 m à ~5 m (limite de précision GPS).
 */

/** Distance (m) au-delà de laquelle le radar est totalement froid. */
export const D_COLD = 100;
/** Distance (m) de chaleur maximale (précision GPS oblige, inutile en dessous). */
export const D_HOT = 5;
/** Pivot de la courbe : à cette distance on est à ~50 % de chaleur. */
export const D_MID = 30;

/**
 * Chaleur 0 (froid) → 1 (brûlant) pour une distance en mètres.
 * Courbe en deux segments log : D_COLD→D_MID couvre 0→0.5, D_MID→D_HOT couvre 0.5→1.
 * → la moitié de la dynamique est concentrée sous 30 m, comme demandé.
 */
export function heat(distance: number): number {
  const d = Math.max(D_HOT, Math.min(D_COLD, distance));
  const seg = (from: number, to: number, x: number) =>
    (Math.log(from) - Math.log(x)) / (Math.log(from) - Math.log(to));
  if (d > D_MID) return 0.5 * seg(D_COLD, D_MID, d);
  return 0.5 + 0.5 * seg(D_MID, D_HOT, d);
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
