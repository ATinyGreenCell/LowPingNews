/// <reference lib="webworker" />
// LowPingNews web service worker: the app opens offline, and costs almost
// nothing to reopen. Changing VERSION is how a new app version reaches phones:
// the browser notices this file changed and installs the new copy.
// A plain script, not a module: classic service workers work in every browser.
const sw = self as unknown as ServiceWorkerGlobalScope;

const VERSION = "9.9";
const SHELL = "lpn-shell-" + VERSION;
const DATA = "lpn-data";
const CORE = ["./", "./index.html", "./app.js", "./core.js"];          // the app cannot run without these
const EXTRA = ["./manifest.webmanifest", "./icon-180.png", "./icon-192.png", "./icon-512.png"];

// Straight from the site (cache: "reload"), never the phone's web cache: that
// may still hold the previous version's files for a few minutes, and a new
// version stored with old files would never update. Only the core files must
// arrive; a missing icon must not block an update.
const fresh = (f: string): Promise<Response> => fetch(new Request(f, { cache: "reload" }));
sw.addEventListener("install", (e: ExtendableEvent) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(CORE.map(async (f) => {
      const r = await fresh(f);
      if (!r.ok) throw new Error(f + " answered " + r.status);
      await c.put(f, r);
    }));
    await Promise.all(EXTRA.map((f) => fresh(f).then((r) => (r.ok ? c.put(f, r) : undefined)).catch(() => undefined)));
    await sw.skipWaiting();
  })());
});

sw.addEventListener("activate", (e: ExtendableEvent) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith("lpn-shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => sw.clients.claim()));
});

// News and station lists: the network first (an unchanged file is a tiny "not
// modified"), but never held hostage by it. With no connection, an answer that
// is not the file (a Wi-Fi login page, a server error), or no answer within
// WAIT_MS, the saved copy answers instead, marked in a header (x-lpn-saved:
// offline or slow). The network's answer, if it still comes, updates the saved
// copy for next time. Only real JSON is ever saved.
const WAIT_MS = 4000;
const usable = (r: Response): boolean => r.ok && /json/i.test(r.headers.get("content-type") || "");
async function savedCopy(url: string, why: "offline" | "slow"): Promise<Response | undefined> {
  const hit = await caches.match(url, { cacheName: DATA });
  if (!hit) return undefined;
  const h = new Headers(hit.headers);
  h.set("x-lpn-offline", "1");                 // what the app before 9.8 looks for
  h.set("x-lpn-saved", why);
  return new Response(await hit.blob(), { status: 200, headers: h });
}

sw.addEventListener("fetch", (e: FetchEvent) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== sw.location.origin) return;   // weather and NOAA: straight through
  if (url.pathname.includes("/data/abs/")) return;   // abstracts: the app saves the ones read; caching every one would grow forever
  if (url.pathname.includes("/data/")) {
    const net = fetch(req);
    // saved as soon as it is in, whether or not the page is still waiting for it
    e.waitUntil(net.then((r) => {
      if (!usable(r)) return undefined;
      const copy = r.clone();
      return caches.open(DATA).then((c) => c.put(req.url, copy));
    }).catch(() => undefined));
    e.respondWith((async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"slow">((res) => { timer = setTimeout(() => res("slow"), WAIT_MS); });
      const first = await Promise.race([net.catch((): "offline" => "offline"), late]);
      clearTimeout(timer);
      if (first instanceof Response && usable(first)) return first;
      const saved = await savedCopy(req.url, first === "slow" ? "slow" : "offline");
      if (saved) return saved;
      // nothing saved yet: the network's answer, whatever it is, whenever it comes
      return first instanceof Response ? first : net.catch(() => new Response("", { status: 503, statusText: "offline" }));
    })());
    return;
  }
  // the app itself: from the phone, never the network once installed
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) =>
    hit || caches.match(req.mode === "navigate" ? "./index.html" : req.url).then((h2) => h2 || fetch(req))));
});
