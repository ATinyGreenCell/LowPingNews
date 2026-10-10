// Tests for the web app's core logic. Run: node web/test/core.test.mjs
import assert from "node:assert/strict";
import * as C from "../static/core.js";
import * as R from "../reader/reader.js";

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
  assert.equal(d.items[0].title, "A BC D", "the whole escape sequence goes, not just its first byte");
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
test("currents: NOAA's events, the stream between them, and hostile rows", () => {
  const now = 1791140000;
  const t = C.parseTile({ nb: 41, c: [["ACT3496", "Huntington Bay, off East Fort Point", 40.9267, -73.4175, 1], ["../evil", "x", 40.9, -73.41, 1],
                                      ["ACT9999", "far", 41.3, -72.9, 2], ["AC1", "short id", 40.9, -73.41, 1], ["ACT2000", "bad bin", 40.9, -73.41, 1.5],
                                      ["ACT2001", "\u001b[2Jnear", 40.901, -73.413, 3], "junk", [null]] }, 40.9, -73.412, now);
  assert.deepEqual(t.currents.map((c) => c.id), ["ACT2001", "ACT3496", "ACT9999"], "nearest first; a malformed ID or bin never reaches NOAA");
  assert.equal(t.currents[0].bin, 3);
  assert.ok(!/\u001b/.test(t.currents[0].name));
  assert.equal(t.nb, 41);
  assert.equal(C.parseTile({}, 0, 0, now).nb, -1, "a missing tile says nothing about NDBC");
  const T = (h, m) => Date.UTC(2026, 9, 4, h, m) / 1000;
  const f = C.parseCurrents({ current_predictions: { units: "knots", cp: [
    { Type: "slack", meanFloodDir: 179, Bin: "1", meanEbbDir: 7, Time: "2026-10-04 17:36", Depth: null, Velocity_Major: 0 },
    { Type: "flood", meanFloodDir: 179, Bin: "1", meanEbbDir: 7, Time: "2026-10-04 14:38", Depth: null, Velocity_Major: 0.42 },
    { Type: "ebb", meanFloodDir: 179, Bin: "1", meanEbbDir: 7, Time: "2026-10-04 20:05", Depth: null, Velocity_Major: -0.4 },
    { Type: "flood", Time: "nonsense", Velocity_Major: 1 }, { Type: "ebb", Time: "2026-10-04 23:00", Velocity_Major: "x" },
    { Type: "flood", Time: "2026-10-05 01:00", Velocity_Major: 99 }, null] } });
  assert.deepEqual(f.ev, [[T(14, 38), 0.42, "F"], [T(17, 36), 0, "S"], [T(20, 5), -0.4, "E"]]);
  assert.deepEqual([f.flood, f.ebb, C.compass(179), C.compass(7), C.compass(350), C.compass(-45), C.compass(225)], [179, 7, "S", "N", "N", "NW", "SW"]);
  // from a peak the stream eases off as a quarter cosine; from slack it builds as a quarter sine
  assert.ok(Math.abs(C.flowAt(f.ev, (T(14, 38) + T(17, 36)) / 2) - 0.42 * Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(C.flowAt(f.ev, (T(17, 36) + T(20, 5)) / 2) + 0.4 * Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(C.flowAt(f.ev, T(17, 36))) < 1e-9, "slack is slack");
  assert.equal(C.flowAt(f.ev, T(12, 0)), null, "outside the predictions: unknown, not guessed");
  assert.ok(Math.abs(C.flowAt([[0, 1, "F"], [100, 0.2, "F"]], 50) - 0.6) < 1e-9, "a stream that never stops eases peak to peak");
  assert.match(C.parseCurrents({ error: { message: "Currents predictions are not available from the requested station" } }).error, /not available/);
  assert.equal(C.parseCurrents("<html>").ev.length, 0);
  assert.equal(C.parseCurrents({ current_predictions: { cp: "x" } }).error, "no predictions");
});
test("how long a tide holds: exact against a minute-by-minute walk", () => {
  const H = 3600;
  const cases = [[[0, 0.4, "L"], [6.2 * H, 7.3, "H"], [12.4 * H, 0.7, "L"], [18.6 * H, 7.7, "H"], [24.8 * H, 0.5, "L"]],
                 [[0, 6.9, "H"], [5.5 * H, -0.6, "L"], [12.9 * H, 5.1, "H"], [18 * H, 1.2, "L"], [25 * H, 7.0, "H"]],
                 [[0, 2.0, "H"], [6 * H, 1.4, "L"], [12 * H, 3.9, "H"], [18.5 * H, 0.2, "L"], [24 * H, 3.0, "H"]]];
  for (const h of cases) for (let i = 1; i < h.length - 1; i++) {
    const w = C.nearWindow(h, i), [t0, v] = h[i];
    const walk = (step, stop) => {
      let x = t0;
      while ((x + step - stop) * step <= 0) {
        const l = C.tideLevel(h, x + step);
        if (!l || Math.abs(l.level - v) > 1) break;
        x += step;
      }
      return x;
    };
    assert.ok(Math.abs(w.start - walk(-60, h[i - 1][0])) <= 60 && Math.abs(w.end - walk(60, h[i + 1][0])) <= 60, JSON.stringify([h[i], w]));
  }
  const w = C.nearWindow(cases[0], 1);
  assert.ok(Math.abs(w.end - w.start - 3 * H) < 600 && !w.whole, "a 7 ft tide holds within a foot about 3 h (rule of twelfths)");
  assert.ok(C.nearWindow(cases[2], 1).whole, "a side under 1 ft is flagged, never passed off as a hold");
  assert.equal(C.nearWindow(cases[0], 0).start, null, "no neighbouring tide predicted: unknown, not guessed");
  assert.equal(C.round5(1000), 900);
});
test("text: whole escape sequences go, emoji never split, lone surrogates never kept", () => {
  assert.equal(C.cleanText("Kept \u001b[2J\u202eone \u001b]0;title\u0007x \u009b31mred", 99), "Kept one x red");
  assert.equal(C.cleanText("plain [2J text", 99), "plain [2J text");
  assert.equal(C.cleanText("wave \ud83c\udf0a and lone \ud83d end", 99), "wave \ud83c\udf0a and lone end");
  const s = C.cleanText("ab\ud83c\udf0a", 3);
  assert.equal(s, "ab", "a cut never leaves half an emoji");
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(C.cut("x\ud83d\ude00y", 2) + C.cleanParas("p\ud83d\ude00q\n\nr", 3)));
});
test("fuzz: tides, currents and windows survive anything a tile or NOAA could send", () => {
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const atoms = [null, undefined, true, 0, -1, 1e308, -1e308, NaN, Infinity, "", "x", "\u001b[2J\u202e\ud83d", "8516945", "ACT3116",
                 "../evil", "2026-10-04 19:42", "garbage", "H", "L", "flood", "ebb", "slack", 40.9, -73.4, [], {}];
  const junk = (d) => {
    const r = rnd();
    if (d > 3 || r < 0.35) return pick(atoms);
    if (r < 0.75) return Array.from({ length: Math.floor(rnd() * 7) }, () => junk(d + 1));
    const o = {};
    for (const k of ["v", "nb", "reader", "s", "b", "c", "predictions", "current_predictions", "cp", "error", "message", "t", "type",
                     "Time", "Type", "Velocity_Major", "meanFloodDir", "meanEbbDir", "units"]) if (rnd() < 0.4) o[k] = junk(d + 1);
    return o;
  };
  const bad = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
  const finiteOrNull = (v, where) => assert.ok(v === null || (typeof v === "number" && isFinite(v)), where + ": " + v);
  for (let n = 0; n < 3000; n++) {
    const now = 1791100000 + Math.floor(rnd() * 1e6);
    const t = C.parseTile(junk(0), 40.9, -73.4, now);
    for (const s of t.stations) { assert.match(s.id, /^[0-9A-Z]{5,10}$/); assert.ok(isFinite(s.km) && !bad.test(s.name)); }
    for (const c of t.currents) { assert.match(c.id, /^[0-9A-Za-z]{3,12}$/); assert.ok(isFinite(c.km)); }
    for (const b of t.buoys) for (const k of ["water", "waves", "period", "dir", "wind", "air"]) finiteOrNull(b[k], "buoy " + k);
    assert.ok(t.reader === "" || t.reader.startsWith("https://"));
    const p = C.parsePredictions(junk(0));
    for (const [tt, v, k] of p.hilo) assert.ok(isFinite(tt) && isFinite(v) && (k === "H" || k === "L"));
    for (let i = 0; i < p.hilo.length; i++) {
      const w = C.nearWindow(p.hilo, i);
      for (const x of [w.start, w.end]) finiteOrNull(x, "window");
    }
    const l = C.tideLevel(p.hilo, now);
    if (l) assert.ok(isFinite(l.level));
    const cr = C.parseCurrents(junk(0));
    const ev = cr.ev || cr.events || [];
    const f = C.flowAt(ev, now);
    assert.ok(f === null || isFinite(typeof f === "number" ? f : f.knots ?? 0), "flow " + JSON.stringify(f));
    assert.ok(!bad.test(p.error || "") && !bad.test(cr.error || ""));
  }
});
test("why the news is stale, in words: this week's stuck update, and every other cause", () => {
  const NY = "America/New_York";
  const fri = Date.parse("2026-10-09T18:50:00Z") / 1000, tue = Date.parse("2026-10-06T09:26:36Z") / 1000;
  const w = C.parseWhy({ v: 1, state: "waiting", since: tue, lastOk: tue - 25000, run: 24, schedule: false });
  assert.equal(C.whyText(w, fri, NY), "stuck on GitHub since Tue 5:26 AM");
  const today = Date.parse("2026-10-09T13:10:00Z") / 1000;
  assert.equal(C.whyText(C.parseWhy({ state: "failing", since: today }), fri, NY), "updates failing since 9:10 AM");
  assert.equal(C.whyText(C.parseWhy({ state: "idle", since: today }), fri, NY), "no update started since 9:10 AM");
  assert.equal(C.whyText(C.parseWhy({ state: "approval", since: tue }), fri, NY), "waiting for approval on GitHub since Tue 5:26 AM");
  assert.equal(C.whyText(C.parseWhy({ state: "running" }), fri, NY), "an update is running now");
  assert.equal(C.whenShort(Date.parse("2026-09-28T12:00:00Z") / 1000, fri, NY), "Sep 28", "more than a week back: the date");
  assert.equal(C.whyText(C.parseWhy({ state: "waiting", since: fri + 9999 }), fri, NY), "stuck on GitHub", "a time in the future is left out");
  for (const junk of [null, 5, "x", [], { state: "<script>" }, { state: "ok" }, { state: "unknown" }, { state: 7 }])
    assert.equal(C.whyText(C.parseWhy(junk), fri, NY), "", JSON.stringify(junk));
  const odd = C.parseWhy({ state: "waiting", since: NaN, lastOk: -5, run: "24", schedule: "yes" });
  assert.deepEqual([odd.since, odd.lastOk, odd.run, odd.schedule], [0, 0, 0, false]);
});

// ---- an article a paragraph at a time: the reader's real lines, the app's assembler ----
const PARAS = Array.from({ length: 12 }, (_, i) => "Paragraph " + (i + 1) + ": " + "words of the article ".repeat(5 + i) + "end.");
const ART = { v: 1, url: "https://news.example/a", text: PARAS.join("\n\n"), complete: true };
const feed = (arr, chunk) => { const [lines, rest] = C.takeLines(chunk); return { steps: lines.map((l) => arr.take(l)), rest }; };
const ask = (arr, out = ART) => {                        // what the app sends, answered as the Worker would
  const m = /from=(\d+)&h=([0-9a-f]{8})/.exec(arr.resume());
  return R.streamLines(out, m ? +m[1] : 0, m ? m[2] : "");
};
test("a streamed article arrives paragraph by paragraph, and ends whole", () => {
  const a = new C.Arrival();
  const { steps, rest } = feed(a, R.streamLines(ART, 0, ""));
  assert.equal(rest, "");
  assert.deepEqual(steps, ["head", ...PARAS.map(() => "p"), "end"]);
  assert.equal(a.text, ART.text);
  assert.ok(a.done && a.article().complete);
  assert.equal(a.of, 12); assert.equal(a.n, 12);
});
test("cut at ANY point, it carries on from the last whole paragraph and ends identical", () => {
  const whole = R.streamLines(ART, 0, "");
  for (let cut = 0; cut <= whole.length; cut += 7) {
    const a = new C.Arrival();
    feed(a, whole.slice(0, cut));                       // the link drops here: the partial last line is dropped too
    const kept = a.n;
    const more = ask(a);
    if (kept) assert.match(more.split("\n")[0], new RegExp('"from":' + kept), "asks only for the rest, cut at " + cut);
    const { steps } = feed(a, more);
    assert.ok(!steps.includes("bad"), "cut at " + cut + ": " + steps.join(","));
    assert.equal(a.text, ART.text, "cut at " + cut);
    assert.ok(a.done);
  }
});
test("several drops in a row, and repeated paragraphs, change nothing", () => {
  const a = new C.Arrival();
  let guard = 0;
  while (!a.done && guard++ < 50) { const next = ask(a); feed(a, next.slice(0, Math.ceil(next.length / 3))); }
  feed(a, ask(a));
  assert.equal(a.text, ART.text);
  const b = new C.Arrival();
  const lines = R.streamLines(ART, 0, "").split("\n");
  feed(b, [lines[0], lines[1], lines[1], lines[2], lines[1]].join("\n") + "\n");
  assert.equal(b.n, 2, "a paragraph it already has is skipped");
});
test("the text changed since the drop: it starts over, and says so", () => {
  const a = new C.Arrival();
  feed(a, R.streamLines(ART, 0, "").split("\n").slice(0, 5).join("\n") + "\n");
  assert.equal(a.n, 4);
  const changed = { ...ART, text: "A rewritten first paragraph, after a correction.\n\n" + PARAS.slice(1).join("\n\n") };
  const { steps } = feed(a, ask(a, changed));
  assert.equal(steps[0], "reset", "the page must clear what it showed");
  assert.equal(a.text, changed.text);
});
test("a saved part seeds the next visit; junk seeds nothing", () => {
  const a = new C.Arrival();
  feed(a, R.streamLines(ART, 0, "").split("\n").slice(0, 4).join("\n") + "\n");
  const again = new C.Arrival({ h: a.h, n: a.n, of: a.of, text: a.text });
  assert.equal(again.resume(), "&from=3&h=" + a.h);
  feed(again, ask(again));
  assert.equal(again.text, ART.text);
  for (const bad of [undefined, null, {}, { h: "xyz", n: 3, text: "t" }, { h: a.h, n: 0, text: "t" }, { h: a.h, n: -1, text: "t" },
                     { h: a.h, n: 2.5, text: "t" }, { h: a.h, n: 9999, text: "t" }, { h: a.h, n: 3, text: 7 }, { h: a.h.toUpperCase(), n: 3, text: "t" }])
    assert.equal(new C.Arrival(bad).resume(), "", JSON.stringify(bad));
});
test("lines out of order or out of bounds are refused, never shown", () => {
  const head = (o) => JSON.stringify({ k: "head", h: "0123abcd", n: 3, from: 0, ...o });
  const P = (i, t = "text " + i) => JSON.stringify({ k: "p", i, t });
  const a = new C.Arrival();
  assert.equal(a.take(P(0)), "bad", "a paragraph before any head");
  assert.equal(a.take(JSON.stringify({ k: "end", complete: true })), "bad", "an end before any head");
  for (const h of [head({ h: "nothex!!" }), head({ n: -1 }), head({ n: 9000 }), head({ from: 4 }), head({ n: "3" }), head({ from: 1.5 })])
    assert.equal(new C.Arrival().take(h), "bad", h);
  assert.equal(a.take(head()), "head");
  assert.equal(a.take(P(1)), "bad", "a gap");
  assert.equal(a.take(P(0)), "p");
  assert.equal(a.take(P(0)), "", "a repeat");
  assert.equal(a.take(JSON.stringify({ k: "end", complete: true })), "bad", "an end before the last paragraph");
  assert.equal(a.take(P(1)), "p"); assert.equal(a.take(P(2)), "p");
  assert.equal(a.take(P(3)), "bad", "more paragraphs than the head said");
  for (const junk of ["", "{", "null", "[]", "42", '"s"', '{"k":"other"}', "<html>"]) assert.equal(a.take(junk), "", junk);
  assert.equal(a.take(JSON.stringify({ k: "end", complete: true, note: "x\u0000y" })), "end");
  assert.equal(a.note, "x y");
  const cont = new C.Arrival({ h: "0123abcd", n: 2, of: 3, text: "a\n\nb" });
  assert.equal(cont.take(head({ from: 1 })), "bad", "a continuation from the wrong place");
  assert.equal(cont.take(head({ from: 2, h: "fedc4321" })), "bad", "a continuation of another text");
  assert.equal(cont.take(head({ from: 2 })), "head");
});
test("streamed text is cleaned like everything else, and bounded", () => {
  const a = new C.Arrival();
  a.take(JSON.stringify({ k: "head", h: "0123abcd", n: 3, from: 0 }));
  a.take(JSON.stringify({ k: "p", i: 0, t: "\u001b[2Jclean‮ me <b>not html</b>" }));
  a.take(JSON.stringify({ k: "p", i: 1, t: "\u0000\u0007" }));       // nothing left: counted, not shown
  a.take(JSON.stringify({ k: "p", i: 2, t: "x".repeat(9000) }));
  assert.equal(a.n, 3);
  const ps = a.text.split("\n\n");
  assert.equal(ps[0], "clean me <b>not html</b>", "the page puts text in with textContent: tags stay text");
  assert.equal(ps.length, 2);
  assert.ok(ps[1].length <= 6000);
  const big = new C.Arrival();
  big.take(JSON.stringify({ k: "head", h: "0123abcd", n: 60, from: 0 }));
  for (let i = 0; i < 60; i++) big.take(JSON.stringify({ k: "p", i, t: "y".repeat(5000) }));
  assert.ok(big.text.length <= C.MAX_TEXT, "capped at " + C.MAX_TEXT);
  assert.equal(big.n, 60, "still counted, so the next try asks from the right place");
});
test("lines from a growing buffer: whole ones out, the rest kept", () => {
  assert.deepEqual(C.takeLines(""), [[], ""]);
  assert.deepEqual(C.takeLines("abc"), [[], "abc"]);
  assert.deepEqual(C.takeLines("a\nb"), [["a"], "b"]);
  assert.deepEqual(C.takeLines("a\nb\n"), [["a", "b"], ""]);
  assert.deepEqual(C.takeLines("\n\n"), [["", ""], ""]);
});
test("retry pacing doubles, has a ceiling, and never goes wrong", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 100].map((k) => C.backoff(k, 2, 60)), [2, 4, 8, 16, 32, 60, 60, 60]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((k) => C.backoff(k, 10, 300)), [10, 20, 40, 80, 160, 300]);
  assert.equal(C.backoff(0, 2, 60), 2);
  assert.equal(C.backoff(1e9, 2, 60), 60);
});
test("saved tide predictions are reused while they span the next day", () => {
  const h = [[NOW - 7200, 1, "L"], [NOW + 15000, 7, "H"], [NOW + 60000, 0, "L"], [NOW + 100000, 7, "H"]];
  assert.ok(C.covers(h, NOW, NOW + 26 * 3600));
  assert.ok(!C.covers(h, NOW, NOW + 30 * 3600), "not far enough ahead");
  assert.ok(!C.covers(h, NOW - 9000, NOW), "not far enough back");
  assert.ok(C.covers(h, NOW - 7200, NOW + 100000), "the ends count");
  for (const bad of [[], null, "x", [[NaN, 1, "H"]], [["a", 1, "H"]], [null]]) assert.ok(!C.covers(bad, NOW, NOW), JSON.stringify(bad));
});
test("tab names are short where room is short", () => {
  assert.equal(C.tabName("Hazards and emergencies"), "Hazards");
  assert.equal(C.tabName("Biology and preprints"), "Biology");
  assert.equal(C.tabName("Arts & culture"), "Arts");
  for (const n of ["Headlines", "PubMed", "World", "Science and", "Band of brothers"]) assert.equal(C.tabName(n), n === "Science and" ? "Science and" : n);
  assert.equal(C.tabName(" and more"), " and more", "never an empty tab");
});
test("a page's own copy of its headline is spotted, real text is not", () => {
  const t = "Coastal towns brace as autumn storm brings gale-force winds and flooding risk";
  assert.ok(C.isHeadline(t, t));
  assert.ok(C.isHeadline("Coastal towns brace as autumn storm brings gale-force winds and flooding risk - BBC News", t), "with the site's name added");
  assert.ok(C.isHeadline("COASTAL TOWNS BRACE AS AUTUMN STORM BRINGS GALE-FORCE WINDS AND FLOODING RISK", t), "in capitals");
  assert.ok(C.isHeadline("Coastal towns brace as autumn storm brings gale‑force winds, and flooding risk", t), "other punctuation");
  assert.ok(!C.isHeadline("Coastal towns brace as autumn storm brings gale-force winds and flooding risk, with forecasters warning that sea defences could fail overnight in several places", t), "a lede that goes on is text");
  assert.ok(!C.isHeadline("Forecasters have issued amber warnings for parts of the coast.", t));
  assert.ok(C.isHeadline("Storm", "Storm"), "an exact repeat, however short");
  assert.ok(!C.isHeadline("Storm warning", "Storm warning issued for the coast"), "a short start of it: too little to judge, kept");
  assert.ok(!C.isHeadline("", t) && !C.isHeadline(t, ""));
  assert.ok(C.isHeadline("Café owners fight the new rent rules in the city centre", "Cafe owners fight the new rent rules in the city centre"), "accents");
});
console.log("web core tests\n  " + ran + " run, " + failed + " failed");
process.exit(failed ? 1 : 0);
