// LowPingNews reader: a Cloudflare Worker that turns one article page into
// plain text, on request, for the LowPingNews web app - Safari's Reader mode,
// done before the page crosses the phone's connection. A few KB of text
// instead of a multi-megabyte page. Nothing is stored or published.
//
// It is not an open proxy: it answers only the app's own address, and only
// fetches links that appear in the app's current headline files.
//
// Deploy: Cloudflare dashboard > Workers & Pages > Create > Worker, paste this
// file (the compiled reader.js), Deploy. Then: lowpingnews reader <its URL>

const VERSION = "8.3";
const SITE = "https://atinygreencell.github.io/LowPingNews/";   // override with a SITE variable
const MAX_BYTES = 2 * 1024 * 1024;     // stop reading a page here
const TIMEOUT_MS = 10000;
const MAX_PARAS = 120;

interface Env { SITE?: string }
interface Out { v: number; url: string; text: string; complete: boolean; note?: string; error?: string }

// ---- HTML to text (a port of the terminal app's extract) ---------------
const SKIP = new Set(["script", "style", "nav", "aside", "footer", "header", "form", "noscript",
                      "figure", "svg", "button", "select", "template", "iframe"]);
const KEEP = new Set(["p", "h1", "h2", "h3", "li", "blockquote"]);
const VOID = new Set(["br", "img", "hr", "meta", "link", "input", "source", "wbr", "area", "base", "col", "embed", "track"]);
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "\u2013",
  mdash: "\u2014", hellip: "\u2026", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", copy: "\u00a9",
  reg: "\u00ae", eacute: "\u00e9", egrave: "\u00e8", aacute: "\u00e1", oacute: "\u00f3", uuml: "\u00fc", ouml: "\u00f6",
  auml: "\u00e4", szlig: "\u00df", ccedil: "\u00e7", ntilde: "\u00f1", deg: "\u00b0", times: "\u00d7", middot: "\u00b7" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 && !(n >= 0xd800 && n < 0xe000) ? String.fromCodePoint(n) : " ";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
const tidy = (s: string): string => decodeEntities(s).replace(CTRL, " ").replace(/\s+/g, " ").trim();

/** Paragraph text only, like the terminal reader. */
export function extract(html: string): string {
  // contents that are not text at all: removed whole, so a "<" inside a
  // script can never open a tag
  const h = html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const out: string[] = [];
  let depth = 0, cur: string[] | null = null;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>|([^<]+)|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(h)) && out.length < MAX_PARAS) {
    if (m[4] !== undefined) { if (!depth && cur) cur.push(m[4]); continue; }
    if (m[2] === undefined) continue;
    const tag = m[2].toLowerCase(), closing = m[1] === "/";
    if (VOID.has(tag) || m[3] === "/") { if (tag === "br" && cur && !depth) cur.push(" "); continue; }
    if (SKIP.has(tag)) { depth = Math.max(0, depth + (closing ? -1 : 1)); continue; }
    if (!KEEP.has(tag) || depth) continue;
    if (!closing) { cur = []; continue; }
    if (cur) { const x = tidy(cur.join("")); if (x.length > 40) out.push(x); }
    cur = null;
  }
  const body = out.join("\n\n");
  if (body.length < 200) {                   // built by JavaScript: try the embedded copy
    const alt = metaFallback(html);
    if (alt.length > body.length) return alt;
  }
  return body;
}

export function metaFallback(html: string): string {
  const m = /"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(html);
  if (m) {
    let body = m[1];
    try { body = JSON.parse("\"" + m[1] + "\""); } catch { /* use it raw */ }
    body = tidy(body);
    if (body.length > 200) return body;
  }
  for (const re of [/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{80,})/i,
                    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{80,})/i]) {
    const d = re.exec(html);
    if (d) return tidy(d[1]);
  }
  return "";
}

/** Full article, or a teaser/abstract? The terminal app's rule. */
export function looksComplete(txt: string, url: string): boolean {
  if (!txt) return false;
  const paras = txt.split("\n\n").filter((p) => p.length > 80);
  if (/(bio|med)rxiv\.org/i.test(url)) {
    const head = txt.slice(0, 12000).toLowerCase();
    const marks = ["introduction", "results", "methods", "discussion", "conclusion"].filter((w) => head.includes(w)).length;
    return marks >= 2 && txt.length > 4000;
  }
  return txt.length > 1200 && paras.length >= 4;
}

/** Where a site keeps the whole article, best first. */
export function fullTextUrls(u: string): string[] {
  const m = /^https?:\/\/(?:www\.)?(biorxiv|medrxiv)\.org\/(?:content|cgi\/content\/short)\/(?:10\.1101\/)?([0-9.]+(?:v\d+)?)/i.exec(u);
  if (m) {
    const root = "https://www." + m[1].toLowerCase() + ".org/content/10.1101/" + m[2];
    return [root + ".full", root];
  }
  return [u];
}

export function safeUrl(v: string | null): string {
  if (!v || v.length > 2000) return "";
  try {
    const u = new URL(v);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return "";
    return u.href;
  } catch { return ""; }
}

// ---- the Worker ---------------------------------------------------------
async function readCapped(r: Response): Promise<string> {
  if (!r.body) return await r.text();
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  while (n < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    parts.push(value);
    n += value.length;
  }
  try { await reader.cancel(); } catch { /* already closed */ }
  const all = new Uint8Array(Math.min(n, MAX_BYTES));
  let at = 0;
  for (const p of parts) { const take = Math.min(p.length, all.length - at); all.set(p.subarray(0, take), at); at += take; if (at >= all.length) break; }
  return new TextDecoder("utf-8").decode(all);
}

async function fetchPage(url: string): Promise<{ html: string; status: number; type: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ac.signal,
      headers: { "User-Agent": "LowPingNewsReader/" + VERSION + " (+github.com/ATinyGreenCell/LowPingNews)",
                 Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" } });
    const type = (r.headers.get("content-type") || "").toLowerCase();
    if (!r.ok || !/html|xml/.test(type)) { try { await r.body?.cancel(); } catch { /* fine */ } return { html: "", status: r.status, type }; }
    return { html: await readCapped(r), status: r.status, type };
  } finally { clearTimeout(timer); }
}

async function listed(site: string, cat: string, url: string): Promise<boolean> {
  const r = await fetch(site + "data/" + cat + ".json", { cf: { cacheTtl: 300 } } as RequestInit);
  if (!r.ok) return false;
  const d = await r.json() as { items?: unknown[] };
  return Array.isArray(d.items) && d.items.some((x) => Array.isArray(x) && x[3] === url);
}

export async function read(url: string): Promise<Out> {
  let best: Out = { v: 1, url, text: "", complete: false };
  for (const u of fullTextUrls(url)) {
    let page;
    try { page = await fetchPage(u); }
    catch (e) { best.error = (e as Error).name === "AbortError" ? "the site took too long" : "the site could not be reached"; continue; }
    if (!page.html) {
      best.error = page.status >= 400 ? "the site answered " + page.status : "not a web page (" + (page.type.split(";")[0] || "unknown") + ")";
      continue;
    }
    const text = extract(page.html);
    const complete = looksComplete(text, u);
    if (complete) return { v: 1, url, text, complete };
    if (text.length > best.text.length) best = { v: 1, url, text, complete: false };
  }
  if (best.text) { delete best.error; best.note = "this looks like only part of the article (a paywall, or an abstract)"; }
  return best;
}

function reply(body: Out | { v: number; error: string }, status: number, origin: string, cache = 0): Response {
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": origin,
                          Vary: "Origin", "X-Content-Type-Options": "nosniff" });
  h.set("Cache-Control", cache ? "public, max-age=" + cache : "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export default {
  async fetch(req: Request, env: Env = {}): Promise<Response> {
    const site = (env.SITE || SITE).replace(/\/?$/, "/");
    const allow = new URL(site).origin;
    const origin = req.headers.get("Origin") || "";
    if (origin !== allow) return new Response("This reader serves the LowPingNews app only.", { status: 403 });
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Methods": "GET",
        "Access-Control-Max-Age": "86400", Vary: "Origin" } });
    }
    if (req.method !== "GET") return reply({ v: 1, error: "GET only" }, 405, allow);
    const q = new URL(req.url).searchParams;
    const cat = q.get("cat") || "";
    const url = safeUrl(q.get("u"));
    if (!/^[a-z0-9_-]{1,24}$/.test(cat) || !url) return reply({ v: 1, error: "bad request" }, 400, allow);
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    const key = new Request("https://reader.cache/" + encodeURIComponent(url));
    if (cache) { const hit = await cache.match(key); if (hit) return reply(await hit.json() as Out, 200, allow, 3600); }
    let ok = false;
    try { ok = await listed(site, cat, url); } catch { ok = false; }
    if (!ok) return reply({ v: 1, error: "not a story in the app right now" }, 404, allow);
    const out = await read(url);
    if (!out.text) return reply({ v: 1, url, text: "", complete: false, error: out.error || "no readable text on that page" }, 502, allow);
    if (cache) {
      await cache.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "public, max-age=21600" } }));
    }
    return reply(out, 200, allow, 3600);
  },
};
