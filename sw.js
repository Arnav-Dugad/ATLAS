/*
 * ATLAS service worker: makes the app installable and keeps the last data readable offline.
 *  - Page loads: network first, cached copy when offline.
 *  - Hashed build assets and CesiumJS files: cache first (they never change in place).
 *  - Snapshot and demo JSON: network first, so data is fresh whenever a connection exists.
 *  - The local engine API (/api/), live streams and third-party map tiles are never intercepted.
 */
const VERSION = "atlas-v1";
const SHELL = `${VERSION}-shell`;
const STATIC = `${VERSION}-static`;
const DATA = `${VERSION}-data`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.add(new Request("./", { cache: "reload" }))).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const scope = new URL(self.registration.scope);

async function networkFirst(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    if (response.ok && response.type === "basic") void cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = await caches.open(SHELL).then((c) => c.match("./"));
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") void cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length);
  if (path.startsWith("api/") || request.headers.get("accept") === "text/event-stream") return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL, 6000));
  } else if (path.startsWith("assets/") || path.startsWith("cesium/") || path.startsWith("icons/")) {
    event.respondWith(cacheFirst(request));
  } else if (path.startsWith("snapshot/") || path.startsWith("demo/")) {
    event.respondWith(networkFirst(request, DATA, 8000));
  }
});
