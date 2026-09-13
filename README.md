# LowPingNews

A terminal news reader and weather forecast for bad connections.

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
  An unchanged feed returns `304 Not Modified` with no body at all. Servers that
  advertise no validator are still sent `If-Modified-Since` derived from the
  cache timestamp — it costs ~40 bytes to ask and many honour it, which turns a
  124 KB Nature refresh into nothing.
- **One retry on a dropped connection.** A transient failure is retried once
  after 400 ms; a real HTTP error is not, since the server answered.
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
lowpingnews             latest across the default category
lowpingnews weather     ultra-light forecast (24h + 7 day)
lowpingnews signal      connection quality and data used
news science            a category: top world science tech bio all
news saved              your starred items
news -q fern            search cached headlines, no network

news -r 4               read item 4 as text
news -d 2,3,5           download article bodies for offline reading
news -d all             download everything in the current list
news -d all --budget 500  raise the 4 MB ceiling for one run
news -o 4               open item 4 in a browser

news -u                 hide items you've already read
news --mark-all         mark the current list read
news -S 4               star / unstar item 4

news -f                 bypass the 15-minute cache
news -n 3               fewer items per source
news -s hn,bbc          only these source ids
news -t                 headlines only, no summaries
news -l                 list sources and categories
news signal             connection quality, throughput and data used
news --cost             estimate a refresh from known sizes, fetch nothing
news --light            skip feeds that last cost over 30KB
news --offline          cache only, open no sockets
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

Optional `"ttl"` (seconds) sets how long that feed is reused before refetching;
the default is 900. It matters for feeds that send no `ETag` or `Last-Modified`,
because those can't answer with a cheap 304 and must resend in full. `news
--check` marks validator support per feed: `v` means conditional GET works,
`-` means every refresh costs the full payload. Nature and both bioRxiv feeds
ship with a 6-hour TTL for that reason.

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
commit to it, and stops at a 4 MB ceiling per run. Items whose text is already
free — carried in the feed, or previously downloaded — are never counted
against the budget and always proceed.

## Knowing before you spend

```
$ news signal
SIGNAL
  wifi     -58 dBm  130 Mbps
  measured good    18 recent fetches
           100% ok  142ms median  84.1K/s
           a light feed ~ 0.1s
           Nature ~ 1.5s
  data     1.2M over 7 days
           today 269K
```

The `probe` lines do a DNS lookup and TCP connect to the hosts your feeds
actually live on, at the port the feed URL specifies. No ICMP and no TLS: a
SYN/ACK per attempt, no payload. ICMP is only shown as a supplement when `ping`
is installed, because carriers drop or deprioritise it independently of TCP and
it skips DNS entirely — and DNS is the usual thing that dies on a weak link.

A TCP connect proves the path to *something*, not necessarily to the origin. A
captive portal or transparent proxy answers for every address, so a connect
under 2 ms to a remote host is flagged `proxied?` — treat those numbers as
measuring your local gateway, not the feed.

The probe and the radio line run without any fetch history, so `news signal`
is useful on a fresh install before you have spent a single byte.

The radio line needs both the `termux-api` package and the separate Termux:API
app, which is only on F-Droid — it is not on Google Play. Without the app the
CLI prints a notice and the radio line is simply omitted; everything else in
`news signal` still works. It is deliberately not
the headline, because dBm predicts throughput badly — a strong bar on congested
backhaul is slower than a weak clear one. The verdict comes from the last 30
real fetches: success rate, median latency and median throughput. That is the
number that predicts whether a download finishes.

`news --cost` estimates a refresh from each feed's last known size and TTL,
opening no sockets. `news --light` drops feeds that last cost over 30 KB.
`news --offline` reads only the cache. Together: check the cost, check the
signal, then choose.

## Files

```
~/.config/news/sources.json     feeds and categories (edit this)
~/.config/news/update.url       remembered --update source
~/.cache/news/*.json            feed cache + ETag validators
~/.local/share/news/state.json  read and starred items
~/.local/share/news/art/        offline article text, 3 MB cap, oldest evicted
~/.local/share/news/net.json    last 200 fetch outcomes, 14 days of daily totals
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

`ship` and `release` refuse to commit anything this project doesn't own.
Downloads is a shared directory and archives get extracted into the working
tree, so an unrelated project landing in the repo is a real failure that has
happened; the allowlist is `news`, `README.md`, `install.sh`, `lowpingnews`,
`LICENSE`, `.gitignore`. Version arguments must be digits and dots, since they
become both a `sed` replacement and a git tag.

`release` is idempotent: an existing tag pointing at HEAD is a no-op, one
stranded on an older commit is moved, and `gh release create` falls through to
`edit` if the release already exists.

Set `LPN_NOFETCH=1` to stop `status` probing the remote.

Installing also installs `lowpingnews` itself, by rename rather than copy — the
kernel keeps the running script's inode open, so it can safely replace itself
mid-execution and the new version takes effect on the next invocation. Copying
onto the live path instead corrupts the remaining lines of the running script.

`sync` picks the newest build in `~/storage/downloads` or `~/downloads` that parses and
carries a `VERSION`, ignoring the filename entirely. Android saves repeat
downloads as `news-1`, `news-2` and so on, and picking by name silently
installs a stale build — which is a real failure this tool exists to prevent.
Any `.tar.gz` in Downloads is extracted over the repo first, so README updates
ride along.

Override paths with `LPN_REPO`, `LPN_DOWNLOADS` and `LPN_RAW`.

## Weather

```
lowpingnews weather -c 40.900,-73.412 --label "Fleets Cove"   # pin once
lowpingnews weather          # thereafter
lowpingnews weather -C       # celsius
```

One gzipped Open-Meteo call, cached 30 minutes, sharing the same HTTP layer,
capped reads and offline fallback as the feeds. Current conditions, a 24-hour
temperature sparkline and rain bar, then seven days. If the fetch fails it
shows the last good forecast and says how old it is. Location is pinned in
`~/.config/news/loc.json`, or taken from `termux-location` once if the
Termux:API app is installed.

## Limitations

- Article extraction is a paragraph heuristic with no JavaScript. When a page
  yields no paragraphs it falls back to the `articleBody` publishers embed as
  JSON-LD for search indexing, then to `og:description`. This is not a paywall
  bypass: it reads only what the page already returned, so a publisher who
  sends no body text still yields nothing.
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
