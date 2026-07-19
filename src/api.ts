import type { Gallery } from "./types";

/**
 * API FlashInvaders — endpoint officieux (celui qu'utilise l'app officielle).
 * CORS ouvert (vérifié), pas de coordonnées renvoyées. Isolé ici pour pouvoir
 * s'adapter proprement si l'endpoint change un jour.
 */
const GALLERY_URL =
  "https://api.space-invaders.com/flashinvaders_v3_pas_trop_predictif/api/gallery?uid=";

export class ApiError extends Error {}

export async function fetchGallery(uid: string): Promise<Gallery> {
  let res: Response;
  try {
    res = await fetch(GALLERY_URL + encodeURIComponent(uid.trim()), {
      headers: { Accept: "application/json" }
    });
  } catch {
    throw new ApiError("Réseau indisponible — tes derniers flashs connus restent affichés.");
  }
  if (!res.ok) throw new ApiError(`L'API FlashInvaders a répondu ${res.status}.`);

  let body: any;
  try { body = await res.json(); } catch {
    throw new ApiError("Réponse inattendue de l'API FlashInvaders.");
  }
  const invaders = body?.invaders;
  if (!invaders || typeof invaders !== "object") {
    throw new ApiError("uid inconnu ou réponse vide — vérifie ton identifiant.");
  }

  return {
    fetchedAt: new Date().toISOString(),
    flashed: Object.keys(invaders),
    player: body.player
      ? {
          name: String(body.player.name ?? ""),
          score: Number(body.player.score ?? 0),
          rank: Number(body.player.rank ?? 0),
          si_found: Number(body.player.si_found ?? Object.keys(invaders).length)
        }
      : null,
    cities: Array.isArray(body.cities)
      ? body.cities.map((c: any) => ({
          id: Number(c.id),
          name: String(c.name ?? ""),
          si_count: Number(c.si_count ?? 0)
        }))
      : [],
    totalWorld: Number(body.total_si_count ?? 0)
  };
}
