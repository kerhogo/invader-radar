/* Service worker Invader Radar.
   - Page (index.html) : RÉSEAU d'abord, avec un délai court. Une nouvelle version est donc servie
     dès le premier lancement ; le cache prend le relais hors ligne ou quand le réseau traîne.
     Une page n'entre dans le cache qu'avec tous les fichiers de son build (assets.json) : ce qui
     en sort hors ligne est toujours une version complète.
   - Fichiers versionnés (/assets/, nom haché au build) : cache d'abord, ils ne changent jamais.
   - Reste de la coquille (manifeste, icônes) : cache d'abord, mise à jour silencieuse derrière.
   - Données (/data/) : RÉSEAU d'abord (fraîcheur quotidienne), cache en secours hors-ligne.
   Le nom du cache ne change pas d'une version à l'autre : une page encore ouverte sur l'ancienne
   version doit pouvoir continuer à y trouver ses fichiers. */
const VERSION = "ir-v3";
const PAGE = "./index.html"; // clé unique de la page, quelle que soit l'URL demandée (./, ./?x=1…)
const PAGE_TIMEOUT_MS = 3000;
/* Recherche dans le cache sans tenir compte de l'en-tête Vary : un fichier pré-chargé par le service
   worker doit être retrouvé quand la page le demande avec d'autres en-têtes (Origin, Accept…). */
const ANY = { ignoreVary: true };

/** Récupère sur le réseau et range la réponse dans le cache si elle est valide. */
async function fetchAndStore(cache, request) {
  const res = await fetch(request);
  if (res.ok) {
    try { await cache.put(request, res.clone()); }
    catch { /* quota ou stockage indisponible : la réponse du réseau reste valable */ }
  }
  return res;
}

/** Range une page dans le cache, une fois tous les fichiers de son build mis en cache. */
async function storePage(cache, res) {
  const list = await fetch("./assets.json", { cache: "no-cache" });
  if (!list.ok) throw new Error("liste des fichiers indisponible");
  await Promise.all((await list.json()).map(async file => {
    const url = "./assets/" + file;
    if (!(await cache.match(url, ANY))) await cache.add(url);
  }));
  await cache.put(PAGE, res);
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // au mieux : le manifeste et les données, pour que l'app soit complète hors ligne dès l'installation
    // (la page qui installe le service worker a chargé les siennes avant qu'il ne la contrôle)
    await Promise.allSettled(["./manifest.webmanifest", "./data/invaders.json", "./data/meta.json", "./data/changelog.json"]
      .map(url => cache.add(url)));
    // sans revalidation, la page pourrait venir du cache HTTP et ne plus correspondre à assets.json
    const page = await fetch(PAGE, { cache: "no-cache" });
    if (!page.ok) throw new Error("page indisponible");
    await storePage(cache, page);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Page : la version en ligne d'abord ; le cache seulement si le réseau échoue, répond mal ou tarde. */
async function pageResponse(event) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(PAGE, ANY);
  // « no-cache » : requête conditionnelle, pour ne pas resservir dix minutes l'ancienne page du cache HTTP.
  // Une réponse obtenue après redirection ne peut pas répondre à une navigation : on la recopie à neuf.
  const network = fetch(event.request.url, { cache: "no-cache" }).then(res =>
    res.redirected ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }) : res);
  // rangement en arrière-plan, mené à terme même si le cache a déjà répondu
  event.waitUntil(network.then(res => (res.ok ? storePage(cache, res.clone()) : undefined)).catch(() => {}));
  if (!cached) return network; // tout premier lancement : rien d'autre à servir
  const online = network.then(res => (res.ok ? res : cached)).catch(() => cached);
  const tooSlow = new Promise(resolve => setTimeout(() => resolve(cached), PAGE_TIMEOUT_MS));
  return Promise.race([online, tooSlow]);
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return; // API + tuiles : réseau direct

  if (event.request.mode === "navigate") {
    event.respondWith(pageResponse(event));
    return;
  }

  if (url.pathname.includes("/data/")) {
    // réseau d'abord : un statut peut changer du jour au lendemain
    event.respondWith(
      caches.open(VERSION).then(async cache => {
        try {
          const res = await fetch(event.request);
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        } catch {
          const cached = await cache.match(event.request, ANY);
          if (cached) return cached;
          throw new Error("offline");
        }
      })
    );
    return;
  }

  if (url.pathname.includes("/assets/")) {
    // nom haché = contenu figé : inutile de le revalider. Un fichier disparu après un déploiement
    // renvoie son 404 tel quel ; la page se recharge alors d'elle-même (voir main.ts).
    event.respondWith(
      caches.open(VERSION).then(async cache => (await cache.match(event.request, ANY)) ?? fetchAndStore(cache, event.request))
    );
    return;
  }

  event.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(event.request, ANY);
      const network = fetchAndStore(cache, event.request).catch(() => cached);
      return cached || network;
    })
  );
});
