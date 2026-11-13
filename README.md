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
- **Actualités** — nouveaux invaders (au niveau quartier), réactivations, destructions, détectés
  par la mise à jour quotidienne.
- **Bilan de balade** — en fin de session : « quartier Convention : il reste 2 à trouver ».

PWA installable sur l'écran d'accueil iOS/Android. Aucun backend : la progression est lue
directement depuis l'API FlashInvaders avec ton uid (stocké uniquement sur ton téléphone).

## Démarrage

```bash
npm install
npm run dev      # les données publiées (public/data/) sont déjà dans le dépôt
```

### Régénérer les données

La CI est seule propriétaire de `public/data/` : elle les régénère et les publie chaque jour.
En local, la régénération sert à mettre au point le pipeline.

```bash
npm run data:spotter   # statuts à jour : une passe polie sur Invader Spotter (~10 min)
npm run data           # fusionne les sources, génère public/data/, contrôle les invariants
npm test               # tests du pipeline (sans réseau)
```

`build-data` refuse un cache Invader Spotter absent, périmé ou partiel : il publierait des
statuts de 2024 à la place des statuts du jour. `npm run data -- --allow-stale` lève ce refus
pour un essai local, dont le résultat ne se committe pas. Avant de committer des données
générées à la main : `git pull --rebase`, puis une passe Spotter du jour.

`npm run data:check` vérifie les invariants des données générées ; avec `FI_UID=<uid>`, il les
croise aussi avec ta galerie FlashInvaders.

Les polygones de `public/data/zones/` (sous-découpages et contours de ville) ne sont pas
régénérés par la CI : ils se produisent à la main et se committent.

```bash
node scripts/fetch-zones.mjs               # sous-découpages des villes (Overpass)
node scripts/fetch-zones.mjs --outlines    # contour des villes sans sous-découpage (Nominatim)
```

Quand une nouvelle ville reçoit ses premières positions, le run quotidien le signale par un
avertissement : il suffit alors de lancer la seconde commande et de committer le fichier créé.

### Quand le rafraîchissement échoue

Le pipeline préfère s'arrêter plutôt que publier des données partielles ; les données de la
veille restent en ligne. Une panne passagère d'une source (connexion coupée, 5xx) est rejouée
ou contournée par la copie `datasrc/` sans intervention : relancer le run suffit si elle a duré.

Il s'arrête aussi quand la base semble **rétrécir** : ville déjà publiée absente du référentiel,
liste d'une ville vide ou écourtée, invaders publiés introuvables. C'est presque toujours une
page mal lue. Si Invader Spotter a réellement retiré ces lignes, relancer le workflow
« Rafraîchissement quotidien des données » à la main en cochant *Accepter une base qui
rétrécit* (en local : `--allow-missing` pour `fetch-spotter`, `--allow-shrink` pour `build-data`).

## Données

| Source | Rôle |
|---|---|
| [Space Invaders World Database](https://github.com/goguelnikov/SpaceInvaders) | socle coordonnées/points (communautaire) |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) via Overpass et Nominatim (© contributeurs OSM, ODbL) | nouveautés, coordonnées manquantes, signaux « intérieur », limites administratives et contours de ville |
| [Invader Spotter](https://www.invader-spotter.art/) | statuts à jour (OK/dégradé/détruit/caché), référentiel officiel des villes |
| [Open Data Paris](https://opendata.paris.fr) (ODbL) | 80 quartiers + 20 arrondissements |
| API FlashInvaders | progression du joueur, dénominateurs officiels |

La CI rafraîchit les données **une fois par jour** (scraping espacé et identifié, une seule passe).
Merci aux mainteneurs de ces sources — ce projet n'existerait pas sans eux.

⚠️ `public/data/invaders.json` contient les coordonnées (nécessaires au radar). **Ne l'ouvre pas
si tu ne veux pas te spoiler** — l'anti-spoiler est garanti par l'interface, pas par le secret.

## Anti-spoiler par design

- Jamais de marqueur individuel sur la carte (zoom plafonné, agrégats par zone uniquement).
  Une ville sans sous-découpage est représentée au zoom par son contour, pas par une bulle
  posée au milieu de ses mosaïques.
- Radar = intensité (distance) sans direction.
- Changelog au niveau quartier, jamais à l'adresse.

Projet personnel, non affilié à Invader, FlashInvaders ni aux sources citées.
