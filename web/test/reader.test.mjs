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
const TAGLINE = "bioRxiv - the preprint server for biology, operated by openRxiv, a nonprofit organization dedicated to advancing scientific communication";
pages["https://news.example/tagline"] = { type: "text/html", body: '<html><head><meta property="og:description" content="' + TAGLINE + '"></head><body><div id="app"></div></body></html>' };
pages["https://journal.example/paper"] = { type: "text/html", body: '<html><head><meta name="citation_abstract" content="' + "We show that the enzyme converts the pigment. ".repeat(6) + '"></head><body></body></html>' };
pages["https://blocked.example/a"] = { type: "text/html", body: "<html><head><title>Just a moment...</title></head><body><script src='/cdn-cgi/challenge-platform/x.js'></script></body></html>" };
const API = {
  "https://api.biorxiv.org/details/biorxiv/10.1101/2026.10.01.612345/na/json": { collection: [
    { version: "1", abstract: "Old version abstract.", authors: "A", date: "2026-09-30", category: "plant biology", published: "NA" },
    { version: "2", abstract: "Violaxanthin de-epoxidases are central to photoprotection.\n\nHere we show a natural alga retains both enzymes.",
      authors: "Smith, J.; Jones, A.; Lee, K.; Park, S.; Ruiz, M.", date: "2026-10-02", category: "plant biology", published: "10.1038/s41477-026-0001-x" }] },
  "https://api.biorxiv.org/details/biorxiv/10.1101/339747/na/json": { collection: [{ version: "1", abstract: "An old-style DOI abstract.", authors: "B", date: "2018-06-05", category: "genomics", published: "NA" }] },
  "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID%3A12345678%20AND%20SRC%3AMED&resultType=core&format=json&pageSize=1":
    { resultList: { result: [{ abstractText: "<h4>Background</h4>Plants make pigments.<h4>Results</h4>We found &amp; characterised an enzyme.",
      authorString: "Smith J, Jones A", journalTitle: "Plant Cell", pubYear: "2026" }] } },
};
const listedUrls = Object.keys(pages).concat(["https://news.example/slow", "https://www.biorxiv.org/content/10.1101/2026.01.02.123456v1",
  "http://biorxiv.org/cgi/content/short/2026.10.01.612345v2?rss=1", "https://www.biorxiv.org/content/10.1101/339747v1",
  "https://europepmc.org/article/MED/12345678"]);
let fetched = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); fetched.push(url);
  if (url === SITE + "data/top.json") return new Response(JSON.stringify({ v: 1, items: listedUrls.map((u, i) => [0, "t" + i, "", u, 0]) }), { headers: { "content-type": "application/json" } });
  if (url.startsWith(SITE + "data/")) return new Response("", { status: 404 });
  if (url in API) return new Response(JSON.stringify(API[url]), { headers: { "content-type": "application/json" } });
  if (url.startsWith("https://api.biorxiv.org/") || url.startsWith("https://www.ebi.ac.uk/")) return new Response("{}", { status: 404 });
  if (url === "https://news.example/slow") return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const p = pages[url];
  if (!p) return new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
  return new Response(p.body, { headers: { "content-type": p.type } });
};
const ask = (u, origin = ORIGIN, cat = "top", method = "GET", env = {}) =>
  W.fetch(new Request("https://reader.example/?cat=" + cat + "&u=" + encodeURIComponent(u), { method, headers: origin ? { Origin: origin } : {} }), env);

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
  // the real limit is 10 s; the test sets 0.3 s rather than sit through it
  const t0 = Date.now(); const slow = await ask("https://news.example/slow", ORIGIN, "top", "GET", { TIMEOUT_MS: "300" });
  assert.equal(slow.status, 502); assert.match((await slow.json()).error, /too long/);
  assert.ok(Date.now() - t0 < 3000, "the timeout setting was ignored");
  const huge = await (await ask("https://news.example/huge")).json();
  assert.ok(huge.text.length <= 2 * 1024 * 1024, "read past the cap");
});
await test("bioRxiv: the full text page is tried first", async () => {
  fetched = [];
  const d = await (await ask("https://www.biorxiv.org/content/10.1101/2026.01.02.123456v1")).json();
  assert.ok(fetched.includes("https://www.biorxiv.org/content/10.1101/2026.01.02.123456v1.full"));
  assert.ok(d.complete, "a paper with its sections is complete");
});
await test("a bioRxiv RSS link gets the API's abstract, latest version, authors and journal", async () => {
  fetched = [];
  const d = await (await ask("http://biorxiv.org/cgi/content/short/2026.10.01.612345v2?rss=1")).json();
  assert.ok(fetched.includes("https://api.biorxiv.org/details/biorxiv/10.1101/2026.10.01.612345/na/json"));
  assert.ok(!fetched.some((u) => u.includes("www.biorxiv.org")), "scraped the page despite the API answering");
  assert.ok(d.complete && /This is the abstract/.test(d.note));
  const p = d.text.split("\n\n");
  assert.match(p[0], /^Smith, J\.; Jones, A\.; Lee, K\. and 2 more \u00b7 Plant biology \u00b7 posted 2026-10-02 \u00b7 version 2$/);
  assert.equal(p[1], "Violaxanthin de-epoxidases are central to photoprotection.");
  assert.ok(!d.text.includes("Old version"), "an older version's abstract was used");
  assert.match(d.text, /Since published: https:\/\/doi\.org\/10\.1038/);
});
await test("old six-digit bioRxiv DOIs work too", async () => {
  const d = await (await ask("https://www.biorxiv.org/content/10.1101/339747v1")).json();
  assert.match(d.text, /An old-style DOI abstract/);
});
await test("Europe PMC: the abstract in sections, entities decoded", async () => {
  const d = await (await ask("https://europepmc.org/article/MED/12345678")).json();
  assert.deepEqual(d.text.split("\n\n"), ["Smith J; Jones A \u00b7 Plant Cell \u00b7 2026", "Background", "Plants make pigments.",
                                         "Results", "We found & characterised an enzyme."]);
});
await test("a site-wide tagline is never passed off as the article", async () => {
  const r = await ask("https://news.example/tagline");
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(await r.json()).includes("nonprofit"));
  const j = await (await ask("https://journal.example/paper")).json();
  assert.match(j.text, /^We show that the enzyme converts the pigment/, "a journal's citation_abstract should be used");
});
await test("an anti-bot page is named, not read", async () => {
  const r = await ask("https://blocked.example/a");
  assert.equal(r.status, 502); assert.match((await r.json()).error, /blocked automated reading/);
});
await test("entities and control characters", () => {
  assert.equal(R.decodeEntities("&lt;b&gt; &#8212; &#x1F600; &bogus; &#0;"), "<b> \u2014 \ud83d\ude00 &bogus;  ");
  assert.equal(R.extract("<p>Ctrl \u0007chars\u202e and a long enough paragraph to keep here.</p>"), "Ctrl chars and a long enough paragraph to keep here.");
});
console.log("reader tests\n  " + ran + " run, " + failed + " failed");
process.exit(failed ? 1 : 0);
