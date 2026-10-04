// LowPingNews web: logic with no browser in it, so it can be tested in Node.
// Everything downloaded is untrusted: parsed strictly, bounded, never HTML.

export const APP_VERSION = "8.6";
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
