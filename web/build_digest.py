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
            if len(rows) >= KEEP:
                break
        doc = {"v": 1, "t": int(now), "app": m.VERSION, "cat": c, "cats": cat_list, "src": names,
               "items": rows,
               "failed": [[n, a] for n, a in sorted(failed.items()) if n in names or
                          any(n == x["name"] and c in x["cats"] for x in srcs)]}
        body = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
        with io.open(os.path.join(data, c + ".json"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(body)
        sizes[c] = len(body.encode("utf-8"))
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
    for c, n in sorted(sizes.items()):
        raw = io.open(os.path.join(out, "data", c + ".json"), "rb").read()
        print("  %-8s %6.1f KB, %5.1f KB compressed" % (c, n / 1024.0, len(gzip.compress(raw)) / 1024.0))


if __name__ == "__main__":
    main()
