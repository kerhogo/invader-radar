# 👾 Invader Radar

Compagnon de chasse [FlashInvaders](https://space-invaders.com/flashinvaders/) — **sans spoiler**.

L'app connaît les positions exactes des mosaïques, mais **ne les affiche jamais**. Elle répond
uniquement à la vraie question du chasseur : *« suis-je en train de passer à côté d'un invader
sans le savoir ? »*

- **Tableau de bord** — progression officielle (score, rang), compteurs trouvés/restants par ville.
- **Carte zones** — choroplèthe façon fog-of-war : ville → arrondissement → quartier, avec
  `trouvés/total` par zone. Aucun pin individuel, à aucun niveau de zoom.
- **Mode chasse** — radar chaud/froid inspiré de la recherche d'AirTag : anneau qui se resserre,
  écran qui chauffe, tic-tac type compteur Geiger. Aucune direction, aucun azimut. Rayon réglable
  10 m → 1 km, avec détail « dont X en intérieur ».
- **Quoi de neuf** — nouveaux invaders (au niveau quartier), réactivations, destructions, détectés
  par la mise à jour quotidienne.
- **Bilan de balade** — en fin de session : « quartier Convention : il reste 2 à trouver ».

PWA installable sur l'écran d'accueil iOS/Android. Aucun backend : la progression est lue
directement depuis l'API FlashInvaders avec ton uid (stocké uniquement sur ton téléphone).

## Démarrage

```bash
npm install
node scripts/fetch-spotter.mjs   # statuts à jour (facultatif, ~8 min, poli avec le site)
node scripts/build-data.mjs      # génère public/data/
npm run dev
```

`node scripts/check-data.mjs [uid]` vérifie les invariants des données générées.

## Données

| Source | Rôle |
|---|---|
| [Space Invaders World Database](https://github.com/goguelnikov/SpaceInvaders) | socle coordonnées/points (communautaire) |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) via Overpass (© contributeurs OSM, ODbL) | nouveautés, coordonnées manquantes, signaux « intérieur », limites administratives |
| [Invader Spotter](https://www.invader-spotter.art/) | statuts à jour (OK/dégradé/détruit/caché), référentiel officiel des villes |
| [Open Data Paris](https://opendata.paris.fr) (ODbL) | 80 quartiers + 20 arrondissements |
| API FlashInvaders | progression du joueur, dénominateurs officiels |

La CI rafraîchit les données **une fois par jour** (scraping espacé et identifié, une seule passe).
Merci aux mainteneurs de ces sources — ce projet n'existerait pas sans eux.

⚠️ `public/data/invaders.json` contient les coordonnées (nécessaires au radar). **Ne l'ouvre pas
si tu ne veux pas te spoiler** — l'anti-spoiler est garanti par l'interface, pas par le secret.

## Anti-spoiler par design

- Jamais de marqueur individuel sur la carte (zoom plafonné, agrégats par zone uniquement).
- Radar = intensité (distance) sans direction.
- Changelog au niveau quartier, jamais à l'adresse.

Projet personnel, non affilié à Invader, FlashInvaders ni aux sources citées.
