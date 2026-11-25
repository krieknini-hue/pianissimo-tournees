const CACHE_NAME = "pianissimo-tournees-v5";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./css/app.css?v=4",
  "./js/api-client.js?v=4",
  "./js/routing.js?v=4",
  "./js/templates.js?v=4",
  "./js/map.js?v=4",
  "./js/planning.js?v=4",
  "./js/messages.js?v=4",
  "./js/finance.js?v=4",
  "./js/app.js?v=4",
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
