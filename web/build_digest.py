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


def fetch_abstract(server, pid, timeout=15):
    import urllib.request
    base = PREPRINT_API or ("https://api.%s.org" % server)
    url = "%s/details/%s/10.1101/%s/na/json" % (base.rstrip("/"), server, pid)
    req = urllib.request.Request(url, headers={"User-Agent": "LowPingNews-site (github.com/ATinyGreenCell/LowPingNews)",
                                               "Accept": "application/json", "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read(2 * 1024 * 1024)
        if (r.headers.get("Content-Encoding") or "").lower() == "gzip":
            import gzip
            raw = gzip.decompress(raw)
        d = json.loads(raw.decode("utf-8", "replace"))
    coll = d.get("collection") if isinstance(d, dict) else None
    if not isinstance(coll, list) or not coll or not isinstance(coll[-1], dict):
        return None
    p = coll[-1]                                     # the latest posted version
    abstract = "\n\n".join(clean(x, 4000) for x in str(p.get("abstract") or "").split("\n\n") if x.strip())
    if not abstract:
        return None
    return {"v": 1, "server": server, "doi": "10.1101/" + pid, "abstract": abstract[:8000],
            **{k: clean(p.get(k), 600) for k in ("authors", "date", "version", "category", "published")}}


def write_abstracts(m, out_dir, links, now):
    cache_f = os.path.join(m.CD, "abstracts.json")
    cache = m.jread(cache_f, {})
    if not isinstance(cache, dict):
        cache = {}
    ids = sorted({x for x in (preprint_id(l) for l in links) if x})
    adir = os.path.join(out_dir, "data", "abs")
    os.makedirs(adir, exist_ok=True)
    asked = written = 0
    for server, pid in ids:
        k = "%s-%s" % (server, pid)
        c = cache.get(k) or {}
        due = (now - c.get("t", 0)) > (ABS_KEEP if c.get("doc") else ABS_RETRY)
        if due and asked < ABS_NEW_MAX:
            asked += 1
            try:
                doc = fetch_abstract(server, pid)
            except Exception:
                doc = None
            c = {"t": int(now), "doc": doc or c.get("doc")}   # a failed refresh keeps the old copy
            cache[k] = c
        if c.get("doc"):
            with io.open(os.path.join(adir, k + ".json"), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(json.dumps(c["doc"], ensure_ascii=False, separators=(",", ":")))
            written += 1
    keep = {"%s-%s" % i for i in ids}
    m.jwrite(cache_f, {k: v for k, v in cache.items() if k in keep})   # only what is still listed
    return asked, written


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


def clean(s, n):
    s = " ".join(str(s or "").split())
    return "".join(ch for ch in s if ch >= " " and ch != "\x7f")[:n]


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
            rows.append([names.index(name), title, clean(it.get("s"), SUMMARY),
                         m.safe_url(it.get("u") or "") or "", epoch(m, it, now)])
            all_links.append(rows[-1][3])
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
    asked, written = sizes.pop("(abstracts)")
    print("  preprint abstracts: %d published, %d asked of bioRxiv this run" % (written, asked))
    for c, n in sorted(sizes.items()):
        raw = io.open(os.path.join(out, "data", c + ".json"), "rb").read()
        print("  %-8s %6.1f KB, %5.1f KB compressed" % (c, n / 1024.0, len(gzip.compress(raw)) / 1024.0))


if __name__ == "__main__":
    main()
