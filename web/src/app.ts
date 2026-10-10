// LowPingNews web: the page. Every piece of downloaded text goes in through
// textContent, never as HTML.
import type { Tide, CurrentStation, Flows, Why } from "./core.js";
import { APP_VERSION, SHOW, Digest, Item, Alert, Article, Arrival, Step, takeLines, backoff, covers, tabName, isHeadline, parseDigest, parseArticle, staleness, ago, adoptWindow, moreWindow, clock, wmo, placeParts, placeFits, liveAlerts, preprintId, abstractFile, parseAbstractDoc, newerVersion, paperId, moon, tileKey, tideLevel, parseTile, parsePredictions, parseCurrents, flowAt, compass, nearWindow, round5, HOLD_FT, parseWhy, whyText } from "./core.js";

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
function keep(k: string, v: unknown): boolean {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }   // full or private
}

// ---- state --------------------------------------------------------------
const S = {
  view: store<string>("view", "weather"),        // weather first, for a first visit too
  cats: [["top", "Headlines"]] as [string, string][],
  digest: null as Digest | null,
  offline: "" as "" | "offline" | "slow",       // the news shown is the saved copy: no connection, or no answer in time
  limit: SHOW,
  shown: [] as Item[],
  known: new Set<string>(),
  fetched: 0,
  reading: null as Item | null,
  listY: 0,                                     // where she was in the list when she opened a story
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
  let text = st.text;
  if (st.level === "stale") {                      // hours old: say why, when the reader can tell
    if (WHY.forT === d.t && WHY.text) text = "news is " + ago(now() - d.t) + " old: " + WHY.text;
    if (!S.offline) void diagnose(d);
  }
  s.textContent = (S.offline === "offline" ? "offline \u00b7 saved copy, " : S.offline === "slow" ? "slow connection \u00b7 saved copy, " : "") +
                  text + (NEWS.checking ? " \u00b7 checking\u2026" : "");
  s.classList.add(S.offline === "offline" || st.level === "stale" ? "bad" : S.offline || st.level === "aging" ? "warn" : "ok");
}

// Asked at most every 10 minutes per news file: the reader condenses GitHub's
// record of the site's update runs into one small answer.
const WHY = { at: 0, forT: 0, text: "" };
async function diagnose(d: Digest): Promise<void> {
  if (!d.reader || (WHY.forT === d.t && now() - WHY.at < 600)) return;
  WHY.at = now(); WHY.forT = d.t; WHY.text = "";
  let w: Why;
  try {
    const r = await getJSON(d.reader + (d.reader.includes("?") ? "&" : "?") + "why=1", { cache: "no-store" });
    w = parseWhy(r.ok ? r.body : null);
  } catch { return; }                             // offline or no reader: the plain warning stands
  if (S.digest !== d) return;                     // moved on meanwhile
  if (w.state === "ok" && w.lastOk > d.t + 900) { void loadNews(S.view); return; }   // a newer copy is out: get it
  WHY.text = whyText(w, now());
  if (WHY.text) status();
}

// ---- the network, with time limits ------------------------------------------
// A stalled link does not fail: it just never answers. So every request has
// limits - for the answer to start (wait), for silence in the middle of it
// (idle), and overall (total) - and passing one aborts it, which counts as
// offline: whatever is saved is shown instead, and it is tried again later.
interface Limits { wait: number; idle: number; total: number }
const QUICK: Limits = { wait: 10, idle: 8, total: 30 };
async function fetchT(url: string, init: RequestInit = {}, lim: Limits = QUICK): Promise<{ r: Response; text: string }> {
  const ac = new AbortController();
  let idle = 0;
  const arm = (sec: number): void => { window.clearTimeout(idle); idle = window.setTimeout(() => ac.abort(), sec * 1000); };
  const all = window.setTimeout(() => ac.abort(), lim.total * 1000);
  arm(lim.wait);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    arm(lim.idle);
    const rd = r.body && r.body.getReader ? r.body.getReader() : null;
    if (!rd) return { r, text: await r.text() };
    const dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      arm(lim.idle);
      text += dec.decode(value, { stream: true });
    }
    return { r, text: text + dec.decode() };
  } finally { window.clearTimeout(idle); window.clearTimeout(all); }
}
/** JSON, with time limits. `saved` says the answer is the phone's saved copy:
 *  "offline" (no connection) or "slow" (the site did not answer in time). */
async function getJSON(url: string, o: { headers?: Record<string, string>; cache?: RequestCache; lim?: Limits } = {}):
    Promise<{ ok: boolean; status: number; body: unknown; saved: "" | "offline" | "slow" }> {
  const { r, text } = await fetchT(url, { headers: o.headers, cache: o.cache || "no-cache" }, o.lim || QUICK);
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const sv = r.headers.get("x-lpn-saved");
  return { ok: r.ok, status: r.status, body,
           saved: sv === "slow" ? "slow" : sv || r.headers.get("x-lpn-offline") === "1" ? "offline" : "" };
}
const linkWord = (): "offline" | "slow" => (navigator.onLine === false ? "offline" : "slow");

// ---- news ---------------------------------------------------------------
// The phone's saved copy is on screen at once; then the site is asked for a
// newer one. A link that stalls or drops leaves the saved copy up, says so,
// and is tried again: after 10 s, 20 s, 40 s... (5 min at most), at once when
// the phone says it is back online, and on returning to the app.
const NEWS = { gen: 0, tries: 0, timer: 0, checking: false, at: {} as Record<string, number> };
/** The service worker's saved copy of one of this site's files, and its age (s). */
async function savedSite(path: string): Promise<{ body: unknown; age: number } | null> {
  try {
    const hit = await caches.match(new URL(path, location.href).href, { cacheName: "lpn-data" });
    if (!hit) return null;
    const when = Date.parse(hit.headers.get("date") || "");
    return { body: await hit.json(), age: isFinite(when) ? Math.max(0, now() - when / 1000) : Infinity };
  } catch { return null; }                        // no service worker storage here, or a broken copy: the network alone
}
async function savedNews(cat: string): Promise<Digest | null> {
  const hit = await savedSite("./data/" + encodeURIComponent(cat) + ".json");
  return hit ? parseDigest(hit.body, now()) : null;
}
async function loadNews(cat: string, manual = false, cheap = false): Promise<void> {
  const gen = ++NEWS.gen;
  window.clearTimeout(NEWS.timer);
  // flipping back to a section asked about in the last 5 minutes: the site
  // rebuilds every 20, so the saved copy is the news - no request at all
  if (cheap && now() - (NEWS.at[cat] || 0) < 300) {
    const saved = await savedNews(cat);
    if (gen !== NEWS.gen || cat !== S.view) return;
    if (saved) { if (!S.digest) adopt(saved, false, true); status(); return; }
  }
  // no-cache = ask the server whether it changed: an unchanged file costs a few
  // hundred bytes. The service worker answers from its copy when the link fails.
  const asked = getJSON("./data/" + encodeURIComponent(cat) + ".json", { lim: { wait: 12, idle: 10, total: 90 } })
    .catch(() => null);
  if (!S.digest) {                                         // nothing on screen yet: the saved copy, meanwhile
    const saved = await savedNews(cat);
    if (saved && gen === NEWS.gen && cat === S.view && !S.digest) adopt(saved, false, true);
  }
  // "checking" shows only if the answer is slow to come: no flicker on a good link
  const slow = window.setTimeout(() => { if (gen === NEWS.gen) { NEWS.checking = true; status(); } }, 1500);
  status();
  let raw: unknown = null;
  let how: "" | "offline" | "slow" = "";
  const r = await asked;
  if (!r) how = linkWord();
  else { how = r.saved; if (r.ok) raw = r.body; }
  window.clearTimeout(slow);
  if (gen !== NEWS.gen) return;                            // a newer load took over
  NEWS.checking = false;
  if (cat !== S.view) return;                              // switched away meanwhile
  S.offline = how;
  if (!how && raw) NEWS.at[cat] = now();
  if (how) {                                               // try again later, while she is looking
    NEWS.tries++;
    NEWS.timer = window.setTimeout(() => {
      if (S.view === cat && document.visibilityState === "visible") void loadNews(cat);
    }, backoff(NEWS.tries, 10, 300) * 1000);
  } else NEWS.tries = 0;
  const d = raw ? parseDigest(raw, now()) : null;
  if (!d) {
    status();
    if (manual) toast(how === "offline" ? "offline: nothing saved for this section" : how ? "no answer from the site yet" : "could not read the news file");
    if (!S.digest) renderNews();
    return;
  }
  adopt(d, manual, !!how);
}
function adopt(d: Digest, manual: boolean, saved: boolean): void {
  const same = !!S.digest && S.digest.cat === d.cat;
  const w = adoptWindow(S.shown, S.known, S.limit, d.items, same);
  S.digest = d;
  S.limit = w.limit;
  S.known = new Set(d.items.map((i) => i.key));
  if (d.cats.length) S.cats = d.cats;
  if (!saved) S.fetched = now();
  renderTabs();
  const back = anchor();
  renderNews();
  back();
  status();
  if (w.fresh) toast(w.fresh + " new at the top");
  else if (manual) toast(S.offline === "offline" ? "offline: showing the saved copy" : S.offline ? "slow connection: showing the saved copy" : "nothing new");
  if (newerVersion(d.app, APP_VERSION)) showUpdate(d.app);
  else if (d.app === APP_VERSION) { mem("lpn-updating", null); mem("lpn-hard", null); }
}
/** Keep her place when the list is redrawn under her: the first story in view
 *  stays where it was on screen, even with new ones added above it. */
function anchor(): () => void {
  if (window.scrollY < 8 || S.reading) return () => undefined;
  const top = $("tabs").getBoundingClientRect().bottom;
  const first = Array.from(document.querySelectorAll<HTMLElement>("main article.card"))
    .find((c) => c.getBoundingClientRect().bottom > top + 1);
  if (!first) return () => undefined;
  const k = first.dataset.k, y = first.getBoundingClientRect().top;
  return () => {
    const again = Array.from(document.querySelectorAll<HTMLElement>("main article.card")).find((c) => c.dataset.k === k);
    if (again) window.scrollBy(0, again.getBoundingClientRect().top - y);
  };
}

// ---- updating the app itself ---------------------------------------------
// The app's files come from the phone's offline copy, so a plain reload shows
// the same old version until the new one has installed. Tapping asks for the
// new version and waits for it to take over; if a reload still shows the old
// one, the offline copy is cleared and the app loads fresh from the site
// (~30 KB), once - after that it says so instead of looping.
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
    // the new version downloads in the background (~30 KB): on a slow link give
    // it time, but only when there is a new version on its way to wait for
    const coming = await Promise.race([
      sws.getRegistration().then(async (reg) => { if (!reg) return false; await reg.update(); return !!(reg.installing || reg.waiting); })
        .catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), 8000))]);
    if (coming) await Promise.race([changed, new Promise((r) => setTimeout(r, 20000))]);
  }
  location.reload();
}
async function hardUpdate(b: HTMLElement): Promise<void> {
  if (updating) return;
  if (mem("lpn-hard")) { b.textContent = "Could not update yet. Close the app fully and open it again."; return; }
  updating = true;
  b.textContent = "Updating\u2026";
  // clearing the offline copy on a link that cannot fetch the new one would
  // leave no app at all until the signal came back: first the site must answer
  // (a news file: the app's own files come from the offline copy, never the net)
  let reached = false;
  try { const r = await getJSON("./data/" + encodeURIComponent(S.cats[0][0]) + ".json"); reached = r.ok && !r.saved; } catch { /* no */ }
  if (!reached) { updating = false; b.textContent = "Could not update now: the connection is too weak. Tap to try again later."; return; }
  mem("lpn-hard", "1");
  try {
    for (const k of await caches.keys()) if (k.startsWith("lpn-shell-")) await caches.delete(k);
    if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  } catch { /* nothing to clear */ }
  location.reload();
}

function card(it: Item, kept: Map<string, boolean>): HTMLElement {
  const read = S.read.has(it.key);
  const age = it.t ? ago(now() - it.t) : "?";
  const c = el("article", "card" + (read ? " read" : ""),
    el("div", "meta", (read ? "" : "\u25cf ") + it.src + " \u00b7 " + age),
    el("h2", "", it.title));
  if (it.summary) c.append(el("p", "sum", it.summary));
  const part = kept.get(it.key);
  if (part !== undefined) c.querySelector(".meta")!.append(part ? " \u00b7 part saved" : " \u00b7 saved");
  c.dataset.k = it.key;
  c.tabIndex = 0;
  c.setAttribute("role", "button");
  c.onclick = () => openReader(it);
  c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openReader(it); } };
  return c;
}

function renderNews(): void {
  if (S.reading) return;                    // never pull an open article out from under her
  const main = $("main");
  main.replaceChildren();
  const d = S.digest;
  if (!d) {
    main.append(el("p", "empty", S.offline ? "No connection, and this section has not been saved yet. It will load when the connection is back." : "Loading\u2026"));
    return;
  }
  if (!d.items.length) { main.append(el("p", "empty", "No stories in this section right now.")); return; }
  S.shown = d.items.slice(0, S.limit);
  const kept = savedIndex();
  for (const it of S.shown) main.append(card(it, kept));
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
// Each paragraph shows as it arrives, so a slow link shows the start at once.
// If the link drops or stalls, what came stays (and is saved), and only the
// rest is asked for: at once when the phone says it is back online, else
// after 2, 4, 8... s (a minute at most). The last 40 are kept on the phone, so
// reading one again costs nothing, offline too.
interface Saved { t: number; a: Article; h?: string; n?: number; of?: number; cut?: boolean }
function savedArticle(key: string): Saved | null {
  const v = store<Saved | null>("art:" + key, null);
  return v && typeof v === "object" && v.a && typeof v.a.text === "string" ? v : null;
}
/** Which stories are saved: key -> true when only part of the text came. */
function savedIndex(): Map<string, boolean> {
  const cut = new Set(store<string[]>("artcut", []));
  return new Map(store<string[]>("arts", []).map((k): [string, boolean] => [k, cut.has(k)]));
}
function saveArticle(key: string, a: Article, more?: { h: string; n: number; of: number; cut: boolean }): void {
  let idx = store<string[]>("arts", []).filter((k) => k !== key);
  let cut = store<string[]>("artcut", []).filter((k) => k !== key);
  const drop = (n: number): void => {
    while (idx.length > n) { const old = idx.shift()!; cut = cut.filter((k) => k !== old); try { localStorage.removeItem("art:" + old); } catch { /* fine */ } }
  };
  drop(39);
  const rec: Saved = more ? { t: now(), a, h: more.h, n: more.n, of: more.of, cut: more.cut } : { t: now(), a };
  // a full phone: make room from the oldest, rather than list a copy that is not there
  let ok = keep("art:" + key, rec);
  while (!ok && idx.length) { drop(Math.max(0, idx.length - 5)); ok = keep("art:" + key, rec); }
  if (ok) { idx.push(key); if (more && more.cut) cut.push(key); }
  keep("arts", idx);
  keep("artcut", cut);
}

// the article being read: its generation, its current try, and how to retry or stop it
const READ = { gen: 0, att: 0, timer: 0, retry: null as null | (() => void), abort: null as null | (() => void),
               save: null as null | (() => void) };
function stopReading(): void {
  READ.gen++;
  window.clearTimeout(READ.timer);
  if (READ.save) READ.save();                    // keep what came, even when she leaves mid-way
  if (READ.abort) READ.abort();
  READ.retry = READ.abort = READ.save = null;
}

function openReader(it: Item, fromHistory = false): void {
  S.reading = it;
  S.listY = window.scrollY;
  markRead(it.key);
  if (!fromHistory) history.pushState({ reading: it.key }, "");
  window.scrollTo(0, 0);
  void renderReader(it);
}

function closeReader(): void {
  if (!S.reading) return;
  S.reading = null;
  stopReading();
  renderNews();
  window.scrollTo(0, S.listY);                  // back where she was, the story she read now dimmed
}

const NOTHING: Article = { text: "", complete: false, note: "", error: "" };
async function renderReader(it: Item, force = false): Promise<void> {
  stopReading();
  const gen = READ.gen, cat = S.view;
  const live = (): boolean => gen === READ.gen && S.reading === it;
  const main = $("main");
  // back buttons name where they go, at the top and at the end of the story
  const back = el("button", "back", "\u2039 " + sectionName());
  back.onclick = () => history.back();
  const paras = el("div", "paras"), prog = el("div", "prog"), notes = el("div", "notes");
  const body = el("div", "body", paras, prog, notes);
  if (it.link) {                                   // there from the start: the way out of a slow reader
    const a_ = el("a", "go", "Open the original page \u2197") as HTMLAnchorElement;
    a_.href = it.link; a_.target = "_blank"; a_.rel = "noopener noreferrer";
    body.append(a_, el("p", "note", "The original page is the full website, which usually costs far more data."));
  }
  const back2 = el("button", "back last", "\u2039 Back to " + sectionName());
  back2.onclick = () => history.back();
  body.append(back2);
  main.replaceChildren(back, el("div", "meta", it.src + (it.t ? " \u00b7 " + ago(now() - it.t) + " ago" : "")),
                       el("h1", "headline", it.title), body);
  // what is shown meanwhile may be a stand-in (the feed's summary, an older
  // copy): the first paragraph that arrives replaces it
  let standIn = false;
  // a page that repeats its headline as its first lines: shown once, above
  const dup = (p: string, i: number): boolean => i < 2 && p.length < 400 && isHeadline(p, it.title);
  const fill = (text: string, stand: boolean, cls = ""): void => {
    paras.replaceChildren(...text.split("\n\n").filter((p, i) => p && !dup(p, i)).map((p) => el("p", cls, p)));
    standIn = stand;
  };
  const say = (text: string, warn = false, frac = -1, button?: [string, () => void]): void => {
    prog.className = "prog" + (warn ? " warn" : "");
    prog.replaceChildren(text);
    if (button) { const b = el("button", "small", button[0]); b.onclick = button[1]; prog.append(" ", b); }
    if (frac >= 0) {
      const bar = el("div", "bar", el("i"));
      (bar.firstChild as HTMLElement).style.width = Math.round(Math.min(1, frac) * 100) + "%";
      prog.append(bar);
    }
  };
  const finish = (a: Article, savedAgo: number, why = ""): void => {
    prog.replaceChildren(); prog.className = "prog";
    notes.replaceChildren();
    if (a.text) {
      if (standIn || !paras.childElementCount) fill(a.text, false);
      const said = a.note ? a.note[0].toUpperCase() + a.note.slice(1) : "";
      if (!a.complete) notes.append(el("p", "note warn", said || "This may be only part of the article."));
      else if (said) notes.append(el("p", "note", said));              // e.g. "This is the abstract."
      if (why) notes.append(el("p", "note warn", why));
      if (savedAgo >= 0) notes.append(el("p", "note", "Saved on this phone " + (savedAgo < 60 ? "just now" : ago(savedAgo) + " ago")));
    } else {
      if (!paras.childElementCount && it.summary) fill(it.summary, false);
      notes.append(el("p", "note warn", why));
    }
  };
  // a complete saved copy is reused; a partial one (a paywall, a tagline, an
  // older reader's best effort) is asked for again, and kept for offline.
  // A preprint's partial copy can only be a bot wall's leftovers or a site slogan: never shown
  const saved0 = savedArticle(it.key);
  const saved = saved0 && (saved0.a.complete || !preprintId(it.link)) ? saved0 : null;
  if (!force && saved && saved.a.text && saved.a.complete && !saved.cut) { finish(saved.a, now() - saved.t); return; }
  if (!it.link) { finish(NOTHING, -1, "This feed gives no link to the full article."); return; }
  // what came before carries on: a cut-off copy continues where it stopped,
  // and asking about a whole one costs two short lines if it has not changed
  const arr = new Arrival(saved && saved.h ? { h: saved.h, n: saved.n, of: saved.of, text: saved.a.text } : undefined);
  if (arr.n) fill(arr.text, false);
  else if (saved && saved.a.text) fill(saved.a.text, true);
  else if (it.summary) fill(it.summary, true, "feed");
  const part = (): string => (arr.of ? arr.n + " of " + arr.of + " paragraphs" : "");
  say(arr.n && arr.n < arr.of ? "Saved " + part() + " \u00b7 getting the rest\u2026" : saved ? "Checking for a newer copy\u2026" : "Getting the text\u2026");
  // a paper: its abstract was published beside the app by the site build
  // (bioRxiv refuses the reader's servers, but not GitHub's): ~1 KB, same site
  const pre = paperId(it.link);
  if (pre && !arr.n) {
    try {
      const { r, text } = await fetchT(abstractFile(pre));
      const a = r.ok ? parseAbstractDoc(JSON.parse(text), pre) : null;
      if (!live()) return;
      if (a && a.text) { saveArticle(it.key, a); fill(a.text, false); finish(a, -1); return; }
    } catch { /* offline, or not published yet: the reader may still manage */ }
    if (!live()) return;
  }
  const reader = S.digest ? S.digest.reader : "";
  if (!reader) {
    if (saved && saved.a.text) finish(saved.a, now() - saved.t);
    else finish(NOTHING, -1, "Full-text reading is not set up for this app yet.");
    return;
  }
  const base = reader + (reader.includes("?") ? "&" : "?") + "cat=" + encodeURIComponent(cat) + "&u=" + encodeURIComponent(it.link) + "&s=1";
  let tries = 0, keptN = arr.n;
  const keepPart = (): void => {                   // save what came: a later visit carries on from it
    if (arr.n > keptN && !arr.done) { saveArticle(it.key, arr.article(), { h: arr.h, n: arr.n, of: arr.of, cut: true }); keptN = arr.n; }
  };
  READ.save = keepPart;
  class Again extends Error {}
  const step = (st: Step): void => {
    if (st === "bad") throw new Again();
    if (st === "reset") { paras.replaceChildren(); standIn = false; }
    if (st === "p") {
      if (standIn) { paras.replaceChildren(); standIn = false; }
      if (arr.last && !dup(arr.last, arr.n - 1)) paras.append(el("p", "new", arr.last));
    }
    if (st === "head" || st === "p" || st === "reset") say("Loading \u00b7 " + part(), false, arr.of ? arr.n / arr.of : 0);
  };
  const retryNow = (): void => {
    if (!live()) return;
    window.clearTimeout(READ.timer);
    if (READ.abort) READ.abort();                  // a stalled try still out: drop it
    void attempt();
  };
  const attempt = async (): Promise<void> => {
    const me = ++READ.att, had = arr.n;
    READ.retry = null;
    const ac = new AbortController();
    READ.abort = () => ac.abort();
    let timer = 0, outcome: "ok" | "again" | "final" = "again", why = "";
    const arm = (sec: number): void => { window.clearTimeout(timer); timer = window.setTimeout(() => ac.abort(), sec * 1000); };
    // the reader may first have to fetch a slow site (it answers within ~20 s);
    // once its answer is coming, 12 s of silence means the link has stalled
    arm(30);
    const hint = window.setTimeout(() => {
      if (live() && me === READ.att && !arr.done) say((arr.n ? part() + " \u00b7 " : "") + "Still waiting for the reader\u2026", false, -1, ["Try again", retryNow]);
    }, 8000);
    try {
      const r = await fetch(base + arr.resume(), { signal: ac.signal });
      window.clearTimeout(hint);
      if (!r.ok) {
        let err = "";
        try { err = parseArticle(JSON.parse(await r.text())).error; } catch { /* not JSON */ }
        // 502: the site itself refused, or had no text - an answer. Any other
        // 5xx or a 429: the reader or Cloudflare had a moment - try again
        if (r.status === 429 || (r.status >= 500 && r.status !== 502)) throw new Again();
        outcome = "final"; why = err || "the reader answered " + r.status;
      } else {
        // a reader from before 9.8 answers one JSON object, all at once
        const json = /json/i.test(r.headers.get("content-type") || "");
        arm(12);
        const rd = r.body!.getReader(), dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          arm(12);
          buf += dec.decode(value, { stream: true });
          if (json) continue;
          const [lines, rest] = takeLines(buf);
          buf = rest;
          for (const ln of lines) step(arr.take(ln));
          if (buf.length > 1048576) throw new Again();               // no line is that long
        }
        buf += dec.decode();
        if (json) {
          const a = parseArticle(JSON.parse(buf));                    // cut off, it does not parse: again
          if (!live() || me !== READ.att) return;
          if (a.text) { saveArticle(it.key, a); fill(a.text, false); finish(a, -1); return; }
          outcome = "final"; why = a.error || "the reader found no text";
        } else outcome = arr.done ? "ok" : "again";                   // cut off before its end (or a Wi-Fi login page): again
      }
    } catch { outcome = "again"; }                                    // dropped, stalled, or offline
    finally { window.clearTimeout(timer); window.clearTimeout(hint); if (me === READ.att) READ.abort = null; }
    if (outcome !== "ok") keepPart();
    if (!live() || me !== READ.att) return;
    if (outcome === "ok") {
      if (!arr.text) { finish(NOTHING, -1, "Could not get the text: the page had no readable text."); return; }
      saveArticle(it.key, arr.article(), { h: arr.h, n: arr.n, of: arr.of, cut: false });
      keptN = arr.n;
      finish(arr.article(), -1);
      return;
    }
    if (outcome === "final") {
      if (arr.n) finish(arr.article(), -1, "Could not get the rest: " + why + ".");
      else if (saved && saved.a.text) finish(saved.a, now() - saved.t);
      else finish(NOTHING, -1, "Could not get the text: " + why + ".");
      return;
    }
    // the link dropped or stalled: what came stays on screen and on the phone.
    // A try that brought paragraphs shows the link works: the next one is soon
    tries = arr.n > had ? 1 : tries + 1;
    const left = part() ? " \u00b7 " + part() : "", frac = arr.of ? arr.n / arr.of : -1;
    const word = navigator.onLine === false ? "Offline" : "Connection lost";
    READ.retry = retryNow;                         // also when the phone is back online, or she returns to the app
    if (tries > 12) { say(word + left + ".", true, frac, ["Try again", () => { tries = 0; retryNow(); }]); return; }
    const wait = backoff(tries, 2, 60);
    say(word + left + " \u00b7 trying again in " + wait + " s", true, frac, ["Try now", retryNow]);
    READ.timer = window.setTimeout(retryNow, wait * 1000);
  };
  await attempt();
}

// ---- tabs ---------------------------------------------------------------
function renderTabs(): void {
  const nav = $("tabs");
  const keep_ = nav.scrollLeft;
  nav.replaceChildren();
  const all: [string, string][] = [["weather", "Weather"], ["tides", "Tides"], ...S.cats];
  let on: HTMLElement | undefined;
  for (const [id, name] of all) {
    const b = el("button", id === S.view ? "tab on" : "tab", tabName(name));
    if (tabName(name) !== name) b.title = name;
    if (id === S.view) { on = b; b.setAttribute("aria-current", "page"); }
    b.onclick = () => go(id);
    nav.append(b);
  }
  nav.scrollLeft = keep_;
  // the chosen tab in view, even far along the row (on opening the app, say)
  if (on && (on.offsetLeft < nav.scrollLeft || on.offsetLeft + on.offsetWidth > nav.scrollLeft + nav.clientWidth))
    nav.scrollLeft = Math.max(0, on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2);
}
/** The open section's name, as its tab shows it. */
function sectionName(): string {
  const c = S.cats.find(([id]) => id === S.view);
  return c ? tabName(c[1]) : "the list";
}

function go(view: string): void {
  if (view === S.view && S.reading) { history.back(); return; }      // the open section's tab: back to its list
  if (view === S.view && view !== "weather" && view !== "tides") { void loadNews(view, true); return; }
  S.view = view;
  keep("view", view);
  if (S.reading) stopReading();
  S.digest = null; S.limit = SHOW; S.shown = []; S.known = new Set(); S.reading = null; S.offline = "";
  renderTabs();
  window.scrollTo(0, 0);
  if (view === "weather") void showWeather();
  else if (view === "tides") void showTides();
  else { renderNews(); void loadNews(view, false, true); }
}

// ---- weather ------------------------------------------------------------
interface Spot { lat: number; lon: number; label: string; via: string; t: number }
const US = /-US$/i.test(navigator.language || "") || (navigator.language || "") === "en";

function spotLine(sp: Spot): string {
  const how = sp.via === "device" ? "from your location" : sp.via === "place" ? "from the place name" : sp.via;
  const age = ago(now() - sp.t);
  return sp.lat.toFixed(3) + ", " + sp.lon.toFixed(3) + " \u00b7 set " + how + " " + (/^\d/.test(age) ? age + " ago" : age);
}
/** The place, on one line, with "Change" opening the ways to set it - kept out
 *  of the way once it is set, since the forecast is what she came for. With no
 *  place yet, they are open, and finding her location comes first. */
function placeBlock(sp: Spot | null, then: () => void): HTMLElement {
  const wrap = el("section", "spot");
  const input = el("input") as HTMLInputElement;
  input.placeholder = "Town, State (e.g. Huntington, NY)";
  input.autocomplete = "off";
  input.enterKeyHint = "search";
  input.setAttribute("aria-label", "Town or place");
  const find = el("button", "", "Find");
  const mine = el("button", "primary", "Use my location");
  const editor = el("div", "where", input, find, mine);
  find.onclick = () => void findPlace(input.value, then);
  input.onkeydown = (e) => { if (e.key === "Enter") void findPlace(input.value, then); };
  mine.onclick = () => locate(then);
  if (!sp) {
    wrap.append(editor, el("p", "note", "Choose a place, or use your location. It is kept on this phone only."));
    return wrap;
  }
  const change = el("button", "small", "Change");
  change.setAttribute("aria-expanded", "false");
  editor.hidden = true;
  change.onclick = () => {
    editor.hidden = !editor.hidden;
    change.textContent = editor.hidden ? "Change" : "Cancel";
    change.setAttribute("aria-expanded", String(!editor.hidden));
    if (!editor.hidden) input.focus();
  };
  wrap.append(el("div", "spothead", el("h2", "place", sp.label || "Your spot"), change), el("p", "spotline", spotLine(sp)), editor);
  return wrap;
}

async function showWeather(force = false): Promise<void> {
  status();
  const main = $("main");
  main.replaceChildren();
  const sp = store<Spot | null>("spot", null);
  main.append(placeBlock(sp, () => void showWeather(true)));
  if (!sp) return;
  const alertsBox = el("section", "alerts", el("p", "note", "Checking for alerts\u2026"));
  const wxBox = el("section", "wx", el("p", "empty", "Loading the forecast\u2026"));
  main.append(alertsBox, wxBox);
  WX.failed = false;
  const missed = (ok: boolean): void => { if (!ok) WX.failed = true; };   // tried again when the link is back
  void renderAlerts(sp, alertsBox, force).then(missed);
  void renderForecast(sp, wxBox, force).then(missed);
}
const WX = { failed: false }, TD = { failed: false };

/** Her location: the exact spot if the phone can get it in time (tides need
 *  it), else a rough one. */
function locate(then: () => void): void {
  if (!navigator.geolocation) { toast("this browser cannot share its location"); return; }
  toast("finding your location\u2026");
  const got = (p: GeolocationPosition): void => {
    keep("spot", { lat: p.coords.latitude, lon: p.coords.longitude, label: "Your location", via: "device", t: now() });
    then();
  };
  navigator.geolocation.getCurrentPosition(got, () => navigator.geolocation.getCurrentPosition(got,
    () => toast("location not shared - type a place instead"), { enableHighAccuracy: false, maximumAge: 1800000, timeout: 15000 }),
    { enableHighAccuracy: true, maximumAge: 300000, timeout: 20000 });
}
// ---- tides -------------------------------------------------------------------
// One tile from this site (stations and buoys near you, ~1-3 KB), NOAA's highs
// and lows (~1 KB), and the moon worked out on the phone.
const COOPS = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
// NOAA's predictions are astronomy, fixed far ahead: a saved copy that spans the
// next day is as good as a new one, so most visits ask NOAA nothing at all.
const SPAN = 26 * 3600;
async function predictions(sid: string, force: boolean, reader: string): Promise<{ hilo: Tide[]; error: string }> {
  const t = now();
  const day = new Date((t - 86400) * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const c = store<{ key: string; sid?: string; t: number; h: Tide[] } | null>("tidepred", null);
  const mine = c && Array.isArray(c.h) && c.h.length && (c.sid || String(c.key).slice(0, -8)) === sid ? c : null;
  if (!force && mine && covers(mine.h, t, t + SPAN)) return { hilo: mine.h, error: "" };
  const q = "?product=predictions&application=LowPingNews&begin_date=" + day + "&range=96&datum=MLLW&station=" + sid +
            "&time_zone=gmt&interval=hilo&units=english&format=json";
  let raw: unknown = null;
  try { raw = (await getJSON(COOPS + q)).body; } catch { /* the browser may refuse NOAA (CORS): the reader asks for us */ }
  if (!raw && reader) { try { raw = (await getJSON(reader + "?tide=" + sid + "&d=" + day)).body; } catch { /* offline */ } }
  const p = parsePredictions(raw);
  if (!raw) TD.failed = true;                      // asked again when the phone is back online
  if (p.hilo.length) keep("tidepred", { key: sid + day, sid, t: now(), h: p.hilo });
  else if (mine && covers(mine.h, t, t)) return { hilo: mine.h, error: "" };    // no answer: the last copy, while it covers now
  else if (!raw) return { hilo: [], error: "could not reach NOAA (no connection?)" };
  return p;
}
/** The nearest station NOAA predicts currents for (some list none), with its
 *  max flood, max ebb and slack times: ~1 KB, kept 12 h like the tides. */
async function currentsNear(cands: CurrentStation[], force: boolean, reader: string): Promise<{ st: CurrentStation; f: Flows }> {
  const day = new Date((now() - 86400) * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const key = (s: CurrentStation): string => s.id + "_" + s.bin + "_" + day;
  const c = store<{ key: string; t: number; f: Flows } | null>("curpred", null);
  const kept = c && c.f && Array.isArray(c.f.ev) && c.f.ev.length ? cands.find((s) => String(c.key).startsWith(s.id + "_" + s.bin + "_")) : undefined;
  const t = now();
  if (!force && kept && covers(c!.f.ev, t, t + SPAN)) return { st: kept, f: c!.f };
  let last: Flows = { ev: [], flood: null, ebb: null, error: "no predictions" };
  for (const s of cands) {
    const q = "?product=currents_predictions&application=LowPingNews&begin_date=" + day + "&range=96&station=" + s.id +
              "&bin=" + s.bin + "&time_zone=gmt&interval=MAX_SLACK&units=english&format=json";
    let raw: unknown = null;
    try { raw = (await getJSON(COOPS + q)).body; } catch { /* the browser may refuse NOAA (CORS): the reader asks for us */ }
    if (!raw && reader) { try { raw = (await getJSON(reader + "?cur=" + s.id + "&bin=" + s.bin + "&d=" + day)).body; } catch { /* offline */ } }
    const f = parseCurrents(raw);
    if (f.ev.length) { keep("curpred", { key: key(s), t: now(), f }); return { st: s, f }; }
    if (!raw) { TD.failed = true; break; }   // nobody answered: offline, the next station would fail the same way
    last = f;
  }
  if (kept && covers(c!.f.ev, t, t)) return { st: kept, f: c!.f };   // no answer: the last copy, while it covers now
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
  const sp = store<Spot | null>("spot", null);
  main.append(placeBlock(sp, () => void showTides(true)));
  if (!sp) return;
  const box = el("section", "tides", el("p", "empty", "Loading tides\u2026"));
  main.append(box);
  const t = now();
  TD.failed = false;
  // the stations and buoys for this square: a copy saved in the last half hour
  // is used as it is; an older one only if the site does not answer in time
  const path = "./data/tides/" + tileKey(sp.lat, sp.lon) + ".json";
  const kept = force ? null : await savedSite(path);
  let tile: unknown = kept && kept.age < 1800 ? kept.body : null;
  if (tile === null) {
    try {
      const { r, text } = await fetchT(path);
      tile = r.ok ? JSON.parse(text) : r.status === 404 ? {} : null;
    } catch { /* offline */ }
  }
  if (!box.isConnected) return;
  box.replaceChildren();
  if (tile === null) { TD.failed = true; box.append(el("p", "note warn", "Could not get the station list. Offline?")); }
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
    const waiting = el("p", "empty", "Getting the tide times\u2026");
    box.append(waiting);
    const pr = await predictions(st.id, force, reader);
    if (!box.isConnected) return;
    waiting.remove();
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
    if (!box.isConnected) return;
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
                                         el("span", "dimw nw", dot + mi(b.km) + dot + ago(t - b.t) + " ago")),
                    el("p", "small", bits.join(dot) || "no readings")));
    }
  } else if (nb >= 0) {                     // a real tile: say why the list is empty
    box.append(el("h3", "", "Buoys"), el("p", "note", nb === 0 ? "No buoy readings on the site right now: NDBC did not answer its last build."
                                                              : "No buoy within 62 mi has reported in the last 3 hours."));
  }
  box.append(el("p", "note", "Heights are above NOAA's average lowest tide (MLLW), so a low can read below 0. Windows: when the water is within " +
    HOLD_FT + " ft of each high or low, from NOAA's times, to about 5 min. Wind and pressure can shift real water a foot or more."));
}

async function findPlace(q: string, then: () => void): Promise<void> {
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
    then();
  } catch { toast("offline: could not look the place up"); }
}

interface Cached { t: number; key: string; body: unknown }
type Shown = "" | "updating" | "offline" | "failed";
/** A saved answer at once - if young enough, nothing else is asked - then the
 *  service's own; `draw` runs for each. Asked with time limits, so a stalled
 *  link ends with the saved copy marked as such, never an endless "Loading".
 *  Only an answer that passes `valid` replaces the saved one: a Wi-Fi login
 *  page answers "200 OK" too. Resolves false when the service was not reached. */
async function freshJSON(name: string, key: string, url: string, maxAge: number, force: boolean, alive: () => boolean,
                         valid: (body: unknown) => boolean, draw: (body: unknown, age: number, shown: Shown, status: number) => void,
                         headers?: Record<string, string>): Promise<boolean> {
  const c = store<Cached | null>(name, null);
  const mine = c && c.key === key ? c : null;
  if (!force && mine && now() - mine.t < maxAge) { draw(mine.body, now() - mine.t, "", 200); return true; }
  if (mine) draw(mine.body, now() - mine.t, "updating", 200);
  let r: Awaited<ReturnType<typeof getJSON>> | null = null;
  try { r = await getJSON(url, { headers }); } catch { /* stalled or offline */ }
  if (!alive()) return true;
  if (r && r.ok && valid(r.body)) { keep(name, { t: now(), key, body: r.body }); draw(r.body, 0, "", r.status); return true; }
  // a clear "no" (outside the US, a bad request) is an answer; no answer, a
  // server error or a login page is no connection: tried again when it is back
  const reached = !!r && (r.status === 404 || r.status === 400);
  if (mine) draw(mine.body, now() - mine.t, reached ? "failed" : "offline", 0);
  else draw(null, -1, reached ? "failed" : "offline", r ? r.status : 0);
  return reached;
}
const since = (age: number): string => (age < 60 ? "a moment ago" : ago(age) + " ago");

function renderAlerts(sp: Spot, box: HTMLElement, force: boolean): Promise<boolean> {
  const key = sp.lat.toFixed(4) + "," + sp.lon.toFixed(4);
  return freshJSON("alerts", key, "https://api.weather.gov/alerts/active?point=" + key, 300, force, () => box.isConnected,
                   (body) => liveAlerts(body, now()) !== null, (body, age, shown, st) => drawAlerts(box, body, age, shown, st),
                   { Accept: "application/geo+json" });
}
function drawAlerts(box: HTMLElement, body: unknown, age: number, shown: Shown, status: number): void {
  box.replaceChildren();
  if (status === 404 || status === 400) return;           // outside the US: NOAA does not cover it
  const live = body ? liveAlerts(body, now()) : null;
  if (!live) {
    box.append(shown === "updating" ? el("p", "note", "Checking for alerts\u2026")
      : el("p", "alert unknown", "ALERTS UNKNOWN \u2014 could not reach weather.gov. This is not an all-clear."));
    return;
  }
  if (shown === "updating") box.append(el("p", "note", "Alerts checked " + since(age) + " \u00b7 checking again\u2026"));
  else if (shown) box.append(el("p", "note warn", "Alerts checked " + since(age) + (shown === "offline" ? " (no connection)" : "") + " - may be out of date"));
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

function renderForecast(sp: Spot, box: HTMLElement, force: boolean): Promise<boolean> {
  const key = sp.lat.toFixed(3) + "," + sp.lon.toFixed(3) + (US ? ",f" : ",c");
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + sp.lat.toFixed(4) + "&longitude=" + sp.lon.toFixed(4) +
    "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,is_day" +
    "&hourly=precipitation_probability,temperature_2m&forecast_hours=24" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
    "&forecast_days=7&timezone=auto&timeformat=unixtime" + (US ? "&temperature_unit=fahrenheit&wind_speed_unit=mph" : "");
  return freshJSON("wx", key, url, 1800, force, () => box.isConnected, isForecast, (body, age, shown) => drawForecast(box, body, age, shown));
}
type FullForecast = Required<Pick<Forecast, "current" | "hourly" | "daily">> & Forecast;
function isForecast(b: unknown): b is FullForecast {
  const f = b as Forecast | null;
  return !!f && typeof f === "object" && !!f.current && !!f.daily && !!f.hourly &&
         Array.isArray(f.daily.time) && Array.isArray(f.hourly.time);
}
function drawForecast(box: HTMLElement, body: unknown, age: number, shown: Shown): void {
  box.replaceChildren();
  if (!isForecast(body)) {
    box.append(el("p", "empty", shown === "updating" ? "Loading the forecast\u2026"
      : "No forecast: " + (shown === "offline" ? "no connection" : "the forecast service did not answer") + ", and none saved for this spot."));
    return;
  }
  const f = body;
  const tz = typeof f.timezone === "string" ? f.timezone : undefined;
  if (shown === "updating") box.append(el("p", "note", "Forecast from " + since(age) + " \u00b7 updating\u2026"));
  else if (shown) box.append(el("p", "note warn", "Forecast from " + since(age) + (shown === "offline" ? " (no connection)" : " (could not update)")));
  const u = US ? "°F" : "°C";
  // a reading the service left out stays out: never "Humidity 0%", a calm wind,
  // a dry day or "no rain expected" made up from a missing number
  const num = (x: unknown): number | null => (typeof x === "number" && isFinite(x) ? x : null);
  const deg = (x: number | null): string => (x === null ? "–" : Math.round(x) + "°");
  const c = f.current;
  const w = wmo(c.weather_code, c.is_day !== 0);
  const tNow = num(c.temperature_2m);
  box.append(el("div", "now", el("span", "big", (tNow === null ? "–" : String(Math.round(tNow))) + u), el("span", "icon", w.icon), el("span", "", w.word)));
  const feels = num(c.apparent_temperature), hum = num(c.relative_humidity_2m), wind = num(c.wind_speed_10m), gust = num(c.wind_gusts_10m);
  const bits: string[] = [];
  if (feels !== null) bits.push("Feels like " + Math.round(feels) + "°");
  if (hum !== null) bits.push("Humidity " + Math.round(hum) + "%");
  if (wind !== null) bits.push("Wind " + Math.round(wind) + (US ? " mph" : " km/h") + (gust !== null && gust > wind + 3 ? ", gusts " + Math.round(gust) : ""));
  if (bits.length) box.append(el("p", "small", bits.join(" · ")));
  const n = Date.now() / 1000;
  const sun = [...f.daily.sunrise.map((t) => ["Sunrise", t] as [string, number]), ...f.daily.sunset.map((t) => ["Sunset", t] as [string, number])]
    .filter(([, t]) => num(t) !== null && t > n).sort((a, b) => a[1] - b[1]).slice(0, 2);
  if (sun.length) box.append(el("p", "small", sun.map(([w, t]) => w + " " + clock(t, false, undefined, tz)).join(" · ")));
  // the next 24 hours: rain chance as bars (none where it was not reported), labelled every six hours
  const pr = f.hourly.precipitation_probability.slice(0, 24).map(num);
  const temps = f.hourly.temperature_2m.slice(0, 24).map(num).filter((x): x is number => x !== null);
  const W = 24 * 12, H = 60;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + (H + 16));
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  let peak = -1;
  pr.forEach((p, i) => {
    if (p !== null) {
      if (peak < 0 || p > (pr[peak] as number)) peak = i;
      const h = Math.max(1, (Math.max(0, Math.min(100, p)) / 100) * H);
      const rect = document.createElementNS(svg.namespaceURI, "rect");
      rect.setAttribute("x", String(i * 12 + 1)); rect.setAttribute("width", "10");
      rect.setAttribute("y", String(H - h)); rect.setAttribute("height", String(h));
      svg.append(rect);
    }
    const at = num(f.hourly.time[i]);
    if (i % 6 === 0 && at !== null) {
      const t = document.createElementNS(svg.namespaceURI, "text");
      t.setAttribute("x", String(i * 12 + 1)); t.setAttribute("y", String(H + 13));
      t.textContent = clock(at, true, undefined, tz);
      svg.append(t);
    }
  });
  const top = peak < 0 ? null : pr[peak] as number, all = pr.every((p) => p !== null);
  svg.setAttribute("aria-label", top === null ? "Chance of rain not reported" : "Chance of rain over the next 24 hours, highest " + Math.round(top) + "%");
  box.append(el("h3", "", "Next 24 hours" + (temps.length ? " · " + Math.round(Math.min(...temps)) + "–" + Math.round(Math.max(...temps)) + u : "")), svg,
    // the bars are the chance of rain, under a heading that gives temperatures: the caption says which is which
    el("p", top !== null && top >= 10 ? "rain" : "small",
       top === null ? "Rain chance not reported"
       : top >= 10 ? "Rain chance by hour, highest " + Math.round(top) + "% around " + clock(f.hourly.time[peak], false, undefined, tz)
       : all ? "Rain chance by hour stays under 10%: no rain expected" : "Rain chance by hour under 10% where reported"));
  // seven days: a day the service gave no date for is left out; a missing number shows as a dash
  const mins = f.daily.temperature_2m_min.map(num), maxs = f.daily.temperature_2m_max.map(num);
  const lows = mins.filter((x): x is number => x !== null), highs = maxs.filter((x): x is number => x !== null);
  const lo = Math.min(...lows), hi = Math.max(...highs), span = (hi - lo) || 1;
  const days = el("div", "days");
  f.daily.time.forEach((t, i) => {
    if (num(t) === null) return;
    const dw = wmo(f.daily.weather_code[i]);
    const a = mins[i], b = maxs[i], rain = num(f.daily.precipitation_probability_max[i]);
    const bar = el("span", "range", el("i"));
    const inner = bar.firstChild as HTMLElement;
    if (a !== null && b !== null && isFinite(lo) && isFinite(hi)) {
      inner.style.left = ((a - lo) / span * 100).toFixed(1) + "%";
      inner.style.width = Math.max(4, (b - a) / span * 100).toFixed(1) + "%";
    } else inner.hidden = true;
    days.append(el("div", "day",
      el("span", "d", new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short", timeZone: tz })),
      el("span", "i", dw.icon), el("span", "w", dw.word),
      el("span", "t", deg(a)), bar, el("span", "t", deg(b)),
      el("span", rain !== null && rain >= 10 ? "p wet" : "p", rain === null ? "–" : Math.round(rain) + "%")));
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
  // the app puts her back in the list itself; the browser's own guess would fight it
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  renderTabs();
  // the first view, as go() would show it - but opening the app is not a tap
  // on the tab, which would count as asking for a refresh
  if (S.view === "weather") void showWeather();
  else if (S.view === "tides") void showTides();
  else { renderNews(); void loadNews(S.view); }
  // the phone's back gesture leaves the article, not the app
  window.addEventListener("popstate", () => { if (S.reading) closeReader(); });
  // leaving the app: keep any article text that came; returning: check again
  // if it has been a while, or if the last try found no connection
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") { if (READ.save) READ.save(); return; }
    if (READ.retry) READ.retry();
    if (S.view !== "weather" && S.view !== "tides" && (now() - S.fetched > 15 * 60 || S.offline)) void loadNews(S.view);
  });
  // the phone knows when its connection comes and goes: an article waiting for
  // the rest of its text carries on at once, and a failed view tries again
  window.addEventListener("online", () => {
    if (READ.retry) READ.retry();
    if (S.view === "weather") { if (WX.failed) void showWeather(); }
    else if (S.view === "tides") { if (TD.failed) void showTides(); }
    else void loadNews(S.view);
  });
  window.addEventListener("offline", () => { if (READ.abort) READ.abort(); });   // say so now, not after a time limit
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
