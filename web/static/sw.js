"use strict";
const sw = self;
const VERSION = "9.3";
const SHELL = "lpn-shell-" + VERSION;
const DATA = "lpn-data";
const CORE = ["./", "./index.html", "./app.js", "./core.js"];
const EXTRA = ["./manifest.webmanifest", "./icon-180.png", "./icon-192.png", "./icon-512.png"];
const fresh = (f) => fetch(new Request(f, { cache: "reload" }));
sw.addEventListener("install", (e) => {
    e.waitUntil((async () => {
        const c = await caches.open(SHELL);
        await Promise.all(CORE.map(async (f) => {
            const r = await fresh(f);
            if (!r.ok)
                throw new Error(f + " answered " + r.status);
            await c.put(f, r);
        }));
        await Promise.all(EXTRA.map((f) => fresh(f).then((r) => (r.ok ? c.put(f, r) : undefined)).catch(() => undefined)));
        await sw.skipWaiting();
    })());
});
sw.addEventListener("activate", (e) => {
    e.waitUntil(caches.keys()
        .then((ks) => Promise.all(ks.filter((k) => k.startsWith("lpn-shell-") && k !== SHELL).map((k) => caches.delete(k))))
        .then(() => sw.clients.claim()));
});
sw.addEventListener("fetch", (e) => {
    const req = e.request;
    const url = new URL(req.url);
    if (req.method !== "GET" || url.origin !== sw.location.origin)
        return;
    if (url.pathname.includes("/data/abs/"))
        return;
    if (url.pathname.includes("/data/")) {
        e.respondWith(fetch(req).then((r) => {
            if (r.ok) {
                const copy = r.clone();
                void caches.open(DATA).then((c) => c.put(req.url, copy));
            }
            return r;
        }).catch(async () => {
            const hit = await caches.match(req.url, { cacheName: DATA });
            if (!hit)
                return new Response("", { status: 503, statusText: "offline" });
            const h = new Headers(hit.headers);
            h.set("x-lpn-offline", "1");
            return new Response(await hit.blob(), { status: 200, headers: h });
        }));
        return;
    }
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match(req.mode === "navigate" ? "./index.html" : req.url).then((h2) => h2 || fetch(req))));
});
