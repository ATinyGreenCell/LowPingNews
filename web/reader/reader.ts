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

const VERSION = "8.8";
const SITE = "https://atinygreencell.github.io/LowPingNews/";   // override with a SITE variable
const MAX_BYTES = 2 * 1024 * 1024;     // stop reading a page here
const TIMEOUT_MS = 10000;
const MAX_PARAS = 120;

interface Env { SITE?: string; TIMEOUT_MS?: string }
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
  // journals and preprint servers tag the abstract itself; a page's general
  // description is often a site-wide tagline ("bioRxiv - the preprint server
  // for biology..."), so it must be long to count
  for (const re of [/<meta[^>]+name=["']citation_abstract["'][^>]+content=["']([^"']{80,})/i,
                    /<meta[^>]+name=["']dc\.description["'][^>]+content=["']([^"']{80,})/i,
                    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{160,})/i,
                    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{160,})/i]) {
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

/** An anti-bot "checking your browser" page: there is no article on it. */
export function isChallenge(html: string): boolean {
  return /<title>\s*(Just a moment|Attention Required|Access denied|Please wait)/i.test(html) ||
         /challenge-platform|cf-chl-|cf_chl_opt|captcha-delivery/i.test(html.slice(0, 20000));
}

// ---- preprints and papers: their own APIs beat scraping -----------------
const PREPRINT = /^https?:\/\/(?:www\.|connect\.)?(biorxiv|medrxiv)\.org\/(?:content\/(?:early\/\d{4}\/\d{2}\/\d{2}\/)?|cgi\/content\/(?:short|abstract|full)\/)(?:10\.1101\/)?(\d{4}\.\d{2}\.\d{2}\.\d{5,8}|\d{6})(?:v\d+)?/i;
const EPMC = /^https?:\/\/(?:www\.)?europepmc\.org\/(?:abstract|article)\/(MED|PMC|PPR|AGR|CBA|CTX|ETH|HIR|PAT)\/([A-Za-z0-9]{1,20})/i;

export function preprintDoi(u: string): { server: string; doi: string } | null {
  const m = PREPRINT.exec(u);
  return m ? { server: m[1].toLowerCase(), doi: "10.1101/" + m[2] } : null;
}

let apiWhy = "";   // why the last API call failed, said in the error so a failure explains itself
function getJSON(url: string, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { signal: ac.signal, headers: { Accept: "application/json",
    "User-Agent": "LowPingNewsReader/" + VERSION + " (+github.com/ATinyGreenCell/LowPingNews)" } })
    .then((r) => { if (r.ok) return r.json(); apiWhy = "answered " + r.status; return null; })
    .catch((e) => { apiWhy = (e as Error).name === "AbortError" ? "took too long" : "could not be reached"; return null; })
    .finally(() => clearTimeout(timer));
}

const authorsShort = (a: string): string => {
  const names = a.split(/;\s*/).map((x) => x.trim()).filter(Boolean);
  return names.length > 3 ? names.slice(0, 3).join("; ") + " and " + (names.length - 3) + " more" : names.join("; ");
};

/** bioRxiv/medRxiv: the official API's abstract, authors and dates. */
export async function preprintAbstract(u: string, timeoutMs: number): Promise<Out | null> {
  const id = preprintDoi(u);
  if (!id) return null;
  const d = await getJSON("https://api." + id.server + ".org/details/" + id.server + "/" + id.doi + "/na/json", timeoutMs)
    .catch(() => null) as { collection?: Record<string, unknown>[] } | null;
  const all = d && Array.isArray(d.collection) ? d.collection : [];
  const p = all[all.length - 1];                     // the latest posted version
  const abs = p && typeof p.abstract === "string" ? p.abstract : "";
  if (!abs.trim()) return null;
  const str = (k: string): string => (p && typeof p[k] === "string" ? tidy(p[k] as string) : "");
  const meta = [authorsShort(str("authors")), str("category") && str("category")[0].toUpperCase() + str("category").slice(1),
                str("date") && "posted " + str("date"), str("version") && "version " + str("version")].filter(Boolean).join(" \u00b7 ");
  const paras = [meta, ...abs.split(/\n\s*\n/).map(tidy)].filter(Boolean);
  const pub = str("published");
  if (pub && pub !== "NA") paras.push("Since published: https://doi.org/" + pub);
  const host = id.server === "medrxiv" ? "medRxiv" : "bioRxiv";
  return { v: 1, url: u, text: paras.join("\n\n"), complete: true,
           note: "This is the abstract. The full paper is on " + host + ": open the original page." };
}

/** Europe PMC: its REST API's abstract. */
export async function epmcAbstract(u: string, timeoutMs: number): Promise<Out | null> {
  const m = EPMC.exec(u);
  if (!m) return null;
  const q = encodeURIComponent("EXT_ID:" + m[2] + " AND SRC:" + m[1].toUpperCase());
  const d = await getJSON("https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=" + q +
                          "&resultType=core&format=json&pageSize=1", timeoutMs).catch(() => null) as
    { resultList?: { result?: Record<string, unknown>[] } } | null;
  const r = d && d.resultList && Array.isArray(d.resultList.result) ? d.resultList.result[0] : null;
  const html = r && typeof r.abstractText === "string" ? r.abstractText : "";
  if (!html.trim()) return null;
  // abstracts come as light HTML: <h4>Background</h4> sections, <p>, <br>
  const paras = html.replace(/<\/?(h\d|p|br|div)[^>]*>/gi, "\n\n").replace(/<[^>]+>/g, "")
    .split(/\n\s*\n/).map(tidy).filter(Boolean);
  const meta = [typeof r!.authorString === "string" ? authorsShort(tidy((r!.authorString as string).replace(/,\s*/g, "; "))) : "",
                typeof r!.journalTitle === "string" ? tidy(r!.journalTitle as string) : "",
                typeof r!.pubYear === "string" ? tidy(r!.pubYear as string) : ""].filter(Boolean).join(" \u00b7 ");
  return { v: 1, url: u, text: [meta, ...paras].filter(Boolean).join("\n\n"), complete: true,
           note: "This is the abstract. Open the original page for the full paper, where it is free to read." };
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

async function fetchPage(url: string, timeoutMs: number): Promise<{ html: string; status: number; type: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
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

export async function read(url: string, timeoutMs: number = TIMEOUT_MS): Promise<Out> {
  // a paper's own API first: clean, reliable, and never an anti-bot wall
  apiWhy = "";
  const api = (await preprintAbstract(url, timeoutMs).catch(() => null)) || (await epmcAbstract(url, timeoutMs).catch(() => null));
  if (api) return api;
  const pre = preprintDoi(url);
  const apiNote = pre ? (pre.server === "medrxiv" ? "medRxiv" : "bioRxiv") + "'s API " + (apiWhy || "had no abstract") : "";
  let best: Out = { v: 1, url, text: "", complete: false };
  for (const u of fullTextUrls(url)) {
    let page;
    try { page = await fetchPage(u, timeoutMs); }
    catch (e) { best.error = (e as Error).name === "AbortError" ? "the site took too long" : "the site could not be reached"; continue; }
    if (!page.html) {
      best.error = page.status >= 400 ? "the site answered " + page.status : "not a web page (" + (page.type.split(";")[0] || "unknown") + ")";
      continue;
    }
    if (isChallenge(page.html)) { best.error = "the site blocked automated reading"; continue; }
    const text = extract(page.html);
    const complete = looksComplete(text, u);
    if (complete) return { v: 1, url, text, complete };
    if (text.length > best.text.length) best = { v: 1, url, text, complete: false };
  }
  if (best.text) { delete best.error; best.note = "this looks like only part of the article (a paywall, or an abstract)"; }
  else if (apiNote) best.error = (best.error || "no readable text") + "; " + apiNote;
  return best;
}

function reply(body: Out | { v: number; error: string }, status: number, origin: string, cache = 0): Response {
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": origin,
                          Vary: "Origin", "X-Content-Type-Options": "nosniff", "X-LPN-Reader": VERSION,
                          "Access-Control-Expose-Headers": "X-LPN-Reader" });
  h.set("Cache-Control", cache ? "public, max-age=" + cache : "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export default {
  async fetch(req: Request, env: Env = {}): Promise<Response> {
    const site = (env.SITE || SITE).replace(/\/?$/, "/");
    const allow = new URL(site).origin;
    const origin = req.headers.get("Origin") || "";
    if (origin !== allow) return new Response("This reader serves the LowPingNews app only.",
                                              { status: 403, headers: { "X-LPN-Reader": VERSION } });
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
    // an optional TIMEOUT_MS setting, bounded: 0.1 s to 30 s, default 10 s
    const tmo = Math.min(30000, Math.max(100, Number(env.TIMEOUT_MS) || TIMEOUT_MS));
    const out = await read(url, tmo);
    if (!out.text) return reply({ v: 1, url, text: "", complete: false, error: out.error || "no readable text on that page" }, 502, allow);
    if (cache) {
      await cache.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "public, max-age=21600" } }));
    }
    return reply(out, 200, allow, 3600);
  },
};
