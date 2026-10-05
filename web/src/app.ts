// LowPingNews web: the page. Every piece of downloaded text goes in through
// textContent, never as HTML.
import type { Tide, CurrentStation, Flows } from "./core.js";
import { APP_VERSION, SHOW, Digest, Item, Alert, Article, parseDigest, parseArticle, staleness, ago, adoptWindow, moreWindow, clock, wmo, placeParts, placeFits, liveAlerts, preprintId, abstractFile, parseAbstractDoc, newerVersion, paperId, moon, tileKey, tideLevel, parseTile, parsePredictions, parseCurrents, flowAt, compass, nearWindow, round5, HOLD_FT } from "./core.js";

type Kids = (Node | string | null | undefined | false)[];
function el(tag: string, cls?: string, ...kids: Kids): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k) e.append(k);
  return e;
}
const now = (): number => Date.now() / 1000;
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
function store<T>(k: string, fallback: T): T {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; }
}
function keep(k: string, v: unknown): void {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private: fine */ }
}

// ---- state --------------------------------------------------------------
const S = {
  view: store<string>("view", "weather"),        // weather first, for a first visit too
  cats: [["top", "Headlines"]] as [string, string][],
  digest: null as Digest | null,
  offline: false,
  limit: SHOW,
  shown: [] as Item[],
  known: new Set<string>(),
  fetched: 0,
  reading: null as Item | null,
  read: new Set<string>(store<string[]>("read", [])),
};
function markRead(k: string): void {
  if (S.read.has(k)) return;
  S.read.add(k);
  keep("read", Array.from(S.read).slice(-3000));
}

function toast(text: string): void {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  window.clearTimeout((t as unknown as { _h: number })._h);
  (t as unknown as { _h: number })._h = window.setTimeout(() => { t.hidden = true; }, 3500);
}

// ---- status line: never let old news look current ------------------------
function status(): void {
  const s = $("status");
  s.className = "status";
  if (S.view === "weather" || S.view === "tides") { s.textContent = ""; return; }
  const d = S.digest;
  if (!d) { s.textContent = S.offline ? "offline, and nothing saved yet" : "loading\u2026"; return; }
  const st = staleness(d.t, now());
  s.textContent = (S.offline ? "offline \u00b7 saved copy, " : "") + st.text;
  s.classList.add(S.offline || st.level === "stale" ? "bad" : st.level === "aging" ? "warn" : "ok");
}

// ---- news ---------------------------------------------------------------
async function loadNews(cat: string, manual = false): Promise<void> {
  status();
  let raw: unknown = null;
  let offline = false;
  try {
    // no-cache = ask the server whether it changed: an unchanged file costs a
    // few hundred bytes. The service worker answers from its copy offline.
    const r = await fetch("./data/" + encodeURIComponent(cat) + ".json", { cache: "no-cache" });
    offline = r.headers.get("x-lpn-offline") === "1";
    if (r.ok) raw = await r.json();
  } catch { offline = true; }
  const d = raw ? parseDigest(raw, now()) : null;
  if (cat !== S.view) return;                              // switched away meanwhile
  S.offline = offline;
  if (!d) { status(); if (manual) toast(offline ? "offline: nothing saved for this section" : "could not read the news file"); renderNews(); return; }
  const same = !!S.digest && S.digest.cat === d.cat;
  const w = adoptWindow(S.shown, S.known, S.limit, d.items, same);
  S.digest = d;
  S.limit = w.limit;
  S.known = new Set(d.items.map((i) => i.key));
  if (d.cats.length) S.cats = d.cats;
  S.fetched = now();
  renderTabs();
  renderNews();
  status();
  if (w.fresh) toast(w.fresh + " new at the top");
  else if (manual) toast(offline ? "offline: showing the saved copy" : "nothing new");
  if (newerVersion(d.app, APP_VERSION)) showUpdate(d.app);
  else if (d.app === APP_VERSION) { mem("lpn-updating", null); mem("lpn-hard", null); }
}

// ---- updating the app itself ---------------------------------------------
// The app's files come from the phone's offline copy, so a plain reload shows
// the same old version until the new one has installed. Tapping asks for the
// new version and waits for it to take over; if a reload still shows the old
// one, the offline copy is cleared and the app loads fresh from the site
// (~15 KB), once - after that it says so instead of looping.
function mem(k: string, v?: string | null): string | null {
  try {
    if (v === undefined) return sessionStorage.getItem(k);
    if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v);
  } catch { /* private mode: no memory, still works */ }
  return null;
}
let updating = false;
function showUpdate(v: string): void {
  const b = $("update");
  if (!updating) b.textContent = "Version " + v + " is ready (you have " + APP_VERSION + "). Tap to update.";
  b.hidden = false;
  const tried = Number(mem("lpn-updating") || 0);
  if (tried && Date.now() - tried < 120000) void hardUpdate(b);    // just tried, still old
}
async function updateNow(b: HTMLElement): Promise<void> {
  if (updating) return;
  updating = true;
  b.textContent = "Updating\u2026";
  mem("lpn-updating", String(Date.now()));
  const sws = navigator.serviceWorker;
  if (sws) {
    const changed = new Promise<void>((res) => sws.addEventListener("controllerchange", () => res(), { once: true }));
    try { const reg = await sws.getRegistration(); if (reg) await reg.update(); } catch { /* offline */ }
    await Promise.race([changed, new Promise((r) => setTimeout(r, 6000))]);
  }
  location.reload();
}
async function hardUpdate(b: HTMLElement): Promise<void> {
  if (updating) return;
  if (mem("lpn-hard")) { b.textContent = "Could not update yet. Close the app fully and open it again."; return; }
  updating = true;
  mem("lpn-hard", "1");
  b.textContent = "Updating\u2026";
  try {
    for (const k of await caches.keys()) if (k.startsWith("lpn-shell-")) await caches.delete(k);
    if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  } catch { /* nothing to clear */ }
  location.reload();
}

function card(it: Item): HTMLElement {
  const read = S.read.has(it.key);
  const age = it.t ? ago(now() - it.t) : "?";
  const c = el("article", "card" + (read ? " read" : ""),
    el("div", "meta", (read ? "" : "\u25cf ") + it.src + " \u00b7 " + age),
    el("h2", "", it.title));
  if (it.summary) c.append(el("p", "sum", it.summary));
  if (savedArticle(it.key)) c.querySelector(".meta")!.append(" \u00b7 saved");
  c.tabIndex = 0;
  c.setAttribute("role", "button");
  c.onclick = () => openReader(it);
  return c;
}

function renderNews(): void {
  if (S.reading) return;                    // never pull an open article out from under her
  const main = $("main");
  main.replaceChildren();
  const d = S.digest;
  if (!d) { main.append(el("p", "empty", S.offline ? "Offline, and this section has not been saved yet." : "Loading\u2026")); return; }
  if (!d.items.length) { main.append(el("p", "empty", "No stories in this section right now.")); return; }
  S.shown = d.items.slice(0, S.limit);
  for (const it of S.shown) main.append(card(it));
  const left = d.items.length - S.shown.length;
  if (left > 0) {
    const nxt = d.items[Math.min(d.items.length, S.limit + 10) - 1];
    const b = el("button", "more", "Show " + Math.min(10, left) + " more" +
                 (nxt.t ? " \u00b7 back to " + ago(now() - nxt.t) + " ago" : ""));
    b.onclick = () => { S.limit = moreWindow(S.limit, d.items.length); renderNews(); };
    main.append(b);
  } else {
    const last = S.shown[S.shown.length - 1];
    main.append(el("p", "end", "That is everything for now" + (last.t ? " \u00b7 oldest " + ago(now() - last.t) + " ago" : "")));
  }
  if (d.failed.length) {
    main.append(el("p", "note", "Not updated this time: " + d.failed.map(([n, a]) =>
      n + (a > 0 ? " (copy " + ago(a) + " old)" : "")).join(", ")));
  }
}

// ---- reading an article: text only, like the terminal app ----------------
// Saved on the phone (the last 40), so reading again costs nothing, offline too.
interface Saved { t: number; a: Article }
function savedArticle(key: string): Saved | null { return store<Saved | null>("art:" + key, null); }
function saveArticle(key: string, a: Article): void {
  const idx = store<string[]>("arts", []).filter((k) => k !== key);
  idx.push(key);
  while (idx.length > 40) { const old = idx.shift(); try { localStorage.removeItem("art:" + old); } catch { /* fine */ } }
  keep("art:" + key, { t: now(), a });
  keep("arts", idx);
}

function openReader(it: Item, fromHistory = false): void {
  S.reading = it;
  markRead(it.key);
  if (!fromHistory) history.pushState({ reading: it.key }, "");
  window.scrollTo(0, 0);
  void renderReader(it);
}

function closeReader(): void {
  if (!S.reading) return;
  S.reading = null;
  renderNews();
}

async function renderReader(it: Item, force = false): Promise<void> {
  const main = $("main");
  const back = el("button", "back", "\u2039 Back");
  back.onclick = () => history.back();
  const body = el("div", "body", el("p", "empty", "Getting the text\u2026"));
  main.replaceChildren(back, el("div", "meta", it.src + (it.t ? " \u00b7 " + ago(now() - it.t) + " ago" : "")),
                       el("h1", "headline", it.title), body);
  const show = (a: Article | null, why: string, savedAgo: number): void => {
    if (S.reading !== it) return;                        // left meanwhile
    body.replaceChildren();
    if (a && a.text) {
      for (const p of a.text.split("\n\n")) body.append(el("p", "", p));
      if (!a.complete) body.append(el("p", "note warn", a.note || "This may be only part of the article."));
      else if (a.note) body.append(el("p", "note", a.note));          // e.g. "This is the abstract."
      if (savedAgo >= 0) body.append(el("p", "note", "Saved on this phone " + (savedAgo < 60 ? "just now" : ago(savedAgo) + " ago")));
    } else {
      if (it.summary) body.append(el("p", "", it.summary));
      body.append(el("p", "note warn", why));
    }
    if (it.link) {
      const a_ = el("a", "go", "Open the original page \u2197") as HTMLAnchorElement;
      a_.href = it.link; a_.target = "_blank"; a_.rel = "noopener noreferrer";
      body.append(a_, el("p", "note", "The original page is the full website, which usually costs far more data."));
    }
  };
  // a complete saved copy is reused; a partial one (a paywall, a tagline, an
  // older reader's best effort) is fetched again, and kept only for offline
  // a preprint's partial copy can only be a bot wall's leftovers or a site slogan: never shown
  const saved0 = savedArticle(it.key);
  const saved = saved0 && (saved0.a.complete || !preprintId(it.link)) ? saved0 : null;
  if (!force && saved && saved.a.text && saved.a.complete) { show(saved.a, "", now() - saved.t); return; }
  const reader = S.digest ? S.digest.reader : "";
  if (!it.link) { show(null, "This feed gives no link to the full article.", -1); return; }
  // a preprint: its abstract was published beside the app by the site build
  // (bioRxiv refuses the reader's servers, but not GitHub's): ~1 KB, same site
  const pre = paperId(it.link);
  if (pre) {
    try {
      const r = await fetch(abstractFile(pre));
      const a = r.ok ? parseAbstractDoc(await r.json(), pre) : null;
      if (a && a.text) { saveArticle(it.key, a); show(a, "", -1); return; }
    } catch { /* offline, or not published yet: the reader may still manage */ }
  }
  if (!reader) { show(null, "Full-text reading is not set up for this app yet.", -1); return; }
  try {
    const r = await fetch(reader + "?cat=" + encodeURIComponent(S.view) + "&u=" + encodeURIComponent(it.link));
    let raw: unknown = null;
    try { raw = await r.json(); } catch { /* not JSON */ }
    const a = parseArticle(raw);
    if (a.text) { saveArticle(it.key, a); show(a, "", -1); }
    else if (saved && saved.a.text) show(saved.a, "", now() - saved.t);
    else show(null, "Could not get the text: " + (a.error || "the reader answered " + r.status) + ".", -1);
  } catch {
    if (saved && saved.a.text) show(saved.a, "", now() - saved.t);
    else show(null, "Offline: this article has not been saved yet.", -1);
  }
}

// ---- tabs ---------------------------------------------------------------
function renderTabs(): void {
  const nav = $("tabs");
  nav.replaceChildren();
  const all: [string, string][] = [["weather", "Weather"], ["tides", "Tides"], ...S.cats];
  for (const [id, name] of all) {
    const b = el("button", id === S.view ? "tab on" : "tab", name);
    b.onclick = () => go(id);
    nav.append(b);
  }
}

function go(view: string): void {
  if (view === S.view && view !== "weather" && view !== "tides") { void loadNews(view, true); return; }
  S.view = view;
  keep("view", view);
  S.digest = null; S.limit = SHOW; S.shown = []; S.known = new Set(); S.reading = null;
  renderTabs();
  window.scrollTo(0, 0);
  if (view === "weather") void showWeather();
  else if (view === "tides") void showTides();
  else { renderNews(); void loadNews(view); }
}

// ---- weather ------------------------------------------------------------
interface Spot { lat: number; lon: number; label: string; via: string; t: number }
const US = /-US$/i.test(navigator.language || "") || (navigator.language || "") === "en";

function spotLine(sp: Spot): string {
  const how = sp.via === "device" ? "your phone's location" : sp.via === "place" ? "set by place name" : sp.via;
  const age = ago(now() - sp.t);
  return "For " + sp.lat.toFixed(3) + ", " + sp.lon.toFixed(3) + " (" + how + ", " + (/^\d/.test(age) ? age + " ago" : age) + ")";
}

async function getJSON(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; status: number; body: unknown }> {
  const r = await fetch(url, { headers, cache: "no-cache" });
  let body: unknown = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

async function showWeather(force = false): Promise<void> {
  status();
  const main = $("main");
  main.replaceChildren();
  const sp = store<Spot | null>("spot", null);
  const box = el("div", "where");
  const input = el("input") as HTMLInputElement;
  input.placeholder = "Town, State (e.g. Huntington, NY)";
  input.autocomplete = "off";
  const find = el("button", "small", "Find");
  const mine = el("button", "small", "Use my location");
  box.append(input, find, mine);
  main.append(box);
  find.onclick = () => void findPlace(input.value);
  input.onkeydown = (e) => { if (e.key === "Enter") void findPlace(input.value); };
  mine.onclick = () => locate();
  if (!sp) { main.append(el("p", "empty", "Choose a place, or use your location. It is kept on this phone only.")); return; }
  main.append(el("h2", "place", sp.label || "Your spot"), el("p", "note", spotLine(sp)));
  const alertsBox = el("section", "alerts");
  const wxBox = el("section", "wx", el("p", "empty", "Loading the forecast\u2026"));
  main.append(alertsBox, wxBox);
  void renderAlerts(sp, alertsBox, force);
  void renderForecast(sp, wxBox, force);
}

function locate(): void {
  if (!navigator.geolocation) { toast("this browser cannot share its location"); return; }
  toast("asking for your location\u2026");
  navigator.geolocation.getCurrentPosition((p) => {
    keep("spot", { lat: p.coords.latitude, lon: p.coords.longitude, label: "Here", via: "device", t: now() });
    void showWeather(true);
  }, () => toast("location not shared - type a place instead"), { enableHighAccuracy: false, maximumAge: 1800000, timeout: 15000 });
}

// ---- tides -------------------------------------------------------------------
// One tile from this site (stations and buoys near you, ~1-3 KB), NOAA's highs
// and lows (~1 KB, kept 12 h), and the moon worked out on the phone.
const COOPS = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
function locatePrecise(): void {
  if (!navigator.geolocation) { toast("this browser cannot share its location"); return; }
  toast("finding your exact spot\u2026");
  navigator.geolocation.getCurrentPosition((p) => {
    keep("spot", { lat: p.coords.latitude, lon: p.coords.longitude, label: "Here", via: "device", t: now() });
    void showTides(true);
  }, () => toast("location not shared - set a place in Weather instead"), { enableHighAccuracy: true, maximumAge: 300000, timeout: 20000 });
}
async function predictions(sid: string, force: boolean, reader: string): Promise<{ hilo: Tide[]; error: string }> {
  const day = new Date((now() - 86400) * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const key = sid + day;
  const c = store<{ key: string; t: number; h: Tide[] } | null>("tidepred", null);
  if (!force && c && c.key === key && now() - c.t < 12 * 3600 && Array.isArray(c.h) && c.h.length) return { hilo: c.h, error: "" };
  const q = "?product=predictions&application=LowPingNews&begin_date=" + day + "&range=96&datum=MLLW&station=" + sid +
            "&time_zone=gmt&interval=hilo&units=english&format=json";
  let raw: unknown = null;
  try { raw = (await getJSON(COOPS + q)).body; } catch { /* the browser may refuse NOAA (CORS): the reader asks for us */ }
  if (!raw && reader) { try { raw = (await getJSON(reader + "?tide=" + sid + "&d=" + day)).body; } catch { /* offline */ } }
  const p = parsePredictions(raw);
  if (p.hilo.length) keep("tidepred", { key, t: now(), h: p.hilo });
  else if (c && c.key === key && c.h && c.h.length) return { hilo: c.h, error: "" };   // offline: the last copy
  return p;
}
/** The nearest station NOAA predicts currents for (some list none), with its
 *  max flood, max ebb and slack times: ~1 KB, kept 12 h like the tides. */
async function currentsNear(cands: CurrentStation[], force: boolean, reader: string): Promise<{ st: CurrentStation; f: Flows }> {
  const day = new Date((now() - 86400) * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const key = (s: CurrentStation): string => s.id + "_" + s.bin + "_" + day;
  const c = store<{ key: string; t: number; f: Flows } | null>("curpred", null);
  const kept = c && c.f && Array.isArray(c.f.ev) && c.f.ev.length ? cands.find((s) => c.key === key(s)) : undefined;
  if (!force && kept && now() - c!.t < 12 * 3600) return { st: kept, f: c!.f };
  let last: Flows = { ev: [], flood: null, ebb: null, error: "no predictions" };
  for (const s of cands) {
    const q = "?product=currents_predictions&application=LowPingNews&begin_date=" + day + "&range=96&station=" + s.id +
              "&bin=" + s.bin + "&time_zone=gmt&interval=MAX_SLACK&units=english&format=json";
    let raw: unknown = null;
    try { raw = (await getJSON(COOPS + q)).body; } catch { /* the browser may refuse NOAA (CORS): the reader asks for us */ }
    if (!raw && reader) { try { raw = (await getJSON(reader + "?cur=" + s.id + "&bin=" + s.bin + "&d=" + day)).body; } catch { /* offline */ } }
    const f = parseCurrents(raw);
    if (f.ev.length) { keep("curpred", { key: key(s), t: now(), f }); return { st: s, f }; }
    if (!raw) break;                       // nobody answered: offline, the next station would fail the same way
    last = f;
  }
  if (kept) return { st: kept, f: c!.f };  // offline: the last copy
  return { st: cands[0], f: last };
}
function dayWord(t: number): string {
  const d = new Date(t * 1000), n = new Date();
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();
  if (same(d, n)) return "today";
  if (same(d, new Date(n.getTime() + 86400000))) return "tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short" });
}
function wait(sec: number): string {
  const m = Math.max(0, Math.floor(sec / 60));
  return m < 60 ? m + " min" : Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
}
function tideChart(hilo: Tide[], t0: number): SVGElement {
  // drawn like the weather chart: 24 hours across, labelled every six, with
  // each high and low marked by a dot and its time
  const NS = "http://www.w3.org/2000/svg", W = 288, H = 64, top = 14, axis = 16;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 96; i++) { const l = tideLevel(hilo, t0 + i * 900); if (l) pts.push([i / 96, l.level]); }
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + (H + axis)); svg.setAttribute("class", "chart tidechart"); svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Water level over the next 24 hours");
  if (pts.length < 2) return svg;
  const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  const x = (f: number): number => f * W, y = (v: number): number => top + (1 - (v - lo) / ((hi - lo) || 1)) * (H - top - 4);
  const line = pts.map((p, i) => (i ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1)).join(" ");
  const mk = (tag: string, attrs: Record<string, string>, text?: string): SVGElement => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  svg.append(mk("path", { d: line + " L" + x(pts[pts.length - 1][0]).toFixed(1) + " " + H + " L" + x(pts[0][0]).toFixed(1) + " " + H + " Z", class: "fill" }),
             mk("path", { d: line, class: "line" }));
  for (const [t, v, k] of hilo) {
    const f = (t - t0) / 86400;
    if (f < 0 || f > 1) continue;
    const cx = x(f), cy = y(v);
    svg.append(mk("circle", { cx: cx.toFixed(1), cy: cy.toFixed(1), r: "2.5", class: k === "H" ? "dot hi" : "dot" }),
               mk("text", { x: String(Math.min(W - 26, Math.max(2, cx - 13))), y: String(k === "H" ? Math.max(9, cy - 5) : Math.min(H - 1, cy + 12)),
                            class: "lab" }, clock(t, true)));
  }
  for (let i = 0; i <= 18; i += 6)                                    // the time axis, as on the weather chart
    svg.append(mk("text", { x: String(x(i / 24) + 1), y: String(H + 13) }, i ? clock(t0 + i * 3600, true) : "now"));
  return svg;
}
// one rule for every day label on this tab, so a list and a sentence never disagree
function dayLabel(t: number): string {
  const w = dayWord(t);
  return w === "today" ? "Today" : w === "tomorrow" ? "Tmrw" : w;
}
const buoyName = (n: string): string => n.replace(/^(?:[A-Z0-9]{4,8}\s+)?\d{5,8}\s*-\s*/, "").replace(/^[\s-]+|[\s-]+$/g, "");
function rows(cls: string): HTMLElement { return el("div", "trows " + cls); }
function edgeTime(edge: number, tide: number): string {
  const e = round5(edge);
  return clock(e) + (dayWord(e) === dayWord(tide) ? "" : " " + dayLabel(e).toLowerCase());
}

async function showTides(force = false): Promise<void> {
  status();
  const main = $("main");
  main.replaceChildren();
  const mine = el("button", "small", "Use my precise location");
  mine.onclick = () => locatePrecise();
  main.append(el("div", "where", mine));
  const sp = store<Spot | null>("spot", null);
  if (!sp) { main.append(el("p", "empty", "Tides need your spot: tap above, or set a place in Weather. It is kept on this phone only.")); return; }
  main.append(el("h2", "place", sp.label || "Your spot"), el("p", "note", spotLine(sp)));
  const box = el("section", "tides", el("p", "empty", "Loading tides\u2026"));
  main.append(box);
  const t = now();
  let tile: unknown = null;
  try {
    const r = await fetch("./data/tides/" + tileKey(sp.lat, sp.lon) + ".json");
    tile = r.ok ? await r.json() : r.status === 404 ? {} : null;
  } catch { /* offline */ }
  if (S.view !== "tides") return;
  box.replaceChildren();
  if (tile === null) box.append(el("p", "note warn", "Could not get the station list. Offline?"));
  const { stations, buoys, currents, nb, reader } = parseTile(tile || {}, sp.lat, sp.lon, t);
  const mi = (k: number): string => (k >= 1.6 ? Math.round(k / 1.609) + " mi" : "under a mile");
  const cands = currents.filter((c) => c.km <= 40).slice(0, 3);
  const flows = cands.length ? currentsNear(cands, force, reader) : null;     // asked alongside the tides
  const st = stations[0];
  const dot = " \u00b7 ";
  const when = (tt: number): string => clock(tt) + (dayWord(tt) === "today" ? "" : " " + dayLabel(tt).toLowerCase());
  if (!st || st.km > 60) {
    if (tile !== null) box.append(el("p", "note warn", "No NOAA tide station within 60 km. Predictions cover US coasts and territories."));
  } else {
    const pr = await predictions(st.id, force, reader);
    if (S.view !== "tides") return;
    if (!pr.hilo.length) box.append(el("p", "note", st.name + dot + mi(st.km)), el("p", "note warn", "NOAA gave no predictions: " + pr.error));
    else {
      const lv = tideLevel(pr.hilo, t);
      const next = pr.hilo.filter((h) => h[0] > t);
      if (lv && next.length) {
        box.append(el("div", "thero",
          el("span", "big", lv.level.toFixed(1)), el("span", "unit", "ft"),
          el("span", "arrow", lv.rising ? "\u2191" : "\u2193"), el("span", "word", lv.rising ? "Rising" : "Falling")),
          el("p", "small", (next[0][2] === "H" ? "High" : "Low") + " tide " + when(next[0][0]) + ", in " + wait(next[0][0] - t)));
        // how long it holds: the window within a foot of the coming (or current) high or low
        const i1 = pr.hilo.length - next.length;
        const word = (k: string): string => (k === "H" ? "high" : "low");
        const prev = i1 >= 1 ? nearWindow(pr.hilo, i1 - 1) : null, w1 = nearWindow(pr.hilo, i1);
        let hold = "";
        if (prev && !prev.whole && prev.end !== null && prev.end > t)
          hold = "Within " + HOLD_FT + " ft of " + word(pr.hilo[i1 - 1][2]) + " now, until " + when(round5(prev.end)) + ".";
        else if (!w1.whole && w1.start !== null && w1.end !== null)
          hold = w1.start <= t ? "Within " + HOLD_FT + " ft of " + word(next[0][2]) + " now, until " + when(round5(w1.end)) + "."
            : "Within " + HOLD_FT + " ft of " + word(next[0][2]) + " from " + when(round5(w1.start)) + " to " + when(round5(w1.end)) +
              ", about " + wait(round5(w1.end) - round5(w1.start)) + ".";
        if (hold) box.append(el("p", "hold", hold));
      }
      box.append(el("p", "tsub", st.name + dot + mi(st.km) + dot, el("span", "nw", "NOAA " + st.id)));
      const win = pr.hilo.filter((h) => h[0] >= t && h[0] <= t + 86400);
      if (win.length) {
        const top = win.reduce((a, b) => (b[1] > a[1] ? b : a)), bot = win.reduce((a, b) => (b[1] < a[1] ? b : a));
        // the true range: the highs and lows inside the 24 h and the level at its two ends
        const span = [...win.map((h) => h[1]), ...[tideLevel(pr.hilo, t), tideLevel(pr.hilo, t + 86400)].filter((x) => x).map((x) => x!.level)];
        box.append(el("h3", "", "Next 24 hours" + dot + Math.min(...span).toFixed(1) + "\u2013" + Math.max(...span).toFixed(1) + " ft"), tideChart(pr.hilo, t),
          el("p", "small", "Highest " + when(top[0]) + ", " + top[1].toFixed(1) + " ft: least shore showing."),
          el("p", "small", "Lowest " + when(bot[0]) + ", " + bot[1].toFixed(1) + " ft: most shore showing."));
      }
      // the table: the day named once, as in a printed tide table; a bar for the height
      const shown = next.slice(0, 4);
      const lo = Math.min(...shown.map((h) => h[1]), 0), hi = Math.max(...shown.map((h) => h[1]));
      const tbl = rows("tides");
      let last = "";
      let anyWhole = false;
      shown.forEach(([tt, v, k], n) => {
        const d = dayLabel(tt), bar = el("span", "range", el("i"));
        (bar.firstChild as HTMLElement).style.width = Math.max(4, (v - lo) / ((hi - lo) || 1) * 100).toFixed(1) + "%";
        const w = nearWindow(pr.hilo, pr.hilo.length - next.length + n);
        anyWhole = anyWhole || w.whole;
        const win = !w.whole && w.start !== null && w.end !== null
          // an edge on another day than its tide says which: past midnight, a bare time reads a day off
          ? "within " + HOLD_FT + " ft " + edgeTime(w.start, tt) + " \u2013 " + edgeTime(w.end, tt) + " \u00b7 " + wait(round5(w.end) - round5(w.start)) : "";
        tbl.append(el("div", k === "H" ? "trow hi" : "trow",
          el("span", "d", d === last ? "" : d), el("span", "c", clock(tt)), el("span", "k", k === "H" ? "High" : "Low"),
          bar, el("span", "v", v.toFixed(1) + " ft"), win ? el("span", "win", win) : null));
        last = d;
      });
      box.append(el("h3", "", "Tides"), tbl);
      if (anyWhole) box.append(el("p", "small warn", "The tide here moves under " + 2 * HOLD_FT +
        " ft between some highs and lows, so the water stays near them for hours: no single window to give."));
    }
  }
  if (flows) {
    const { st: cs, f } = await flows;
    if (S.view !== "tides") return;
    box.append(el("h3", "", "Currents"));
    if (!f.ev.length) box.append(el("p", "note", cs.name + dot + mi(cs.km)), el("p", "note warn", "NOAA gave no current predictions: " + f.error));
    else {
      const v = flowAt(f.ev, t);
      const next = f.ev.filter((e) => e[0] > t);
      const label = { F: "Max flood", E: "Max ebb", S: "Slack" };
      if (v !== null && next.length) {
        const ns = next.find((e) => e[2] === "S"), nm = next.find((e) => e[2] !== "S");
        const to = v > 0 ? f.flood : f.ebb;
        if (Math.abs(v) < 0.1) {
          box.append(el("div", "thero", el("span", "word big2", "About slack")));
          if (nm) box.append(el("p", "small", label[nm[2]] + " " + when(nm[0]) + ", in " + wait(nm[0] - t)));
        } else {
          const arrow = el("span", "arrow", "\u2191");
          if (to !== null) { arrow.style.transform = "rotate(" + Math.round(to) + "deg)"; arrow.title = "toward " + compass(to); }
          box.append(el("div", "thero", el("span", "big", Math.abs(v).toFixed(1)), el("span", "unit", "kn"), arrow,
            el("span", "word", (v > 0 ? "Flooding" : "Ebbing") + (to !== null ? " toward " + compass(to) : ""))));
          const nx = ns || nm;
          if (nx) box.append(el("p", "small", label[nx[2]] + " " + when(nx[0]) + ", in " + wait(nx[0] - t)));
        }
      }
      box.append(el("p", "tsub", cs.name + dot + mi(cs.km) + dot, el("span", "nw", "NOAA " + cs.id)));
      const shown = next.slice(0, 4);
      const top = Math.max(...shown.map((e) => Math.abs(e[1])), 0.1);
      const tbl = rows("currents");
      let last = "";
      for (const [tt, kv, k] of shown) {
        const d = dayLabel(tt), bar = el("span", "range", el("i"));
        (bar.firstChild as HTMLElement).style.width = (k === "S" ? 0 : Math.max(4, Math.abs(kv) / top * 100)).toFixed(1) + "%";
        tbl.append(el("div", k === "S" ? "trow" : "trow hi",
          el("span", "d", d === last ? "" : d), el("span", "c", clock(tt)), el("span", "k", label[k]),
          bar, el("span", "v", k === "S" ? "" : Math.abs(kv).toFixed(1) + " kn")));
        last = d;
      }
      box.append(tbl);
      if (f.flood !== null && f.ebb !== null) box.append(el("p", "small", "Floods toward " + compass(f.flood) + ", ebbs toward " + compass(f.ebb) + "."));
    }
  }
  const mo = moon(t);
  const md = (x: number): string => new Date(x * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const ev = ([[mo.next, "New"], [mo.full, "Full"]] as [number, string][]).sort((a, b) => a[0] - b[0]);
  box.append(el("h3", "", "Moon"), el("div", "thero small2", el("span", "word", mo.name), el("span", "dimw", Math.round(mo.lit * 100) + "% lit")),
             el("p", "small", ev.map(([x, w]) => w + " " + md(x)).join(dot)));
  if (mo.tide) box.append(el("p", "small", mo.tide === "spring" ? "Spring tides: higher highs and lower lows than usual." : "Neap tides: a smaller range than usual."));
  const near = buoys.filter((b) => b.km <= 100).slice(0, 2);
  if (near.length) {
    box.append(el("h3", "", "Buoys"));
    const deg = (c: number): string => (US ? Math.round(c * 9 / 5 + 32) + "\u00b0F" : Math.round(c) + "\u00b0C");
    for (const b of near) {
      const bits: string[] = [];
      if (b.water !== null) bits.push("water " + deg(b.water));
      if (b.waves !== null) bits.push("waves " + (b.waves * 3.281).toFixed(1) + " ft" + (b.period ? " every " + Math.round(b.period) + " s" : ""));
      if (b.wind !== null) bits.push("wind " + (b.dir !== null ? compass(b.dir) + " " : "") + Math.round(b.wind * 1.944) + " kt");
      if (b.air !== null) bits.push("air " + deg(b.air));
      box.append(el("div", "tbuoy", el("div", "n", el("strong", "", buoyName(b.name) || "Buoy " + b.id),
                                         el("span", "dimw", dot + mi(b.km) + dot + ago(t - b.t) + " ago")),
                    el("p", "small", bits.join(dot) || "no readings")));
    }
  } else if (nb >= 0) {                     // a real tile: say why the list is empty
    box.append(el("h3", "", "Buoys"), el("p", "note", nb === 0 ? "No buoy readings on the site right now: NDBC did not answer its last build."
                                                              : "No buoy within 62 mi has reported in the last 3 hours."));
  }
  box.append(el("p", "note", "Heights are above NOAA's average lowest tide (MLLW), so a low can read below 0. Windows: when the water is within " +
    HOLD_FT + " ft of each high or low, from NOAA's times, to about 5 min. Wind and pressure can shift real water a foot or more."));
}

async function findPlace(q: string): Promise<void> {
  const { town, quals } = placeParts(q);
  if (town.length < 2) { toast("type a town name"); return; }
  try {
    const r = await getJSON("https://geocoding-api.open-meteo.com/v1/search?count=" + (quals.length ? 20 : 5) +
                            "&language=en&format=json&name=" + encodeURIComponent(town));
    const res = ((r.body as { results?: unknown[] })?.results || []) as Record<string, unknown>[];
    const hits = res.filter((x) => typeof x.latitude === "number" && typeof x.longitude === "number" &&
                                   (!quals.length || placeFits(x, quals)));
    if (!hits.length) { toast("no place matched" + (quals.length ? " in that region" : "")); return; }
    const h = hits[0];
    const label = [h.name, h.admin1, h.country_code].filter((x) => typeof x === "string" && x).join(", ");
    keep("spot", { lat: h.latitude, lon: h.longitude, label, via: "place", t: now() });
    if (hits.length > 1) toast("chose " + label + " (" + (hits.length - 1) + " other matches)");
    void showWeather(true);
  } catch { toast("offline: could not look the place up"); }
}

interface Cached { t: number; key: string; body: unknown }

async function cachedJSON(name: string, key: string, url: string, maxAge: number, force: boolean,
                          headers?: Record<string, string>): Promise<{ body: unknown; age: number; fresh: boolean; status: number }> {
  const c = store<Cached | null>(name, null);
  if (!force && c && c.key === key && now() - c.t < maxAge) return { body: c.body, age: now() - c.t, fresh: true, status: 200 };
  try {
    const r = await getJSON(url, headers);
    if (r.ok) { keep(name, { t: now(), key, body: r.body }); return { body: r.body, age: 0, fresh: true, status: r.status }; }
    return { body: null, age: -1, fresh: false, status: r.status };
  } catch {
    if (c && c.key === key) return { body: c.body, age: now() - c.t, fresh: false, status: 0 };
    return { body: null, age: -1, fresh: false, status: 0 };
  }
}

async function renderAlerts(sp: Spot, box: HTMLElement, force: boolean): Promise<void> {
  const key = sp.lat.toFixed(4) + "," + sp.lon.toFixed(4);
  const r = await cachedJSON("alerts", key, "https://api.weather.gov/alerts/active?point=" + key, 300, force,
                             { Accept: "application/geo+json" });
  box.replaceChildren();
  if (r.status === 404 || r.status === 400) return;           // outside the US: NOAA does not cover it
  const live = r.body ? liveAlerts(r.body, now()) : null;
  if (!live) {
    box.append(el("p", "alert unknown", "ALERTS UNKNOWN \u2014 could not reach weather.gov. This is not an all-clear."));
    return;
  }
  if (!r.fresh) box.append(el("p", "note warn", "Alerts checked " + ago(r.age) + " ago (offline) - may be out of date"));
  if (!live.alerts.length) { box.append(el("p", "ok", "\u2713 No NOAA alerts for this spot")); return; }
  for (const a of live.alerts as Alert[]) {
    const sev = a.severity === "Extreme" || a.severity === "Severe" ? "alert severe" : "alert";
    const card_ = el("details", sev, el("summary", "",
      "\u26a0\ufe0f " + a.event + (a.ends ? " \u00b7 until " + new Date(a.ends * 1000).toLocaleDateString(undefined, { weekday: "short" })
        + " " + clock(a.ends) : "")));
    if (a.headline) card_.append(el("p", "", a.headline));
    for (const para of a.description.split("\n\n")) card_.append(el("p", "small", para));
    if (a.instruction) card_.append(el("p", "todo", "What to do: " + a.instruction));
    if (a.severity === "Extreme" || a.severity === "Severe") (card_ as HTMLDetailsElement).open = true;
    box.append(card_);
  }
}

interface Forecast {
  timezone?: string;
  current?: Record<string, number>;
  hourly?: { time: number[]; precipitation_probability: number[]; temperature_2m: number[] };
  daily?: { time: number[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[];
            precipitation_probability_max: number[]; sunrise: number[]; sunset: number[] };
}

async function renderForecast(sp: Spot, box: HTMLElement, force: boolean): Promise<void> {
  const key = sp.lat.toFixed(3) + "," + sp.lon.toFixed(3) + (US ? ",f" : ",c");
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + sp.lat.toFixed(4) + "&longitude=" + sp.lon.toFixed(4) +
    "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,is_day" +
    "&hourly=precipitation_probability,temperature_2m&forecast_hours=24" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
    "&forecast_days=7&timezone=auto&timeformat=unixtime" + (US ? "&temperature_unit=fahrenheit&wind_speed_unit=mph" : "");
  const r = await cachedJSON("wx", key, url, 1800, force);
  box.replaceChildren();
  const f = r.body as Forecast | null;
  if (!f || !f.current || !f.daily || !f.hourly) { box.append(el("p", "empty", "No forecast: offline, and none saved for this spot.")); return; }
  const tz = typeof f.timezone === "string" ? f.timezone : undefined;
  if (!r.fresh) box.append(el("p", "note warn", "Forecast from " + ago(r.age) + " ago (offline)"));
  const u = US ? "\u00b0F" : "\u00b0C";
  const c = f.current;
  const w = wmo(c.weather_code, c.is_day !== 0);
  box.append(el("div", "now", el("span", "big", Math.round(c.temperature_2m) + u), el("span", "icon", w.icon), el("span", "", w.word)),
    el("p", "small", "Feels like " + Math.round(c.apparent_temperature) + "\u00b0 \u00b7 Humidity " + Math.round(c.relative_humidity_2m) +
       "% \u00b7 Wind " + Math.round(c.wind_speed_10m) + (US ? " mph" : " km/h") +
       (c.wind_gusts_10m > c.wind_speed_10m + 3 ? ", gusts " + Math.round(c.wind_gusts_10m) : "")));
  const n = Date.now() / 1000;
  const sun = [...f.daily.sunrise.map((t) => ["Sunrise", t] as [string, number]), ...f.daily.sunset.map((t) => ["Sunset", t] as [string, number])]
    .filter(([, t]) => t > n).sort((a, b) => a[1] - b[1])[0];
  if (sun) box.append(el("p", "small", sun[0] + " " + clock(sun[1], false, undefined, tz)));
  // the next 24 hours: rain chance as bars, labelled every six hours
  const pr = f.hourly.precipitation_probability.slice(0, 24);
  const temps = f.hourly.temperature_2m.slice(0, 24);
  const W = 24 * 12, H = 60;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + (H + 16));
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  pr.forEach((p, i) => {
    const h = Math.max(1, (Math.max(0, Math.min(100, p || 0)) / 100) * H);
    const rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("x", String(i * 12 + 1)); rect.setAttribute("width", "10");
    rect.setAttribute("y", String(H - h)); rect.setAttribute("height", String(h));
    svg.append(rect);
    if (i % 6 === 0) {
      const t = document.createElementNS(svg.namespaceURI, "text");
      t.setAttribute("x", String(i * 12 + 1)); t.setAttribute("y", String(H + 13));
      t.textContent = clock(f.hourly!.time[i], true, undefined, tz);
      svg.append(t);
    }
  });
  const peak = pr.reduce((b, p, i) => (p > pr[b] ? i : b), 0);
  svg.setAttribute("aria-label", "Chance of rain over the next 24 hours, highest " + (pr[peak] || 0) + "%");
  box.append(el("h3", "", "Next 24 hours \u00b7 " + Math.round(Math.min(...temps)) + "\u2013" + Math.round(Math.max(...temps)) + u), svg,
    el("p", (pr[peak] || 0) >= 10 ? "rain" : "small", (pr[peak] || 0) >= 10
      ? "Rain " + pr[peak] + "% around " + clock(f.hourly.time[peak], false, undefined, tz) : "No rain expected"));
  // seven days
  const lo = Math.min(...f.daily.temperature_2m_min), hi = Math.max(...f.daily.temperature_2m_max), span = (hi - lo) || 1;
  const days = el("div", "days");
  f.daily.time.forEach((t, i) => {
    const dw = wmo(f.daily!.weather_code[i]);
    const a = f.daily!.temperature_2m_min[i], b = f.daily!.temperature_2m_max[i];
    const bar = el("span", "range", el("i"));
    const inner = bar.firstChild as HTMLElement;
    inner.style.left = ((a - lo) / span * 100).toFixed(1) + "%";
    inner.style.width = Math.max(4, (b - a) / span * 100).toFixed(1) + "%";
    days.append(el("div", "day",
      el("span", "d", new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short", timeZone: tz })),
      el("span", "i", dw.icon), el("span", "w", dw.word),
      el("span", "t", Math.round(a) + "\u00b0"), bar, el("span", "t", Math.round(b) + "\u00b0"),
      el("span", (f.daily!.precipitation_probability_max[i] || 0) >= 10 ? "p wet" : "p", (f.daily!.precipitation_probability_max[i] || 0) + "%")));
  });
  box.append(el("h3", "", "7 days"), days);
}

// ---- start --------------------------------------------------------------
function start(): void {
  $("refresh").onclick = () => {
    if (S.view === "weather") void showWeather(true);
    else if (S.view === "tides") void showTides(true);
    else if (S.reading) void renderReader(S.reading, true);         // in an article: fetch it afresh
    else void loadNews(S.view, true);
  };
  $("update").onclick = () => void updateNow($("update"));
  $("ver").textContent = "v" + APP_VERSION;
  renderTabs();
  go(S.view === "weather" ? "weather" : S.view);
  // return to the app: check again only if it has been a while
  // the phone's back gesture leaves the article, not the app
  window.addEventListener("popstate", () => { if (S.reading) closeReader(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.view !== "weather" && S.view !== "tides" && now() - S.fetched > 15 * 60) void loadNews(S.view);
  });
  window.addEventListener("online", () => { if (S.view !== "weather" && S.view !== "tides") void loadNews(S.view); });
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true ||
                     matchMedia("(display-mode: standalone)").matches;
  if (ios && !standalone && !store<boolean>("hinted", false)) {
    const h = $("hint");
    h.hidden = false;
    h.onclick = () => { h.hidden = true; keep("hinted", true); };
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => { /* still works online */ });
}

start();
