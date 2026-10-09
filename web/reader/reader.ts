// LowPingNews reader: a Cloudflare Worker that turns one article page into
// plain text, on request, for the LowPingNews web app - Safari's Reader mode,
// done before the page crosses the phone's connection. A few KB of text
// instead of a multi-megabyte page. Nothing is stored or published.
//
// It is not an open proxy: it answers only the app's own address, and only
// fetches links that appear in the app's current headline files.
//
// It also keeps the site's news on time: every 20 minutes Cloudflare's cron
// wakes it to start the site's update on GitHub, whose own scheduler runs a
// "20-minute" job only a few times a day. And when the news has gone stale,
// the app asks it why (?why), getting one small answer instead of GitHub's
// run listings, which are tens of KB each.
//
// Deploy: lpn reader deploy. Start the 20-minute updates: lpn schedule.

const VERSION = "9.7";
const SITE = "https://atinygreencell.github.io/LowPingNews/";   // override with a SITE variable
const MAX_BYTES = 2 * 1024 * 1024;     // stop reading a page here
const TIMEOUT_MS = 10000;
const MAX_PARAS = 120;

interface Env { SITE?: string; TIMEOUT_MS?: string; GH_TOKEN?: string; GH_REPO?: string; GH_REF?: string }
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

// the u flag makes the surrogate range match only LONE surrogates (from a
// JSON "\ud83d" alone); without it, the halves of every emoji would go too
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu;
const ANSI = /(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]{0,2000}(?:\x07|\x1b\\|\x9c)?|\x1b[@-Z\\\-_]/g;
const tidy = (s: string): string => decodeEntities(s).replace(ANSI, "").replace(CTRL, " ").replace(/\s+/g, " ").trim();

/** Paragraph text only, like the terminal reader. */
/** Comments and the contents of script-like blocks, removed whole (so a "<"
 *  inside a script can never open a tag) in ONE forward pass. Lazy regexes
 *  (<!--[\s\S]*?-->) rescan to the end from every unclosed opening: a page of
 *  unclosed "<!--" cost quadratic CPU, and a Worker's CPU limit is ~10 ms. */
export function stripBlocks(html: string): string {
  const lower = html.replace(/[A-Z]+/g, (x) => x.toLowerCase());   // ASCII only: the same length
  const open = /<!--|<(script|style|noscript|svg|template|iframe)\b/g;
  let out = "", i = 0, m: RegExpExecArray | null;
  while ((m = open.exec(lower))) {
    out += html.slice(i, m.index) + " ";
    const close = m[1] ? lower.indexOf("</" + m[1], open.lastIndex) : lower.indexOf("-->", open.lastIndex);
    if (close < 0) return out;                         // never closed: the rest is not text
    const gt = m[1] ? lower.indexOf(">", close) : close + 2;
    if (gt < 0) return out;
    i = gt + 1;
    open.lastIndex = i;
  }
  return out + html.slice(i);
}

export function extract(html: string): string {
  const h = stripBlocks(html);
  const out: string[] = [];
  let depth = 0, cur: string[] | null = null;
  // a tag match can only fail by running off the end where no ">" is left; text
  // after the last ">" holds no tag, so it is set aside first: no rescans, linear
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>|([^<]+)|</g;
  let m: RegExpExecArray | null;
  const cut = h.lastIndexOf(">") + 1;
  const body0 = h.slice(0, cut);
  while ((m = re.exec(body0)) && out.length < MAX_PARAS) {
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

/** Every <meta ...> tag in the text, found in one forward pass (at most 400, each at most 4 KB). */
export function metaTags(head: string): string[] {
  const lower = head.replace(/[A-Z]+/g, (x) => x.toLowerCase());
  const out: string[] = [];
  let i = 0;
  while (out.length < 400) {
    const at = lower.indexOf("<meta", i);
    if (at < 0) break;
    const gt = lower.indexOf(">", at);
    if (gt < 0) break;                                    // no tag can close past here
    const last = lower.lastIndexOf("<meta", gt);          // unclosed ones before it: the tag that closes here
    if (gt - last <= 4096) out.push(head.slice(last, gt + 1));
    i = gt + 1;
  }
  return out;
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
  // for biology..."), so it must be long to count. Description tags live in the
  // head: searching only there is faster on every page, and bounded repeats keep
  // a page of unclosed <meta from going quadratic.
  // each meta tag is found once, in one pass over the head, and only the small
  // tag string is searched: linear whatever the page holds (a regex per tag
  // start rescanned the head, 400 ms on a page of unclosed <meta)
  const tags = metaTags(html.slice(0, 200000));
  for (const [attr, name, min] of [["name", "citation_abstract", 80], ["name", "dc.description", 80],
                                   ["property", "og:description", 160], ["name", "description", 160]] as const) {
    for (const tg of tags) {
      const n = new RegExp("\\b" + attr + "\\s*=\\s*[\"']" + name.replace(".", "\\.") + "[\"']", "i").test(tg);
      const c = n ? /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tg) : null;
      const v = c ? (c[1] ?? c[2] ?? "") : "";
      if (v.length >= min) return tidy(v);
    }
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

// APIs get the crawler convention: NOAA's edge answers tool-like User-Agents
// with a bare 404, and this still names us and where to find us
const UA = "Mozilla/5.0 (compatible; LowPingNewsReader/" + VERSION + "; +https://github.com/ATinyGreenCell/LowPingNews)";
let apiWhy = "";   // why the last API call failed, said in the error so a failure explains itself
function getJSON(url: string, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { signal: ac.signal, headers: { Accept: "application/json", "User-Agent": UA } })
    .then(async (r) => {
      if (!r.ok) { apiWhy = "answered " + r.status; return null; }
      const t = await r.text();
      if (!t.trim()) { apiWhy = "sent nothing"; return null; }        // bioRxiv's details endpoint, lately
      try { return JSON.parse(t); } catch { apiWhy = "sent something unreadable"; return null; }
    })
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

/** Crossref registers bioRxiv's DOIs and holds the abstract bioRxiv deposits. */
export async function crossrefAbstract(u: string, timeoutMs: number): Promise<Out | null> {
  const id = preprintDoi(u);
  if (!id) return null;
  const d = await getJSON("https://api.crossref.org/works/" + id.doi, timeoutMs).catch(() => null) as
    { message?: Record<string, unknown> } | null;
  const m = d && d.message && typeof d.message === "object" ? d.message : null;
  const jats = m && typeof m.abstract === "string" ? m.abstract : "";
  const paras = decodeEntities(jats.replace(/<jats:title>[\s\S]*?<\/jats:title>/gi, "")
    .replace(/<\/(jats:)?p>/gi, "\n\n").replace(/<[^>]+>/g, " ")).split(/\n\s*\n/).map(tidy).filter(Boolean);
  if (paras.join(" ").length < 80) return null;
  const names = (Array.isArray(m!.author) ? m!.author as Record<string, unknown>[] : [])
    .filter((a) => a && typeof a.family === "string")
    .map((a) => tidy(a.family as string) + (typeof a.given === "string" && a.given.trim()
      ? ", " + (a.given as string).trim().split(/\s+/).map((w) => w[0] + ".").join(" ") : ""));
  const host = id.server === "medrxiv" ? "medRxiv" : "bioRxiv";
  return { v: 1, url: u, text: [authorsShort(names.join("; ")), ...paras].filter(Boolean).join("\n\n"), complete: true,
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
  const pre = preprintDoi(url);
  if (pre) {
    // a preprint server's pages are an anti-bot wall or a site-wide slogan:
    // never scraped. Its own API, then Crossref, or an honest reason.
    const a = (await preprintAbstract(url, timeoutMs).catch(() => null)) || (await crossrefAbstract(url, timeoutMs).catch(() => null));
    if (a) return a;
    const host = pre.server === "medrxiv" ? "medRxiv" : "bioRxiv";
    return { v: 1, url, text: "", complete: false,
             error: "no abstract yet (" + host + "'s API " + (apiWhy || "had none") + ", and Crossref had none)" };
  }
  // a PubMed record: its abstract from Europe PMC's copy of PubMed
  const pm = /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,9})\/?(?:[?#].*)?$/i.exec(url);
  const api = await epmcAbstract(pm ? "https://europepmc.org/article/MED/" + pm[1] : url, timeoutMs).catch(() => null);
  if (api) api.url = url;
  if (api) return api;
  const apiNote = "";
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

/** Tide highs and lows for the app, when a browser refuses NOAA's API (CORS).
 *  Only a station ID and a date pass through, to one fixed NOAA query: this is
 *  never an open proxy. Cached at the edge for six hours. */
async function tide(q: URLSearchParams, allow: string): Promise<Response> {
  const sid = q.get("tide") || "", day = q.get("d") || "";
  if (!/^[0-9A-Z]{5,10}$/.test(sid) || !/^20\d{6}$/.test(day)) return reply({ v: 1, error: "bad request" }, 400, allow);
  const url = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=LowPingNews" +
              "&begin_date=" + day + "&range=96&datum=MLLW&station=" + sid + "&time_zone=gmt&interval=hilo&units=english&format=json";
  const d = await getJSON(url, TIMEOUT_MS * 2).catch(() => null) as { predictions?: unknown[]; error?: { message?: unknown } } | null;
  const preds = d && Array.isArray(d.predictions)
    ? d.predictions.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").slice(0, 40)
        .map((x) => ({ t: String(x.t).slice(0, 16), v: String(x.v).slice(0, 10), type: String(x.type).slice(0, 2) }))
    : null;
  return noaa(preds ? { predictions: preds } : null, d, allow);
}

/** Tidal-current maxima and slacks, on the same terms: only a station, its
 *  depth bin and a date pass through, to one fixed NOAA query. */
async function current(q: URLSearchParams, allow: string): Promise<Response> {
  const sid = q.get("cur") || "", bin = q.get("bin") || "", day = q.get("d") || "";
  if (!/^[0-9A-Za-z]{4,12}$/.test(sid) || !/^\d{1,2}$/.test(bin) || !/^20\d{6}$/.test(day)) return reply({ v: 1, error: "bad request" }, 400, allow);
  const url = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=LowPingNews" +
              "&begin_date=" + day + "&range=96&station=" + sid + "&bin=" + bin + "&time_zone=gmt&interval=MAX_SLACK&units=english&format=json";
  const d = await getJSON(url, TIMEOUT_MS * 2).catch(() => null) as { current_predictions?: { cp?: unknown[] }; error?: { message?: unknown } } | null;
  const cp = d && d.current_predictions && Array.isArray(d.current_predictions.cp)
    ? d.current_predictions.cp.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").slice(0, 60)
        .map((x) => ({ Type: String(x.Type).slice(0, 8), Time: String(x.Time).slice(0, 16), Velocity_Major: Number(x.Velocity_Major),
                       meanFloodDir: Number(x.meanFloodDir), meanEbbDir: Number(x.meanEbbDir) }))
    : null;
  return noaa(cp && cp.length ? { current_predictions: { cp } } : null, d, allow);
}

/** NOAA's answer passed on: the trimmed body, or why there is none. */
function noaa(body: unknown, d: { error?: { message?: unknown } } | null, allow: string): Response {
  const out = body || { error: { message: d && d.error ? tidy(String(d.error.message || "")).slice(0, 160) : "NOAA " + (apiWhy || "did not answer") } };
  return new Response(JSON.stringify(out), { status: body ? 200 : 502, headers: {
    "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": allow, Vary: "Origin",
    "Cache-Control": body ? "public, max-age=21600" : "no-store", "X-LPN-Reader": VERSION,
    "Access-Control-Expose-Headers": "X-LPN-Reader" } });
}

// ---- the site's update: started on time, and explained when it is not ------
const GH_API = "https://api.github.com";
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** "owner/repo" behind the app's site: its github.io address says, or GH_REPO. */
export function repoOf(site: string, override?: string): string {
  const ok = (x: string): string => (SLUG.test(x) && !/\/\.\.?$/.test(x) ? x : "");
  if (override) return ok(override.trim());
  try {
    const u = new URL(site);
    const m = /^([a-z0-9-]{1,39})\.github\.io$/i.exec(u.hostname);
    if (!m) return "";
    const first = u.pathname.split("/").filter(Boolean)[0];
    return ok(m[1] + "/" + (first || u.hostname));      // a user site's repository is named after its host
  } catch { return ""; }
}

function ghHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": UA };
  if (token) h.Authorization = "Bearer " + token;
  return h;
}
const tokenOf = (env: Env): string => { const t = (env.GH_TOKEN || "").trim(); return /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : ""; };

/** Start the site's update: one request to GitHub. Without a token, nothing. */
export async function kick(env: Env): Promise<{ ok: boolean; status: number; why: string }> {
  const token = tokenOf(env), repo = repoOf(env.SITE || SITE, env.GH_REPO);
  const ref = /^[A-Za-z0-9._\/-]{1,100}$/.test(env.GH_REF || "") ? env.GH_REF! : "main";
  if (!token) return { ok: false, status: 0, why: env.GH_TOKEN ? "the token is malformed" : "no token yet: lpn schedule" };
  if (!repo) return { ok: false, status: 0, why: "no repository for this site: set GH_REPO" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(GH_API + "/repos/" + repo + "/actions/workflows/web.yml/dispatches", {
      method: "POST", signal: ac.signal, headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref }) });
    const why = r.ok ? "" : r.status === 401 ? "GitHub refused the token (expired or revoked): lpn schedule"
      : r.status === 403 || r.status === 404 ? "the token cannot start this repository's update (Actions: Read and write)"
      : r.status === 422 ? "GitHub would not start the update (" + ref + ")" : "GitHub answered " + r.status;
    return { ok: r.ok, status: r.status, why };
  } catch (e) {
    return { ok: false, status: 0, why: (e as Error).name === "AbortError" ? "GitHub took too long" : "GitHub could not be reached" };
  } finally { clearTimeout(timer); }
}

export interface Pipeline { state: "ok" | "running" | "waiting" | "approval" | "failing" | "idle" | "unknown";
                            since: number; lastOk: number; run: number }
/** Where the site's update stands, from GitHub's list of its runs (newest
 *  first): stuck waiting, failing, not being started, running, or fine. */
export function pipeline(raw: unknown, now: number): Pipeline {
  const out: Pipeline = { state: "unknown", since: 0, lastOk: 0, run: 0 };
  const list = raw && typeof raw === "object" && Array.isArray((raw as { workflow_runs?: unknown }).workflow_runs)
    ? (raw as { workflow_runs: unknown[] }).workflow_runs : [];
  const t = (v: unknown): number => { const x = typeof v === "string" ? Date.parse(v) / 1000 : NaN; return isFinite(x) ? x : 0; };
  const runs = list.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({ n: typeof r.run_number === "number" ? r.run_number : 0, status: String(r.status || ""),
                   end: String(r.conclusion || ""), at: t(r.created_at), done: t(r.updated_at) }))
    .filter((r) => r.at > 0 && r.at <= now + 600).sort((a, b) => b.at - a.at);
  if (!runs.length) return out;
  const ok = runs.find((r) => r.end === "success");
  out.lastOk = ok ? ok.done || ok.at : 0;
  const after = runs.filter((r) => !ok || r.at > ok.at);           // runs since the last good one, newest first
  out.since = after.length ? after[after.length - 1].at : 0;
  const newest = runs[0];
  // a run held at its publish step blocks every run after it (they queue, or
  // cancel each other): any one waiting more than a few minutes is the story
  const held = after.find((r) => r.status === "waiting" && now - r.at > 300);
  if (held) { out.state = "waiting"; out.run = held.n; return out; }
  const bad = after.find((r) => r.status === "completed" && ["failure", "startup_failure", "timed_out", "action_required"].includes(r.end));
  if (bad && after.filter((r) => r.status === "completed" && r.end !== "cancelled" && r.end !== "skipped").every((r) => r.end !== "success")) {
    out.state = "failing"; out.run = bad.n; return out;
  }
  if (newest.status !== "completed" && now - newest.at > 30 * 60) { out.state = "waiting"; out.run = newest.n; return out; }  // queued for ages
  if (now - newest.at > 90 * 60) { out.state = "idle"; out.since = newest.at; out.run = newest.n; return out; }
  if (newest.status !== "completed") { out.state = "running"; out.run = newest.n; return out; }
  out.state = "ok";
  return out;
}

/** The app's question when its news is stale: why? One small answer, kept
 *  five minutes at the edge so many phones cost GitHub one request. */
async function why(env: Env, allow: string): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request("https://reader.cache/why");
  const send = (body: unknown, cacheable: boolean): Response => new Response(JSON.stringify(body), { status: 200, headers: {
    "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": allow, Vary: "Origin",
    "Cache-Control": cacheable ? "public, max-age=300" : "no-store", "X-LPN-Reader": VERSION, "Access-Control-Expose-Headers": "X-LPN-Reader" } });
  if (cache) { const hit = await cache.match(key); if (hit) return send(await hit.json(), true); }
  const token = tokenOf(env), repo = repoOf(env.SITE || SITE, env.GH_REPO);
  const now = Date.now() / 1000;
  let p: Pipeline = { state: "unknown", since: 0, lastOk: 0, run: 0 };
  if (repo) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch(GH_API + "/repos/" + repo + "/actions/workflows/web.yml/runs?per_page=20&exclude_pull_requests=true",
                            { signal: ac.signal, headers: ghHeaders(token) });
      if (r.ok) p = pipeline(await r.json(), now);
      if (p.state === "waiting") {        // held for approval, or stuck? the environment says
        const e = await fetch(GH_API + "/repos/" + repo + "/environments/github-pages", { signal: ac.signal, headers: ghHeaders(token) });
        const ej = e.ok ? await e.json() as { protection_rules?: { type?: string }[] } : null;
        if (ej && Array.isArray(ej.protection_rules) && ej.protection_rules.some((x) => x && x.type === "required_reviewers")) p.state = "approval";
      }
    } catch { /* unknown, said as such */ } finally { clearTimeout(timer); }
  }
  const body = { v: 1, ...p, schedule: !!token };
  if (cache && p.state !== "unknown") await cache.put(key, new Response(JSON.stringify(body), { headers: { "Cache-Control": "public, max-age=300" } }));
  return send(body, p.state !== "unknown");
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
    if (q.has("why")) return why(env, allow);
    if (q.has("tide")) return tide(q, allow);
    if (q.has("cur")) return current(q, allow);
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
  // Cloudflare's cron (set up by lpn schedule): start the site's update on time
  async scheduled(_event: unknown, env: Env = {}): Promise<void> {
    const r = await kick(env);
    if (!r.ok) console.log("site update not started: " + r.why);
  },
};
