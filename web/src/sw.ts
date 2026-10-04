/// <reference lib="webworker" />
// LowPingNews web service worker: the app opens offline, and costs almost
// nothing to reopen. Changing VERSION is how a new app version reaches phones:
// the browser notices this file changed and installs the new copy.
// A plain script, not a module: classic service workers work in every browser.
const sw = self as unknown as ServiceWorkerGlobalScope;

const VERSION = "8.6";
const SHELL = "lpn-shell-" + VERSION;
const DATA = "lpn-data";
const FILES = ["./", "./index.html", "./app.js", "./core.js", "./manifest.webmanifest",
               "./icon-180.png", "./icon-192.png", "./icon-512.png"];

sw.addEventListener("install", (e: ExtendableEvent) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => sw.skipWaiting()));
});

sw.addEventListener("activate", (e: ExtendableEvent) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith("lpn-shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => sw.clients.claim()));
});

sw.addEventListener("fetch", (e: FetchEvent) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== sw.location.origin) return;   // weather and NOAA: straight through
  if (url.pathname.includes("/data/")) {
    // news: ask the network first (an unchanged file is a tiny "not modified");
    // offline, answer from the saved copy and say so in a header
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); void caches.open(DATA).then((c) => c.put(req.url, copy)); }
      return r;
    }).catch(async () => {
      const hit = await caches.match(req.url, { cacheName: DATA });
      if (!hit) return new Response("", { status: 503, statusText: "offline" });
      const h = new Headers(hit.headers);
      h.set("x-lpn-offline", "1");
      return new Response(await hit.blob(), { status: 200, headers: h });
    }));
    return;
  }
  // the app itself: from the phone, never the network once installed
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) =>
    hit || caches.match(req.mode === "navigate" ? "./index.html" : req.url).then((h2) => h2 || fetch(req))));
});
