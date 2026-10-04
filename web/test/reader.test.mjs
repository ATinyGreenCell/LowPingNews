// Tests for the article reader Worker. Run: node web/test/reader.test.mjs
import assert from "node:assert/strict";
import W, * as R from "../reader/reader.js";

let ran = 0, failed = 0;
async function test(name, fn) {
  ran++;
  try { await fn(); console.log("  ok    " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n        " + (e && e.message || e)); }
}
const SITE = "https://atinygreencell.github.io/LowPingNews/";
const ORIGIN = "https://atinygreencell.github.io";
const para = (i) => "<p>Paragraph " + i + " of a real article, long enough to count as body text for the reader &amp; its rules. " + "More words here. ".repeat(14) + "</p>";
const ARTICLE = "<html><head><script>var x = '<p>not text</p>';</script><style>p{}</style></head><body>" +
  "<header><p>Site header that should never appear in the text, long enough.</p></header><nav><li>Home menu link that is long enough to keep</li></nav>" +
  "<article><h1>A headline that is long enough to be kept by the rules</h1>" + [1,2,3,4,5,6].map(para).join("") +
  "<figure><p>A caption inside a figure, long enough to be kept if not skipped.</p></figure></article>" +
  "<!-- <p>a commented-out paragraph that is long enough</p> --><footer><p>Copyright footer text long enough to be kept wrongly.</p></footer></body></html>";
const JSONLD = '<html><body><div id="app"></div><script type="application/ld+json">{"articleBody":"' + "Embedded body text. ".repeat(20) + 'The end."}</script></body></html>';
const pages = {
  "https://news.example/a": { type: "text/html; charset=utf-8", body: ARTICLE },
  "https://news.example/js": { type: "text/html", body: JSONLD },
  "https://news.example/pdf": { type: "application/pdf", body: "%PDF-1.4" },
  "https://news.example/huge": { type: "text/html", body: "<p>" + "x".repeat(3 * 1024 * 1024) + "</p>" },
  "https://www.biorxiv.org/content/10.1101/2026.01.02.123456v1.full": { type: "text/html",
    body: "<p>Introduction to the work, long enough to be counted as a paragraph of body text.</p><p>Results section words. " + "r ".repeat(3000) + "</p><p>Methods and Discussion follow here, long enough.</p>" },
};
const listedUrls = Object.keys(pages).concat(["https://news.example/slow", "https://www.biorxiv.org/content/10.1101/2026.01.02.123456v1"]);
let fetched = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); fetched.push(url);
  if (url === SITE + "data/top.json") return new Response(JSON.stringify({ v: 1, items: listedUrls.map((u, i) => [0, "t" + i, "", u, 0]) }), { headers: { "content-type": "application/json" } });
  if (url.startsWith(SITE + "data/")) return new Response("", { status: 404 });
  if (url === "https://news.example/slow") return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const p = pages[url];
  if (!p) return new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
  return new Response(p.body, { headers: { "content-type": p.type } });
};
const ask = (u, origin = ORIGIN, cat = "top", method = "GET") =>
  W.fetch(new Request("https://reader.example/?cat=" + cat + "&u=" + encodeURIComponent(u), { method, headers: origin ? { Origin: origin } : {} }));

await test("an article becomes paragraphs of plain text", async () => {
  const r = await ask("https://news.example/a");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  const d = await r.json();
  assert.ok(d.complete, "six paragraphs should count as complete");
  assert.match(d.text, /^A headline that is long enough/);
  assert.match(d.text, /reader & its rules/, "entities decoded");
  for (const bad of ["not text", "Site header", "Home menu", "caption inside", "commented-out", "Copyright footer", "<"])
    assert.ok(!d.text.includes(bad), "kept: " + bad);
});
await test("a page built by JavaScript falls back to its embedded copy", async () => {
  const d = await (await ask("https://news.example/js")).json();
  assert.match(d.text, /Embedded body text/); assert.ok(!d.complete && d.note, "flagged as partial");
});
await test("only the app may use it, only for listed stories", async () => {
  assert.equal((await ask("https://news.example/a", "https://evil.example")).status, 403);
  assert.equal((await ask("https://news.example/a", "")).status, 403, "no Origin: not a browser");
  assert.equal((await ask("https://elsewhere.example/x")).status, 404, "not in the app's headline files");
  assert.equal((await ask("javascript:alert(1)")).status, 400);
  assert.equal((await ask("https://news.example/a", ORIGIN, "../etc")).status, 400);
  const pre = await ask("https://news.example/a", ORIGIN, "top", "OPTIONS");
  assert.equal(pre.status, 204);
});
await test("non-pages, slow sites and huge pages fail cleanly", async () => {
  const pdf = await ask("https://news.example/pdf");
  assert.equal(pdf.status, 502); assert.match((await pdf.json()).error, /not a web page/);
  const t0 = Date.now(); const slow = await ask("https://news.example/slow");
  assert.equal(slow.status, 502); assert.match((await slow.json()).error, /too long/);
  assert.ok(Date.now() - t0 < 12000);
  const huge = await (await ask("https://news.example/huge")).json();
  assert.ok(huge.text.length <= 2 * 1024 * 1024, "read past the cap");
});
await test("bioRxiv: the full text page is tried first", async () => {
  fetched = [];
  const d = await (await ask("https://www.biorxiv.org/content/10.1101/2026.01.02.123456v1")).json();
  assert.ok(fetched.includes("https://www.biorxiv.org/content/10.1101/2026.01.02.123456v1.full"));
  assert.ok(d.complete, "a paper with its sections is complete");
});
await test("entities and control characters", () => {
  assert.equal(R.decodeEntities("&lt;b&gt; &#8212; &#x1F600; &bogus; &#0;"), "<b> \u2014 \ud83d\ude00 &bogus;  ");
  assert.equal(R.extract("<p>Ctrl \u0007chars\u202e and a long enough paragraph to keep here.</p>"), "Ctrl chars and a long enough paragraph to keep here.");
});
console.log("reader tests\n  " + ran + " run, " + failed + " failed");
process.exit(failed ? 1 : 0);
