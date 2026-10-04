#!/usr/bin/env python3
"""Build the LowPingNews web app: static files plus one small JSON file per
category, made with the terminal app's own fetching and parsing.

    python3 web/build_digest.py OUT_DIR

Run by GitHub Actions every 20 minutes. A phone browser cannot read most news
feeds itself (they do not allow other sites to fetch them), so this reads them
here and publishes the result beside the app, where the phone can. One small
request per category replaces a dozen feeds and their handshakes.
"""
import io
import json
import os
import re
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STATIC = os.path.join(HERE, "static")
KEEP = 60                # stories per category: ten shown, the rest for "more"
SUMMARY = 220            # characters of summary kept per story
TITLE = 300
SKIP_CATS = {"app"}      # release notes are for the terminal app
# the article reader's address (a Cloudflare Worker), from the READER_URL
# repository variable; https only. Empty: the app offers summaries and links.
READER = os.environ.get("LPN_READER_URL", "").strip()
if not READER.startswith("https://") or any(ch in READER for ch in " \"'<>"):
    READER = ""


# ---- preprint abstracts: fetched here, published beside the app -----------
# bioRxiv refuses requests from Cloudflare's servers (where the reader runs),
# so the reader cannot fetch them. This runs on GitHub's servers: it asks
# bioRxiv's official API once per preprint and writes a ~1 KB file the app
# reads from its own site. Abstracts are what bioRxiv's API and feeds already
# distribute openly; full papers are never copied.
PREPRINT = re.compile(r"^https?://(?:www\.|connect\.)?(biorxiv|medrxiv)\.org/"
                      r"(?:content/(?:early/\d{4}/\d{2}/\d{2}/)?|cgi/content/(?:short|abstract|full)/)"
                      r"(?:10\.1101/)?(\d{4}\.\d{2}\.\d{2}\.\d{5,8}|\d{6})(?:v\d+)?", re.I)
PREPRINT_API = os.environ.get("LPN_PREPRINT_API", "")   # tests only; real: https://api.<server>.org
ABS_NEW_MAX = 80          # API calls per run, at most
ABS_KEEP = 7 * 86400      # refresh a cached abstract weekly (new versions)
ABS_RETRY = 3600          # after a failure, wait this long before asking again


def preprint_id(link):
    m = PREPRINT.match(link or "")
    return (m.group(1).lower(), m.group(2)) if m else None


def _get_json(url, timeout=15):
    """GET JSON from an open API. None if it fails or sends nothing usable
    (bioRxiv's per-paper endpoint has been answering 200 with an empty body)."""
    import gzip, urllib.request
    req = urllib.request.Request(url, headers={
        "User-Agent": "LowPingNews-site/1 (https://github.com/ATinyGreenCell/LowPingNews)",
        "Accept": "application/json", "Accept-Encoding": "gzip"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(2 * 1024 * 1024)
            if (r.headers.get("Content-Encoding") or "").lower() == "gzip":
                raw = gzip.decompress(raw)
        d = json.loads(raw.decode("utf-8", "replace")) if raw.strip() else None
    except Exception:
        return None
    return d if isinstance(d, dict) else None


def _paras(text, n=8000):
    return "\n\n".join(p for p in (clean(x, 4000) for x in re.split(r"\n\s*\n", str(text or ""))) if p)[:n]


def from_crossref(pid):
    """Crossref, which registers bioRxiv's DOIs, holds the abstract bioRxiv deposited."""
    base = PREPRINT_API or "https://api.crossref.org"
    d = _get_json("%s/works/10.1101/%s" % (base.rstrip("/"), pid))
    msg = d.get("message") if d else None
    if not isinstance(msg, dict) or not isinstance(msg.get("abstract"), str):
        return None
    jats = re.sub(r"<jats:title>.*?</jats:title>", "", msg["abstract"], flags=re.S | re.I)
    text = _paras(re.sub(r"<[^>]+>", " ", re.sub(r"</jats:p>|</p>", "\n\n", jats, flags=re.I)))
    import html
    text = _paras(html.unescape(text))
    if len(text) < 80:
        return None
    names = []
    for a in msg.get("author") or []:
        if isinstance(a, dict) and (a.get("family") or a.get("name")):
            g = str(a.get("given") or "")
            names.append(clean(a.get("family") or a.get("name"), 80) + (", " + " ".join(w[0] + "." for w in g.split() if w) if g.strip() else ""))
    dp = ((msg.get("posted") or msg.get("created") or {}).get("date-parts") or [[None]])[0]
    date = "-".join("%02d" % x if i else str(x) for i, x in enumerate(dp) if isinstance(x, int)) if dp and dp[0] else ""
    return {"abstract": text, "authors": "; ".join(names)[:600], "date": date, "src": "crossref"}


def from_biorxiv(server, pid):
    base = PREPRINT_API or ("https://api.%s.org" % server)
    d = _get_json("%s/details/%s/10.1101/%s/na/json" % (base.rstrip("/"), server, pid))
    coll = d.get("collection") if d else None
    if not isinstance(coll, list) or not coll or not isinstance(coll[-1], dict):
        return None
    p = coll[-1]                                     # the latest posted version
    text = _paras(p.get("abstract"))
    if not text:
        return None
    out = {k: clean(p.get(k), 600) for k in ("authors", "date", "version", "category", "published")}
    out.update(abstract=text, src="biorxiv")
    return out


def _day(epoch):
    """A feed item's time (seconds) as YYYY-MM-DD; nothing if absent or odd."""
    try:
        return time.strftime("%Y-%m-%d", time.gmtime(int(epoch))) if epoch and int(epoch) > 0 else ""
    except (TypeError, ValueError, OverflowError, OSError):
        return ""


FEED_FULL = 300   # a feed text at least this long is taken as the whole abstract


PUBMED = re.compile(r"^https?://pubmed\.ncbi\.nlm\.nih\.gov/(\d{1,9})/?(?:[?#].*)?$", re.I)


def paper_id(link):
    """("biorxiv"|"medrxiv", id) for a preprint, ("pubmed", pmid) for a PubMed record."""
    p = preprint_id(link)
    if p:
        return p
    m = PUBMED.match(link or "")
    return ("pubmed", m.group(1)) if m else None


def from_epmc(pmids):
    """Europe PMC's copy of PubMed: abstracts for many PMIDs in one request."""
    from urllib.parse import quote
    base = PREPRINT_API or "https://www.ebi.ac.uk"
    q = "(" + " OR ".join("EXT_ID:" + x for x in pmids) + ") AND SRC:MED"
    d = _get_json("%s/europepmc/webservices/rest/search?query=%s&resultType=core&format=json&pageSize=%d"
                  % (base.rstrip("/"), quote(q, safe=""), len(pmids)), timeout=30)
    res = ((d or {}).get("resultList") or {}).get("result") if d else None
    out = {}
    import html
    for r in res if isinstance(res, list) else []:
        if not isinstance(r, dict) or str(r.get("pmid") or r.get("id") or "") not in pmids:
            continue
        raw = str(r.get("abstractText") or "")
        text = _paras(html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"</?(h\d|p|br|div)[^>]*>", "\n\n", raw, flags=re.I))))
        if len(text) < 80:
            continue
        doi = str(r.get("doi") or "")
        out[str(r.get("pmid") or r.get("id"))] = {
            "abstract": text, "authors": clean(str(r.get("authorString") or "").replace(", ", "; "), 600),
            "journal": clean(r.get("journalTitle") or (r.get("journalInfo") or {}).get("journal", {}).get("title"), 200),
            "date": clean(r.get("firstPublicationDate") or r.get("pubYear"), 10),
            "published": doi if re.match(r"^10\.\S+$", doi) else "", "src": "europepmc"}
    return out


def write_abstracts(m, out_dir, items, now):
    """items: (link, feed item) for every story listed. Each preprint or PubMed
    record gets data/abs/<server>-<id>.json, read by the app from its own site.
    A preprint feed's own text is used when it is the whole abstract (bioRxiv's
    feeds carry it): nothing more is downloaded. Otherwise Crossref, then
    bioRxiv's API; PubMed records come from Europe PMC, many per request.
    Each paper is asked about once, then cached."""
    cache_f = os.path.join(m.CD, "abstracts.json")
    cache = m.jread(cache_f, {})
    if not isinstance(cache, dict):
        cache = {}
    best = {}
    for link, it in items:
        pid = paper_id(link)
        if not pid:
            continue
        text = str(it.get("c") or it.get("s") or "")
        if pid not in best or len(text) > len(best[pid][0]):
            best[pid] = (text, it)
    adir = os.path.join(out_dir, "data", "abs")
    os.makedirs(adir, exist_ok=True)
    asked = 0
    docs = {}
    due_pubmed = []
    for (server, pid), (text, it) in sorted(best.items()):
        k = "%s-%s" % (server, pid)
        c = cache.get(k) if isinstance(cache.get(k), dict) else {}
        due = (now - c.get("t", 0)) > (ABS_KEEP if c.get("doc") else ABS_RETRY)
        if server != "pubmed" and len(text) >= FEED_FULL and not text.endswith("\u2026"):
            docs[k] = {"abstract": _paras(text), "authors": clean(it.get("a"), 600),
                       "date": _day(it.get("d")), "src": "feed"}
            cache.pop(k, None)
        elif server == "pubmed":
            if due and len(due_pubmed) < ABS_NEW_MAX:
                due_pubmed.append(pid)
            else:
                docs[k] = c.get("doc")
        else:
            if due and asked < ABS_NEW_MAX:
                asked += 1
                got = from_crossref(pid) or from_biorxiv(server, pid)
                c = {"t": int(now), "doc": got or c.get("doc")}   # a failed refresh keeps the old copy
                cache[k] = c
            docs[k] = c.get("doc")
    for i in range(0, len(due_pubmed), 50):                     # Europe PMC: 50 records a request
        batch = due_pubmed[i:i + 50]
        asked += 1
        got = from_epmc(batch)
        for pid in batch:
            k = "pubmed-" + pid
            old = (cache.get(k) or {}).get("doc") if isinstance(cache.get(k), dict) else None
            cache[k] = {"t": int(now), "doc": got.get(pid) or old}
            docs[k] = cache[k]["doc"]
    written = 0
    for k, doc in sorted(docs.items()):
        if not doc or not doc.get("abstract"):
            continue
        server, pid = k.split("-", 1)
        out = {"v": 1, "server": server}
        out.update({"pmid": pid} if server == "pubmed" else {"doi": "10.1101/" + pid})
        out.update({kk: vv for kk, vv in doc.items() if isinstance(vv, str) and vv and kk not in ("server", "doi", "pmid")})
        with io.open(os.path.join(adir, k + ".json"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
        written += 1
    keep = {"%s-%s" % i for i in best}
    m.jwrite(cache_f, {k: v for k, v in cache.items() if k in keep})   # only what is still listed
    return asked, written


# ---- tides: one small tile per 1-degree square ---------------------------
# NOAA's station lists are megabytes and NDBC's buoys cannot be read from a web
# page (no CORS), so this build gathers them and writes data/tides/<lat>_<lon>.json:
# every tide station and buoy within about 100 km of that square, with each
# buoy's latest reading, and the tidal-current stations within CURR_KM of it.
# A phone fetches only its own tile (a few KB).
TIDE_META = os.environ.get("LPN_TIDE_META") or "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions"
CURR_META = os.environ.get("LPN_CURR_META") or "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=currentpredictions&units=english"
NDBC = os.environ.get("LPN_NDBC") or "https://www.ndbc.noaa.gov"
WEEK = 7 * 86400
CURR_KM = 40        # a current is local, and harbours are dense with stations: keep tiles small


def _get_text(url, timeout=30, cap=8 * 1024 * 1024):
    import gzip, urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "LowPingNews-site/1 (https://github.com/ATinyGreenCell/LowPingNews)",
                                               "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read(cap)
        if (r.headers.get("Content-Encoding") or "").lower() == "gzip":
            raw = gzip.decompress(raw)
    return raw.decode("utf-8", "replace")


def _weekly(m, name, fetch, now):
    """A slow-changing list: refetched weekly; a failed refetch keeps the old one."""
    f = os.path.join(m.CD, name)
    c = m.jread(f, {})
    if not isinstance(c, dict):
        c = {}
    if now - c.get("t", 0) > WEEK or not c.get("d"):
        try:
            d = fetch()
            if d:
                c = {"t": int(now), "d": d}
                m.jwrite(f, c)
        except Exception as e:
            print("  (%s not refreshed: %s)" % (name, str(e)[:80]))
    return c.get("d") or []


def tide_stations():
    d = json.loads(_get_text(TIDE_META))
    out = []
    for x in (d.get("stations") if isinstance(d, dict) else None) or []:
        try:
            sid, lat, lon = str(x["id"]), float(x["lat"]), float(x.get("lng", x.get("lon")))
        except (KeyError, TypeError, ValueError):
            continue
        if not re.match(r"^[0-9A-Z]{5,10}$", sid) or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        name = clean(x.get("name"), 50) + (", " + clean(x.get("state"), 4) if x.get("state") else "")
        out.append([sid, name, round(lat, 4), round(lon, 4)])
    return out


def current_stations():
    """NOAA's tidal-current prediction stations: [id, name, lat, lon, bin].
    The list repeats a station once per depth bin, shallowest first: keep the
    shallowest, the water a boat or a swimmer is in. NOAA answers "not
    available" for a station asked without one of its listed bins."""
    d = json.loads(_get_text(CURR_META))
    best = {}
    for x in (d.get("stations") if isinstance(d, dict) else None) or []:
        try:
            sid, lat, lon = str(x["id"]), float(x["lat"]), float(x.get("lng", x.get("lon")))
            b = x.get("currbin")
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if (not re.match(r"^[0-9A-Za-z]{4,12}$", sid) or isinstance(b, bool) or not isinstance(b, int)
                or not 0 <= b <= 99 or not (-90 <= lat <= 90 and -180 <= lon <= 180)):
            continue
        if sid not in best or b < best[sid][4]:
            best[sid] = [sid, clean(x.get("name"), 50), round(lat, 4), round(lon, 4), b]
    return list(best.values())


def buoy_names():
    import xml.etree.ElementTree as ET
    root = ET.fromstring(_get_text(NDBC + "/activestations.xml"))
    return {clean(e.get("id"), 10).upper(): clean(e.get("name"), 50) for e in root.iter("station") if e.get("id")}


def buoy_obs(now):
    """NDBC's one file of every station's latest reading (metric, UTC)."""
    import calendar
    lines = _get_text(NDBC + "/data/latest_obs/latest_obs.txt").splitlines()
    head = next((l.lstrip("#").split() for l in lines if l.startswith("#") and "LAT" in l.upper()), None)
    if not head:
        return []
    col = {h.upper(): i for i, h in enumerate(head)}
    need = ("STN", "LAT", "LON", "YYYY", "MM", "DD", "HH", "MM_")
    out = []
    for l in lines:
        if l.startswith("#") or not l.strip():
            continue
        v = l.split()
        if len(v) < len(head):
            continue
        num = lambda k: (None if k not in col or v[col[k]] in ("MM", "N/A") else float(v[col[k]]))
        try:
            # the header names minutes "mm" and months "MM": they are the 5th and 8th columns
            t = calendar.timegm((int(v[3]), int(v[4]), int(v[5]), int(v[6]), int(v[7]), 0))
            lat, lon = float(v[1]), float(v[2])
            row = [clean(v[0], 10).upper(), "", round(lat, 3), round(lon, 3), t,
                   num("WTMP"), num("WVHT"), num("DPD"), num("WDIR"), num("WSPD"), num("GST"), num("ATMP")]
        except (ValueError, IndexError, OverflowError):
            continue
        if now - t <= 6 * 3600 and -90 <= lat <= 90 and -180 <= lon <= 180:
            out.append(row)
    return out


def write_tides(m, out_dir, now):
    import math
    st = _weekly(m, "tide-stations.json", tide_stations, now)
    cur = _weekly(m, "current-stations.json", current_stations, now)
    names = _weekly(m, "buoy-names.json", buoy_names, now)
    try:
        obs = buoy_obs(now)
    except Exception as e:
        print("  (buoy readings not fetched: %s)" % str(e)[:80])
        obs = []
    for b in obs:
        b[1] = (names.get(b[0]) if isinstance(names, dict) else "") or ""
    tiles = {}
    for kind, rows in (("s", st), ("b", obs)):
        for r in rows:
            la, lo = int(math.floor(r[2])), int(math.floor(r[3]))
            for dla in (-1, 0, 1):
                for dlo in (-1, 0, 1):
                    k = "%d_%d" % (la + dla, (lo + dlo + 180) % 360 - 180)
                    tiles.setdefault(k, {"s": [], "b": [], "c": []})[kind].append(r)
    for r in cur:                       # only the squares it is within CURR_KM of, not all nine
        la, lo = int(math.floor(r[2])), int(math.floor(r[3]))
        for dla in (-1, 0, 1):
            for dlo in (-1, 0, 1):
                a0, o0 = la + dla, lo + dlo
                if m.km(r[2], r[3], min(max(r[2], a0), a0 + 1), min(max(r[3], o0), o0 + 1)) <= CURR_KM:
                    k = "%d_%d" % (a0, (o0 + 180) % 360 - 180)
                    tiles.setdefault(k, {"s": [], "b": [], "c": []})["c"].append(r)
    tdir = os.path.join(out_dir, "data", "tides")
    os.makedirs(tdir, exist_ok=True)
    for k, d in tiles.items():
        # nb: buoy readings in the whole build, so a phone can tell "none near
        # you" from "NDBC did not answer this build"
        with io.open(os.path.join(tdir, k + ".json"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps({"v": 1, "t": int(now), "reader": READER, "nb": len(obs),
                                 "s": d["s"], "b": d["b"], "c": d["c"]},
                                ensure_ascii=False, separators=(",", ":")))
    return len(st), len(obs), len(cur), len(tiles)


def load_news():
    import importlib.util
    from importlib.machinery import SourceFileLoader
    spec = importlib.util.spec_from_loader("news", SourceFileLoader("news", os.path.join(ROOT, "news")))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def feed_list(m):
    """The web app's feeds: web/feeds.json if present, else the built-in catalog."""
    p = os.environ.get("LPN_WEB_FEEDS") or os.path.join(HERE, "feeds.json")
    if os.path.exists(p):
        with io.open(p, encoding="utf-8") as fh:
            feeds = json.load(fh)
        cats = {}
    else:
        cat = json.loads(m.CATALOG_SEED)
        feeds, cats = cat["feeds"], cat.get("cats", {})
    out = []
    for f in feeds:
        if not isinstance(f, dict) or not f.get("id") or not f.get("url"):
            continue
        fc = [c for c in (f.get("cats") or []) if c not in SKIP_CATS]
        if not fc or not m.feed_url(f["url"]):
            continue
        out.append(dict(f, kind=f.get("kind") or "rss", cats=fc))
    return out, cats


def epoch(m, it, now):
    d = it.get("d")
    if isinstance(d, (int, float)):           # stored items already hold epoch seconds
        t = d
    else:
        t = m.when(str(d)) if d else None
    if not t or t > now + 600:           # undated, or dated in the future: unknown
        return 0
    return int(t)


# controls, C1 controls and invisible direction overrides: never published
BAD = re.compile(u"[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]")


def clean(s, n):
    s = " ".join(str(s or "").split())
    return BAD.sub("", s)[:n]


def build(out_dir, now=None):
    m = load_news()
    now = now or time.time()
    srcs, cat_names = feed_list(m)
    bag = m.gather(srcs, False)
    by_cat = {}
    failed = {}
    for x in srcs:
        got = bag.get(x["id"])
        items = []
        if got and got[0]:
            items = got[0]
            if got[2] != 0:                  # served from cache after a failure
                failed[x["name"]] = int(got[2]) if isinstance(got[2], (int, float)) and got[2] > 0 else -1
        else:
            c = m.jread("%s/%s.json" % (m.CD, x["id"]), {})
            items = c.get("items") or []
            failed[x["name"]] = int(m.age_of(c.get("t"))) if c.get("t") else -1
        for c_ in x["cats"]:
            by_cat.setdefault(c_, []).extend((x["name"], it) for it in items if isinstance(it, dict))
    cats = sorted(by_cat, key=lambda c: (c != "top", c))
    cat_list = [[c, cat_names.get(c) or c.title()] for c in cats]
    data = os.path.join(out_dir, "data")
    os.makedirs(data, exist_ok=True)
    sizes = {}
    all_links = []
    for c in cats:
        rows, seen, names = [], set(), []
        for name, it in sorted(by_cat[c], key=lambda r: -m.when_sort(r[1])):
            title = clean(it.get("ti"), TITLE)
            k = m.key(title)
            if not title or k in seen:
                continue
            seen.add(k)
            if name not in names:
                names.append(name)
            rows.append([names.index(name), title, m.preview(clean(it.get("s"), 2000), SUMMARY),
                         m.safe_url(it.get("u") or "") or "", epoch(m, it, now)])
            all_links.append((rows[-1][3], it))
            if len(rows) >= KEEP:
                break
        doc = {"v": 1, "t": int(now), "app": m.VERSION, "cat": c, "cats": cat_list, "src": names,
               "reader": READER,
               "items": rows,
               "failed": [[n, a] for n, a in sorted(failed.items()) if n in names or
                          any(n == x["name"] and c in x["cats"] for x in srcs)]}
        body = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
        with io.open(os.path.join(data, c + ".json"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(body)
        sizes[c] = len(body.encode("utf-8"))
    sizes["(abstracts)"] = write_abstracts(m, out_dir, all_links, now)
    try:
        sizes["(tides)"] = write_tides(m, out_dir, now)
    except Exception as e:                       # tides never stop the news
        print("  (tides skipped: %s)" % str(e)[:120])
        sizes["(tides)"] = (0, 0, 0, 0)
    return sizes


def copy_static(out_dir):
    for name in os.listdir(STATIC):
        src = os.path.join(STATIC, name)
        if os.path.isfile(src):
            shutil.copy(src, os.path.join(out_dir, name))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "site")
    os.makedirs(out, exist_ok=True)
    copy_static(out)
    sizes = build(out)
    import gzip
    ns, nb, nc, nt = sizes.pop("(tides)")
    print("  tides: %d stations, %d buoy readings, %d current stations, %d tiles" % (ns, nb, nc, nt))
    asked, written = sizes.pop("(abstracts)")
    print("  paper abstracts: %d published, %d outside requests this run" % (written, asked))
    for c, n in sorted(sizes.items()):
        raw = io.open(os.path.join(out, "data", c + ".json"), "rb").read()
        print("  %-8s %6.1f KB, %5.1f KB compressed" % (c, n / 1024.0, len(gzip.compress(raw)) / 1024.0))


if __name__ == "__main__":
    main()
