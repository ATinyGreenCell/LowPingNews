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
- **A truncated download is still worth reading.** If the connection dies
  mid-transfer the bytes that arrived are kept, not discarded: gzip is a stream
  so every complete block still decompresses, and every `<item>` that closed is
  a complete record. Measured against a feed cut mid-stream: 85% of the bytes
  yields 10 of 12 stories, 60% yields 6, 35% yields 3. A partial feed is flagged
  in the cache, stored without validators (a later 304 must never confirm a copy
  you never fully received) and expires in two minutes instead of fifteen.
- **A hung connection still shows you the news.** Weak signal usually means a
  socket that is accepted and never answered, not one that is refused. When the
  20-second deadline expires with workers still blocked, the cached copy is
  served rather than reporting the feed as down.
- **Failed fetches count as failures.** A fetch that fell back to cache is still
  recorded as a failure, so `news signal` cannot report 100% success while the
  radio is off. If no probed host is reachable the verdict reads `offline`.
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

Requires Python 3.5 or newer. Nothing else — no pip, no compiler, no
dependencies.

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

`kind` is `rss` (RSS 2.0, RSS 1.0/RDF and Atom are all handled), `hn` for the
Hacker News Algolia API, or `epmc` for a Europe PMC REST search — one JSON
request, no key, covering PubMed records and preprints. Edit the `query=` part
of the Europe PMC URL to change what it tracks. Only `http`/`https` URLs are accepted.

Optional `"timeout"` (seconds, default 10, max 60) sets how long to wait for a
feed. Some endpoints build their output on demand — `connect.biorxiv.org` does,
and the larger subjects can take twenty seconds — so those ship with
`"timeout": 25`. The overall fetch deadline grows to fit the slowest source plus
its retry, rather than capping everything at twenty seconds.

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

## While it fetches

`--stream` prints each feed the moment it arrives instead of waiting for all of
them, so on a bad link you read the early ones while the slow ones are still in
flight, and a connection that dies partway still leaves you whatever landed.
Output is flushed per feed, so nothing is lost in a buffer.

Ordering becomes arrival order rather than newest-first, which is the trade:
without `--stream` everything is sorted chronologically across all feeds, but
nothing appears until the slowest one finishes.

Resuming is automatic either way. Each feed writes its own cache entry as it
completes, so if signal dies after nine of fourteen, the next run finds those
nine within their TTL and only refetches the five that are missing. There is no
resume state to manage — the cache *is* the resume point.

## Progress

```
  [████████······] 3/5 24.1K/~61.4K dw,ars
```

The bar is shown when not streaming. Feeds are pulled in parallel and a weak
link can take twenty seconds, so the
fetch reports live instead of leaving a blank terminal: how many feeds are done,
bytes so far, which ones are still in flight. When the cache knows what those
feeds usually cost, the bar is a real percentage against that estimate (`~`);
on a cold cache it falls back to counting completed feeds. Feeds that answer
`304` cost nothing, so a run where most are unchanged finishes well under the
estimate.

It writes to stderr and only when stderr is a terminal, so piping stays clean.
`LPN_NO_PROGRESS=1` turns it off.

## Knowing before you spend

```
$ lowpingnews signal
SIGNAL  good
  link       23ms   37ms dns  bbci.co.uk
  link       21ms  127ms dns  rss.csmonitor.com
             29ms  icmp, 0% loss
  rate    31.9K/s  167ms  100% ok of 12
  top        61.4K ~2s
  science   147.1K ~5s
  bio       149.5K ~5s
  data       191.8K today  1.2M over 7d
```

The verdict is on the first line, because the question is "should I pull now".
Then the link itself, then measured throughput, then **what a refresh of each
category would actually cost and how long it would take at the rate you are
currently getting**. Categories already within their TTL are omitted, because there is nothing to
decide about them. An all-fresh cache says so; a cold install says `nothing
cached yet` instead, since never-fetched and up-to-date are not the same state
even though both cost 0B to skip.

Throughput and success rate come from the last 30 minutes of real fetches, not
a fixed count — an outage from an hour ago should not colour the connection you
have now. Below five samples in that window it falls back to the last twelve.

The `link` lines do a DNS lookup and TCP connect to the hosts your feeds
actually live on, at the port the feed URL specifies. No ICMP and no TLS: a
SYN/ACK per attempt, no payload. ICMP appears only as a supplement when `ping`
is installed, because carriers drop or deprioritise it independently of TCP and
it skips DNS entirely — and DNS is the usual thing that dies on a weak link.

A TCP connect proves the path to *something*, not necessarily to the origin. A
captive portal or transparent proxy answers for every address, so a connect
under 2 ms to a remote host is flagged `proxied?` — treat those numbers as
measuring your local gateway, not the feed.

The radio line needs both the `termux-api` package and the separate Termux:API
app, which is only on F-Droid — it is not on Google Play. Without the app the
CLI prints a notice and the radio line is simply omitted; everything else in
`lowpingnews signal` still works.

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

## Portability

Pure standard library, Python 3.5+, verified with `vermin`. No f-strings, no
`fromisoformat`, no `subprocess(capture_output=)` — the newest thing it needs is
from 2015.

- **Paths** honour `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `XDG_DATA_HOME` where
  set, `%APPDATA%` / `%LOCALAPPDATA%` on Windows, and `~/.config` style
  otherwise.
- **Colour** is enabled on Windows by turning on VT processing, and dropped
  automatically if that fails, if output is piped, or if `NO_COLOR` is set.
- **`ping`** flags differ per platform: `-W` is seconds on Linux/BSD,
  milliseconds on macOS, and Windows uses `-n`/`-w`. ICMP is optional anyway.
- **Opening a link** tries `termux-open-url`, then the stdlib `webbrowser`,
  then prints the URL.
- **The installer** avoids `sed -i`, which is mutually incompatible between GNU
  and BSD, and rewrites the shebang in Python instead. It picks the first
  writable directory among `$PREFIX/bin`, `~/.local/bin`, `/usr/local/bin` and
  `~/bin`, and tells you if it is not on your `PATH`.

Not supported: Python 2, and Windows without a VT-capable console.

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
temperature sparkline and rain bar, then seven days. Today's rain figure covers
only the hours still ahead (marked `*`), because the API's daily maximum runs
midnight to midnight and at 19:00 would otherwise report rain that already
fell. If the fetch fails it
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
