export const APP_VERSION = "8.3";
export const SHOW = 10;
export const MORE = 10;
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
export function cleanParas(v, max) {
    if (typeof v !== "string")
        return "";
    return v.split(/\n\s*\n/).map((p) => cleanText(p, max)).filter(Boolean).join("\n\n").slice(0, max);
}
export function cleanText(v, max) {
    if (typeof v !== "string")
        return "";
    return v.replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, max);
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
