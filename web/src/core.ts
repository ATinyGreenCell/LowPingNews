// LowPingNews web: logic with no browser in it, so it can be tested in Node.
// Everything downloaded is untrusted: parsed strictly, bounded, never HTML.

export const APP_VERSION = "9.5";
export const SHOW = 10;          // stories shown at first
export const MORE = 10;          // ...and added per "more"

export interface Item {
  src: string;
  title: string;
  summary: string;
  link: string;                  // "" when the feed gave no safe link
  t: number;                     // epoch seconds; 0 = unknown
  key: string;
}

export interface Digest {
  t: number;                     // when the news was gathered (epoch s)
  app: string;
  cat: string;
  cats: [string, string][];
  items: Item[];
  failed: [string, number][];    // feeds that could not be read, and their copy's age (s, -1 unknown)
  reader: string;                // the article reader's address, "" if none is set up
}

const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Text with its paragraphs kept: NWS alerts are "* WHAT... / * WHERE..." blocks. */
export function cleanParas(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.split(/\n\s*\n/).map((p) => cleanText(p, max)).filter(Boolean).join("\n\n").slice(0, max);
}

export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Only plain web links: no javascript:, data:, or user:password@host. */
export function safeUrl(v: unknown): string {
  if (typeof v !== "string" || v.length > 2000) return "";
  let u: URL;
  try { u = new URL(v); } catch { return ""; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  if (u.username || u.password) return "";
  return u.href;
}

export function storyKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 120);
}

/** Parse one category file. Returns null for anything malformed. */
export function parseDigest(raw: unknown, now: number): Digest | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.v !== 1 || typeof d.t !== "number" || !isFinite(d.t) || d.t <= 0) return null;
  if (!Array.isArray(d.items) || !Array.isArray(d.src)) return null;
  const src = (d.src as unknown[]).map((s) => cleanText(s, 60));
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const r of (d.items as unknown[]).slice(0, 200)) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const [si, ti, su, li, t] = r as unknown[];
    if (typeof si !== "number" || !Number.isInteger(si) || si < 0 || si >= src.length) continue;
    const title = cleanText(ti, 300);
    if (!title) continue;
    const key = storyKey(title);
    if (seen.has(key)) continue;
    seen.add(key);
    let when = typeof t === "number" && isFinite(t) && t > 0 ? Math.floor(t) : 0;
    if (when > now + 600) when = 0;                      // future-dated: unknown, never pinned on top
    items.push({ src: src[si] || "?", title, summary: cleanText(su, 400), link: safeUrl(li), t: when, key });
  }
  const cats: [string, string][] = [];
  if (Array.isArray(d.cats)) {
    for (const c of (d.cats as unknown[]).slice(0, 20)) {
      if (Array.isArray(c) && typeof c[0] === "string" && /^[a-z0-9_-]{1,24}$/.test(c[0])) {
        cats.push([c[0], cleanText(c[1], 40) || c[0]]);
      }
    }
  }
  const failed: [string, number][] = [];
  if (Array.isArray(d.failed)) {
    for (const f of (d.failed as unknown[]).slice(0, 50)) {
      if (Array.isArray(f) && typeof f[0] === "string") {
        failed.push([cleanText(f[0], 60), typeof f[1] === "number" && isFinite(f[1]) ? f[1] : -1]);
      }
    }
  }
  const reader = safeUrl(d.reader);
  return { t: d.t, app: cleanText(d.app, 12), cat: cleanText(d.cat, 24), cats, items, failed,
           reader: reader.startsWith("https://") ? reader : "" };
}

export interface Article { text: string; complete: boolean; note: string; error: string }

/** The reader's answer, parsed as strictly as everything else. */
export function parseArticle(raw: unknown): Article {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = typeof d.text === "string" ? d.text.split("\n\n").map((p) => cleanText(p, 6000)).filter(Boolean).join("\n\n").slice(0, 200000) : "";
  return { text, complete: d.complete === true, note: cleanText(d.note, 200), error: cleanText(d.error, 200) };
}

/** "just now", "5m", "3h", "2d" - for ages in seconds. */
/** A bioRxiv/medRxiv link's preprint ID, if it is one. */
const PREPRINT = /^https?:\/\/(?:www\.|connect\.)?(biorxiv|medrxiv)\.org\/(?:content\/(?:early\/\d{4}\/\d{2}\/\d{2}\/)?|cgi\/content\/(?:short|abstract|full)\/)(?:10\.1101\/)?(\d{4}\.\d{2}\.\d{2}\.\d{5,8}|\d{6})(?:v\d+)?/i;
export function preprintId(link: string): { server: string; id: string } | null {
  const m = PREPRINT.exec(link || "");
  return m ? { server: m[1].toLowerCase(), id: m[2] } : null;
}
/** A preprint or a PubMed record: the papers whose abstracts the site publishes. */
const PUBMED = /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,9})\/?(?:[?#].*)?$/i;
export function paperId(link: string): { server: string; id: string } | null {
  const p = preprintId(link);
  if (p) return p;
  const m = PUBMED.exec(link || "");
  return m ? { server: "pubmed", id: m[1] } : null;
}
/** Where the site build publishes that paper's abstract (same site, ~1 KB). */
export function abstractFile(p: { server: string; id: string }): string {
  return "./data/abs/" + p.server + "-" + p.id + ".json";
}
const authorsShort = (a: string): string => {
  const names = a.split(/;\s*/).map((x) => x.trim()).filter(Boolean);
  return names.length > 3 ? names.slice(0, 3).join("; ") + " and " + (names.length - 3) + " more" : names.join("; ");
};
/** The published abstract file as an article: who, when, which version, then the abstract. */
export function parseAbstractDoc(raw: unknown, want?: { server: string; id: string }): Article {
  const none: Article = { text: "", complete: false, note: "", error: "no abstract" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return none;
  const d = raw as Record<string, unknown>;
  if (want && (d.server !== want.server ||
               (want.server === "pubmed" ? d.pmid !== want.id : d.doi !== "10.1101/" + want.id))) return none;   // some other paper's file
  const str = (k: string): string => cleanText(d[k], 600);
  const abs = cleanParas(d.abstract, 8000);
  if (!abs) return none;
  const cat = str("category");
  const meta = [authorsShort(str("authors")), str("journal"), cat && cat[0].toUpperCase() + cat.slice(1),
                str("date") && (d.server === "pubmed" ? "published " : "posted ") + str("date"),
                str("version") && "version " + str("version")].filter(Boolean).join(" \u00b7 ");
  const paras = [meta, abs].filter(Boolean);
  const pub = str("published");
  if (pub && pub !== "NA" && /^10\.\S+$/.test(pub)) paras.push("Since published: https://doi.org/" + pub);
  const host = d.server === "medrxiv" ? "medRxiv" : d.server === "pubmed" ? "the journal's site (PubMed links to it)" : "bioRxiv";
  return { text: paras.join("\n\n"), complete: true, error: "",
           note: "This is the abstract. The full paper is on " + host + ": open the original page." };
}

/** Is version a newer than b? ("8.10" > "8.9"; anything odd is not newer) */
export function newerVersion(a: unknown, b: string): boolean {
  if (typeof a !== "string" || !/^\d+(\.\d+)*$/.test(a) || !/^\d+(\.\d+)*$/.test(b)) return false;
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

export function ago(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "?";
  if (sec < 60) return "just now";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  if (sec < 86400) return Math.floor(sec / 3600) + "h";
  return Math.floor(sec / 86400) + "d";
}

export type Level = "fresh" | "aging" | "stale" | "unknown";

/** How current the news is. The site is rebuilt every 20 minutes, so an hour
 *  means a missed run or two, and three hours means updates have stopped. */
export function staleness(t: number, now: number): { level: Level; text: string } {
  if (!t || t > now + 600) return { level: "unknown", text: "update time unknown" };
  const age = now - t;
  if (age < 45 * 60) return { level: "fresh", text: "updated " + (age < 60 ? "just now" : ago(age) + " ago") };
  if (age < 3 * 3600) return { level: "aging", text: "updated " + ago(age) + " ago" };
  return { level: "stale", text: "news is " + ago(age) + " old - updates may have stopped" };
}

/** The window over a category's stories. Nothing visible is pushed out when
 *  newer stories arrive: the window keeps down to the oldest story shown. */
export function adoptWindow(shown: Item[], known: Set<string>, limit: number,
                            next: Item[], sameCat: boolean, start: number = SHOW): { limit: number; fresh: number } {
  if (!sameCat || !shown.length) return { limit: Math.max(1, start), fresh: 0 };
  let lim = limit;
  const oldest = shown[shown.length - 1].key;
  const at = next.findIndex((it) => it.key === oldest);
  if (at >= 0) lim = Math.max(lim, at + 1);
  const fresh = known.size ? next.slice(0, lim).filter((it) => !known.has(it.key)).length : 0;
  return { limit: Math.max(1, lim), fresh };
}

export function moreWindow(limit: number, total: number): number {
  return Math.min(total, limit + MORE);
}

/** Times as the phone's region writes them: "3:05 PM" in the US, "15:05"
 *  elsewhere. compact gives an axis label: "3p", or "15". */
export function clock(epoch: number, compact = false, locale?: string, timeZone?: string): string {
  const d = new Date(epoch * 1000);
  const opt: Intl.DateTimeFormatOptions = compact ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" };
  if (timeZone) opt.timeZone = timeZone;
  const s = d.toLocaleTimeString(locale, opt);
  if (!compact) return s;
  const m = /^(\d{1,2})\s*([AaPp])\.?\s*[Mm]\.?$/.exec(s.replace(/\u202f|\u00a0/g, " ").trim());
  return m ? m[1] + m[2].toLowerCase() : s.replace(/\D/g, "").slice(0, 2);
}

// ---- weather ------------------------------------------------------------
const WMO: Record<number, [string, string]> = {
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

export function wmo(code: unknown, day = true): { word: string; icon: string } {
  const c = typeof code === "number" ? code : -1;
  const w = WMO[c] || ["Unknown", "\u2754"];
  if (!day && (c === 0 || c === 1)) return { word: w[0], icon: "\ud83c\udf19" };
  return { word: w[0], icon: w[1] };
}

const US_STATES: Record<string, string> = Object.fromEntries((
  "AL Alabama|AK Alaska|AZ Arizona|AR Arkansas|CA California|CO Colorado|CT Connecticut|DE Delaware|" +
  "DC District of Columbia|FL Florida|GA Georgia|HI Hawaii|ID Idaho|IL Illinois|IN Indiana|IA Iowa|" +
  "KS Kansas|KY Kentucky|LA Louisiana|ME Maine|MD Maryland|MA Massachusetts|MI Michigan|MN Minnesota|" +
  "MS Mississippi|MO Missouri|MT Montana|NE Nebraska|NV Nevada|NH New Hampshire|NJ New Jersey|" +
  "NM New Mexico|NY New York|NC North Carolina|ND North Dakota|OH Ohio|OK Oklahoma|OR Oregon|" +
  "PA Pennsylvania|RI Rhode Island|SC South Carolina|SD South Dakota|TN Tennessee|TX Texas|UT Utah|" +
  "VT Vermont|VA Virginia|WA Washington|WV West Virginia|WI Wisconsin|WY Wyoming|PR Puerto Rico"
).split("|").map((p) => [p.slice(0, 2), p.slice(3)]));

/** "Huntington, NY" -> town "Huntington", qualifiers [["ny","new york"]].
 *  The geocoder matches names only, so the region is a filter, never sent. */
export function placeParts(q: string): { town: string; quals: string[][] } {
  const parts = q.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { town: "", quals: [] };
  const quals = parts.slice(1).map((p) => {
    const alts = [p.toLowerCase()];
    const st = US_STATES[p.toUpperCase()];
    if (st) alts.push(st.toLowerCase());
    return alts;
  });
  return { town: parts[0].slice(0, 80), quals };
}

export function placeFits(r: Record<string, unknown>, quals: string[][]): boolean {
  const fields = ["admin1", "admin2", "admin3", "country", "country_code"]
    .map((k) => (typeof r[k] === "string" ? (r[k] as string).toLowerCase() : "")).filter(Boolean);
  return quals.every((alts) => alts.some((a) => fields.some((f) => a === f || f === a + " county" || a === f + " county")));
}

// ---- NOAA alerts --------------------------------------------------------
export interface Alert { event: string; severity: string; urgency: string; headline: string;
                         ends: number; description: string; instruction: string }

const SEV: Record<string, number> = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };

/** Real alerts that have not run out, most severe first. Tests and drills
 *  never pass; neither do cancellations or anything already expired. */
export function liveAlerts(raw: unknown, now: number): { alerts: Alert[]; expired: number } | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { features?: unknown }).features)) return null;
  const out: Alert[] = [];
  let expired = 0;
  for (const f of ((raw as { features: unknown[] }).features).slice(0, 60)) {
    const p = (f && typeof f === "object" ? (f as { properties?: unknown }).properties : null) as Record<string, unknown> | null;
    if (!p || (p.status ?? "Actual") !== "Actual" || p.messageType === "Cancel") continue;
    const endS = cleanText(p.ends, 40) || cleanText(p.expires, 40);
    const end = endS ? Date.parse(endS) / 1000 : 0;
    if (end && end < now) { expired++; continue; }
    out.push({ event: cleanText(p.event, 80) || "Alert", severity: cleanText(p.severity, 20) || "Unknown",
               urgency: cleanText(p.urgency, 20), headline: cleanText(p.headline, 300), ends: end || 0,
               description: cleanParas(p.description, 4000), instruction: cleanParas(p.instruction, 2000) });
  }
  out.sort((a, b) => (SEV[a.severity] ?? 5) - (SEV[b.severity] ?? 5));
  return { alerts: out, expired };
}


// ---- tides ------------------------------------------------------------------
// The moon from the mean lunation (within ~half a day of the true times), the
// water level between NOAA's predicted highs and lows (their curves are this
// cosine), and safe readers for the site's tile and NOAA's predictions.
const SYNODIC = 29.530588853;
const NEW_MOON0 = 947182440;          // 2000-01-06 18:14 UTC, a known new moon
export interface Moon { name: string; lit: number; age: number; tide: "" | "spring" | "neap"; full: number; next: number }
export function moon(t: number): Moon {
  const age = (((t - NEW_MOON0) / 86400) % SYNODIC + SYNODIC) % SYNODIC;
  const lit = (1 - Math.cos(2 * Math.PI * age / SYNODIC)) / 2;
  const names: [number, string][] = [[1, "New moon"], [6.4, "Waxing crescent"], [8.4, "First quarter"], [13.8, "Waxing gibbous"],
    [15.8, "Full moon"], [21.1, "Waning gibbous"], [23.1, "Last quarter"], [28.5, "Waning crescent"], [99, "New moon"]];
  const name = names.find(([lim]) => age < lim)![1];
  const near = (x: number): number => Math.min(Math.abs(age - x), SYNODIC - Math.abs(age - x));
  const half = SYNODIC / 2;
  const tide = Math.min(near(0), near(half)) <= 2 ? "spring" : Math.min(near(SYNODIC / 4), near(3 * SYNODIC / 4)) <= 2 ? "neap" : "";
  return { name, lit, age, tide, full: t + (((half - age) % SYNODIC + SYNODIC) % SYNODIC) * 86400,
           next: t + (((SYNODIC - age) % SYNODIC + SYNODIC) % SYNODIC) * 86400 };
}
export function kmBetween(a1: number, o1: number, a2: number, o2: number): number {
  const p = Math.PI / 180;
  const h = Math.sin((a2 - a1) * p / 2) ** 2 + Math.cos(a1 * p) * Math.cos(a2 * p) * Math.sin((o2 - o1) * p / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function tileKey(lat: number, lon: number): string { return Math.floor(lat) + "_" + Math.floor(lon); }
export type Tide = [number, number, "H" | "L"];
export function tideLevel(hilo: Tide[], t: number): { level: number; rising: boolean } | null {
  for (let i = 0; i + 1 < hilo.length; i++) {
    const [t0, v0] = hilo[i], [t1, v1] = hilo[i + 1];
    if (t0 <= t && t <= t1 && t1 > t0) {
      const f = (1 - Math.cos(Math.PI * (t - t0) / (t1 - t0))) / 2;
      return { level: v0 + (v1 - v0) * f, rising: v1 > v0 };
    }
  }
  return null;
}
const num = (x: unknown): number | null => (typeof x === "number" && isFinite(x) ? x : null);
export interface Station { id: string; name: string; km: number }
export interface CurrentStation { id: string; name: string; km: number; bin: number }
export interface Buoy { id: string; name: string; km: number; t: number; water: number | null; waves: number | null;
                        period: number | null; dir: number | null; wind: number | null; air: number | null }
/** The site's tile, sorted by distance from you: hostile or broken rows dropped.
 *  nb is the buoy readings in the whole build (-1 if the tile does not say):
 *  0 there means NDBC did not answer, not that no buoy is near. */
export function parseTile(raw: unknown, lat: number, lon: number, now: number):
    { stations: Station[]; buoys: Buoy[]; currents: CurrentStation[]; nb: number; reader: string } {
  const d = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rows = (k: string): unknown[][] => (Array.isArray(d[k]) ? (d[k] as unknown[]).filter(Array.isArray) as unknown[][] : []);
  const stations: Station[] = [];
  for (const r of rows("s")) {
    const a = num(r[2]), o = num(r[3]);
    if (a === null || o === null || typeof r[0] !== "string" || !/^[0-9A-Z]{5,10}$/.test(r[0])) continue;
    stations.push({ id: r[0], name: cleanText(r[1], 60), km: kmBetween(lat, lon, a, o) });
  }
  const buoys: Buoy[] = [];
  for (const r of rows("b")) {
    const a = num(r[2]), o = num(r[3]), t = num(r[4]);
    if (a === null || o === null || t === null || now - t > 3 * 3600 || typeof r[0] !== "string") continue;
    buoys.push({ id: cleanText(r[0], 10), name: cleanText(r[1], 50), km: kmBetween(lat, lon, a, o), t,
                 water: num(r[5]), waves: num(r[6]), period: num(r[7]), dir: num(r[8]), wind: num(r[9]), air: num(r[11]) });
  }
  const currents: CurrentStation[] = [];
  for (const r of rows("c")) {
    const a = num(r[2]), o = num(r[3]), b = num(r[4]);
    if (a === null || o === null || b === null || !Number.isInteger(b) || b < 0 || b > 99 ||
        typeof r[0] !== "string" || !/^[0-9A-Za-z]{4,12}$/.test(r[0])) continue;
    currents.push({ id: r[0], name: cleanText(r[1], 60), km: kmBetween(lat, lon, a, o), bin: b });
  }
  stations.sort((x, y) => x.km - y.km);
  buoys.sort((x, y) => x.km - y.km);
  currents.sort((x, y) => x.km - y.km);
  const reader = safeUrl(d.reader), nb = num(d.nb);
  return { stations, buoys, currents, nb: nb !== null && nb >= 0 ? nb : -1, reader: reader.startsWith("https://") ? reader : "" };
}
export function compass(deg: number): string {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.floor(((deg % 360) + 360 + 22.5) / 45) % 8];
}
/** A tidal-current event: [epoch, knots (flood +, ebb -), max Flood | max Ebb | Slack]. */
export type Flow = [number, number, "F" | "E" | "S"];
export interface Flows { ev: Flow[]; flood: number | null; ebb: number | null; error: string }
/** NOAA's max flood, max ebb and slack times, asked for in GMT, in order, with
 *  the directions flood and ebb run toward (degrees true). */
export function parseCurrents(raw: unknown): Flows {
  const d = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (d.error && typeof d.error === "object")
    return { ev: [], flood: null, ebb: null, error: cleanText((d.error as Record<string, unknown>).message, 160) || "no predictions" };
  const box = d.current_predictions && typeof d.current_predictions === "object" ? d.current_predictions as Record<string, unknown> : {};
  const deg = (x: unknown): number | null => (typeof x === "number" && isFinite(x) && x >= 0 && x <= 360 ? x : null);
  const ev: Flow[] = [];
  let flood: number | null = null, ebb: number | null = null;
  for (const x of Array.isArray(box.cp) ? box.cp as Record<string, unknown>[] : []) {
    if (!x || typeof x !== "object") continue;
    const m = typeof x.Time === "string" ? /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/.exec(x.Time) : null;
    const v = typeof x.Velocity_Major === "number" ? x.Velocity_Major : parseFloat(String(x.Velocity_Major));
    if (!m || !isFinite(v) || Math.abs(v) >= 15) continue;
    const ty = String(x.Type).toLowerCase();
    const k: Flow[2] = ty === "slack" ? "S" : ty === "flood" ? "F" : ty === "ebb" ? "E" : Math.abs(v) < 0.05 ? "S" : v > 0 ? "F" : "E";
    ev.push([Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000, v, k]);
    if (flood === null) flood = deg(x.meanFloodDir);
    if (ebb === null) ebb = deg(x.meanEbbDir);
  }
  ev.sort((a, b) => a[0] - b[0]);
  return { ev, flood, ebb, error: ev.length ? "" : "no predictions" };
}
/** The current at t between NOAA's events (knots, flood +): a quarter sine from
 *  slack to the peak and back - tidal streams are close to sinusoidal - and a
 *  smooth ease from peak to peak where the stream never stops. null outside. */
export function flowAt(ev: Flow[], t: number): number | null {
  for (let i = 0; i + 1 < ev.length; i++) {
    const [t0, v0, k0] = ev[i], [t1, v1, k1] = ev[i + 1];
    if (t0 <= t && t <= t1 && t1 > t0) {
      const f = (t - t0) / (t1 - t0);
      if (k0 === "S" && k1 !== "S") return v0 + (v1 - v0) * Math.sin(f * Math.PI / 2);
      if (k0 !== "S" && k1 === "S") return v1 + (v0 - v1) * Math.cos(f * Math.PI / 2);
      return v0 + (v1 - v0) * (1 - Math.cos(Math.PI * f)) / 2;
    }
  }
  return null;
}
/** NOAA's high/low predictions, asked for in GMT: [epoch, feet, H|L], in order. */
export function parsePredictions(raw: unknown): { hilo: Tide[]; error: string } {
  const d = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (d.error && typeof d.error === "object") return { hilo: [], error: cleanText((d.error as Record<string, unknown>).message, 160) || "no predictions" };
  const out: Tide[] = [];
  for (const x of Array.isArray(d.predictions) ? d.predictions as Record<string, unknown>[] : []) {
    const m = x && typeof x.t === "string" ? /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/.exec(x.t) : null;
    const v = x ? parseFloat(String(x.v)) : NaN;
    if (!m || !isFinite(v)) continue;
    out.push([Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000, v, String(x.type).toUpperCase().startsWith("H") ? "H" : "L"]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return { hilo: out, error: out.length ? "" : "no predictions" };
}

// ---- how long a high or low "holds" -------------------------------------------
// The tide never stops; it moves slowest near each high and low. A window is
// when the water is within d ft of one. Each side is its own half cosine (the
// falling and rising sides differ): with range R and fraction f of the way to
// the next tide, |level - v| <= d until f = acos(1 - 2d/R) / pi. A side with
// R <= d never gets d away and runs to the next tide: "whole", not a hold.
export const HOLD_FT = 1;
export function nearWindow(hilo: Tide[], i: number, d = HOLD_FT): { start: number | null; end: number | null; whole: boolean } {
  const [t, v] = hilo[i];
  let whole = false;
  const edge = (j: number): number | null => {
    if (j < 0 || j >= hilo.length) return null;
    const [tj, vj] = hilo[j], r = Math.abs(vj - v);
    if (r <= d) { whole = true; return tj; }
    return t + (tj - t) * Math.acos(1 - 2 * d / r) / Math.PI;
  };
  const start = edge(i - 1), end = edge(i + 1);
  return { start, end, whole };
}
/** To five minutes: a window from a curve fit is not good to the minute. */
export const round5 = (t: number): number => Math.round(t / 300) * 300;
