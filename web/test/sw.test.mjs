// The service worker's install: fresh files from the site, icons optional.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
let ran = 0, failed = 0;
async function test(name, fn) {
  ran++;
  try { await fn(); console.log("  ok    " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n        " + String(e.message || e).split("\n")[0]); }
}
const code = fs.readFileSync(new URL("../static/sw.js", import.meta.url), "utf8");
function load(site) {
  const handlers = {}, stores = {}, asked = [];
  let skipped = false;
  class Req { constructor(u, o = {}) { this.url = u; this.cache = o.cache || "default"; } }
  const self = {
    addEventListener: (t, f) => { handlers[t] = f; },
    skipWaiting: async () => { skipped = true; },
    location: { origin: "https://x.github.io" },
  };
  const ctx = {
    self, Request: Req, Response, Headers, URL, Promise, Error, console,
    caches: { open: async (n) => (stores[n] = stores[n] || { put: async (k, r) => { stores[n][k] = r; } }) },
    fetch: async (r) => {
      asked.push([r.url, r.cache]);
      return r.url in site ? new Response(site[r.url]) : new Response("", { status: 404 });
    },
  };
  vm.runInNewContext(code, ctx);
  const install = async () => {
    let p;
    handlers.install({ waitUntil: (x) => { p = x; } });
    await p;
  };
  return { install, asked, stores, skipped: () => skipped };
}
const all = { "./": "i", "./index.html": "i", "./app.js": "a", "./core.js": "c", "./manifest.webmanifest": "m",
              "./icon-180.png": "1", "./icon-192.png": "2", "./icon-512.png": "5" };
await test("every file comes straight from the site, never the phone's web cache", async () => {
  const w = load(all);
  await w.install();
  assert.equal(w.asked.length, 8);
  assert.ok(w.asked.every(([, c]) => c === "reload"), JSON.stringify(w.asked));
  assert.ok(w.skipped(), "the new version should take over at once");
});
await test("a missing icon does not block an update", async () => {
  const site = { ...all }; delete site["./icon-512.png"];
  const w = load(site);
  await w.install();
  assert.ok(w.skipped());
  const shell = Object.keys(w.stores).find((k) => k.startsWith("lpn-shell-"));
  assert.ok("./app.js" in w.stores[shell] && !("./icon-512.png" in w.stores[shell]));
});
await test("a missing app file fails the install, keeping the working version", async () => {
  const site = { ...all }; delete site["./app.js"];
  const w = load(site);
  await assert.rejects(w.install());
  assert.ok(!w.skipped(), "a broken version must never take over");
});

// ---- news and station lists: never held hostage by the link ---------------------
// Time runs 40x fast here: the 4 s wait is 0.1 s.
function loadData(net) {
  const handlers = {}, saved = new Map(), waits = [];
  const ctx = {
    self: { addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting: async () => {}, location: { origin: "https://x.github.io" },
            clients: { claim: async () => {} } },
    Request, Response, Headers, URL, Promise, Error, console, setTimeout: (f, ms) => setTimeout(f, ms / 40), clearTimeout,
    caches: {
      open: async () => ({ put: async (k, r) => { saved.set(k, r); } }),
      match: async (k) => (saved.has(k) ? saved.get(k).clone() : undefined),
    },
    fetch: net,
  };
  vm.runInNewContext(code, ctx);
  const ask = async (path) => {
    let answer;
    const e = { request: { url: "https://x.github.io/LowPingNews" + path, method: "GET", mode: "cors" },
                respondWith: (p) => { answer = p; }, waitUntil: (p) => waits.push(p) };
    handlers.fetch(e);
    const t0 = Date.now();
    const r = await answer;
    return { r, ms: Date.now() - t0, body: await r.text() };
  };
  const settle = () => Promise.all(waits);
  const put = (path, body) => saved.set("https://x.github.io/LowPingNews" + path,
    new Response(body, { headers: { "content-type": "application/json", date: "Fri, 09 Oct 2026 12:00:00 GMT" } }));
  const savedBody = async (path) => { const r = saved.get("https://x.github.io/LowPingNews" + path); return r ? r.clone().text() : null; };
  return { ask, settle, put, savedBody };
}
const json = (b, extra = {}) => new Response(b, { headers: { "content-type": "application/json; charset=utf-8", ...extra } });
const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
await test("news: the network's answer, saved for next time", async () => {
  const w = loadData(async () => json('{"v":2}'));
  w.put("/data/top.json", '{"v":1}');
  const { r, body } = await w.ask("/data/top.json");
  assert.equal(body, '{"v":2}'); assert.equal(r.headers.get("x-lpn-saved"), null);
  await w.settle();
  assert.equal(await w.savedBody("/data/top.json"), '{"v":2}');
});
await test("no connection: the saved copy, marked, for this app and older ones", async () => {
  const w = loadData(async () => { throw new TypeError("Failed to fetch"); });
  w.put("/data/top.json", '{"v":1}');
  const { r, body } = await w.ask("/data/top.json");
  assert.equal(body, '{"v":1}');
  assert.deepEqual([r.headers.get("x-lpn-saved"), r.headers.get("x-lpn-offline")], ["offline", "1"]);
  const none = await w.ask("/data/world.json");
  assert.equal(none.r.status, 503);
});
await test("a stalled link: the saved copy within the wait, and the late answer still saved", async () => {
  const w = loadData(() => later(400, json('{"v":3}')));
  w.put("/data/top.json", '{"v":1}');
  const { r, body, ms } = await w.ask("/data/top.json");
  assert.equal(body, '{"v":1}'); assert.equal(r.headers.get("x-lpn-saved"), "slow");
  assert.ok(ms < 350, "answered in " + ms + " ms, not when the network got round to it");
  await w.settle();
  assert.equal(await w.savedBody("/data/top.json"), '{"v":3}', "the late answer updates the saved copy");
});
await test("a slow link with nothing saved: it waits for the network", async () => {
  const w = loadData(() => later(250, json('{"v":4}')));
  const { body } = await w.ask("/data/tides/40_-74.json");
  assert.equal(body, '{"v":4}');
});
await test("a Wi-Fi login page or a server error is never saved as the news", async () => {
  for (const make of [() => new Response("<html>Sign in to Airport Wi-Fi</html>", { headers: { "content-type": "text/html" } }),
                      () => new Response('{"error":1}', { status: 500, headers: { "content-type": "application/json" } }),
                      () => new Response("busy", { status: 503 })]) {
    const w = loadData(async () => make());
    w.put("/data/top.json", '{"v":1}');
    const { r, body } = await w.ask("/data/top.json");
    assert.equal(body, '{"v":1}', "the saved copy answers instead");
    assert.equal(r.headers.get("x-lpn-saved"), "offline");
    await w.settle();
    assert.equal(await w.savedBody("/data/top.json"), '{"v":1}', "and stays as it was");
  }
});
await test("abstracts and other sites are left to the browser", async () => {
  for (const url of ["https://x.github.io/LowPingNews/data/abs/biorxiv/1.json", "https://api.open-meteo.com/v1/forecast"]) {
    let responded = false, asked = 0;
    const e = { request: { url, method: "GET", mode: "cors" }, respondWith: () => { responded = true; }, waitUntil: () => {} };
    vm.runInNewContext(code, { self: { addEventListener: (t, f) => { if (t === "fetch") f(e); }, location: { origin: "https://x.github.io" } },
                               Request, Response, Headers, URL, Promise, Error, console, setTimeout, clearTimeout, caches: {},
                               fetch: async () => { asked++; return json("{}"); } });
    assert.ok(!responded && !asked, url);
  }
});
console.log("service worker tests\n  " + ran + " run, " + failed + " failed");
process.exit(failed ? 1 : 0);
