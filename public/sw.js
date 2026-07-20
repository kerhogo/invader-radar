/* Service worker Invader Radar.
   - App shell / assets : cache d'abord, mise à jour silencieuse derrière.
   - Données (/data/) : RÉSEAU d'abord (fraîcheur quotidienne), cache en secours hors-ligne. */
const VERSION = "ir-v2";
const SHELL = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return; // API + tuiles : réseau direct

  if (url.pathname.includes("/data/")) {
    // réseau d'abord : un statut peut changer du jour au lendemain
    event.respondWith(
      caches.open(VERSION).then(async cache => {
        try {
          const res = await fetch(event.request);
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        } catch {
          const cached = await cache.match(event.request);
          if (cached) return cached;
          throw new Error("offline");
        }
      })
    );
    return;
  }

  event.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then(res => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
