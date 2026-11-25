const CACHE_NAME = "pianissimo-tournees-v6";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./css/app.css?v=5",
  "./js/api-client.js?v=5",
  "./js/routing.js?v=5",
  "./js/templates.js?v=5",
  "./js/map.js?v=5",
  "./js/planning.js?v=5",
  "./js/messages.js?v=5",
  "./js/finance.js?v=5",
  "./js/app.js?v=5",
  "./icons/harp.svg",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
