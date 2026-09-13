# LowPingNews

A terminal news reader for bad connections.

One file, Python standard library only, no pip install. Built for Termux on a
phone with one bar of signal, where every kilobyte and every TLS handshake
costs you.

```
$ news science
NEWS · science  Sun 13 Sep 09:12

  1 Phys.org · 12m
    ● ↓ Ancient fern genome sequenced
    The fifty-gigabase assembly took years of compute and a
    rethink of how repeats are scaffolded…

  2 Quanta · 1h
    ● A new proof settles an old question about primes
    …

  12 items · 4.1KB · 3 unchanged (304) · news -r N to read
```

## Why

Most feed readers assume bandwidth. This one assumes you don't have any.

- **Conditional GET.** Feeds are re-requested with `ETag` / `If-Modified-Since`.
  An unchanged feed returns `304 Not Modified` with no body at all.
- **Few hosts, deliberately.** TLS handshake is roughly 4 KB per host no matter
  how small the payload. Host count dominates everything else, so the default
  set is small on purpose. Adding a sixth feed costs more than it looks like.
- **No background polling.** Nothing refreshes unless you ask it to. A timer
  that silently re-handshakes five hosts is the fastest way to make this worse
  than doing nothing.
- **Full text from the feed when possible.** Many feeds ship the whole article
  in `content:encoded`. That's already paid for, so reading it costs zero.
- **Offline library.** Download articles while you have signal, read them in
  the dead zone.
- **Everything caches.** A dead feed falls back to its last good copy rather
  than failing the run.

## Install

```sh
git clone https://github.com/ATinyGreenCell/LowPingNews
cd LowPingNews
sh install.sh
news --check
```

Or by hand:

```sh
cp news $PREFIX/bin/ && chmod +x $PREFIX/bin/news
sed -i "1s|.*|#!$(command -v python3)|" $PREFIX/bin/news
```

Requires Python 3.8+. Nothing else.

Run `news --check` first — it fetches every configured feed and reports
ok / empty / fail with item count, size and latency. Feed URLs rot; this tells
you which ones have.

## Usage

```
news                    latest across the default category
news science            a category: top world science tech bio all
news saved              your starred items
news -q fern            search cached headlines, no network

news -r 4               read item 4 as text
news -d 2,3,5           download article bodies for offline reading
news -d all             download everything in the current list
news -o 4               open item 4 in a browser

news -u                 hide items you've already read
news --mark-all         mark the current list read
news -S 4               star / unstar item 4

news -f                 bypass the 15-minute cache
news -n 3               fewer items per source
news -s hn,bbc          only these source ids
news -t                 headlines only, no summaries
news -l                 list sources and categories
news --check            test every feed URL
news --update URL       replace this script with the latest
```

Item numbers refer to the last list you printed.

Markers: `●` unread, `↓` article text available offline.

## Sources

Defaults lean on center-rated and specialist outlets, and put the
politically-charged material in categories you have to ask for:

| category  | sources                                        |
|-----------|------------------------------------------------|
| `top`     | BBC World, CS Monitor, DW, Phys.org, Ars Technica |
| `world`   | the above plus Al Jazeera, France 24           |
| `science` | Phys.org, ScienceDaily, Quanta, Nature         |
| `tech`    | Ars Technica, The Register, Hacker News        |
| `bio`     | bioRxiv plant biology, bioRxiv synthetic biology |

No outlet is unbiased, and an aggregator's real bias is in which feeds it
picks. That choice is a plain JSON file — edit it:

```sh
$EDITOR ~/.config/news/sources.json
```

```json
{"id": "eos", "name": "Eos", "kind": "rss",
 "url": "https://eos.org/feed", "cats": ["science"]}
```

`kind` is `rss` (RSS 2.0, RSS 1.0/RDF and Atom are all handled) or `hn` for the
Hacker News Algolia API. Only `http`/`https` URLs are accepted.

## Data behaviour

| action                        | over the wire                       |
|-------------------------------|-------------------------------------|
| within the 15-minute cache    | nothing, no socket opened           |
| refresh, feed unchanged       | handshake + 304, no body            |
| refresh, feed changed         | handshake + gzipped feed            |
| `news -r N`, text in feed     | nothing                             |
| `news -r N`, already downloaded | nothing                           |
| `news -r N`, neither          | one page fetch, size reported       |

`-d` prints a per-item ledger so you can see what a batch cost before you
commit to it.

## Files

```
~/.config/news/sources.json     feeds and categories (edit this)
~/.config/news/update.url       remembered --update source
~/.cache/news/*.json            feed cache + ETag validators
~/.local/share/news/state.json  read and starred items
~/.local/share/news/art/        offline article text, 3 MB cap, oldest evicted
```

Config is deliberately outside the cache, so clearing the cache never eats
your source list.

## Updating

```sh
news --update https://raw.githubusercontent.com/ATinyGreenCell/LowPingNews/main/news
news --update      # afterwards, remembers the URL
```

The download is verified before anything is overwritten — size floor, a
content marker, and a full `ast.parse()` — because a truncated download is the
normal failure on a lossy link and a half-written file still installs cleanly
enough to break the command. The replace is atomic and the previous version is
kept at `news.bak`.

## Limitations

- Article extraction is a paragraph heuristic with no JavaScript. Paywalled or
  client-rendered pages return "no readable paragraphs" rather than text.
- `-d all` on a full list can mean several hundred KB. The ledger tells you
  after the fact, not before.
- Feeds must be public. No authentication, no OPML import.
- `-o` uses `termux-open-url` when present, otherwise it just prints the URL.

## Hardening

Tested against a hostile `sources.json` (path-traversal ids, duplicate ids,
`file://` URLs, non-dict entries), a 40 MB gzip bomb, oversized and malformed
feeds, corrupt cache and state files, non-UTF-8 terminals (`LANG=C`), and
titles in scripts with no Latin characters. Downloads are capped at 2 MB for
feeds and 5 MB for pages, decompression is bounded, source ids are sanitised
before they become filenames, and every state write fails soft.

## License

MIT
