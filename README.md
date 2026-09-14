# LowPingNews

**A terminal news reader and weather forecast for bad connections.**

One Python file. No dependencies, no pip install, no API keys. Built for a phone
on one bar of signal, where every kilobyte and every handshake costs you.

```
$ lowpingnews

NEWS top   Sun 13 Sep 19:35

  1 DW · 32m
    ● Sweden election 'very close' as left bloc claims tight lead
    The left-wing opposition is narrowly ahead, but it will be…

  2 Phys.org · 1h
    ● JWST ruled out finding tiny moons around an exoplanet
    The James Webb Space Telescope has opened many wonders…

  3 BBC World · 1h
    ● ↓ Swedish party blocs tied after Sunday vote, projections say
    A partial count by Sweden's election authority projected…

  25 items · 16.5KB · 2 unchanged (304) · news -r N to read
```

`●` unread  `↓` article text already downloaded, readable offline at zero cost

---

## Install

```sh
git clone https://github.com/ATinyGreenCell/LowPingNews
cd LowPingNews
sh install.sh
lowpingnews --check
```

Needs Python 3.5 or newer. That is the only requirement.

On Termux: `pkg install python git` first. `lpn` is installed as a short alias.

`--check` fetches every feed once and reports which work, what they cost and how
fast they answered. Feed URLs rot; this is how you find out.

## Everyday use

```sh
lowpingnews                 headlines
lowpingnews science         a category: top world science tech bio all
lowpingnews weather         forecast for your location
lowpingnews signal          is this connection worth using?

lowpingnews -r 4            read item 4 as text
lowpingnews -d all          download every article for offline reading
lowpingnews -o 4            open item 4 in a browser
```

The pattern it is built for — pull while you have signal, read where you don't:

```sh
lowpingnews bio -d all      # at the trailhead
lowpingnews -r 3            # later, no signal, zero bytes
```

## Weather

```sh
lowpingnews weather -g       # fresh GPS fix, then remembered
lowpingnews weather          # last known location
lowpingnews weather -c 40.900,-73.412 --label "Fleets Cove"
lowpingnews weather -C       # celsius
```

```
Fleets Cove  Sun 13 Sep 15:00
  71°F feels 75°  CL Clear
  S 5mph g14   RH 87%   sets 19:12

  NEXT 24H   59–73°F
  ▄▆▆▇█████▇▆▆▄▃▂▂▁▁▁▁▁▂▂▃
  ···▁▃▆▇▅▃▁······▁▂▁·····  85% @21h, 0.79in
  15    21    03    09

  7 DAY
  Sun CL  66° ·····█████··  76°  85%*
  Mon OV  59° ··██████····  71°   5%
  * today = hours remaining
```

Probability alone does not support a decision — 60% at 0.1 in and 60% at 0.8 in
are different afternoons — so the rain line carries the expected total as well
as the peak hour. The axis under the sparkline exists because a sparkline you
cannot time-index is a picture, not a forecast. Gust speed appears only when it
meaningfully exceeds the mean wind, and the next sun event is whichever comes
first chronologically, with a countdown once it is under three hours away.

One gzipped Open-Meteo call, cached 30 minutes, about 660 bytes. Today's rain
figure and icon cover only the hours still ahead — the API's daily values run
midnight to midnight and would otherwise report rain that already fell.

By default the location **follows the device**: if the stored fix is over 30
minutes old it is quietly refreshed using the network provider, which is instant
and works indoors. If no fix is available the last known location is used
rather than failing.

`-c` is different — it pins deliberately and stays put however stale it gets,
which is what you want for a fixed site. `-g` takes a GPS fix and clears any
pin, so it is also how you stop following one place and start following
yourself. The header says which you are on: `via network, +/-40m` or `pinned`.

Needs the `termux-api` package **and** the Termux:API app from F-Droid; without
them the stored or pinned location is used.

## Signal

```
$ lowpingnews signal
SIGNAL  good
  link       23ms   37ms dns  bbci.co.uk
  link       21ms  127ms dns  rss.csmonitor.com
             29ms  icmp, 0% loss
  rate    31.9K/s  167ms  100% ok of 12
  top        61.4K ~2s
  science   147.1K ~5s
  data      191.8K today  1.2M over 7d
```

The verdict comes first, because the question is "should I pull now". Then the
link, then measured throughput, then what each category would cost and how long
it would take at the rate you are actually getting. Categories within their TTL
are omitted.

Throughput comes from the last 30 minutes of real fetches, not a fixed count.
The `link` lines are DNS plus TCP connect to the hosts your feeds live on. No
ICMP by default: carriers drop it independently of TCP and it skips DNS, which
is what usually dies first on a weak link. A connect under 2 ms to a remote host
is flagged `proxied?`, since captive portals answer for everything.

## Why it survives a connection that barely works

- **Conditional GET.** Unchanged feeds return `304 Not Modified` with no body.
  Servers advertising no validator are still sent `If-Modified-Since` from the
  cache timestamp — about 40 bytes to ask, and many honour it. On the default
  set this measured **437 KB → 269 KB** on a repeat pull.
- **Few hosts, deliberately.** A TLS handshake is roughly 4 KB regardless of
  payload, so host count dominates. The default set is small on purpose.
- **Nothing polls in the background.** Nothing is fetched unless you ask.
- **Truncated downloads still count.** If the connection dies mid-transfer the
  bytes that arrived are kept: gzip is a stream, and every `<item>` that closed
  is a complete record. 85% of a feed yields 10 of 12 stories; 60% yields 6.
- **A hung connection still shows you the news.** Weak signal usually means a
  socket accepted and never answered. When the deadline expires the cached copy
  is served rather than reporting the feed as down.
- **Nothing fails silently.** Feeds never reached are counted in the footer,
  because a partial pull that looks complete is worse than an error.
- **Resume is automatic.** Each feed caches as it completes, so a run that dies
  after nine of fourteen refetches only the five still missing.

## All commands

```
lowpingnews [CATEGORY] [flags]

  CATEGORY   top world science tech bio all signal weather saved

  -r N       read item N as text          -d 1,3,5   download those articles
  -o N       open item N in a browser     -d all     download everything listed
  -S N       star / unstar item N         --budget N raise the 4MB ceiling
  -u         hide items already read      --mark-all mark the list read
  -q TERM    search cached headlines

  -f         bypass the cache             --offline  cache only, no sockets
  -n N       items per source             --light    skip feeds over 30KB
  -s IDS     only these sources           --cost     estimate a refresh, fetch nothing
  -t         headlines only               --stream   print feeds as they arrive
  --check    test every feed URL          --ascii    no unicode
  -l         list sources                 --no-color no colour

  weather    -g GPS fix   -c LAT,LON   --label NAME   -C celsius
```

Item numbers refer to the last list you printed.

`--stream` prints each feed the moment it arrives instead of waiting for the
slowest, so a dying connection still leaves you whatever landed. The trade is
arrival order instead of newest-first. Without it, a progress bar reports bytes,
completed feeds and elapsed time on stderr, so a slow fetch is visibly a wait
rather than a hang.

## Sources

| category | feeds |
|---|---|
| `top` | BBC World, CS Monitor, DW, Phys.org, Ars Technica |
| `world` | the above plus Al Jazeera, France 24 |
| `science` | Phys.org, ScienceDaily, Quanta, Nature |
| `tech` | Ars Technica, The Register, Hacker News |
| `bio` | bioRxiv plant biology, bioRxiv synthetic biology, Europe PMC |

No outlet is unbiased, and an aggregator's real bias is which feeds it picks.
That choice is a plain JSON file:

```sh
$EDITOR ~/.config/news/sources.json
```

```json
{"id": "eos", "name": "Eos", "kind": "rss", "cats": ["science"],
 "url": "https://eos.org/feed", "ttl": 3600, "timeout": 10}
```

`kind` is `rss` (RSS 2.0, RSS 1.0/RDF and Atom all handled), `hn` for the Hacker
News Algolia API, or `epmc` for a Europe PMC REST search covering PubMed records
and preprints. Only `http`/`https` URLs are accepted.

`ttl` (default 900s) is how long a feed is reused before refetching — it matters
most for feeds sending no `ETag`/`Last-Modified`, since those cannot answer with
a cheap 304. `timeout` (default 10s, max 60) matters for endpoints that build
output on demand; `connect.biorxiv.org` does, and ships at 25.

Your edits survive upgrades. The flip side: new default feeds will not appear
automatically. Delete the file to regenerate it.

## Measured

Every default feed, from a phone on 2026-09-13:

| feed | items | wire | raw | gzip | validator |
|------|------:|-----:|----:|:----:|:---------:|
| bbc | 23 | 4.3 KB | 17.7 KB | yes | – |
| csm | 20 | 4.4 KB | 11.8 KB | yes | – |
| aje | 25 | 4.1 KB | 16.8 KB | yes | v |
| quanta | 5 | 3.1 KB | 11.0 KB | yes | v |
| phys | 30 | 7.8 KB | 30.8 KB | yes | – |
| f24 | 24 | 8.5 KB | 27.8 KB | yes | – |
| sd | 60 | 12.1 KB | 43.0 KB | yes | v |
| ars | 20 | 18.6 KB | 75.7 KB | yes | v |
| hn | 20 | 20.7 KB | 20.7 KB | **no** | – |
| dw | 136 | 26.3 KB | 115.9 KB | yes | – |
| brxs | 30 | 71.9 KB | 71.9 KB | **no** | – |
| brxp | 30 | 77.6 KB | 77.6 KB | **no** | – |
| reg | 50 | 86.6 KB | 246.7 KB | yes | – |
| nature | 75 | 124.3 KB | 124.3 KB | **no** | – |

Four servers ignore `Accept-Encoding` entirely. Advertising `deflate` alongside
`gzip` was tried and changed nothing, so that avenue is closed. `nature` and
`reg` dominate their categories; retag them in `sources.json` for a leaner
default. These are worst-case figures — conditional GET makes a second run the
same day close to free.

| action | over the wire |
|---|---|
| within the cache TTL | nothing, no socket opened |
| refresh, feed unchanged | handshake + 304, no body |
| refresh, feed changed | handshake + gzipped feed |
| `-r N`, text already in the feed | nothing |
| `-r N`, already downloaded | nothing |
| `-r N`, neither | one page fetch, size reported |

## Files

```
~/.config/news/sources.json     feeds and categories (edit this)
~/.config/news/loc.json         weather location
~/.config/news/update.url       remembered update source
~/.cache/news/*.json            feed cache + ETag validators
~/.local/share/news/state.json  read and starred items
~/.local/share/news/net.json    last 200 fetch outcomes, 14 days of totals
~/.local/share/news/art/        offline article text, 3 MB cap, oldest evicted
```

Config lives outside the cache, so clearing the cache never eats your feed list.
`XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_DATA_HOME` are honoured where set,
`%APPDATA%`/`%LOCALAPPDATA%` on Windows.

## Updating

```sh
lowpingnews update
```

Downloads the latest release and verifies it before overwriting anything — size
floor, content marker and a full `ast.parse()` — because a truncated download is
the normal failure on a lossy link, and a half-written file still installs
cleanly enough to break the command. The replace is atomic; the previous version
is kept at `news.bak`.

## Portability

Pure standard library, Python 3.5+, verified with `vermin`. No f-strings, no
`fromisoformat`. The newest thing it needs is from 2015.

- Colour is enabled on Windows via VT processing and dropped if that fails, if
  output is piped, or if `NO_COLOR` is set.
- `ping` flags differ per platform and are handled; ICMP is optional anyway.
- Opening a link tries `termux-open-url`, then stdlib `webbrowser`, then prints
  the URL.
- The installer avoids `sed -i`, which is mutually incompatible between GNU and
  BSD, and picks the first writable directory among `$PREFIX/bin`,
  `~/.local/bin`, `/usr/local/bin`, `~/bin`.
- Source ids colliding with Windows device names (`con`, `nul`, `com1`) are
  suffixed, since those cannot be opened as files.

Not supported: Python 2, and Windows without a VT-capable console.

## Limitations

- Article extraction is a paragraph heuristic with no JavaScript. When a page
  yields no paragraphs it falls back to the `articleBody` publishers embed as
  JSON-LD for search indexing, then `og:description`. This is not a paywall
  bypass: it reads only what the page already returned.
- `-d all` on a long list can mean hundreds of KB. There is a 4 MB ceiling and a
  per-item ledger, but cost is reported as it goes, not before.
- Feeds must be public. No authentication, no OPML import.
- Europe PMC reflects PubMed indexing, which lags publication by weeks. bioRxiv
  is the live wire; Europe PMC is the record.

## Hardening

Tested against a hostile `sources.json` (path-traversal ids, duplicate ids,
`file://` URLs, non-dict entries, Windows device names), a 40 MB gzip bomb,
oversized and malformed feeds, truncated transfers, black-holed connections,
corrupt cache and state files, non-UTF-8 terminals, out-of-range coordinates,
and titles in scripts with no Latin characters.

- Downloads capped at 2 MB per feed and 5 MB per page, decompression bounded.
- All state writes go to a temp file then `os.replace`, so two terminals running
  at once cannot leave a half-written file.
- At most 6 concurrent fetches regardless of how many feeds are configured.
- Timestamps without a timezone are read as UTC, which RSS permits and Python
  would otherwise interpret as local time.
- Malformed XML falls back to a loose extractor rather than discarding the feed.
  France 24's feed is invalid XML and is carried entirely by that path.
- A failed fetch counts as a failure even when the cache saves the render, so
  `signal` cannot report 100% success while the radio is off.
- A date more than an hour in the future is neither displayed nor sorted by, so
  one feed with a bad clock cannot pin itself to the top of the list. Minor skew
  reads as "just now"; anything further shows `?` alongside genuinely undated
  items.
- Weather codes are ranked by an explicit severity table, not by numeric value:
  WMO puts rain showers (80) above heavy snow (75), so `max()` would have
  reported the wrong condition for a snowy day.
- `Ctrl-C` exits cleanly; `SIGPIPE` and broken pipes make `| head` behave.

## Development

`lowpingnews` doubles as its own dev tool:

```sh
lpn status          installed / repo / newest download / git, flags mismatches
lpn sync            newest valid build -> repo -> install
lpn test            smoke test the installed build
lpn ship "msg"      install, commit, push
lpn release 4.5     bump, install, test, commit, tag, gh release
```

`sync` picks builds by parsed `VERSION`, never by filename, and refuses archives
containing files this project does not own. `ship` and `release` refuse to
commit anything outside the files this project owns. `release` is idempotent.

## License

MIT
