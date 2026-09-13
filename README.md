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
ok / empty / fail with item count, latency, and two sizes: `wire` (compressed,
what your data plan is billed) and `raw` (after decompression). Feed URLs rot;
this tells you which ones have.

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
news --version          print version
```

Item numbers refer to the last list you printed.

Markers: `●` unread, `↓` article text available offline.

Output is coloured: each source keeps a stable hue so you can scan by outlet,
ages shade from green (under an hour) to dim (over a day), read items recede to
dim, and `--check` shades each feed's cost green/yellow/red. Colour is dropped
automatically when piped, when `NO_COLOR` is set, or with `--no-color`; non-UTF-8
terminals fall back to ASCII markers. Every view fits 40 columns.

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

## Measured

Every feed in the default set, fetched from a phone on 2026-09-13:

| feed | items | wire | raw | compressed |
|------|------:|-----:|----:|:----------:|
| bbc | 23 | 4.3 KB | 17.7 KB | yes |
| csm | 20 | 4.4 KB | 11.8 KB | yes |
| aje | 25 | 4.1 KB | 16.8 KB | yes |
| quanta | 5 | 3.1 KB | 11.0 KB | yes |
| phys | 30 | 7.8 KB | 30.8 KB | yes |
| f24 | 24 | 8.5 KB | 27.8 KB | yes |
| sd | 60 | 12.1 KB | 43.0 KB | yes |
| ars | 20 | 18.6 KB | 75.7 KB | yes |
| hn | 20 | 20.7 KB | 20.7 KB | **no** |
| dw | 136 | 26.3 KB | 115.9 KB | yes |
| brxs | 30 | 71.9 KB | 71.9 KB | **no** |
| brxp | 30 | 77.6 KB | 77.6 KB | **no** |
| reg | 50 | 86.6 KB | 246.7 KB | yes |
| nature | 75 | 124.3 KB | 124.3 KB | **no** |

Per category, worst case (every feed changed since last run):

| category | wire | dominated by |
|---|---:|---|
| `top` | ~61 KB | dw (43%) |
| `tech` | ~126 KB | reg (69%) |
| `science` | ~147 KB | nature (84%) |
| `bio` | ~150 KB | both bioRxiv feeds, neither compressed |

Four servers ignore `Accept-Encoding` entirely and send plain text. Advertising
`deflate` alongside `gzip` was tried and changed nothing for them, so that
avenue is closed — the only remaining lever on those feeds is to drop them.

`nature` and `reg` account for most of the total. If you want a leaner default,
retag them in `sources.json` so they're only pulled deliberately: that takes
`science` to ~23 KB and `tech` to ~39 KB.

These are worst-case figures. Conditional GET means an unchanged feed costs a
handshake and a 304, so a second run the same day is close to free.

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
lowpingnews update     # installs the latest from GitHub
```

Or directly, which remembers the URL after the first run:

```sh
news --update https://raw.githubusercontent.com/ATinyGreenCell/LowPingNews/main/news
news --update
```

The download is verified before anything is overwritten — size floor, a
content marker, and a full `ast.parse()` — because a truncated download is the
normal failure on a lossy link and a half-written file still installs cleanly
enough to break the command. The replace is atomic and the previous version is
kept at `news.bak`.

## Development

`lowpingnews` (aliased `lpn`) wraps the build loop. Every command that installs
verifies afterwards that the version it meant to install is the version now on
`PATH`.

```sh
lowpingnews status          installed / repo / newest download / git, flags mismatches
lowpingnews sync            newest VALID download -> repo -> install
lowpingnews test            smoke test the installed build
lowpingnews ship "msg"      install, commit, push
lowpingnews release 2.0     bump VERSION, install, test, commit, tag, gh release
lowpingnews pull            git pull, then install
lowpingnews clean           delete stale downloads
```

`sync` picks the newest build in `~/storage/downloads` that actually parses and
carries a `VERSION`, ignoring the filename entirely. Android saves repeat
downloads as `news-1`, `news-2` and so on, and picking by name silently
installs a stale build — which is a real failure this tool exists to prevent.
Any `.tar.gz` in Downloads is extracted over the repo first, so README updates
ride along.

Override paths with `LPN_REPO`, `LPN_DOWNLOADS` and `LPN_RAW`.

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
titles in scripts with no Latin characters.

- Downloads capped at 2 MB per feed and 5 MB per page, with bounded
  decompression, so a compression bomb stops at the cap instead of in RAM.
- All state writes go to a temp file and `os.replace`, so two terminals running
  at once can never leave a half-written cache or read-state file.
- At most 6 concurrent fetches regardless of how many feeds you configure. A
  phone radio is not a datacentre; verified at 6 with 24 sources.
- Timestamps without a timezone are read as UTC. RSS permits them, and
  Python's default would silently interpret them as local time.
- Source ids are sanitised before they become filenames.
- Malformed XML falls back to a loose extractor rather than discarding the
  feed. France 24's feed is invalid XML and is carried entirely by this path.
- `Ctrl-C` exits 130 without a traceback; `SIGPIPE` and broken pipes exit
  cleanly so `news | head` behaves.

## License

MIT
