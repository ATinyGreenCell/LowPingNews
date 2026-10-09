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
  "https://api.biorxiv.org/details/biorxiv/10.1101/2026.10.04.700001/na/json": "",
  "https://api.crossref.org/works/10.1101/2026.10.04.700001": { status: "ok", message: {
    abstract: "<jats:title>Abstract</jats:title><jats:p>Cytokinin delays senescence &amp; keeps chloroplasts working, here shown in detail.</jats:p><jats:p>CIA2 and CIL mediate it.</jats:p>",
    author: [{ given: "Ngozi Ada", family: "Okafor" }, { given: "Wei", family: "Li" }, { name: "A consortium" }] } },
  "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=LowPingNews&begin_date=20261003&range=96&datum=MLLW&station=8516945&time_zone=gmt&interval=hilo&units=english&format=json":
    { predictions: [{ t: "2026-10-04 19:42", v: "7.3", type: "H", extra: "<script>" }] },
  "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=LowPingNews&begin_date=20261003&range=96&station=ACT3496&bin=1&time_zone=gmt&interval=MAX_SLACK&units=english&format=json":
    { current_predictions: { units: "knots", cp: [{ Type: "flood", meanFloodDir: 179, Bin: "1", meanEbbDir: 7, Time: "2026-10-04 14:38", Depth: null,
                                                    Velocity_Major: 0.42, extra: "<script>" }] } },
  "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID%3A12345678%20AND%20SRC%3AMED&resultType=core&format=json&pageSize=1":
    { resultList: { result: [{ abstractText: "<h4>Background</h4>Plants make pigments.<h4>Results</h4>We found &amp; characterised an enzyme.",
      authorString: "Smith J, Jones A", journalTitle: "Plant Cell", pubYear: "2026" }] } },
};
const listedUrls = Object.keys(pages).concat(["https://news.example/slow", "https://www.biorxiv.org/content/10.1101/2026.01.02.123456v1",
  "http://biorxiv.org/cgi/content/short/2026.10.01.612345v2?rss=1", "https://www.biorxiv.org/content/10.1101/339747v1",
  "https://europepmc.org/article/MED/12345678", "http://biorxiv.org/content/early/2026/10/01/2026.10.01.612345",
  "https://www.biorxiv.org/content/10.1101/2026.01.03.999999v1", "https://www.biorxiv.org/content/10.1101/2026.10.04.700001v1",
  "https://pubmed.ncbi.nlm.nih.gov/12345678/"]);
let fetched = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); fetched.push(url);
  if (url === SITE + "data/top.json") return new Response(JSON.stringify({ v: 1, items: listedUrls.map((u, i) => [0, "t" + i, "", u, 0]) }), { headers: { "content-type": "application/json" } });
  if (url.startsWith(SITE + "data/")) return new Response("", { status: 404 });
  if (url in API) return new Response(typeof API[url] === "string" ? API[url] : JSON.stringify(API[url]), { headers: { "content-type": "application/json" } });
  if (url.startsWith("https://api.biorxiv.org/") || url.startsWith("https://www.ebi.ac.uk/") || url.startsWith("https://api.crossref.org/") ||
      url.startsWith("https://api.tidesandcurrents.noaa.gov/")) return new Response("{}", { status: 404 });
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
await test("a preprint's pages are never scraped: they are a bot wall or a slogan", async () => {
  fetched = [];
  const r = await ask("https://www.biorxiv.org/content/10.1101/2026.01.02.123456v1");
  const d = await r.json();
  assert.ok(!fetched.some((u) => u.startsWith("https://www.biorxiv.org/")), "fetched: " + fetched.join(" "));
  assert.ok(!d.text && !JSON.stringify(d).includes("nonprofit"), "never the site's slogan");
  assert.match(d.error, /no abstract yet \(bioRxiv's API answered 404, and Crossref had none\)/);
});
await test("bioRxiv's API sending nothing: Crossref's abstract instead", async () => {
  const d = await (await ask("https://www.biorxiv.org/content/10.1101/2026.10.04.700001v1")).json();
  assert.ok(d.complete, JSON.stringify(d));
  assert.deepEqual(d.text.split("\n\n"), ["Okafor, N. A.; Li, W.", "Cytokinin delays senescence & keeps chloroplasts working, here shown in detail.",
                                          "CIA2 and CIL mediate it."]);
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
await test("when bioRxiv refuses the reader, the error says so", async () => {
  const r = await ask("https://www.biorxiv.org/content/10.1101/2026.01.03.999999v1");
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /bioRxiv's API answered 404/);
  const d = await (await ask("http://biorxiv.org/content/early/2026/10/01/2026.10.01.612345")).json();
  assert.match(d.text, /central to photoprotection/, "an older /content/early/ link is a preprint too");
});
await test("a PubMed link gets its abstract from Europe PMC's copy", async () => {
  const d = await (await ask("https://pubmed.ncbi.nlm.nih.gov/12345678/")).json();
  assert.ok(d.complete && /Plants make pigments/.test(d.text), JSON.stringify(d));
  assert.equal(d.url, "https://pubmed.ncbi.nlm.nih.gov/12345678/");
});
await test("tides: one fixed NOAA query, only a station and a date pass through", async () => {
  const tideAsk = (qs, origin = ORIGIN) => W.fetch(new Request("https://reader.example/?" + qs, { headers: origin ? { Origin: origin } : {} }), {});
  fetched = [];
  const r = await tideAsk("tide=8516945&d=20261003");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { predictions: [{ t: "2026-10-04 19:42", v: "7.3", type: "H" }] }, "only the three fields pass");
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  for (const bad of ["tide=8516945%26datum%3DNAVD&d=20261003", "tide=../x&d=20261003", "tide=8516945&d=today", "tide=&d=20261003"]) {
    fetched = [];
    const b = await tideAsk(bad);
    assert.equal(b.status, 400, bad);
    assert.ok(!fetched.some((u) => u.includes("tidesandcurrents")), "nothing reached NOAA for " + bad);
  }
  assert.equal((await tideAsk("tide=8516945&d=20261003", "https://evil.example")).status, 403);
  const miss = await tideAsk("tide=9999999&d=20261003");
  assert.equal(miss.status, 502);
});
await test("currents: one fixed NOAA query, only a station, its bin and a date pass through", async () => {
  const curAsk = (qs, origin = ORIGIN) => W.fetch(new Request("https://reader.example/?" + qs, { headers: origin ? { Origin: origin } : {} }), {});
  fetched = [];
  const r = await curAsk("cur=ACT3496&bin=1&d=20261003");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { current_predictions: { cp: [{ Type: "flood", Time: "2026-10-04 14:38", Velocity_Major: 0.42,
                                                                     meanFloodDir: 179, meanEbbDir: 7 }] } }, "only five fields pass");
  for (const bad of ["cur=ACT3496%26product%3Dwater_level&bin=1&d=20261003", "cur=../x&bin=1&d=20261003", "cur=ACT3496&bin=1;x&d=20261003",
                     "cur=ACT3496&bin=1&d=today", "cur=ACT3496&d=20261003"]) {
    fetched = [];
    const b = await curAsk(bad);
    assert.equal(b.status, 400, bad);
    assert.ok(!fetched.some((u) => u.includes("tidesandcurrents")), "nothing reached NOAA for " + bad);
  }
  assert.equal((await curAsk("cur=ACT3496&bin=1&d=20261003", "https://evil.example")).status, 403);
  assert.equal((await curAsk("cur=ACT0000&bin=1&d=20261003")).status, 502);
});
await test("hostile pages cost linear time, and the text stays clean", () => {
  const pages = ["<p>hi</p>" + "<!--".repeat(20000) + "x".repeat(400000), "<script>".repeat(30000), "<p".repeat(300000),
                 "<head>" + "<meta name=x ".repeat(150000), "<".repeat(1500000)];
  for (const p of pages) {
    const t = performance.now();
    R.extract(p);
    assert.ok(performance.now() - t < 150, "took " + (performance.now() - t).toFixed(0) + " ms on " + JSON.stringify(p.slice(0, 20)));
  }
  const page = "<html><head><meta name=\"citation_abstract\" content=\"" + "An abstract that is long enough. ".repeat(4) + "\"></head>" +
               "<body><!-- <p>hidden comment paragraph that should never show up here</p> --><script>var p = '<p>not text</p>';</script>" +
               "<p>A real paragraph about tides \ud83c\udf0a with a lone \ud83d and \u001b[2Jescape code in it. " +
               "It goes on long enough to be the article itself, not a teaser, so the body wins over the abstract.</p>" +
               "<p>A second paragraph keeps the page well past the threshold for a real article body here.</p></body></html>";
  const out = R.extract(page);
  assert.ok(!/hidden comment|not text/.test(out), out);
  assert.ok(out.includes("\ud83c\udf0a") && !/\u001b|\[2J/.test(out) && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(out.replace("\ud83c\udf0a", "")), out);
  assert.match(R.metaFallback("<head>" + "<meta name=x ".repeat(5000) + "<meta name=\"citation_abstract\" content=\"" +
               "Long enough abstract text here. ".repeat(4) + "\"></head>"), /Long enough abstract/, "found past many broken tags");
  assert.deepEqual(R.metaTags("<META NAME=a CONTENT=b><meta name=c><meta name=d"), ["<META NAME=a CONTENT=b>", "<meta name=c>"]);
});
await test("the 20-minute schedule: one request to start the site's update, nothing without a token", async () => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) => { seen.push({ u: String(u), init }); return new Response(null, { status: 204 }); };
  try {
    await W.scheduled({}, {});
    await W.scheduled({}, { GH_TOKEN: "not a token!" });
    assert.equal(seen.length, 0, "no token, or a malformed one: no request at all");
    await W.scheduled({}, { GH_TOKEN: "github_pat_" + "A".repeat(40) });
    assert.equal(seen.length, 1);
    const { u, init } = seen[0];
    assert.equal(u, "https://api.github.com/repos/atinygreencell/LowPingNews/actions/workflows/web.yml/dispatches");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { ref: "main" });
    assert.equal(init.headers.Authorization, "Bearer github_pat_" + "A".repeat(40));
    assert.match(init.headers["User-Agent"], /^Mozilla\/5\.0 \(compatible; LowPingNewsReader\/[\d.]+; \+https:\/\//, "GitHub needs a User-Agent");
    assert.equal(init.headers["X-GitHub-Api-Version"], "2022-11-28");
    for (const [code, re] of [[401, /expired or revoked/], [404, /Actions: Read and write/], [403, /Actions: Read and write/], [422, /would not start/], [500, /answered 500/]]) {
      globalThis.fetch = async () => new Response("{}", { status: code });
      const r = await R.kick({ GH_TOKEN: "github_pat_" + "B".repeat(40) });
      assert.ok(!r.ok && re.test(r.why), code + ": " + r.why);
    }
    globalThis.fetch = async () => { throw new TypeError("network down"); };
    assert.match((await R.kick({ GH_TOKEN: "github_pat_" + "C".repeat(40) })).why, /could not be reached/);
  } finally { globalThis.fetch = real; }
});

await test("the site's repository comes from its address, and nothing odd gets into the API path", () => {
  assert.equal(R.repoOf("https://atinygreencell.github.io/LowPingNews/"), "atinygreencell/LowPingNews");
  assert.equal(R.repoOf("https://someone.github.io/"), "someone/someone.github.io", "a user site's repository");
  assert.equal(R.repoOf("https://news.example.com/x/"), "", "a custom domain needs GH_REPO");
  assert.equal(R.repoOf("https://news.example.com/", "Owner/Repo.name_1"), "Owner/Repo.name_1");
  for (const bad of ["a/..", "a/.", "../b", "a/b/c", "a b/c", "a/b?x=1", "-a/b", "a/" + "x".repeat(101), "a/b#", "a/b%2f"])
    assert.equal(R.repoOf("https://x.github.io/y/", bad), "", bad);
  assert.equal(R.repoOf("not a url"), "");
});

await test("why the news is stale: this week's stuck run, a failing build, a silent scheduler", () => {
  const H = 3600, now = 1791300000;
  const run = (n, ago, status, conclusion, done = ago - 60) => ({ run_number: n, status, conclusion,
    created_at: new Date((now - ago) * 1000).toISOString(), updated_at: new Date((now - done) * 1000).toISOString() });
  // this week: #24 held at its publish step for days, every later run cancelled behind it, the newest pending
  const week = [run(37, 0.5 * H, "pending", null), ...Array.from({ length: 12 }, (_, i) => run(36 - i, (6 + 6 * i) * H, "completed", "cancelled")),
                run(24, 81 * H, "waiting", null, 81 * H), run(23, 88 * H, "completed", "success")];
  const p = R.pipeline({ workflow_runs: week }, now);
  assert.deepEqual([p.state, p.run], ["waiting", 24], JSON.stringify(p));
  assert.equal(p.since, now - 81 * H, "since the first run after the last good one");
  assert.equal(p.lastOk, now - 88 * H + 60);
  // the newest run held (approval needed on every run, each cancelled by the next)
  assert.equal(R.pipeline({ workflow_runs: [run(9, 0.2 * H, "waiting", null), run(8, 0.6 * H, "completed", "cancelled"), run(7, 1 * H, "completed", "success")] }, now).state, "waiting");
  assert.equal(R.pipeline({ workflow_runs: [run(9, 60, "waiting", null), run(7, 1 * H, "completed", "success")] }, now).state, "running", "a minute's wait is normal");
  const fail = R.pipeline({ workflow_runs: [run(12, 0.3 * H, "completed", "failure"), run(11, 0.7 * H, "completed", "failure"),
                                            run(10, 1 * H, "completed", "success")] }, now);
  assert.deepEqual([fail.state, fail.run, fail.since], ["failing", 12, now - 0.7 * H]);
  assert.equal(R.pipeline({ workflow_runs: [run(5, 5 * H, "completed", "success")] }, now).state, "idle", "nothing started for hours: the scheduler");
  assert.equal(R.pipeline({ workflow_runs: [run(6, 0.1 * H, "in_progress", null), run(5, 0.5 * H, "completed", "success")] }, now).state, "running");
  assert.equal(R.pipeline({ workflow_runs: [run(6, 2 * H, "queued", null), run(5, 3 * H, "completed", "success")] }, now).state, "waiting", "queued for hours");
  assert.equal(R.pipeline({ workflow_runs: [run(6, 0.3 * H, "completed", "success")] }, now).state, "ok");
  for (const junk of [null, 5, "x", [], {}, { workflow_runs: "no" }, { workflow_runs: [null, 1, { created_at: "garbage" }] }])
    assert.equal(R.pipeline(junk, now).state, "unknown", JSON.stringify(junk));
});

await test("?why: one small answer for the app, kept at the edge, never for other sites", async () => {
  const real = globalThis.fetch, store = new Map();
  globalThis.caches = { default: { match: async (k) => store.get(k.url)?.clone(), put: async (k, r) => { store.set(k.url, r); } } };
  let calls = 0;
  const now = Date.now();
  const ago = (s) => new Date(now - s * 1000).toISOString();
  globalThis.fetch = async (u) => {
    calls++;
    if (String(u).includes("/environments/github-pages")) return new Response(JSON.stringify({ protection_rules: [{ type: "required_reviewers" }] }));
    return new Response(JSON.stringify({ workflow_runs: [{ run_number: 3, status: "waiting", conclusion: null, created_at: ago(3600), updated_at: ago(3600) },
                                                         { run_number: 2, status: "completed", conclusion: "success", created_at: ago(7200), updated_at: ago(7100) }] }));
  };
  try {
    const ask = (origin) => W.fetch(new Request("https://reader.example/?why=1", { headers: { Origin: origin } }), { GH_TOKEN: "github_pat_" + "D".repeat(40) });
    const r = await ask(ORIGIN);
    const d = await r.json();
    assert.deepEqual([d.state, d.run, d.schedule], ["approval", 3, true], JSON.stringify(d));
    assert.ok(JSON.stringify(d).length < 200, "a few hundred bytes, not GitHub's 250 KB");
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
    const before = calls;
    assert.equal((await (await ask(ORIGIN)).json()).state, "approval");
    assert.equal(calls, before, "the second phone is answered from the edge");
    assert.equal((await ask("https://evil.example")).status, 403);
    assert.ok(!JSON.stringify(d).includes("github_pat_"), "the token never leaves");
  } finally { globalThis.fetch = real; delete globalThis.caches; }
});

// ---- a paragraph per line (s=1), and picking up after a dropped link ----------
const lines = async (r) => (await r.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const askS = (u, extra = "", env = {}, ctx) =>
  W.fetch(new Request("https://reader.example/?cat=top&u=" + encodeURIComponent(u) + "&s=1" + extra, { headers: { Origin: ORIGIN } }), env, ctx);
await test("s=1: a head, one line per paragraph, an end - the same text as the JSON answer", async () => {
  const whole = await (await ask("https://news.example/a")).json();
  const r = await askS("https://news.example/a");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/plain/, "text/plain, so Cloudflare compresses it");
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  const L = await lines(r);
  const [head, ...rest] = L, end = rest.pop();
  assert.deepEqual([head.k, head.from, head.n, head.h], ["head", 0, rest.length, R.hashText(whole.text)]);
  assert.ok(rest.every((x, i) => x.k === "p" && x.i === i), "paragraphs in order, numbered");
  assert.equal(rest.map((x) => x.t).join("\n\n"), whole.text, "the same text, split at its paragraphs");
  assert.deepEqual([end.k, end.complete], ["end", whole.complete]);
  const js = await (await askS("https://news.example/js")).text();
  assert.match(js.trim().split("\n").pop(), /"note":"this looks like only part/, "a partial article's note rides on the end line");
});
await test("a cut answer continues where it stopped; a changed text starts over", async () => {
  const L = await lines(await askS("https://news.example/a"));
  const h = L[0].h, n = L[0].n;
  const more = await lines(await askS("https://news.example/a", "&from=3&h=" + h));
  assert.equal(more[0].from, 3);
  assert.deepEqual(more.slice(1, -1).map((x) => x.i), Array.from({ length: n - 3 }, (_, i) => i + 3), "only the missing paragraphs");
  assert.equal(more.slice(1, -1).map((x) => x.t).join("\n\n"), L.slice(4, -1).map((x) => x.t).join("\n\n"));
  for (const [q, why] of [["&from=3&h=0badc0de", "another text"], ["&from=" + (n + 1) + "&h=" + h, "past the end"],
                          ["&from=3", "no hash"], ["&from=-2&h=" + h, "negative"], ["&from=3&h=" + h.toUpperCase(), "not a hash"]]) {
    const again = await lines(await askS("https://news.example/a", q));
    assert.equal(again[0].from, 0, why + ": the whole text again");
    assert.equal(again.length, L.length, why);
  }
  const none = await lines(await askS("https://news.example/a", "&from=" + n + "&h=" + h));
  assert.deepEqual(none.map((x) => x.k), ["head", "end"], "already complete: a refresh costs two short lines");
});
await test("the hash is stable and sensitive", () => {
  assert.equal(R.hashText(""), "811c9dc5");
  assert.equal(R.hashText("a"), "e40c292c", "FNV-1a, as published");
  assert.notEqual(R.hashText("Paragraph one.\n\nTwo"), R.hashText("Paragraph one.\n\nTwo."));
  assert.equal(R.hashText("😀 café"), R.hashText("😀 café"));
});
await test("a slow site: the app hears back in time, and the finished work answers its next try", async () => {
  const real = globalThis.fetch, store = new Map(), kept = [];
  globalThis.caches = { default: { match: async (k) => store.get(k.url)?.clone(), put: async (k, r) => { store.set(k.url, r); } } };
  globalThis.fetch = async (u, init) => {
    if (String(u) !== "https://news.example/late") return real(u, init);
    await new Promise((res) => setTimeout(res, 1600));        // a site that ignores the reader's patience
    return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
  };
  listedUrls.push("https://news.example/late");
  try {
    const t0 = Date.now();
    const r = await askS("https://news.example/late", "", { TIMEOUT_MS: "300" }, { waitUntil: (p) => kept.push(p) });
    assert.equal(r.status, 504, "answered at the deadline, not left hanging");
    assert.ok(Date.now() - t0 < 1500, "took " + (Date.now() - t0) + " ms");
    assert.equal(kept.length, 1, "the work goes on after the answer");
    await kept[0];
    const t1 = Date.now();
    const r2 = await askS("https://news.example/late", "", { TIMEOUT_MS: "300" });
    assert.equal(r2.status, 200);
    assert.ok(Date.now() - t1 < 200, "the next try comes from the edge cache");
    const L = await lines(r2);
    assert.equal(L[0].k, "head"); assert.ok(L[0].n >= 6);
  } finally { globalThis.fetch = real; delete globalThis.caches; listedUrls.pop(); }
});
await test("a stalled headline file cannot hold the reader", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u) === SITE + "data/top.json")
      return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    return real(u, init);
  };
  try {
    const t0 = Date.now();
    const r = await askS("https://news.example/a", "", { TIMEOUT_MS: "300" });   // 8 s for real, 1 s here
    assert.equal(r.status, 404);
    assert.ok(Date.now() - t0 < 2500, "took " + (Date.now() - t0) + " ms");
  } finally { globalThis.fetch = real; }
});

await test("entities and control characters", () => {
  assert.equal(R.decodeEntities("&lt;b&gt; &#8212; &#x1F600; &bogus; &#0;"), "<b> \u2014 \ud83d\ude00 &bogus;  ");
  assert.equal(R.extract("<p>Ctrl \u0007chars\u202e and a long enough paragraph to keep here.</p>"), "Ctrl chars and a long enough paragraph to keep here.");
});
console.log("reader tests\n  " + ran + " run, " + failed + " failed");
process.exit(failed ? 1 : 0);
