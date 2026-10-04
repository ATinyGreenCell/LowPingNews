import { APP_VERSION, SHOW, parseDigest, parseArticle, staleness, ago, adoptWindow, moreWindow, clock, wmo, placeParts, placeFits, liveAlerts, preprintId, abstractFile, parseAbstractDoc, newerVersion, paperId, moon, tileKey, tideLevel, parseTile, parsePredictions } from "./core.js";
function el(tag, cls, ...kids) {
    const e = document.createElement(tag);
    if (cls)
        e.className = cls;
    for (const k of kids)
        if (k)
            e.append(k);
    return e;
}
const now = () => Date.now() / 1000;
const $ = (id) => document.getElementById(id);
function store(k, fallback) {
    try {
        const v = localStorage.getItem(k);
        return v ? JSON.parse(v) : fallback;
    }
    catch {
        return fallback;
    }
}
function keep(k, v) {
    try {
        localStorage.setItem(k, JSON.stringify(v));
    }
    catch { }
}
const S = {
    view: store("view", "weather"),
    cats: [["top", "Headlines"]],
    digest: null,
    offline: false,
    limit: SHOW,
    shown: [],
    known: new Set(),
    fetched: 0,
    reading: null,
    read: new Set(store("read", [])),
};
function markRead(k) {
    if (S.read.has(k))
        return;
    S.read.add(k);
    keep("read", Array.from(S.read).slice(-3000));
}
function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.hidden = false;
    window.clearTimeout(t._h);
    t._h = window.setTimeout(() => { t.hidden = true; }, 3500);
}
function status() {
    const s = $("status");
    s.className = "status";
    if (S.view === "weather" || S.view === "tides") {
        s.textContent = "";
        return;
    }
    const d = S.digest;
    if (!d) {
        s.textContent = S.offline ? "offline, and nothing saved yet" : "loading\u2026";
        return;
    }
    const st = staleness(d.t, now());
    s.textContent = (S.offline ? "offline \u00b7 saved copy, " : "") + st.text;
    s.classList.add(S.offline || st.level === "stale" ? "bad" : st.level === "aging" ? "warn" : "ok");
}
async function loadNews(cat, manual = false) {
    status();
    let raw = null;
    let offline = false;
    try {
        const r = await fetch("./data/" + encodeURIComponent(cat) + ".json", { cache: "no-cache" });
        offline = r.headers.get("x-lpn-offline") === "1";
        if (r.ok)
            raw = await r.json();
    }
    catch {
        offline = true;
    }
    const d = raw ? parseDigest(raw, now()) : null;
    if (cat !== S.view)
        return;
    S.offline = offline;
    if (!d) {
        status();
        if (manual)
            toast(offline ? "offline: nothing saved for this section" : "could not read the news file");
        renderNews();
        return;
    }
    const same = !!S.digest && S.digest.cat === d.cat;
    const w = adoptWindow(S.shown, S.known, S.limit, d.items, same);
    S.digest = d;
    S.limit = w.limit;
    S.known = new Set(d.items.map((i) => i.key));
    if (d.cats.length)
        S.cats = d.cats;
    S.fetched = now();
    renderTabs();
    renderNews();
    status();
    if (w.fresh)
        toast(w.fresh + " new at the top");
    else if (manual)
        toast(offline ? "offline: showing the saved copy" : "nothing new");
    if (newerVersion(d.app, APP_VERSION))
        showUpdate(d.app);
    else if (d.app === APP_VERSION) {
        mem("lpn-updating", null);
        mem("lpn-hard", null);
    }
}
function mem(k, v) {
    try {
        if (v === undefined)
            return sessionStorage.getItem(k);
        if (v === null)
            sessionStorage.removeItem(k);
        else
            sessionStorage.setItem(k, v);
    }
    catch { }
    return null;
}
let updating = false;
function showUpdate(v) {
    const b = $("update");
    if (!updating)
        b.textContent = "Version " + v + " is ready (you have " + APP_VERSION + "). Tap to update.";
    b.hidden = false;
    const tried = Number(mem("lpn-updating") || 0);
    if (tried && Date.now() - tried < 120000)
        void hardUpdate(b);
}
async function updateNow(b) {
    if (updating)
        return;
    updating = true;
    b.textContent = "Updating\u2026";
    mem("lpn-updating", String(Date.now()));
    const sws = navigator.serviceWorker;
    if (sws) {
        const changed = new Promise((res) => sws.addEventListener("controllerchange", () => res(), { once: true }));
        try {
            const reg = await sws.getRegistration();
            if (reg)
                await reg.update();
        }
        catch { }
        await Promise.race([changed, new Promise((r) => setTimeout(r, 6000))]);
    }
    location.reload();
}
async function hardUpdate(b) {
    if (updating)
        return;
    if (mem("lpn-hard")) {
        b.textContent = "Could not update yet. Close the app fully and open it again.";
        return;
    }
    updating = true;
    mem("lpn-hard", "1");
    b.textContent = "Updating\u2026";
    try {
        for (const k of await caches.keys())
            if (k.startsWith("lpn-shell-"))
                await caches.delete(k);
        if (navigator.serviceWorker)
            for (const r of await navigator.serviceWorker.getRegistrations())
                await r.unregister();
    }
    catch { }
    location.reload();
}
function card(it) {
    const read = S.read.has(it.key);
    const age = it.t ? ago(now() - it.t) : "?";
    const c = el("article", "card" + (read ? " read" : ""), el("div", "meta", (read ? "" : "\u25cf ") + it.src + " \u00b7 " + age), el("h2", "", it.title));
    if (it.summary)
        c.append(el("p", "sum", it.summary));
    if (savedArticle(it.key))
        c.querySelector(".meta").append(" \u00b7 saved");
    c.tabIndex = 0;
    c.setAttribute("role", "button");
    c.onclick = () => openReader(it);
    return c;
}
function renderNews() {
    if (S.reading)
        return;
    const main = $("main");
    main.replaceChildren();
    const d = S.digest;
    if (!d) {
        main.append(el("p", "empty", S.offline ? "Offline, and this section has not been saved yet." : "Loading\u2026"));
        return;
    }
    if (!d.items.length) {
        main.append(el("p", "empty", "No stories in this section right now."));
        return;
    }
    S.shown = d.items.slice(0, S.limit);
    for (const it of S.shown)
        main.append(card(it));
    const left = d.items.length - S.shown.length;
    if (left > 0) {
        const nxt = d.items[Math.min(d.items.length, S.limit + 10) - 1];
        const b = el("button", "more", "Show " + Math.min(10, left) + " more" +
            (nxt.t ? " \u00b7 back to " + ago(now() - nxt.t) + " ago" : ""));
        b.onclick = () => { S.limit = moreWindow(S.limit, d.items.length); renderNews(); };
        main.append(b);
    }
    else {
        const last = S.shown[S.shown.length - 1];
        main.append(el("p", "end", "That is everything for now" + (last.t ? " \u00b7 oldest " + ago(now() - last.t) + " ago" : "")));
    }
    if (d.failed.length) {
        main.append(el("p", "note", "Not updated this time: " + d.failed.map(([n, a]) => n + (a > 0 ? " (copy " + ago(a) + " old)" : "")).join(", ")));
    }
}
function savedArticle(key) { return store("art:" + key, null); }
function saveArticle(key, a) {
    const idx = store("arts", []).filter((k) => k !== key);
    idx.push(key);
    while (idx.length > 40) {
        const old = idx.shift();
        try {
            localStorage.removeItem("art:" + old);
        }
        catch { }
    }
    keep("art:" + key, { t: now(), a });
    keep("arts", idx);
}
function openReader(it, fromHistory = false) {
    S.reading = it;
    markRead(it.key);
    if (!fromHistory)
        history.pushState({ reading: it.key }, "");
    window.scrollTo(0, 0);
    void renderReader(it);
}
function closeReader() {
    if (!S.reading)
        return;
    S.reading = null;
    renderNews();
}
async function renderReader(it, force = false) {
    const main = $("main");
    const back = el("button", "back", "\u2039 Back");
    back.onclick = () => history.back();
    const body = el("div", "body", el("p", "empty", "Getting the text\u2026"));
    main.replaceChildren(back, el("div", "meta", it.src + (it.t ? " \u00b7 " + ago(now() - it.t) + " ago" : "")), el("h1", "headline", it.title), body);
    const show = (a, why, savedAgo) => {
        if (S.reading !== it)
            return;
        body.replaceChildren();
        if (a && a.text) {
            for (const p of a.text.split("\n\n"))
                body.append(el("p", "", p));
            if (!a.complete)
                body.append(el("p", "note warn", a.note || "This may be only part of the article."));
            else if (a.note)
                body.append(el("p", "note", a.note));
            if (savedAgo >= 0)
                body.append(el("p", "note", "Saved on this phone " + (savedAgo < 60 ? "just now" : ago(savedAgo) + " ago")));
        }
        else {
            if (it.summary)
                body.append(el("p", "", it.summary));
            body.append(el("p", "note warn", why));
        }
        if (it.link) {
            const a_ = el("a", "go", "Open the original page \u2197");
            a_.href = it.link;
            a_.target = "_blank";
            a_.rel = "noopener noreferrer";
            body.append(a_, el("p", "note", "The original page is the full website, which usually costs far more data."));
        }
    };
    const saved0 = savedArticle(it.key);
    const saved = saved0 && (saved0.a.complete || !preprintId(it.link)) ? saved0 : null;
    if (!force && saved && saved.a.text && saved.a.complete) {
        show(saved.a, "", now() - saved.t);
        return;
    }
    const reader = S.digest ? S.digest.reader : "";
    if (!it.link) {
        show(null, "This feed gives no link to the full article.", -1);
        return;
    }
    const pre = paperId(it.link);
    if (pre) {
        try {
            const r = await fetch(abstractFile(pre));
            const a = r.ok ? parseAbstractDoc(await r.json(), pre) : null;
            if (a && a.text) {
                saveArticle(it.key, a);
                show(a, "", -1);
                return;
            }
        }
        catch { }
    }
    if (!reader) {
        show(null, "Full-text reading is not set up for this app yet.", -1);
        return;
    }
    try {
        const r = await fetch(reader + "?cat=" + encodeURIComponent(S.view) + "&u=" + encodeURIComponent(it.link));
        let raw = null;
        try {
            raw = await r.json();
        }
        catch { }
        const a = parseArticle(raw);
        if (a.text) {
            saveArticle(it.key, a);
            show(a, "", -1);
        }
        else if (saved && saved.a.text)
            show(saved.a, "", now() - saved.t);
        else
            show(null, "Could not get the text: " + (a.error || "the reader answered " + r.status) + ".", -1);
    }
    catch {
        if (saved && saved.a.text)
            show(saved.a, "", now() - saved.t);
        else
            show(null, "Offline: this article has not been saved yet.", -1);
    }
}
function renderTabs() {
    const nav = $("tabs");
    nav.replaceChildren();
    const all = [["weather", "Weather"], ["tides", "Tides"], ...S.cats];
    for (const [id, name] of all) {
        const b = el("button", id === S.view ? "tab on" : "tab", name);
        b.onclick = () => go(id);
        nav.append(b);
    }
}
function go(view) {
    if (view === S.view && view !== "weather" && view !== "tides") {
        void loadNews(view, true);
        return;
    }
    S.view = view;
    keep("view", view);
    S.digest = null;
    S.limit = SHOW;
    S.shown = [];
    S.known = new Set();
    S.reading = null;
    renderTabs();
    window.scrollTo(0, 0);
    if (view === "weather")
        void showWeather();
    else if (view === "tides")
        void showTides();
    else {
        renderNews();
        void loadNews(view);
    }
}
const US = /-US$/i.test(navigator.language || "") || (navigator.language || "") === "en";
function spotLine(sp) {
    const how = sp.via === "device" ? "your phone's location" : sp.via === "place" ? "set by place name" : sp.via;
    return "For " + sp.lat.toFixed(3) + ", " + sp.lon.toFixed(3) + " (" + how + ", " + ago(now() - sp.t) + " ago)";
}
async function getJSON(url, headers) {
    const r = await fetch(url, { headers, cache: "no-cache" });
    let body = null;
    try {
        body = await r.json();
    }
    catch { }
    return { ok: r.ok, status: r.status, body };
}
async function showWeather(force = false) {
    status();
    const main = $("main");
    main.replaceChildren();
    const sp = store("spot", null);
    const box = el("div", "where");
    const input = el("input");
    input.placeholder = "Town, State (e.g. Huntington, NY)";
    input.autocomplete = "off";
    const find = el("button", "small", "Find");
    const mine = el("button", "small", "Use my location");
    box.append(input, find, mine);
    main.append(box);
    find.onclick = () => void findPlace(input.value);
    input.onkeydown = (e) => { if (e.key === "Enter")
        void findPlace(input.value); };
    mine.onclick = () => locate();
    if (!sp) {
        main.append(el("p", "empty", "Choose a place, or use your location. It is kept on this phone only."));
        return;
    }
    main.append(el("h2", "place", sp.label || "Your spot"), el("p", "note", spotLine(sp)));
    const alertsBox = el("section", "alerts");
    const wxBox = el("section", "wx", el("p", "empty", "Loading the forecast\u2026"));
    main.append(alertsBox, wxBox);
    void renderAlerts(sp, alertsBox, force);
    void renderForecast(sp, wxBox, force);
}
function locate() {
    if (!navigator.geolocation) {
        toast("this browser cannot share its location");
        return;
    }
    toast("asking for your location\u2026");
    navigator.geolocation.getCurrentPosition((p) => {
        keep("spot", { lat: p.coords.latitude, lon: p.coords.longitude, label: "Here", via: "device", t: now() });
        void showWeather(true);
    }, () => toast("location not shared - type a place instead"), { enableHighAccuracy: false, maximumAge: 1800000, timeout: 15000 });
}
const COOPS = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
function locatePrecise() {
    if (!navigator.geolocation) {
        toast("this browser cannot share its location");
        return;
    }
    toast("finding your exact spot\u2026");
    navigator.geolocation.getCurrentPosition((p) => {
        keep("spot", { lat: p.coords.latitude, lon: p.coords.longitude, label: "Here", via: "device", t: now() });
        void showTides(true);
    }, () => toast("location not shared - set a place in Weather instead"), { enableHighAccuracy: true, maximumAge: 300000, timeout: 20000 });
}
async function predictions(sid, force, reader) {
    const day = new Date((now() - 86400) * 1000).toISOString().slice(0, 10).replace(/-/g, "");
    const key = sid + day;
    const c = store("tidepred", null);
    if (!force && c && c.key === key && now() - c.t < 12 * 3600 && Array.isArray(c.h) && c.h.length)
        return { hilo: c.h, error: "" };
    const q = "?product=predictions&application=LowPingNews&begin_date=" + day + "&range=96&datum=MLLW&station=" + sid +
        "&time_zone=gmt&interval=hilo&units=english&format=json";
    let raw = null;
    try {
        raw = (await getJSON(COOPS + q)).body;
    }
    catch { }
    if (!raw && reader) {
        try {
            raw = (await getJSON(reader + "?tide=" + sid + "&d=" + day)).body;
        }
        catch { }
    }
    const p = parsePredictions(raw);
    if (p.hilo.length)
        keep("tidepred", { key, t: now(), h: p.hilo });
    else if (c && c.key === key && c.h && c.h.length)
        return { hilo: c.h, error: "" };
    return p;
}
function dayWord(t) {
    const d = new Date(t * 1000), n = new Date();
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, n))
        return "today";
    if (same(d, new Date(n.getTime() + 86400000)))
        return "tomorrow";
    return d.toLocaleDateString(undefined, { weekday: "short" });
}
function wait(sec) {
    const m = Math.max(0, Math.floor(sec / 60));
    return m < 60 ? m + " min" : Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
}
function tideChart(hilo, t0) {
    const NS = "http://www.w3.org/2000/svg", W = 320, H = 96, pad = 14;
    const pts = [];
    for (let i = 0; i <= 96; i++) {
        const l = tideLevel(hilo, t0 + i * 900);
        if (l)
            pts.push([i / 96, l.level]);
    }
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("class", "tidechart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Water level over the next 24 hours");
    if (pts.length < 2)
        return svg;
    const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
    const x = (f) => f * W, y = (v) => pad + (1 - (v - lo) / ((hi - lo) || 1)) * (H - 2 * pad);
    const line = pts.map((p, i) => (i ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1)).join(" ");
    const area = document.createElementNS(NS, "path");
    area.setAttribute("d", line + " L" + x(pts[pts.length - 1][0]).toFixed(1) + " " + H + " L" + x(pts[0][0]).toFixed(1) + " " + H + " Z");
    area.setAttribute("class", "fill");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", line);
    path.setAttribute("class", "line");
    svg.append(area, path);
    for (const [t, v, k] of hilo) {
        const f = (t - t0) / 86400;
        if (f < 0 || f > 1)
            continue;
        const lab = document.createElementNS(NS, "text");
        lab.setAttribute("x", String(Math.min(W - 30, Math.max(2, x(f) - 16))));
        lab.setAttribute("y", String(k === "H" ? y(v) - 4 : Math.min(H - 2, y(v) + 12)));
        lab.textContent = clock(t, true);
        svg.append(lab);
    }
    return svg;
}
async function showTides(force = false) {
    status();
    const main = $("main");
    main.replaceChildren();
    const mine = el("button", "small", "Use my precise location");
    mine.onclick = () => locatePrecise();
    main.append(el("div", "where", mine));
    const sp = store("spot", null);
    if (!sp) {
        main.append(el("p", "empty", "Tides need your spot: tap above, or set a place in Weather. It is kept on this phone only."));
        return;
    }
    main.append(el("h2", "place", sp.label || "Your spot"), el("p", "note", spotLine(sp)));
    const box = el("section", "tides", el("p", "empty", "Loading tides\u2026"));
    main.append(box);
    const t = now();
    let tile = null;
    try {
        const r = await fetch("./data/tides/" + tileKey(sp.lat, sp.lon) + ".json");
        tile = r.ok ? await r.json() : r.status === 404 ? {} : null;
    }
    catch { }
    if (S.view !== "tides")
        return;
    box.replaceChildren();
    if (tile === null)
        box.append(el("p", "note warn", "Could not get the station list. Offline?"));
    const { stations, buoys, reader } = parseTile(tile || {}, sp.lat, sp.lon, t);
    const mi = (k) => (k >= 1.6 ? Math.round(k / 1.609) + " mi" : "under a mile");
    const st = stations[0];
    if (!st || st.km > 60) {
        if (tile !== null)
            box.append(el("p", "note warn", "No NOAA tide station within 60 km. Predictions cover US coasts and territories."));
    }
    else {
        box.append(el("p", "note", "Station " + st.name + ", " + mi(st.km) + " away (NOAA " + st.id + ")"));
        const pr = await predictions(st.id, force, reader);
        if (S.view !== "tides")
            return;
        if (!pr.hilo.length)
            box.append(el("p", "note warn", "NOAA gave no predictions: " + pr.error));
        else {
            const lv = tideLevel(pr.hilo, t);
            const next = pr.hilo.filter((h) => h[0] > t);
            if (lv && next.length)
                box.append(el("p", "now", "Now " + lv.level.toFixed(1) + " ft and " + (lv.rising ? "rising" : "falling") +
                    " \u00b7 " + (next[0][2] === "H" ? "high" : "low") + " tide in " + wait(next[0][0] - t)));
            const list = el("div", "tidelist");
            for (const [tt, v, k] of next.slice(0, 4))
                list.append(el("div", k === "H" ? "trow hi" : "trow", el("span", "k", k === "H" ? "High" : "Low"), el("span", "c", clock(tt)), el("span", "v", v.toFixed(1) + " ft"), el("span", "w", tt - t < 12 * 3600 ? "in " + wait(tt - t) : dayWord(tt))));
            box.append(list);
            const win = pr.hilo.filter((h) => h[0] >= t && h[0] <= t + 86400);
            if (win.length) {
                const top = win.reduce((a, b) => (b[1] > a[1] ? b : a)), bot = win.reduce((a, b) => (b[1] < a[1] ? b : a));
                box.append(el("p", "", "Water highest " + clock(top[0]) + " " + dayWord(top[0]) + ", " + top[1].toFixed(1) + " ft: least shore showing"), el("p", "", "Water lowest " + clock(bot[0]) + " " + dayWord(bot[0]) + ", " + bot[1].toFixed(1) + " ft: most shore showing"), tideChart(pr.hilo, t), el("p", "note", "Next 24 hours, from now"));
            }
        }
    }
    const mo = moon(t);
    const md = (x) => new Date(x * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const ev = [[mo.next, "new"], [mo.full, "full"]].sort((a, b) => a[0] - b[0]);
    box.append(el("p", "", "Moon: " + mo.name + ", " + Math.round(mo.lit * 100) + "% lit \u00b7 " +
        ev.map(([x, w]) => w + " " + md(x)).join(", ") +
        (mo.tide === "spring" ? " \u00b7 spring tides: higher highs, lower lows" : mo.tide === "neap" ? " \u00b7 neap tides: a smaller range than usual" : "")));
    const near = buoys.filter((b) => b.km <= 100).slice(0, 2);
    if (near.length) {
        box.append(el("h3", "", "Buoys"));
        const deg = (c) => (US ? Math.round(c * 9 / 5 + 32) + "\u00b0F" : Math.round(c) + "\u00b0C");
        const cmp = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
        for (const b of near) {
            const bits = [];
            if (b.water !== null)
                bits.push("water " + deg(b.water));
            if (b.waves !== null)
                bits.push("waves " + (b.waves * 3.281).toFixed(1) + " ft" + (b.period ? " every " + Math.round(b.period) + " s" : ""));
            if (b.wind !== null)
                bits.push("wind " + (b.dir !== null ? cmp[Math.floor((b.dir + 22.5) / 45) % 8] + " " : "") + Math.round(b.wind * 1.944) + " kt");
            if (b.air !== null)
                bits.push("air " + deg(b.air));
            box.append(el("p", "", b.id + " " + (b.name || "buoy") + ", " + mi(b.km) + ": " + (bits.join(", ") || "no readings") +
                " \u00b7 " + ago(t - b.t) + " ago"));
        }
    }
    box.append(el("p", "note", "Predictions, not observations: wind and pressure can shift the water by a foot or more."));
}
async function findPlace(q) {
    var _a;
    const { town, quals } = placeParts(q);
    if (town.length < 2) {
        toast("type a town name");
        return;
    }
    try {
        const r = await getJSON("https://geocoding-api.open-meteo.com/v1/search?count=" + (quals.length ? 20 : 5) +
            "&language=en&format=json&name=" + encodeURIComponent(town));
        const res = (((_a = r.body) === null || _a === void 0 ? void 0 : _a.results) || []);
        const hits = res.filter((x) => typeof x.latitude === "number" && typeof x.longitude === "number" &&
            (!quals.length || placeFits(x, quals)));
        if (!hits.length) {
            toast("no place matched" + (quals.length ? " in that region" : ""));
            return;
        }
        const h = hits[0];
        const label = [h.name, h.admin1, h.country_code].filter((x) => typeof x === "string" && x).join(", ");
        keep("spot", { lat: h.latitude, lon: h.longitude, label, via: "place", t: now() });
        if (hits.length > 1)
            toast("chose " + label + " (" + (hits.length - 1) + " other matches)");
        void showWeather(true);
    }
    catch {
        toast("offline: could not look the place up");
    }
}
async function cachedJSON(name, key, url, maxAge, force, headers) {
    const c = store(name, null);
    if (!force && c && c.key === key && now() - c.t < maxAge)
        return { body: c.body, age: now() - c.t, fresh: true, status: 200 };
    try {
        const r = await getJSON(url, headers);
        if (r.ok) {
            keep(name, { t: now(), key, body: r.body });
            return { body: r.body, age: 0, fresh: true, status: r.status };
        }
        return { body: null, age: -1, fresh: false, status: r.status };
    }
    catch {
        if (c && c.key === key)
            return { body: c.body, age: now() - c.t, fresh: false, status: 0 };
        return { body: null, age: -1, fresh: false, status: 0 };
    }
}
async function renderAlerts(sp, box, force) {
    const key = sp.lat.toFixed(4) + "," + sp.lon.toFixed(4);
    const r = await cachedJSON("alerts", key, "https://api.weather.gov/alerts/active?point=" + key, 300, force, { Accept: "application/geo+json" });
    box.replaceChildren();
    if (r.status === 404 || r.status === 400)
        return;
    const live = r.body ? liveAlerts(r.body, now()) : null;
    if (!live) {
        box.append(el("p", "alert unknown", "ALERTS UNKNOWN \u2014 could not reach weather.gov. This is not an all-clear."));
        return;
    }
    if (!r.fresh)
        box.append(el("p", "note warn", "Alerts checked " + ago(r.age) + " ago (offline) - may be out of date"));
    if (!live.alerts.length) {
        box.append(el("p", "ok", "\u2713 No NOAA alerts for this spot"));
        return;
    }
    for (const a of live.alerts) {
        const sev = a.severity === "Extreme" || a.severity === "Severe" ? "alert severe" : "alert";
        const card_ = el("details", sev, el("summary", "", "\u26a0\ufe0f " + a.event + (a.ends ? " \u00b7 until " + new Date(a.ends * 1000).toLocaleDateString(undefined, { weekday: "short" })
            + " " + clock(a.ends) : "")));
        if (a.headline)
            card_.append(el("p", "", a.headline));
        for (const para of a.description.split("\n\n"))
            card_.append(el("p", "small", para));
        if (a.instruction)
            card_.append(el("p", "todo", "What to do: " + a.instruction));
        if (a.severity === "Extreme" || a.severity === "Severe")
            card_.open = true;
        box.append(card_);
    }
}
async function renderForecast(sp, box, force) {
    const key = sp.lat.toFixed(3) + "," + sp.lon.toFixed(3) + (US ? ",f" : ",c");
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + sp.lat.toFixed(4) + "&longitude=" + sp.lon.toFixed(4) +
        "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,is_day" +
        "&hourly=precipitation_probability,temperature_2m&forecast_hours=24" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
        "&forecast_days=7&timezone=auto&timeformat=unixtime" + (US ? "&temperature_unit=fahrenheit&wind_speed_unit=mph" : "");
    const r = await cachedJSON("wx", key, url, 1800, force);
    box.replaceChildren();
    const f = r.body;
    if (!f || !f.current || !f.daily || !f.hourly) {
        box.append(el("p", "empty", "No forecast: offline, and none saved for this spot."));
        return;
    }
    const tz = typeof f.timezone === "string" ? f.timezone : undefined;
    if (!r.fresh)
        box.append(el("p", "note warn", "Forecast from " + ago(r.age) + " ago (offline)"));
    const u = US ? "\u00b0F" : "\u00b0C";
    const c = f.current;
    const w = wmo(c.weather_code, c.is_day !== 0);
    box.append(el("div", "now", el("span", "big", Math.round(c.temperature_2m) + u), el("span", "icon", w.icon), el("span", "", w.word)), el("p", "small", "Feels like " + Math.round(c.apparent_temperature) + "\u00b0 \u00b7 Humidity " + Math.round(c.relative_humidity_2m) +
        "% \u00b7 Wind " + Math.round(c.wind_speed_10m) + (US ? " mph" : " km/h") +
        (c.wind_gusts_10m > c.wind_speed_10m + 3 ? ", gusts " + Math.round(c.wind_gusts_10m) : "")));
    const n = Date.now() / 1000;
    const sun = [...f.daily.sunrise.map((t) => ["Sunrise", t]), ...f.daily.sunset.map((t) => ["Sunset", t])]
        .filter(([, t]) => t > n).sort((a, b) => a[1] - b[1])[0];
    if (sun)
        box.append(el("p", "small", sun[0] + " " + clock(sun[1], false, undefined, tz)));
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
        rect.setAttribute("x", String(i * 12 + 1));
        rect.setAttribute("width", "10");
        rect.setAttribute("y", String(H - h));
        rect.setAttribute("height", String(h));
        svg.append(rect);
        if (i % 6 === 0) {
            const t = document.createElementNS(svg.namespaceURI, "text");
            t.setAttribute("x", String(i * 12 + 1));
            t.setAttribute("y", String(H + 13));
            t.textContent = clock(f.hourly.time[i], true, undefined, tz);
            svg.append(t);
        }
    });
    const peak = pr.reduce((b, p, i) => (p > pr[b] ? i : b), 0);
    svg.setAttribute("aria-label", "Chance of rain over the next 24 hours, highest " + (pr[peak] || 0) + "%");
    box.append(el("h3", "", "Next 24 hours \u00b7 " + Math.round(Math.min(...temps)) + "\u2013" + Math.round(Math.max(...temps)) + u), svg, el("p", (pr[peak] || 0) >= 10 ? "rain" : "small", (pr[peak] || 0) >= 10
        ? "Rain " + pr[peak] + "% around " + clock(f.hourly.time[peak], false, undefined, tz) : "No rain expected"));
    const lo = Math.min(...f.daily.temperature_2m_min), hi = Math.max(...f.daily.temperature_2m_max), span = (hi - lo) || 1;
    const days = el("div", "days");
    f.daily.time.forEach((t, i) => {
        const dw = wmo(f.daily.weather_code[i]);
        const a = f.daily.temperature_2m_min[i], b = f.daily.temperature_2m_max[i];
        const bar = el("span", "range", el("i"));
        const inner = bar.firstChild;
        inner.style.left = ((a - lo) / span * 100).toFixed(1) + "%";
        inner.style.width = Math.max(4, (b - a) / span * 100).toFixed(1) + "%";
        days.append(el("div", "day", el("span", "d", new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short", timeZone: tz })), el("span", "i", dw.icon), el("span", "w", dw.word), el("span", "t", Math.round(a) + "\u00b0"), bar, el("span", "t", Math.round(b) + "\u00b0"), el("span", (f.daily.precipitation_probability_max[i] || 0) >= 10 ? "p wet" : "p", (f.daily.precipitation_probability_max[i] || 0) + "%")));
    });
    box.append(el("h3", "", "7 days"), days);
}
function start() {
    $("refresh").onclick = () => {
        if (S.view === "weather")
            void showWeather(true);
        else if (S.view === "tides")
            void showTides(true);
        else if (S.reading)
            void renderReader(S.reading, true);
        else
            void loadNews(S.view, true);
    };
    $("update").onclick = () => void updateNow($("update"));
    $("ver").textContent = "v" + APP_VERSION;
    renderTabs();
    go(S.view === "weather" ? "weather" : S.view);
    window.addEventListener("popstate", () => { if (S.reading)
        closeReader(); });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && S.view !== "weather" && S.view !== "tides" && now() - S.fetched > 15 * 60)
            void loadNews(S.view);
    });
    window.addEventListener("online", () => { if (S.view !== "weather" && S.view !== "tides")
        void loadNews(S.view); });
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone = navigator.standalone === true ||
        matchMedia("(display-mode: standalone)").matches;
    if (ios && !standalone && !store("hinted", false)) {
        const h = $("hint");
        h.hidden = false;
        h.onclick = () => { h.hidden = true; keep("hinted", true); };
    }
    if ("serviceWorker" in navigator)
        navigator.serviceWorker.register("./sw.js").catch(() => { });
}
start();
