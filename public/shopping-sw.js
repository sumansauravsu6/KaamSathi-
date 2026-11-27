const CACHE = "kaamsaathi-shopping-help-v1";
const ASSETS = ["/shopping-offline.html", "/shopping-icon.svg", "/shopping-icon-maskable.svg"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("kaamsaathi-shopping-help-") && key !== CACHE).map((key) => caches.delete(key)))));
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate" && url.pathname.startsWith("/shop/")) {
    event.respondWith(fetch(event.request).catch(() => caches.match("/shopping-offline.html")));
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
