import { APP_VERSION, SHOW, parseDigest, staleness, ago, adoptWindow, moreWindow, clock, wmo, placeParts, placeFits, liveAlerts, } from "./core.js";
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
    view: store("view", "top"),
    cats: [["top", "Headlines"]],
    digest: null,
    offline: false,
    limit: SHOW,
    shown: [],
    known: new Set(),
    fetched: 0,
    open: "",
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
    if (S.view === "weather") {
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
    if (d.app && d.app !== APP_VERSION)
        $("update").hidden = false;
}
function card(it) {
    const read = S.read.has(it.key);
    const age = it.t ? ago(now() - it.t) : "?";
    const c = el("article", "card" + (read ? " read" : ""), el("div", "meta", (read ? "" : "\u25cf ") + it.src + " \u00b7 " + age), el("h2", "", it.title));
    const open = S.open === it.key;
    if (it.summary)
        c.append(el("p", open ? "sum full" : "sum", it.summary));
    if (open && it.link) {
        const a = el("a", "go", "Open article \u2197");
        a.href = it.link;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        c.append(a);
    }
    c.tabIndex = 0;
    c.setAttribute("role", "button");
    c.onclick = (e) => {
        if (e.target.tagName === "A") {
            markRead(it.key);
            return;
        }
        S.open = open ? "" : it.key;
        markRead(it.key);
        renderNews();
    };
    return c;
}
function renderNews() {
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
function renderTabs() {
    const nav = $("tabs");
    nav.replaceChildren();
    const all = [...S.cats, ["weather", "Weather"]];
    for (const [id, name] of all) {
        const b = el("button", id === S.view ? "tab on" : "tab", name);
        b.onclick = () => go(id);
        nav.append(b);
    }
}
function go(view) {
    if (view === S.view && view !== "weather") {
        void loadNews(view, true);
        return;
    }
    S.view = view;
    keep("view", view);
    S.digest = null;
    S.limit = SHOW;
    S.shown = [];
    S.known = new Set();
    S.open = "";
    renderTabs();
    window.scrollTo(0, 0);
    if (view === "weather")
        void showWeather();
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
    $("refresh").onclick = () => { if (S.view === "weather")
        void showWeather(true);
    else
        void loadNews(S.view, true); };
    $("update").onclick = () => location.reload();
    renderTabs();
    go(S.view === "weather" ? "weather" : S.view);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && S.view !== "weather" && now() - S.fetched > 15 * 60)
            void loadNews(S.view);
    });
    window.addEventListener("online", () => { if (S.view !== "weather")
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
