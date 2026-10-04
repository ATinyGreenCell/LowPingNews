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
console.log("service worker tests\n  " + ran + " run, " + failed + " failed");
process.exit(failed ? 1 : 0);
