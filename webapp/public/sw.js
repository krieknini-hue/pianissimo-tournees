const CACHE_NAME = "pianissimo-tournees-v4";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./css/app.css?v=3",
  "./js/config.js?v=3",
  "./js/supabase-client.js?v=3",
  "./js/routing.js?v=3",
  "./js/templates.js?v=3",
  "./js/map.js?v=3",
  "./js/planning.js?v=3",
  "./js/messages.js?v=3",
  "./js/finance.js?v=3",
  "./js/app.js?v=3",
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
