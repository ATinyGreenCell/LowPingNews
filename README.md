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

  25 items · ~51K · 2 unchanged (304) · news -r N to read
```

`●` unread  `↓` article text already downloaded, readable offline at zero cost

That is the printed list (`--plain`, or any time output is piped). In a terminal
it opens an interactive reader instead: each article a card with the whole
title, tap or `j`/`k` to move, Enter to read, `q` to quit.

---

## Robustness

Everything the app reads from outside - feeds, article pages, forecasts, NOAA
alerts, tides, currents, buoys, the catalog, its own saved files - is treated as
possibly broken or hostile, and the test suite fuzzes it with thousands of
mutated inputs every run:

- **Nothing reaches your terminal raw.** Escape sequences are removed whole
  (never leaving "[2J" behind), with invisible direction overrides and
  unprintable characters; links must be plain http(s) to a real host.
- **A missing reading stays missing.** A forecast without wind says nothing
  about wind - never "calm"; unknown rain is "not reported", never "no rain
  expected"; an unknown sky is "Unknown", never "Clear". A broken forecast never
  replaces a good saved one.
- **One bad item never costs a feed**, and nothing a server sends can freeze a
  parser: every text scan is linear, whatever the input.
- **No server can hold a refresh.** Each request has a total time limit (25 s)
  as well as an idle one; a cut download keeps its bytes and resumes next time;
  a server that times out has its other feeds served from cache for that round.
- **Fast starts.** `lowpingnews` loads the app as a module, so Python keeps its
  compiled form (in `~/.cache/lowpingnews/pyc`) instead of recompiling 6,500
  lines on every run: a warm list in ~37 ms instead of ~100 ms here.
- **The web app** carries a security policy (its own scripts only, and only the
  five services it reads), and the site's build job - which reads the outside
  feeds - cannot publish; only the deploy job can, with every action pinned to
  an exact commit.

## On a phone, in the browser (iPhone or Android)

Open **https://atinygreencell.github.io/LowPingNews/** in Safari or Chrome, then:

- **iPhone**: tap the Share button, then **Add to Home Screen**.
- **Android**: tap the menu, then **Install app** or **Add to Home screen**.

It opens like an app, works offline from its last copy, and needs no account.
**Weather** comes first: the forecast, and NOAA watches and warnings in the
United States, for your location or a place you type ("Huntington, NY"). The
news tabs show ten stories with "Show 10 more" further back in time. Tapping a
story opens its **text only**, like the terminal app: a few KB instead of the
whole website. Articles you open are kept on the phone (the last 40), so
reading one again costs nothing and works offline.

On a slow link the text fills in paragraph by paragraph as it arrives, with the
feed's summary shown meanwhile. If the connection drops, what arrived stays on
screen (and on the phone: the story is marked "part saved"), and only the rest
is fetched when the link is back - at once when the phone reports it is online
again, otherwise after 2, 4, 8... seconds. Refreshing an article you already
have costs about 100 bytes when it has not changed.

**Bad connections.** Nothing waits on a stalled link: every request has time
limits - for the answer to start, for silence in the middle of it, and overall.
The news, forecast, alerts and tide times you last had show at once, with their
age, and a newer copy replaces them when it arrives; the status line says
"offline" or "slow connection" while it shows the saved copy, and the app tries
again by itself. Tide predictions are astronomy, fixed in advance, so a saved
set that spans the next day is reused without asking NOAA. A Wi-Fi sign-in
page answers "200 OK" too, so it is never saved in place of the news or the
forecast.

**Data.** The whole app is about 30 KB the first time, then kept on the phone. A
news section is one small file (roughly 5-8 KB) and costs a few hundred bytes
when nothing has changed. Weather comes straight from Open-Meteo and
weather.gov, a few KB each, and is reused for half an hour (alerts: five minutes).

**How it works.** Phone browsers are not allowed to read most news feeds
directly, so a GitHub Action reads them using this program and publishes one
small file per category beside the app. Nothing runs on a server of yours.
The app always says how old the news is, says when it is offline and showing a
saved copy, names any feed that could not be read, and says "ALERTS UNKNOWN"
rather than implying all-clear when weather.gov cannot be reached.

**Keeping it on time.** GitHub's own scheduler runs a "20-minute" job only a
few times a day, so on its own the news can be hours old. `lpn schedule` (once,
after the reader is deployed) has Cloudflare's cron wake the reader every 20
minutes to start the update. It asks for a GitHub token that can do one thing -
start and read this repository's update runs - and opens GitHub's form already
filled in (no expiry, Actions: read and write); you pick the repository and
tap Generate. The token is checked, then kept on Cloudflare only; `lpn release`
keeps it and the schedule in place. `lpn schedule off` goes back to GitHub's.

A run is never left blocking the rest: each new run replaces one still going
(an older run stuck at its publish step once held every update for three
days). When the news is hours old anyway, the app says why in its status line -
"stuck on GitHub since Tue 5:26 AM", "updates failing since 9:10 AM", "no update
started since..." - from one small answer the reader condenses out of GitHub's
run records, and `lpn status` gives the cause with the command or setting that
fixes it.

**Setting it up** (once, for the repository owner): sign `gh` in with permission
to change workflows, release, then switch it on:

```sh
gh auth refresh -h github.com -s workflow
lpn release 8.2
lpn web                     # turns on GitHub Pages and prints the address
```

**The article reader** (once, about five minutes, free). A browser cannot fetch
other sites' pages, so a small Cloudflare Worker does it on request: it fetches
the one page she taps, keeps only the paragraphs, and sends back the text - a
paragraph per line, so the app shows each one as it lands and, after a dropped
link, asks only for the paragraphs it is missing. Nothing is stored or published - publishing copies of articles on the app's
public site would invite copyright takedowns. It answers only the app's own
address, and only for links in the app's current headline files, so it is not
an open proxy.

1. Sign up at dash.cloudflare.com (free plan).
2. Make an API token: My Profile > API Tokens > Create Token > use the
   **Edit Cloudflare Workers** template > Continue > Create Token. Copy it.
3. In Termux: `lpn reader deploy`, and paste the token when asked (it is
   hidden as you paste, checked with Cloudflare, and kept in your config folder,
   readable only by you).

That uploads the reader, finds its address, confirms the new version is live,
and points the app at it. After that, `lpn release` redeploys the reader by
itself whenever it has changed - no Cloudflare editor, no copying and pasting.

Until then, a story shows its summary and a link to the original page.

Preprints and papers are read through their own services rather than their web
pages: bioRxiv and medRxiv links through api.biorxiv.org, Europe PMC links
through its REST API. You get the authors, the posting date and version, and
the abstract (labelled as such); bioRxiv's pages sit behind an anti-bot check
that would otherwise return only the site's tagline. `lpn release` keeps the
deployed reader up to date.

**PubMed tab.** Newest PubMed papers matching a search (by default: duckweed,
plant and plastid transformation, molecular farming, plant synthetic biology),
read through Europe PMC's daily copy of PubMed - one light request, no API key.
Links go to PubMed itself, and abstracts are published beside the app like
preprints'. In the terminal, tick it in `lowpingnews catalog`.

**Preprint abstracts.** bioRxiv and medRxiv feeds already carry each paper's
full abstract, so the site build publishes it beside the app as a ~1 KB file
(`data/abs/`) - opening a preprint costs one small request and never touches
bioRxiv's web pages, which block automated reading. If a feed's text is too
short to be the whole abstract, the build asks Crossref (where bioRxiv deposits
its abstracts), then bioRxiv's own API, once per paper. Story previews in the
lists are shortened to keep each news file at 3-4 KB; they end with "..." so a
preview never looks like a cut-off article.


The app is TypeScript in `web/src`, compiled to plain JavaScript in `web/static`
(no frameworks, no dependencies); `web/build_digest.py` builds the news files.
GitHub turns its own schedule off after 60 days without activity in the
repository; the 20-minute schedule (`lpn schedule`) is unaffected, and either
way the app says the news is old rather than showing it as current.

## Install

Needs Python 3.5 or newer and nothing else: no pip packages, no API keys.

**Android (Termux)**

```sh
pkg install python git
git clone https://github.com/ATinyGreenCell/LowPingNews
cd LowPingNews && sh install.sh
lowpingnews
```

**Linux and macOS**

```sh
git clone https://github.com/ATinyGreenCell/LowPingNews
cd LowPingNews && sh install.sh
lowpingnews
```

`install.sh` puts `news`, `lowpingnews` and the short alias `lpn` in the first
writable of `~/.local/bin`, `/usr/local/bin` and `~/bin`; no `sudo` needed. If it
says that folder is not on your `PATH`, it prints the line to add. On macOS with
Python from python.org, run *Install Certificates.command* (in the Python folder
under Applications) once, or HTTPS will fail.

**Windows** (PowerShell, Python from python.org or the Microsoft Store)

```powershell
git clone https://github.com/ATinyGreenCell/LowPingNews
cd LowPingNews
py news
```

No installer is needed: `py news` runs it from the folder (download the ZIP from
GitHub if you have no git). You get the printed list; for the interactive reader,
`pip install windows-curses` once.

### First steps

```sh
lowpingnews               the reader (q quits)
lowpingnews top 13        thirteen newest headlines
lowpingnews weather -p "Huntington, NY"     forecast; the place is remembered
lowpingnews radio         NOAA warnings and forecast (United States)
lowpingnews tides         next high and low tides, currents, moon, nearby buoys
lowpingnews catalog       choose feeds: tap or space to tick
lowpingnews --check       test every feed: which work, what they cost
```

### Updating

```sh
lowpingnews update        # Android, Linux, macOS
py news --update          # Windows
```

See [Updating safely](#updating-safely) for what it checks before replacing anything.

### Uninstalling

Delete the commands and the data folders:

```sh
rm -f ~/.local/bin/{news,lowpingnews,lpn,weather}      # or $PREFIX/bin on Termux
rm -rf ~/.config/news ~/.cache/news ~/.local/share/news
```

With `XDG_CONFIG_HOME` and friends set, the folders are named `lowpingnews` inside
them; on Windows they are under `%APPDATA%\lowpingnews`.

### Trying it out and reporting problems

Please open an issue at
[github.com/ATinyGreenCell/LowPingNews/issues](https://github.com/ATinyGreenCell/LowPingNews/issues)
with the output of `lowpingnews --version`, your platform (Termux, Linux, macOS,
Windows), what you ran, and what you saw. A screenshot helps most with display
problems.

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

## How many articles

Ten, newest first across every feed in the category, unless you give a number:
`lowpingnews top 13`, `lowpingnews science 40`. The printed list says how many
more are stored and the command to see them (`10 of 60: lowpingnews top 20 for
more`). `-n` is still a per-feed limit. A search (`-q`) shows every match.

In the reader, **m** (or `j` past the last card) shows ten more, further back in
time. They come from what is already stored, so they cost nothing; the message
says how far back they reach, and when there is nothing older it says so, with
the age of the oldest story. When newer stories arrive - on a refresh, or the
reader's own background check - they are added on top and the window grows, so
nothing you could see is pushed out ("3 new at the top"). The banner shows
`10 items of 60`. Changing category starts again at ten.

In the reader each article is a card: its number (the one `news -r N` takes),
`•` unread or `★` starred, the source and age, the whole title wrapped to your
screen, and a dim one-line summary. Everything on a card came with the feed, so
cards cost no data beyond the list itself. `v` hides summaries to fit more cards.

**← →** (or `h`/`l`) change category, like `n`/`p`. Numbers are counts, so a
category name cannot be a number.

## Weather

```sh
lowpingnews weather -g       # fresh device fix, then remembered
lowpingnews weather --ip     # no GPS? locate by IP (city-level)
lowpingnews weather -p "Huntington, New York"   # by place name
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

`-p` looks the name up with Open-Meteo's geocoder — no key, same provider as the
forecast — and stores the match, so you only search once. Ambiguous names resolve
to the best match and the alternatives are printed to stderr, so `-p Huntington`
tells you it chose New York over West Virginia rather than silently picking. Add
a region to disambiguate: `-p "Huntington, West Virginia"`. A matched place is
sticky like a pin; it will not drift.

**On a laptop** there is usually no GPS, so `-g` uses the OS location service:
CoreLocation on macOS (via `CoreLocationCLI`, `brew install corelocationcli`) and
`System.Device.Location` on Windows, which needs Location enabled in Privacy
settings. Linux desktops have no standard provider, so use `--ip` or pin.

`--ip` asks a public IP-geolocation service where you are. It is accurate to a
city, not a street, and it necessarily tells that service your IP address —
which is why it never runs on its own and must be asked for. The header labels
such a fix `via ip, city-level` so it is never mistaken for a real position.
Two endpoints are tried in turn; if both fail it says so rather than guessing.

For a fixed desk, `-c` remains the best option: exact, private, no lookup.

On Android it needs the `termux-api` package **and** the matching Termux:API app. The two
Termux distributions are signed differently, so the companion must come from the
same source as Termux itself — an F-Droid Termux:API will not pair with a Play
Store Termux, and the Play build's companion is not released yet. On the Play
build, pin a location with `-c`; everything else works normally.

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
- **Few hosts, deliberately.** Every new connection pays a TCP and TLS
  handshake of about 6 KB before a single byte of news arrives, so host count
  dominates. The default set is small on purpose.
- **Repeat connections resume.** One TLS context is shared for the whole run,
  so a second request to the same host resumes the session instead of
  repeating the handshake, and feeds on the same host are fetched in turn so
  the second can benefit.
- **Nothing is fetched while you are not looking.** The plain list fetches
  only when run. The interactive reader refreshes stale data and samples the
  ping meter only within five minutes of a keypress; left idle, it shows how
  old its data is and spends nothing.
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
default. These are body sizes only; see below for what a request really
costs.

## What a request really costs

A body is the smallest part of most requests. Measured on a live interface
against an HTTPS server:

| request | on the wire |
|---|---|
| `304 Not Modified`, fresh TLS handshake | 6.7 KB |
| `304 Not Modified`, resumed TLS session | 3.8 KB |
| three 304s on one kept-alive connection | 8.6 KB (vs 20.1 KB separately) |
| ping meter probe (TCP open, reset) | 0.8 KB |

Of a fresh 304, headers are about 0.8 KB and the rest is TCP and TLS — mostly
the server's certificate chain. So a refresh of five unchanged feeds is not
"close to free"; it is about 33 KB. Bodies add their own size plus ~5% for
packet framing and the acknowledgements sent back.

Earlier versions reported only the compressed body, which understated small
requests by up to 90%. Totals are now estimated from these measurements —
within a few percent on the server they were taken from — and shown with a
`~` because certificate chains and network paths differ. `--budget` counts
the same estimate, and will not start a fetch it cannot afford.

`--update` asks for the first 4 KB of the published file before anything
else: the version is near the top, and most checks end in "already current".
Measured against GitHub, that is ~11 KB instead of ~39 KB. It also refuses to
install an *older* version unless `LPN_FORCE=1` is set — a stale branch once
quietly turned 6.5 back into 6.1.

Hacker News, which is served uncompressed, is asked only for the six fields
the reader uses. That saving is unmeasured: the API was not reachable from
the build machine. If the server refuses the trimmed query, the reader steps
down to a plainer one and remembers what worked.

| action | over the wire |
|---|---|
| within the cache TTL | nothing, no socket opened |
| refresh, feed unchanged | handshake + 304, no body: ~4-7 KB |
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

## Place names

`-p "Huntington, New York"` searches for Huntington and keeps only matches in
New York; postal abbreviations work too (`-p "Huntington, NY"`), as do counties
and countries (`-p "Paris, France"`). If nothing matches the region, it says so
rather than choosing a place elsewhere. A place name is remembered, so
`weather` and `radio` both show which spot they used, and how it was set.

## NOAA radio

`lowpingnews tides` (or `tide`, and the Tides tab in the web app) gives the
next highs and lows at the nearest NOAA tide station, when the water will be
highest and lowest over the next day (least and most shore showing), a 24-hour
chart, the tidal current at the nearest NOAA current station within 25 miles
(flooding or ebbing and how fast now, then the next slacks and maximum flood
and ebb), the moon's phase with spring/neap tides, and the nearest buoys' water
temperature, waves and wind. It uses the same spot as `weather` (pin it with
`-c LAT,LON --label NAME`); the web app can use your phone's precise location.
A few KB a check: one small tile of nearby stations and buoys from the app's
site, NOAA's tide and current predictions (kept for the day), and the moon is
computed on the device. Predictions, not observations - wind and pressure move
real water. If no buoy shows, it says whether none near you has reported in
the last 3 hours or NDBC did not answer the site's last build.

The markers tide apps draw along a harbour are mostly these same NOAA
prediction points - tide stations (heights) and current stations (knots) - not
buoys: a buoy is an instrument reporting what it measured, and NDBC's list
has every one this uses.

**How long a tide holds.** The water never stops; it moves slowest around each
high and low. For each one, `tides` (and the web app's Tides tab) gives the
window when the water is within 1 ft of it - for a low, roughly when the shore
is near its widest. Worked out from NOAA's predicted times and heights along the
standard tide curve, each side separately, and rounded to 5 minutes; checked
against a minute-by-minute walk of the curve. Where the tide moves less than a
foot, it says so instead of giving a window. Heights are above NOAA's average
lowest tide (MLLW), so a low can read below zero.

`lowpingnews radio` (or `noaa`) is a weather radio in text: active watches and
warnings for your spot first, most severe first, then the National Weather
Service forecast read period by period, the way the broadcast reads it. It
uses the same location as `weather` (`-c`, `-p`, `--label`). United States only.

- It always says which spot it checked: your name for it, the exact
  coordinates, and how they were set (pinned, place name, device, or network
  address), with the Weather Service's nearest town beside the office and zone
  for comparison. A spot from a network address, or an old device fix that
  could not be refreshed, gets a warning and the command to pin your location.
- Severe and extreme warnings print in full, including "What to do"; lesser
  ones are shortened (`radio --full` shows everything).
- Alerts are re-checked after five minutes, the forecast after thirty; a
  repeat inside that window costs nothing. A typical check is a few KB.
- If weather.gov cannot be reached it says **ALERTS UNKNOWN** — never "no
  alerts". A cached copy is shown with its age, warnings that have since
  ended are hidden and counted, and tests and drills are never shown.
- `--marine ANZ335` adds the coastal marine forecast for a zone (find yours at
  weather.gov/marine); it is remembered until `--marine off`.
- Exit status: 0 checked, 1 no NOAA coverage here, 2 alerts could not be checked.
- `weather` shows a one-line banner when the radio found warnings within the
  last hour, at no extra cost.

## Weather in words

Times read the way people say them: "Sunset 7:00 PM", "Rain 80% around 5 PM", and
the rain graph's axis `2p  8p  2a  8a`. `LPN_CLOCK=24` keeps 24-hour time, here
and in the radio.

### Conditions

Conditions are written out — Partly Cloudy, Icy Drizzle, Thunder & Hail — never
two-letter codes, with a small icon beside them: ☀ sun, ☁ cloud, ☂ rain,
❄ snow, ☈ thunderstorm, ≋ fog, paired (☀☁ partly cloudy, ☀☂ showers, ☂☂ heavy
rain). They are built only from glyphs every terminal draws one cell wide;
weather emoji like 🌤 are drawn two cells wide while claiming one, which pushes
every column after them out of line. With `LANG=C` or `--ascii` the words
appear alone. Wind, humidity, sunrise and the rain outlook are full sentences
("Rain 80% around 11:00, 0.50 in total"), and the 7-day table labels its
columns. Names are never shortened to fit: below about 40 columns the
temperature bar gives way to a plain range, and on very narrow screens each day
takes two lines.

## `news` and `weather` as commands

`lpn install` (which `lpn release` also runs) puts `news` in your `PATH` and
adds a small `weather` launcher that runs the LowPingNews forecast, passing
flags through: `weather -f`, `weather -p Huntington`, `weather -c 40.9,-73.4`.

It will not take over a `weather` that is not its own — an older script of
yours is left in place, with a note on how to move it aside. The launcher is
recognised by a marker line, so later installs keep it current.

Installing also reports anything that would silently win over these commands:
a script earlier in your `PATH`, or an alias or function in `~/.bashrc`,
`~/.profile`, `~/.bash_profile` or `~/.zshrc`. It only reports — your files are
never edited. After moving or deleting what it names, run `hash -r` (or open a
new session) so the shell forgets where it last found the old command.

## Weak signal

Built for a phone at the edge of coverage:

- **Cut downloads resume.** When a transfer drops partway, the bytes already
  received are kept, and the next attempt asks only for the rest - at once
  (up to twice in the same run), or on the next run within the hour. Every
  byte of a feed is paid for once. Complete items from the part already
  received are shown meanwhile. A resume is guarded by `If-Range`, so if the
  feed changed in between it comes back whole; it is never spliced. Servers
  that compress on the fly mark their versions "weak", and those are never
  resumed, because their bytes can differ between requests.
- **Flickers are retried.** A connection that times out, resets or drops
  before anything arrives - the failures a weak signal causes - is retried
  twice, after 0.6 s and 1.8 s, while there is time. A refused connection, a
  bad certificate or a name that does not exist is a definite answer and fails
  at once.
- **Quiet feeds are checked less often.** Even "nothing changed" costs a TLS
  handshake, about 6.7 KB. Each check that finds nothing new doubles the wait,
  up to 8x (15 minutes becomes 2 hours, never more than 3); any change snaps it
  back. Feeds in the alerts category never back off, and `-f` always fetches.
- **DNS failures fall back.** When a name lookup fails - often the first thing
  to go on a weak signal - the last address that worked for that host (within
  14 days) is used. Healthy lookups always win.

## Speed

A run with every feed cached takes about a third of the time it used to
(208 ms to 82 ms on the build machine): the program waited a fixed 0.12 s per
batch of feeds even when they came from cache in a millisecond.

## Updating safely

`lowpingnews update` (`py news --update` on Windows) fetches the latest release
from GitHub. A check that finds nothing new costs about 11 KB; an update about
70 KB. Nothing is replaced unless the new copy:

- arrived whole: a cut transfer is refused, and so is a file missing its last
  part, even though such a file can still parse;
- is this program, parses, and is newer: older releases are refused unless
  you set `LPN_FORCE=1`;
- actually runs on your machine: it is started once, and must report its
  version, before it replaces anything.

The swap is atomic, the previous version is kept as `news.bak` beside it, and
your interpreter line and file permissions are kept. `lowpingnews update` also
updates the `lowpingnews` command itself, but only when `news` updated or was
already current.

## Portability

Pure standard library, Python 3.5+. Tested on Termux (Android) and Linux; the
behaviour Windows and macOS differ in is tested by simulation.

- **Windows**: no `curses`, `termios` or `fcntl`. Everything still runs; the
  reader falls back to the printed list, or works with `pip install
  windows-curses`. Colour uses VT processing and is dropped if unavailable.
  Updates write the file byte for byte, so line endings stay Unix-style.
- **macOS**: the scripts avoid `sed -i`, whose arguments differ between GNU and
  BSD. Python from python.org needs *Install Certificates.command* once.
- **Termux**: Google Play builds run programs through a preloaded library; the
  tests keep the full environment so that works.
- Opening a link tries `termux-open-url`, then the standard `webbrowser`, then
  prints the URL.
- Source ids that collide with Windows device names (`con`, `nul`, `com1`) are
  suffixed, since those cannot be files.

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
- `--offline` is enforced inside the one function that touches the network, so
  no new code path can forget it.
- The interactive view survives terminals down to 1x1, live resizing, and
  titles in wide or mixed-direction scripts.
- `Ctrl-C` exits cleanly; `SIGPIPE` and broken pipes make `| head` behave.

## Development

`lowpingnews` doubles as its own dev tool:

```sh
lpn status          installed / repo / newest download / git, flags mismatches,
                    and when the site last published (and why not since)
lpn sync            newest valid build -> repo -> install
lpn test            smoke test the installed build
lpn ship "msg"      install, commit, push
lpn release 4.5     bump, install, test, commit, tag, gh release
lpn web             put the phone web app on GitHub Pages
lpn reader deploy   upload the article reader to Cloudflare
lpn schedule        update the site every 20 minutes from Cloudflare (once)
```

`sync` picks builds by parsed `VERSION`, never by filename, and refuses archives
containing files this project does not own. `ship` and `release` refuse to
commit anything outside the files this project owns. `release` is idempotent.

## Why curses, not a framework

Measured, not assumed. Textual costs ~207 ms to import and Rich ~57 ms; together
they pull 13.5 MB across 8 packages and need Python 3.9. The reader uses `curses`
from the standard library instead, which imports in ~12 ms.

The printed list stays a first-class mode: `--plain`, pipes, `news -q term`,
`--stream`, scrollback and copy/paste all work because that output is an
ordinary text stream.

## Reading an article

Pressing enter in `--tui`, or `news -r N`, fetches the article itself rather
than the feed blurb, and says which of three things you actually got. In the
interactive reader the article opens at once on the feed's summary while the
page loads beside it, with the bytes so far on the bottom line: on a stalled
link the keys keep working and **b** goes back, and the text is saved whenever
it arrives.

```
  full article
  abstract only - no full text available
  feed summary only - no full text available
```

bioRxiv and medRxiv publish an abstract at the link in the feed and the whole
paper at the same address plus `.full`, so that is tried first and the abstract
page is only used as a fallback — matched on the DOI path shape, so mirrors work
too. For ordinary sites the page is the article. Whether what came back is the
whole thing is a judgement: a preprint counts as complete when it carries its
own section headings and real length, anything else when it runs past a few
paragraphs. A paywall teaser fails both and is never called a full article.

Saved copies remember which kind they were, so a re-read does not claim more
than the first fetch found — and a saved *abstract* is never the end of the
road: if a full-text address exists it is tried first, so copies downloaded
before this existed get upgraded on the next read.

bioRxiv feeds have linked in more than one form (`/cgi/content/short/<id>` as
well as `/content/10.1101/<id>`); both carry the same id and resolve to the
same `.full` page. When full text still is not had, the reader says why:

```
  abstract only - no full text available
  tried: 2026.09.20.677123v1.full HTTP 403
```

## Choosing feeds

Run `lowpingnews catalog` — or press **f** in the reader — for the feed
editor: every category is a section, and every feed a tick box. **Tap a feed to
tick or untick it**, or move with j/k and press space; swipe to scroll.
`lowpingnews catalog alerts` opens at that section. Ticking a feed puts it in
that category; changes are saved as you make them. Each row shows the feed's size
and the host it points to. A ★ marks a recommended feed that a recorded check
has found working and light; a recommended feed nobody has checked yet shows
`unverified` instead, and gets its star once `catalog check` vouches for it.

```
 FEEDS  9 subscribed, 33 in the index (checked 2d ago)
 alerts  Hazards and emergencies
 [x]   USGS big quakes             ? earthquake.usgs.gov
 [ ]   GDACS disasters             ? gdacs.org
```

  tap    tick or untick for this category (space does the same)
  t      add this feed to another category - type a new name to create one
  a      add any feed by address, or a website that advertises one
  d      remove a feed from every category
  u      fetch the newest feed list

Tapping works by asking the terminal to report touches, which also stops it
from selecting text — so that is switched on only while the editor is open,
and handed back when you leave. `LPN_NO_MOUSE=1` keeps it off entirely.
Piped, or with `--plain`, `catalog` prints the list instead of opening the
editor.

The same from the command line, apt-style:

```sh
lowpingnews catalog update               # fetch the newest feed list
lowpingnews catalog                      # what you can subscribe to
lowpingnews catalog alerts               # one category
lowpingnews catalog add quakes           # subscribe
lowpingnews catalog add quakes --to "Survival Kit"   # any category, new ones too
lowpingnews catalog add example.org/blog # a site: its advertised feed is found
lowpingnews catalog remove quakes --from alerts
lowpingnews catalog check                # are my feeds healthy?
```

**The feed list** is `catalog.json` in this repository: one gzipped file of
about 1.6 KB, fetched only when you ask and only if it changed (an unchanged
check costs a TLS handshake, ~7 KB). It is a list of suggestions — updating it
never changes what you are subscribed to. Every field in it is treated as
untrusted: addresses must be http(s), names are stripped of control
characters, categories are normalised, and a malformed entry is dropped on its
own while a malformed file is rejected whole, keeping the one you had. If a feed
you follow moves, `catalog update` says so and `catalog upgrade` takes the new
address.

The whole list also ships inside the program, so a new install with no
network can still offer every recommendation. Once a list has been fetched it
is authoritative: a feed the published list drops — typically one that failed
its checks — stops being offered, rather than living on from the built-in
copy. The header always says how long ago your copy was checked, and nudges
you after two weeks; a timestamp from a wrong clock reads as "age unknown".

**Checking feeds.** `catalog check` asks each feed for its first 8 KB only, by
range request, and reports whether it answered, whether it is really a feed,
its size, and whether it sends validators (which make unchanged refreshes
cheap). Servers that ignore range requests are cut off early with a small
receive window: a probe that once received 129 KB for a 481 KB feed now
receives about 30 KB. `check all` asks first if the total looks large, and
`--budget KB` caps it. `--write catalog.json` records the results in the file,
which is how entries get their `ok` date: run it on a phone and commit.

**Adding by address** accepts what people actually type — `lwn.net/headlines`,
a full URL, a host with a port — and refuses anything that cannot be a feed:
other schemes (`ftp:`, `file:`, `javascript:`), an address with no host, and
an address containing a user name or password, which would otherwise sit in
`sources.json` in plain text. A feed found through a web page is named after
the feed itself, or the name the page gave it — never after its first article.
Pasting several lines at a prompt takes the first and discards the rest, so
leftover text can never reach the next prompt or act as menu keys. Failed
`add` and `remove` commands exit non-zero, so scripts can tell.

**Verification status of the shipped list.** The fifteen defaults were checked
by real fetches from a phone; the project's own release feed was checked from
the build machine. The other recommendations — including the hazard feeds —
have not been checked from a real connection yet, which is why they carry no
star. `lowpingnews catalog check all --write catalog.json` on a phone, then a
release, is how that changes.

Categories are yours to make: any word in any script (`été`, `日本`) except the
few the command line already uses (`all`, `weather`, `signal`, `saved`...).
Every edit keeps the previous `sources.json` as `sources.json.bak`, a damaged
`sources.json` is reported rather than overwritten, and the last feed cannot be
removed, since an empty list would quietly bring the defaults back.

## Interactive mode (the default)

In a terminal, `lowpingnews` opens the interactive reader:

```
 LowPingNews 6.7  BIO  40 items            ▂▃▂▁▂ 38ms good
 • bioRxiv plant  3d   BSA101: Unlocking Historical Mutant...
```

  j/k move    enter read    b back    s star    o open
  n/p category    r refresh    f feeds    q quit

The classic list is still there, and is what you get whenever the invocation
asks for it: `--plain`, any list-shaping flag (`-t`, `-u`, `-n`, `-q`,
`--stream`, `--light`...), a pipe (`lowpingnews | head`), `TERM=dumb`, or
`LPN_NO_TUI=1`. Scripts never see the TUI. Numbers shown in the TUI are the
ones `-r N`, `-o N` and `-S N` use afterwards.

**The ping meter** in the banner is round-trip time to the nearest point of
presence, measured as a TCP handshake — not ICMP, which carriers drop
independently of real traffic and which most Termux installs lack. The
references are anycast addresses (1.1.1.1, 8.8.8.8, 9.9.9.9): the network
routes each to its closest site, so "nearest to where you are" needs no location
lookup. One probe is sent every five minutes, trying a different reference
each time until all three have been measured, then keeping the fastest. Each
probe is about 0.8 KB, closed with a reset rather than the usual exchange to
save packets, and none are sent more than five minutes after your last
keypress — so an idle reader costs nothing. `--offline` and `LPN_NO_PING=1`
turn it off; `LPN_PING_REFS=host:port,...` substitutes your own reference.

Built on `curses` (standard library, ~12 ms to import). POSIX-only: on Windows
it needs `pip install windows-curses`; without it the default quietly falls
back to the list, and only an explicit `--tui` complains.

## Freshness

The rule: anything shown is either current or says how old it is. In
practice:

- **Every footer** — normal, `--offline`, `--stream`, weather — reports data
  served from cache after a failed refresh: `stale 5h ago`.
- **The TUI banner** always carries the age of the oldest source on screen, in
  green while current and yellow once past its refresh interval
  (`TOP  40 items  12m` / `stale 5h`). Ages in the list recompute every second.
- **The TUI refreshes itself** once data passes its interval, in the
  background, using conditional requests so an unchanged feed costs a
  handshake (~4-7 KB) rather than a full download — but only within five
  minutes of a keypress. The cursor stays on the story it was on. After a failed
  attempt it backs off two minutes instead of retrying continuously, and no
  feed is refreshed more often than once a minute whatever its `ttl` says.
- **Status messages expire**, and "working" messages are replaced by the
  outcome, so nothing like "refreshing…" outlives the work it describes.
- **`-r N` on an old list** warns on stderr: `note: from a list shown 2d ago`.
- **Saved articles** say how old they are: `full article, saved 3d ago`.
- **The ping meter** reports `stale` if its sampler stops producing readings,
  rather than showing an old number as current.
- **A timestamp in the future** — a cache written while the phone's clock was
  wrong — counts as *unknown age*, never as fresh. The naive check
  `now - t < ttl` is true for negative ages, which would have frozen a feed
  indefinitely; and a self-generated `If-Modified-Since` dated in the future
  invites a 304, which would have defeated even `-f`. Both are guarded, and
  "age unknown" is shown rather than a plausible-looking number.

## Tests

```sh
python3 test.py            # everything
python3 test.py weather    # just the weather tests
lpn test                   # same, via the dev tool
```

No network — verified by logging every name lookup across a full run, which
found none — and the program itself is not mocked: each test starts a local HTTP
server and runs the real binary against it, with config, cache and state
redirected to a scratch directory. The suite covers failures that actually
shipped — a truncated transfer cached as complete, a future-dated item pinning
itself to the top of the list, warm-cache paths that crashed because only cold
ones were exercised, control characters reaching the terminal, and lines
overflowing a 40-column screen.


The suite runs four tests at a time (at least two, even on one core: most
tests wait on a terminal, a local server or a timeout rather than compute).
Timings from the last run spread the slow ones evenly. Failures are repeated,
with their reasons, at the end, where they cannot scroll away.
`LPN_TEST_JOBS=1` runs one at a time; a name filter (`python3 test.py weather`)
always runs serially.
## License

MIT
