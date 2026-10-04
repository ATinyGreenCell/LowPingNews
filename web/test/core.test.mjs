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

console.log("web core tests\n  " + ran + " run, " + failed + " failed");
process.exit(failed ? 1 : 0);
