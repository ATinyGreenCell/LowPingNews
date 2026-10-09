export const APP_VERSION = "9.7";
export const SHOW = 10;
export const MORE = 10;
const ANSI = /(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]{0,2000}(?:\x07|\x1b\\|\x9c)?|\x1b[@-Z\\\-_]/g;
const CTRL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu;
export function cut(s, n) {
    if (s.length <= n)
        return s;
    const c = s.charCodeAt(n - 1);
    return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}
export function cleanParas(v, max) {
    if (typeof v !== "string")
        return "";
    return cut(v.split(/\n\s*\n/).map((p) => cleanText(p, max)).filter(Boolean).join("\n\n"), max);
}
export function cleanText(v, max) {
    if (typeof v !== "string")
        return "";
    return cut(v.replace(ANSI, "").replace(CTRL, " ").replace(/\s+/g, " ").trim(), max);
}
export function safeUrl(v) {
    if (typeof v !== "string" || v.length > 2000)
        return "";
    let u;
    try {
        u = new URL(v);
    }
    catch {
        return "";
    }
    if (u.protocol !== "https:" && u.protocol !== "http:")
        return "";
    if (u.username || u.password)
        return "";
    return u.href;
}
export function storyKey(title) {
    return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 120);
}
export function parseDigest(raw, now) {
    if (!raw || typeof raw !== "object")
        return null;
    const d = raw;
    if (d.v !== 1 || typeof d.t !== "number" || !isFinite(d.t) || d.t <= 0)
        return null;
    if (!Array.isArray(d.items) || !Array.isArray(d.src))
        return null;
    const src = d.src.map((s) => cleanText(s, 60));
    const items = [];
    const seen = new Set();
    for (const r of d.items.slice(0, 200)) {
        if (!Array.isArray(r) || r.length < 5)
            continue;
        const [si, ti, su, li, t] = r;
        if (typeof si !== "number" || !Number.isInteger(si) || si < 0 || si >= src.length)
            continue;
        const title = cleanText(ti, 300);
        if (!title)
            continue;
        const key = storyKey(title);
        if (seen.has(key))
            continue;
        seen.add(key);
        let when = typeof t === "number" && isFinite(t) && t > 0 ? Math.floor(t) : 0;
        if (when > now + 600)
            when = 0;
        items.push({ src: src[si] || "?", title, summary: cleanText(su, 400), link: safeUrl(li), t: when, key });
    }
    const cats = [];
    if (Array.isArray(d.cats)) {
        for (const c of d.cats.slice(0, 20)) {
            if (Array.isArray(c) && typeof c[0] === "string" && /^[a-z0-9_-]{1,24}$/.test(c[0])) {
                cats.push([c[0], cleanText(c[1], 40) || c[0]]);
            }
        }
    }
    const failed = [];
    if (Array.isArray(d.failed)) {
        for (const f of d.failed.slice(0, 50)) {
            if (Array.isArray(f) && typeof f[0] === "string") {
                failed.push([cleanText(f[0], 60), typeof f[1] === "number" && isFinite(f[1]) ? f[1] : -1]);
            }
        }
    }
    const reader = safeUrl(d.reader);
    return { t: d.t, app: cleanText(d.app, 12), cat: cleanText(d.cat, 24), cats, items, failed,
        reader: reader.startsWith("https://") ? reader : "" };
}
export function parseArticle(raw) {
    const d = (raw && typeof raw === "object" ? raw : {});
    const text = typeof d.text === "string" ? d.text.split("\n\n").map((p) => cleanText(p, 6000)).filter(Boolean).join("\n\n").slice(0, 200000) : "";
    return { text, complete: d.complete === true, note: cleanText(d.note, 200), error: cleanText(d.error, 200) };
}
const PREPRINT = /^https?:\/\/(?:www\.|connect\.)?(biorxiv|medrxiv)\.org\/(?:content\/(?:early\/\d{4}\/\d{2}\/\d{2}\/)?|cgi\/content\/(?:short|abstract|full)\/)(?:10\.1101\/)?(\d{4}\.\d{2}\.\d{2}\.\d{5,8}|\d{6})(?:v\d+)?/i;
export function preprintId(link) {
    const m = PREPRINT.exec(link || "");
    return m ? { server: m[1].toLowerCase(), id: m[2] } : null;
}
const PUBMED = /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,9})\/?(?:[?#].*)?$/i;
export function paperId(link) {
    const p = preprintId(link);
    if (p)
        return p;
    const m = PUBMED.exec(link || "");
    return m ? { server: "pubmed", id: m[1] } : null;
}
export function abstractFile(p) {
    return "./data/abs/" + p.server + "-" + p.id + ".json";
}
const authorsShort = (a) => {
    const names = a.split(/;\s*/).map((x) => x.trim()).filter(Boolean);
    return names.length > 3 ? names.slice(0, 3).join("; ") + " and " + (names.length - 3) + " more" : names.join("; ");
};
export function parseAbstractDoc(raw, want) {
    const none = { text: "", complete: false, note: "", error: "no abstract" };
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return none;
    const d = raw;
    if (want && (d.server !== want.server ||
        (want.server === "pubmed" ? d.pmid !== want.id : d.doi !== "10.1101/" + want.id)))
        return none;
    const str = (k) => cleanText(d[k], 600);
    const abs = cleanParas(d.abstract, 8000);
    if (!abs)
        return none;
    const cat = str("category");
    const meta = [authorsShort(str("authors")), str("journal"), cat && cat[0].toUpperCase() + cat.slice(1),
        str("date") && (d.server === "pubmed" ? "published " : "posted ") + str("date"),
        str("version") && "version " + str("version")].filter(Boolean).join(" \u00b7 ");
    const paras = [meta, abs].filter(Boolean);
    const pub = str("published");
    if (pub && pub !== "NA" && /^10\.\S+$/.test(pub))
        paras.push("Since published: https://doi.org/" + pub);
    const host = d.server === "medrxiv" ? "medRxiv" : d.server === "pubmed" ? "the journal's site (PubMed links to it)" : "bioRxiv";
    return { text: paras.join("\n\n"), complete: true, error: "",
        note: "This is the abstract. The full paper is on " + host + ": open the original page." };
}
export function newerVersion(a, b) {
    if (typeof a !== "string" || !/^\d+(\.\d+)*$/.test(a) || !/^\d+(\.\d+)*$/.test(b))
        return false;
    const x = a.split(".").map(Number), y = b.split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d)
            return d > 0;
    }
    return false;
}
export function ago(sec) {
    if (!isFinite(sec) || sec < 0)
        return "?";
    if (sec < 60)
        return "just now";
    if (sec < 3600)
        return Math.floor(sec / 60) + "m";
    if (sec < 86400)
        return Math.floor(sec / 3600) + "h";
    return Math.floor(sec / 86400) + "d";
}
export function staleness(t, now) {
    if (!t || t > now + 600)
        return { level: "unknown", text: "update time unknown" };
    const age = now - t;
    if (age < 45 * 60)
        return { level: "fresh", text: "updated " + (age < 60 ? "just now" : ago(age) + " ago") };
    if (age < 3 * 3600)
        return { level: "aging", text: "updated " + ago(age) + " ago" };
    return { level: "stale", text: "news is " + ago(age) + " old - updates may have stopped" };
}
export function adoptWindow(shown, known, limit, next, sameCat, start = SHOW) {
    if (!sameCat || !shown.length)
        return { limit: Math.max(1, start), fresh: 0 };
    let lim = limit;
    const oldest = shown[shown.length - 1].key;
    const at = next.findIndex((it) => it.key === oldest);
    if (at >= 0)
        lim = Math.max(lim, at + 1);
    const fresh = known.size ? next.slice(0, lim).filter((it) => !known.has(it.key)).length : 0;
    return { limit: Math.max(1, lim), fresh };
}
export function moreWindow(limit, total) {
    return Math.min(total, limit + MORE);
}
export function clock(epoch, compact = false, locale, timeZone) {
    const d = new Date(epoch * 1000);
    const opt = compact ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" };
    if (timeZone)
        opt.timeZone = timeZone;
    const s = d.toLocaleTimeString(locale, opt);
    if (!compact)
        return s;
    const m = /^(\d{1,2})\s*([AaPp])\.?\s*[Mm]\.?$/.exec(s.replace(/\u202f|\u00a0/g, " ").trim());
    return m ? m[1] + m[2].toLowerCase() : s.replace(/\D/g, "").slice(0, 2);
}
const WMO = {
    0: ["Clear", "\u2600\ufe0f"], 1: ["Mostly Clear", "\ud83c\udf24\ufe0f"], 2: ["Partly Cloudy", "\u26c5"],
    3: ["Overcast", "\u2601\ufe0f"], 45: ["Fog", "\ud83c\udf2b\ufe0f"], 48: ["Freezing Fog", "\ud83c\udf2b\ufe0f"],
    51: ["Light Drizzle", "\ud83c\udf26\ufe0f"], 53: ["Drizzle", "\ud83c\udf26\ufe0f"], 55: ["Heavy Drizzle", "\ud83c\udf27\ufe0f"],
    56: ["Icy Drizzle", "\ud83c\udf27\ufe0f"], 57: ["Icy Drizzle", "\ud83c\udf27\ufe0f"], 61: ["Light Rain", "\ud83c\udf26\ufe0f"],
    63: ["Rain", "\ud83c\udf27\ufe0f"], 65: ["Heavy Rain", "\ud83c\udf27\ufe0f"], 66: ["Freezing Rain", "\ud83c\udf27\ufe0f"],
    67: ["Freezing Rain", "\ud83c\udf27\ufe0f"], 71: ["Light Snow", "\ud83c\udf28\ufe0f"], 73: ["Snow", "\ud83c\udf28\ufe0f"],
    75: ["Heavy Snow", "\u2744\ufe0f"], 77: ["Snow Grains", "\ud83c\udf28\ufe0f"], 80: ["Light Showers", "\ud83c\udf26\ufe0f"],
    81: ["Showers", "\ud83c\udf27\ufe0f"], 82: ["Heavy Showers", "\ud83c\udf27\ufe0f"], 85: ["Snow Showers", "\ud83c\udf28\ufe0f"],
    86: ["Heavy Snowfall", "\u2744\ufe0f"], 95: ["Thunderstorm", "\u26c8\ufe0f"], 96: ["Thunder & Hail", "\u26c8\ufe0f"],
    99: ["Thunder & Hail", "\u26c8\ufe0f"],
};
export function wmo(code, day = true) {
    const c = typeof code === "number" ? code : -1;
    const w = WMO[c] || ["Unknown", "\u2754"];
    if (!day && (c === 0 || c === 1))
        return { word: w[0], icon: "\ud83c\udf19" };
    return { word: w[0], icon: w[1] };
}
const US_STATES = Object.fromEntries(("AL Alabama|AK Alaska|AZ Arizona|AR Arkansas|CA California|CO Colorado|CT Connecticut|DE Delaware|" +
    "DC District of Columbia|FL Florida|GA Georgia|HI Hawaii|ID Idaho|IL Illinois|IN Indiana|IA Iowa|" +
    "KS Kansas|KY Kentucky|LA Louisiana|ME Maine|MD Maryland|MA Massachusetts|MI Michigan|MN Minnesota|" +
    "MS Mississippi|MO Missouri|MT Montana|NE Nebraska|NV Nevada|NH New Hampshire|NJ New Jersey|" +
    "NM New Mexico|NY New York|NC North Carolina|ND North Dakota|OH Ohio|OK Oklahoma|OR Oregon|" +
    "PA Pennsylvania|RI Rhode Island|SC South Carolina|SD South Dakota|TN Tennessee|TX Texas|UT Utah|" +
    "VT Vermont|VA Virginia|WA Washington|WV West Virginia|WI Wisconsin|WY Wyoming|PR Puerto Rico").split("|").map((p) => [p.slice(0, 2), p.slice(3)]));
export function placeParts(q) {
    const parts = q.split(",").map((p) => p.trim()).filter(Boolean);
    if (!parts.length)
        return { town: "", quals: [] };
    const quals = parts.slice(1).map((p) => {
        const alts = [p.toLowerCase()];
        const st = US_STATES[p.toUpperCase()];
        if (st)
            alts.push(st.toLowerCase());
        return alts;
    });
    return { town: parts[0].slice(0, 80), quals };
}
export function placeFits(r, quals) {
    const fields = ["admin1", "admin2", "admin3", "country", "country_code"]
        .map((k) => (typeof r[k] === "string" ? r[k].toLowerCase() : "")).filter(Boolean);
    return quals.every((alts) => alts.some((a) => fields.some((f) => a === f || f === a + " county" || a === f + " county")));
}
const SEV = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
export function liveAlerts(raw, now) {
    var _a;
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.features))
        return null;
    const out = [];
    let expired = 0;
    for (const f of (raw.features).slice(0, 60)) {
        const p = (f && typeof f === "object" ? f.properties : null);
        if (!p || ((_a = p.status) !== null && _a !== void 0 ? _a : "Actual") !== "Actual" || p.messageType === "Cancel")
            continue;
        const endS = cleanText(p.ends, 40) || cleanText(p.expires, 40);
        const end = endS ? Date.parse(endS) / 1000 : 0;
        if (end && end < now) {
            expired++;
            continue;
        }
        out.push({ event: cleanText(p.event, 80) || "Alert", severity: cleanText(p.severity, 20) || "Unknown",
            urgency: cleanText(p.urgency, 20), headline: cleanText(p.headline, 300), ends: end || 0,
            description: cleanParas(p.description, 4000), instruction: cleanParas(p.instruction, 2000) });
    }
    out.sort((a, b) => { var _a, _b; return ((_a = SEV[a.severity]) !== null && _a !== void 0 ? _a : 5) - ((_b = SEV[b.severity]) !== null && _b !== void 0 ? _b : 5); });
    return { alerts: out, expired };
}
const SYNODIC = 29.530588853;
const NEW_MOON0 = 947182440;
export function moon(t) {
    const age = (((t - NEW_MOON0) / 86400) % SYNODIC + SYNODIC) % SYNODIC;
    const lit = (1 - Math.cos(2 * Math.PI * age / SYNODIC)) / 2;
    const names = [[1, "New moon"], [6.4, "Waxing crescent"], [8.4, "First quarter"], [13.8, "Waxing gibbous"],
        [15.8, "Full moon"], [21.1, "Waning gibbous"], [23.1, "Last quarter"], [28.5, "Waning crescent"], [99, "New moon"]];
    const name = names.find(([lim]) => age < lim)[1];
    const near = (x) => Math.min(Math.abs(age - x), SYNODIC - Math.abs(age - x));
    const half = SYNODIC / 2;
    const tide = Math.min(near(0), near(half)) <= 2 ? "spring" : Math.min(near(SYNODIC / 4), near(3 * SYNODIC / 4)) <= 2 ? "neap" : "";
    return { name, lit, age, tide, full: t + (((half - age) % SYNODIC + SYNODIC) % SYNODIC) * 86400,
        next: t + (((SYNODIC - age) % SYNODIC + SYNODIC) % SYNODIC) * 86400 };
}
export function kmBetween(a1, o1, a2, o2) {
    const p = Math.PI / 180;
    const h = Math.sin((a2 - a1) * p / 2) ** 2 + Math.cos(a1 * p) * Math.cos(a2 * p) * Math.sin((o2 - o1) * p / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function tileKey(lat, lon) { return Math.floor(lat) + "_" + Math.floor(lon); }
export function tideLevel(hilo, t) {
    for (let i = 0; i + 1 < hilo.length; i++) {
        const [t0, v0] = hilo[i], [t1, v1] = hilo[i + 1];
        if (t0 <= t && t <= t1 && t1 > t0) {
            const f = (1 - Math.cos(Math.PI * (t - t0) / (t1 - t0))) / 2;
            return { level: v0 + (v1 - v0) * f, rising: v1 > v0 };
        }
    }
    return null;
}
const num = (x) => (typeof x === "number" && isFinite(x) ? x : null);
export function parseTile(raw, lat, lon, now) {
    const d = raw && typeof raw === "object" ? raw : {};
    const rows = (k) => (Array.isArray(d[k]) ? d[k].filter(Array.isArray) : []);
    const stations = [];
    for (const r of rows("s")) {
        const a = num(r[2]), o = num(r[3]);
        if (a === null || o === null || typeof r[0] !== "string" || !/^[0-9A-Z]{5,10}$/.test(r[0]))
            continue;
        stations.push({ id: r[0], name: cleanText(r[1], 60), km: kmBetween(lat, lon, a, o) });
    }
    const buoys = [];
    for (const r of rows("b")) {
        const a = num(r[2]), o = num(r[3]), t = num(r[4]);
        if (a === null || o === null || t === null || now - t > 3 * 3600 || typeof r[0] !== "string")
            continue;
        buoys.push({ id: cleanText(r[0], 10), name: cleanText(r[1], 50), km: kmBetween(lat, lon, a, o), t,
            water: num(r[5]), waves: num(r[6]), period: num(r[7]), dir: num(r[8]), wind: num(r[9]), air: num(r[11]) });
    }
    const currents = [];
    for (const r of rows("c")) {
        const a = num(r[2]), o = num(r[3]), b = num(r[4]);
        if (a === null || o === null || b === null || !Number.isInteger(b) || b < 0 || b > 99 ||
            typeof r[0] !== "string" || !/^[0-9A-Za-z]{4,12}$/.test(r[0]))
            continue;
        currents.push({ id: r[0], name: cleanText(r[1], 60), km: kmBetween(lat, lon, a, o), bin: b });
    }
    stations.sort((x, y) => x.km - y.km);
    buoys.sort((x, y) => x.km - y.km);
    currents.sort((x, y) => x.km - y.km);
    const reader = safeUrl(d.reader), nb = num(d.nb);
    return { stations, buoys, currents, nb: nb !== null && nb >= 0 ? nb : -1, reader: reader.startsWith("https://") ? reader : "" };
}
export function compass(deg) {
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.floor(((deg % 360) + 360 + 22.5) / 45) % 8];
}
export function parseCurrents(raw) {
    const d = raw && typeof raw === "object" ? raw : {};
    if (d.error && typeof d.error === "object")
        return { ev: [], flood: null, ebb: null, error: cleanText(d.error.message, 160) || "no predictions" };
    const box = d.current_predictions && typeof d.current_predictions === "object" ? d.current_predictions : {};
    const deg = (x) => (typeof x === "number" && isFinite(x) && x >= 0 && x <= 360 ? x : null);
    const ev = [];
    let flood = null, ebb = null;
    for (const x of Array.isArray(box.cp) ? box.cp : []) {
        if (!x || typeof x !== "object")
            continue;
        const m = typeof x.Time === "string" ? /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/.exec(x.Time) : null;
        const v = typeof x.Velocity_Major === "number" ? x.Velocity_Major : parseFloat(String(x.Velocity_Major));
        if (!m || !isFinite(v) || Math.abs(v) >= 15)
            continue;
        const ty = String(x.Type).toLowerCase();
        const k = ty === "slack" ? "S" : ty === "flood" ? "F" : ty === "ebb" ? "E" : Math.abs(v) < 0.05 ? "S" : v > 0 ? "F" : "E";
        ev.push([Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000, v, k]);
        if (flood === null)
            flood = deg(x.meanFloodDir);
        if (ebb === null)
            ebb = deg(x.meanEbbDir);
    }
    ev.sort((a, b) => a[0] - b[0]);
    return { ev, flood, ebb, error: ev.length ? "" : "no predictions" };
}
export function flowAt(ev, t) {
    for (let i = 0; i + 1 < ev.length; i++) {
        const [t0, v0, k0] = ev[i], [t1, v1, k1] = ev[i + 1];
        if (t0 <= t && t <= t1 && t1 > t0) {
            const f = (t - t0) / (t1 - t0);
            if (k0 === "S" && k1 !== "S")
                return v0 + (v1 - v0) * Math.sin(f * Math.PI / 2);
            if (k0 !== "S" && k1 === "S")
                return v1 + (v0 - v1) * Math.cos(f * Math.PI / 2);
            return v0 + (v1 - v0) * (1 - Math.cos(Math.PI * f)) / 2;
        }
    }
    return null;
}
export function parsePredictions(raw) {
    const d = raw && typeof raw === "object" ? raw : {};
    if (d.error && typeof d.error === "object")
        return { hilo: [], error: cleanText(d.error.message, 160) || "no predictions" };
    const out = [];
    for (const x of Array.isArray(d.predictions) ? d.predictions : []) {
        const m = x && typeof x.t === "string" ? /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/.exec(x.t) : null;
        const v = x ? parseFloat(String(x.v)) : NaN;
        if (!m || !isFinite(v))
            continue;
        out.push([Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000, v, String(x.type).toUpperCase().startsWith("H") ? "H" : "L"]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return { hilo: out, error: out.length ? "" : "no predictions" };
}
export const HOLD_FT = 1;
export function nearWindow(hilo, i, d = HOLD_FT) {
    const [t, v] = hilo[i];
    let whole = false;
    const edge = (j) => {
        if (j < 0 || j >= hilo.length)
            return null;
        const [tj, vj] = hilo[j], r = Math.abs(vj - v);
        if (r <= d) {
            whole = true;
            return tj;
        }
        return t + (tj - t) * Math.acos(1 - 2 * d / r) / Math.PI;
    };
    const start = edge(i - 1), end = edge(i + 1);
    return { start, end, whole };
}
export const round5 = (t) => Math.round(t / 300) * 300;
const WHY_STATES = ["ok", "running", "waiting", "approval", "failing", "idle", "unknown"];
export function parseWhy(raw) {
    const d = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 && v < 1e11 ? v : 0);
    const state = typeof d.state === "string" && WHY_STATES.includes(d.state) ? d.state : "unknown";
    return { state, since: num(d.since), lastOk: num(d.lastOk), run: Math.floor(num(d.run)), schedule: d.schedule === true };
}
export function whenShort(t, now, timeZone) {
    const day = (x) => new Date(x * 1000).toLocaleDateString("en-CA", timeZone ? { timeZone } : {});
    if (day(t) === day(now))
        return clock(t, false, "en-US", timeZone);
    const opt = (o) => (timeZone ? { ...o, timeZone } : o);
    if (now - t < 6 * 86400)
        return new Date(t * 1000).toLocaleDateString("en-US", opt({ weekday: "short" })) + " " + clock(t, false, "en-US", timeZone);
    return new Date(t * 1000).toLocaleDateString("en-US", opt({ month: "short", day: "numeric" }));
}
export function whyText(w, now, timeZone) {
    const since = w.since && w.since <= now ? " since " + whenShort(w.since, now, timeZone) : "";
    switch (w.state) {
        case "approval": return "waiting for approval on GitHub" + since;
        case "waiting": return "stuck on GitHub" + since;
        case "failing": return "updates failing" + since;
        case "idle": return "no update started" + since;
        case "running": return "an update is running now";
        default: return "";
    }
}
