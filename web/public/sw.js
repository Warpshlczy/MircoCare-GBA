// AuraGBA service worker — hand-written, no next-pwa.
// ponytail: static assets are cache-first; navigations are NETWORK-first so a deploy
// actually reaches an installed user (cache-first HTML would pin them to a stale build
// whose hashed CSS no longer exists). Upgrade path: workbox if we ever need runtime
// route strategies, background sync or precache revisioning.
// Bump CACHE on every release: activate() deletes every other cache.
const CACHE = "auragba-v3";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  // navigations: network-first, cache only as an offline fallback
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }

  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          })
          .catch(() => caches.match("/"))
    )
  );
});