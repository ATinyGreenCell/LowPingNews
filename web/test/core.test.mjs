// Tests for the web app's core logic. Run: node web/test/core.test.mjs
import assert from "node:assert/strict";
import * as C from "../static/core.js";

let ran = 0, failed = 0;
function test(name, fn) {
  ran++;
  try { fn(); console.log("  ok    " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n        " + (e && e.message || e)); }
}
const NOW = 1_790_000_000;
const doc = (items, extra = {}) => ({ v: 1, t: NOW - 60, app: "8.2", cat: "top", cats: [["top", "Headlines"]],
  src: ["BBC", "DW"], items, failed: [], ...extra });

test("a well-formed file parses", () => {
  const d = C.parseDigest(doc([[0, "Story one", "Sum", "https://bbc.co.uk/a", NOW - 100]]), NOW);
  assert.equal(d.items.length, 1);
  assert.deepEqual([d.items[0].src, d.items[0].title, d.items[0].link], ["BBC", "Story one", "https://bbc.co.uk/a"]);
});

test("dangerous or odd links are dropped, the story kept", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "https://user:pw@evil.example/", "ftp://x/y", 42, "not a url"]) {
    const d = C.parseDigest(doc([[0, "T " + String(bad), "", bad, NOW]]), NOW);
    assert.equal(d.items.length, 1);
    assert.equal(d.items[0].link, "", String(bad));
  }
});

test("control and direction characters are stripped", () => {
  const d = C.parseDigest(doc([[0, "A\u0000B\u001b[2JC\u202eD", "x\u200by", "", NOW]]), NOW);
  assert.equal(d.items[0].title, "A B [2JC D");
  assert.equal(d.items[0].summary, "x y");
});

test("malformed files and rows are refused, never crash", () => {
  for (const bad of [null, 5, "x", {}, { v: 2, t: NOW, items: [], src: [] }, { v: 1, t: NaN, items: [], src: [] },
                     { v: 1, t: NOW, items: "x", src: [] }]) assert.equal(C.parseDigest(bad, NOW), null);
  const d = C.parseDigest(doc([[9, "bad source index", "", "", NOW], [0.5, "fractional", "", "", NOW], "row",
                                [0, "", "", "", NOW], [0, "fine", "", "", NOW]]), NOW);
  assert.deepEqual(d.items.map((i) => i.title), ["fine"]);
});

test("future-dated stories are treated as undated, and duplicates dropped", () => {
  const d = C.parseDigest(doc([[0, "From the future", "", "", NOW + 86400], [1, "From the future!", "", "", NOW]]), NOW);
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].t, 0);
});

test("sizes are bounded", () => {
  const rows = Array.from({ length: 500 }, (_, i) => [0, "Story " + i + " " + "x".repeat(1000), "y".repeat(5000), "", NOW]);
  const d = C.parseDigest(doc(rows), NOW);
  assert.equal(d.items.length, 200);
  assert.ok(d.items[0].title.length <= 300 && d.items[0].summary.length <= 400);
});

test("staleness: fresh, aging, stale, unknown", () => {
  assert.equal(C.staleness(NOW - 600, NOW).level, "fresh");
  assert.equal(C.staleness(NOW - 2 * 3600, NOW).level, "aging");
  const s = C.staleness(NOW - 5 * 3600, NOW);
  assert.equal(s.level, "stale"); assert.match(s.text, /5h old/);
  assert.equal(C.staleness(NOW + 7200, NOW).level, "unknown");
  assert.equal(C.staleness(0, NOW).level, "unknown");
});

const items = (titles) => titles.map((t, i) => ({ src: "A", title: t, summary: "", link: "", t: NOW - i, key: C.storyKey(t) }));
test("new stories are added on top; nothing visible is pushed out", () => {
  const old = items(Array.from({ length: 30 }, (_, i) => "Old " + i));
  const shown = old.slice(0, 20);
  const next = items(["New 0", "New 1", "New 2"].concat(old.map((i) => i.title)));
  const w = C.adoptWindow(shown, new Set(old.map((i) => i.key)), 20, next, true);
  assert.deepEqual(w, { limit: 23, fresh: 3 });
  assert.deepEqual(C.adoptWindow(shown, new Set(), 20, next, false), { limit: C.SHOW, fresh: 0 });
  assert.equal(C.moreWindow(10, 33), 20); assert.equal(C.moreWindow(30, 33), 33);
});

const at = (h, m) => Date.UTC(2026, 9, 4, h, m) / 1000;
test("times follow the phone's region: 12-hour in the US", () => {
  assert.equal(C.clock(at(15, 5), false, "en-US", "UTC").replace(/\u202f/g, " "), "3:05 PM");
  assert.deepEqual([at(0, 0), at(12, 0), at(15, 0), at(9, 0)].map((t) => C.clock(t, true, "en-US", "UTC")), ["12a", "12p", "3p", "9a"]);
  assert.equal(C.clock(at(15, 0), true, "en-GB", "UTC"), "15");
});

test("a place's region filters, and is never part of the name", () => {
  const { town, quals } = C.placeParts("Huntington, NY");
  assert.equal(town, "Huntington");
  assert.ok(C.placeFits({ admin1: "New York" }, quals));
  assert.ok(!C.placeFits({ admin1: "West Virginia" }, C.placeParts("x, Virginia").quals));
  assert.ok(C.placeFits({ admin2: "Suffolk County" }, C.placeParts("x, Suffolk").quals));
});

test("alerts: drills, cancellations and expired ones never show; worst first", () => {
  const f = (event, sev, extra = {}) => ({ properties: { event, severity: sev, status: "Actual", messageType: "Alert",
    ends: new Date((NOW + 3600) * 1000).toISOString(), description: "* WHAT...x\n\n* WHERE...y", ...extra } });
  const r = C.liveAlerts({ features: [f("Wind Advisory", "Moderate"), f("Flood Warning", "Severe"),
    f("Tornado Warning", "Extreme", { status: "Test" }), f("Gone", "Severe", { ends: new Date((NOW - 60) * 1000).toISOString() }),
    f("Cancelled", "Severe", { messageType: "Cancel" })] }, NOW);
  assert.deepEqual(r.alerts.map((a) => a.event), ["Flood Warning", "Wind Advisory"]);
  assert.equal(r.expired, 1);
  assert.equal(r.alerts[0].description, "* WHAT...x\n\n* WHERE...y", "paragraphs kept");
  assert.equal(C.liveAlerts({ nope: 1 }, NOW), null);
});

test("preprint links are recognised in every shape the feeds use", () => {
  for (const u of ["http://biorxiv.org/cgi/content/short/2026.10.02.679012v1?rss=1",
                   "https://www.biorxiv.org/content/10.1101/2026.10.02.679012v2",
                   "http://biorxiv.org/content/early/2026/10/02/2026.10.02.679012"])
    assert.deepEqual(C.preprintId(u), { server: "biorxiv", id: "2026.10.02.679012" }, u);
  assert.deepEqual(C.preprintId("https://www.medrxiv.org/content/10.1101/339747v1"), { server: "medrxiv", id: "339747" });
  assert.equal(C.preprintId("https://news.example/2026.10.02.679012"), null);
  assert.equal(C.abstractFile({ server: "biorxiv", id: "2026.10.02.679012" }), "./data/abs/biorxiv-2026.10.02.679012.json");
});
test("an abstract file reads as who, when, which version, then the abstract", () => {
  const a = C.parseAbstractDoc({ server: "biorxiv", abstract: "MYC2 is central.\n\nWe mapped it.", authors: "Lee, K.; Park, S.; Kim, H.; Ruiz, M.",
                                 date: "2026-10-02", version: "2", category: "plant biology", published: "10.1038/x.1" });
  assert.deepEqual(a.text.split("\n\n"), ["Lee, K.; Park, S.; Kim, H. and 1 more \u00b7 Plant biology \u00b7 posted 2026-10-02 \u00b7 version 2",
                                          "MYC2 is central.", "We mapped it.", "Since published: https://doi.org/10.1038/x.1"]);
  assert.ok(a.complete && /abstract/.test(a.note));
  assert.equal(C.parseAbstractDoc({ abstract: "x", published: "javascript:alert(1)" }).text.includes("javascript"), false);
  assert.equal(C.parseAbstractDoc(null).text, "");
});
test("the update banner shows only for a genuinely newer version", () => {
  assert.ok(C.newerVersion("8.8", "8.7"));
  assert.ok(C.newerVersion("8.10", "8.9"), "8.10 is newer than 8.9");
  assert.ok(C.newerVersion("9.0", "8.12"));
  for (const [a, b] of [["8.7", "8.7"], ["8.6", "8.7"], ["8.7", "8.7.0"], [undefined, "8.7"], ["8.7<x>", "8.7"], ["", "8.7"]])
    assert.equal(C.newerVersion(a, b), false, a + " vs " + b);
});
test("an abstract file for some other paper is not shown", () => {
  const doc = { server: "biorxiv", doi: "10.1101/2026.10.02.679012", abstract: "Right paper." };
  assert.equal(C.parseAbstractDoc(doc, { server: "biorxiv", id: "2026.10.02.679012" }).text.endsWith("Right paper."), true);
  assert.equal(C.parseAbstractDoc(doc, { server: "biorxiv", id: "2026.10.02.000001" }).text, "");
  assert.equal(C.parseAbstractDoc(doc, { server: "medrxiv", id: "2026.10.02.679012" }).text, "");
  assert.equal(C.parseAbstractDoc([doc]).text, "");
});
test("fuzz: hostile or broken data never throws and never reaches the page raw", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const atoms = [null, undefined, true, 0, -1, 1e308, NaN, "", "x".repeat(70000), "\u0000\u001b[2J\u202e<script>alert(1)</script>",
                 "javascript:alert(1)", "https://ok.example/a", "8.9", "10.1101/2026.10.02.679012", "biorxiv", [], {}];
  const junk = (d) => {
    const r = rnd();
    if (d > 3 || r < 0.4) return atoms[Math.floor(rnd() * atoms.length)];
    if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 6) }, () => junk(d + 1));
    const o = {};
    for (const k of ["v", "t", "app", "cat", "cats", "src", "items", "failed", "reader", "text", "complete", "note", "error",
                     "abstract", "authors", "date", "version", "category", "published", "server", "doi", "features"])
      if (rnd() < 0.5) o[k] = junk(d + 1);
    return o;
  };
  const bad = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
  const scan = (v, path) => {
    if (typeof v === "string") assert.ok(!bad.test(v), "control/direction character survived at " + path);
    else if (v && typeof v === "object") for (const k of Object.keys(v)) scan(v[k], path + "." + k);
  };
  for (let n = 0; n < 3000; n++) {
    const x = junk(0);
    const d = C.parseDigest(x, 1791100000);
    if (d) { scan(d, "digest"); for (const it of d.items) assert.ok(!it.link || /^https?:\/\//.test(it.link), "unsafe link: " + it.link); }
    scan(C.parseArticle(x), "article");
    scan(C.parseAbstractDoc(x), "abstract");
    C.newerVersion(x, "8.9"); C.preprintId(typeof x === "string" ? x : ""); C.liveAlerts(x, 1791100000);
  }
});
test("PubMed records: recognised, and their abstract file checked by PMID", () => {
  assert.deepEqual(C.paperId("https://pubmed.ncbi.nlm.nih.gov/41000001/"), { server: "pubmed", id: "41000001" });
  assert.deepEqual(C.paperId("http://biorxiv.org/cgi/content/short/2026.10.02.679012v1?rss=1"), { server: "biorxiv", id: "2026.10.02.679012" });
  assert.equal(C.paperId("https://pubmed.ncbi.nlm.nih.gov/?term=x"), null);
  assert.equal(C.abstractFile({ server: "pubmed", id: "41000001" }), "./data/abs/pubmed-41000001.json");
  const doc = { server: "pubmed", pmid: "41000001", abstract: "Plastids.", authors: "Lee K; Park S", journal: "Plant Cell", date: "2026-10-02" };
  const a = C.parseAbstractDoc(doc, { server: "pubmed", id: "41000001" });
  assert.equal(a.text.split("\n\n")[0], "Lee K; Park S \u00b7 Plant Cell \u00b7 published 2026-10-02");
  assert.match(a.note, /journal/);
  assert.equal(C.parseAbstractDoc(doc, { server: "pubmed", id: "41000002" }).text, "", "another record's file");
});
test("tides: the moon, the water level, and hostile tiles", () => {
  const full = C.moon(1706205240), nw = C.moon(1712600460);
  assert.ok(full.name === "Full moon" && full.lit > 0.97 && full.tide === "spring", JSON.stringify(full));
  assert.ok(nw.name === "New moon" && nw.lit < 0.03, JSON.stringify(nw));
  assert.equal(C.moon(1706205240 + 7.4 * 86400).tide, "neap");
  const hilo = [[0, 0, "L"], [21600, 6, "H"], [43200, 0.5, "L"]];
  assert.ok(Math.abs(C.tideLevel(hilo, 10800).level - 3) < 1e-9 && C.tideLevel(hilo, 10800).rising);
  assert.equal(C.tideLevel(hilo, 50000), null, "outside the predictions: unknown, not guessed");
  assert.equal(C.tileKey(40.9, -73.4), "40_-74", "negative longitudes round down");
  assert.ok(Math.abs(C.kmBetween(40.871, -73.426, 40.713, -74.006) - 51.9) < 0.5);
  const now = 1791140000;
  const t = C.parseTile({ reader: "javascript:alert(1)", s: [["8516945", "Northport, NY", 40.9, -73.35], ["BAD/ID", "x", 40.9, -73.41],
                          ["8516990", "\u001b[2JWillets", 40.79, -73.78], "junk", [null]],
                          b: [["44040", "W LIS", 40.956, -73.58, now - 600, 18, 0.5, 4, 225, 6.2, 8, 19], ["44022", "old", 40.9, -73.7, now - 4 * 3600]] },
                        40.9, -73.412, now);
  assert.deepEqual(t.stations.map((s) => s.id), ["8516945", "8516990"], "a malformed ID never reaches NOAA's address");
  assert.ok(!/\u001b/.test(t.stations[1].name));
  assert.deepEqual(t.buoys.map((b) => b.id), ["44040"], "a reading 4 hours old is not current");
  assert.equal(t.reader, "", "only an https reader is trusted");
  assert.equal(C.parseTile(null, 0, 0, now).stations.length, 0);
  const p = C.parsePredictions({ predictions: [{ t: "2026-10-04 19:42", v: "7.3", type: "H" }, { t: "2026-10-04 13:30", v: "-0.2", type: "L" },
                                               { t: "nonsense", v: "1" }, { t: "2026-10-05 01:58", v: "x", type: "L" }] });
  assert.deepEqual(p.hilo, [[Date.UTC(2026, 9, 4, 13, 30) / 1000, -0.2, "L"], [Date.UTC(2026, 9, 4, 19, 42) / 1000, 7.3, "H"]]);
  assert.match(C.parsePredictions({ error: { message: "No Predictions data was found." } }).error, /No Predictions/);
});
console.log("web core tests\n  " + ran + " run, " + failed + " failed");
process.exit(failed ? 1 : 0);
