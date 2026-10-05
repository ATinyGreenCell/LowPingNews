#!/usr/bin/env python3
"""LowPingNews test suite. Stdlib only, no network: every server is local.

    python3 test.py            run everything
    python3 test.py date       run tests whose name contains "date"
"""
import gzip, io, json, os, re, shutil, socketserver, subprocess, sys, tempfile
import threading, time
import http.server
from importlib.machinery import SourceFileLoader
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
NEWS = os.path.join(HERE, "news")
FAILED, RAN = [], 0

# ---------------------------------------------------------------- parallel runs
# Every test makes its own scratch folders and its own local server, so the
# suite can run in several processes at once. With no filter given, this
# process only plans and collects: the longest tests are spread across the
# workers using timings saved from the last run. LPN_TEST_JOBS=1 runs it serially.
_CHILD = os.environ.get("LPN_TEST_CHILD") == "1"
_PLAN = set(json.load(open(os.environ["LPN_TEST_PLAN"]))) if _CHILD and os.environ.get("LPN_TEST_PLAN") else None
_OUT = os.environ.get("LPN_TEST_OUT") if _CHILD else None
_TIMES = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "lowpingnews-test-times.json")


def _record(name, status, msg, secs):
    if _OUT:
        with open(_OUT, "a") as fh:
            fh.write(json.dumps([name, status, msg, round(secs, 2)]) + "\n")


def _run_parallel(jobs):
    src = io.open(os.path.abspath(__file__), encoding="utf-8").read()
    names = re.findall(r"^@test\s*\ndef t_(\w+)", src, re.M)
    try:
        past = json.load(open(_TIMES))
    except Exception:
        past = {}
    plan = [[] for _ in range(jobs)]
    load_ = [0.0] * jobs
    for n in sorted(names, key=lambda n: -float(past.get(n, 1.0))):   # longest first, to the lightest worker
        k = load_.index(min(load_))
        plan[k].append(n)
        load_[k] += float(past.get(n, 1.0))
    tmp = tempfile.mkdtemp(prefix="lpn-tests-")
    print("LowPingNews tests (%d at a time; LPN_TEST_JOBS=1 for one)" % jobs)
    sys.stdout.flush()
    t0, procs = time.time(), []
    for k, part in enumerate(plan):
        pf, of = os.path.join(tmp, "plan%d.json" % k), os.path.join(tmp, "out%d.jsonl" % k)
        json.dump(part, open(pf, "w"))
        e = dict(os.environ, LPN_TEST_CHILD="1", LPN_TEST_PLAN=pf, LPN_TEST_OUT=of, PYTHONUNBUFFERED="1")
        procs.append((subprocess.Popen([sys.executable, os.path.abspath(__file__)], env=e), of, part))
    results = {}
    for pr, of, part in procs:
        rc = pr.wait()
        got = {}
        if os.path.exists(of):
            for ln in open(of):
                r = json.loads(ln)
                got[r[0]] = r
        for n in part:                              # a worker that died takes its tests with it: say so
            results[n] = got.get(n) or [n, "error", "its worker stopped during or before this test (exit %d)" % rc, 0]
    shutil.rmtree(tmp, ignore_errors=True)
    bad = [results[n] for n in names if results[n][1] in ("fail", "error")]
    skipped = [n for n in names if results[n][1] == "skip"]
    try:
        past.update({n: results[n][3] for n in names if results[n][3]})
        os.makedirs(os.path.dirname(_TIMES), exist_ok=True)
        json.dump(past, open(_TIMES, "w"))
    except Exception:
        pass
    print("LowPingNews tests")
    print("  %d run, %d failed%s, %.0fs" % (len(names) - len(skipped), len(bad),
                                         (", %d skipped" % len(skipped)) if skipped else "", time.time() - t0))
    for n, st, msg, _s in bad:                      # repeated here, where they cannot scroll away
        print("  %s  %s\n        %s" % ("FAIL " if st == "fail" else "ERROR", n, msg))
    sys.exit(1 if bad else 0)


if __name__ == "__main__" and not _CHILD and len(sys.argv) == 1:
    # tests mostly wait (on a terminal, a server, a timeout), so even one core
    # gains from two at once; four is plenty and keeps a phone responsive
    _jobs = int(os.environ.get("LPN_TEST_JOBS") or max(2, min(4, os.cpu_count() or 1)))
    if _jobs > 1:
        _run_parallel(_jobs)


def load():
    spec = importlib.util.spec_from_loader("news", SourceFileLoader("news", NEWS))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def sandbox():
    """Point config/cache/data at a scratch dir so tests never touch real state."""
    d = tempfile.mkdtemp(prefix="lpn-test-")
    env = dict(os.environ)
    env["XDG_CONFIG_HOME"] = os.path.join(d, "cfg")
    env["XDG_CACHE_HOME"] = os.path.join(d, "cache")
    env["XDG_DATA_HOME"] = os.path.join(d, "data")
    env["LPN_NO_PROGRESS"] = "1"
    # no ping meter unless a test asks for one: it probes real anycast hosts
    env["LPN_NO_PING"] = "1"
    # what Termux sets; the host's own TERM (here "linux") would test a
    # different terminal - no alternate screen, another mouse encoding
    env["TERM"] = "xterm-256color"
    # NOAA's station lists are megabytes: a site build in a test never fetches
    # them (or NDBC's readings) unless the test serves its own
    for k in ("LPN_TIDE_META", "LPN_CURR_META", "LPN_NDBC"):
        env[k] = NOWHERE
    return d, env


def sources(env, entries):
    p = os.path.join(env["XDG_CONFIG_HOME"], "lowpingnews")
    os.makedirs(p, exist_ok=True)
    with io.open(os.path.join(p, "sources.json"), "w", encoding="utf-8") as f:
        json.dump(entries, f)


def run(env, *args):
    p = subprocess.run([NEWS] + list(args), stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, env=env)
    out = re.sub(r"\x1b\[[0-9;]*m", "", p.stdout.decode("utf-8", "replace"))
    err = p.stderr.decode("utf-8", "replace")
    if "Traceback" in err:
        raise AssertionError("crashed: " + err.strip().split("\n")[-1])
    return out, err, p.returncode


class Server(object):
    """Serves whatever the test hands it, and records what was requested."""
    def __init__(self):
        self.routes, self.seen = {}, []
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_GET(self):
                outer.seen.append((self.path, dict(self.headers)))
                fn = outer.routes.get(self.path.split("?")[0])
                if fn is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                fn(self)

        class TS(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True
        self.httpd = TS(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def feed(self, path, items, gzip_it=True, etag=None, cut=None, headers=None):
        body = ('<?xml version="1.0"?><rss version="2.0" '
                'xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>'
                + "".join(items) + '</channel></rss>').encode()
        raw = gzip.compress(body) if gzip_it else body

        def handler(h):
            if etag and h.headers.get("If-None-Match") == etag:
                h.send_response(304)
                h.send_header("ETag", etag)
                h.send_header("Content-Length", "0")
                h.end_headers()
                return
            h.send_response(200)
            if gzip_it:
                h.send_header("Content-Encoding", "gzip")
            if etag:
                h.send_header("ETag", etag)
            for k, v in (headers or {}).items():
                h.send_header(k, v)
            h.send_header("Content-Length", str(len(raw)))
            h.end_headers()
            if cut is None:
                h.wfile.write(raw)
            else:                                  # simulate a dying connection
                h.wfile.write(raw[:int(len(raw) * cut)])
                h.wfile.flush()
                h.close_connection = True
                try:
                    h.connection.close()
                except Exception:
                    pass
        self.routes[path] = handler

    def json(self, path, obj):
        raw = gzip.compress(json.dumps(obj).encode())

        def handler(h):
            h.send_response(200)
            h.send_header("Content-Encoding", "gzip")
            h.send_header("Content-Length", str(len(raw)))
            h.end_headers()
            h.wfile.write(raw)
        self.routes[path] = handler


def _read_until(fd, done=None, least=0.0, quiet=0.6, most=20.0, settle_after=None):
    """Read a pty until `done(bytes)` is true, or - without `done` - until the
    program has been quiet for `quiet` seconds after at least `least`. Fixed
    sleeps passed on a fast machine and failed mid-suite on a warm phone."""
    import select
    out, start, last = b"", time.time(), time.time()
    while True:
        now = time.time()
        if now - start >= most:
            return out
        if done is not None and done(out):
            return out
        # a screen too small to show the awaited text: accept one that has
        # drawn something and then stayed still for a good while
        if done is not None and settle_after is not None and out and \
                now - start >= settle_after and now - last >= 1.5:
            return out
        # quiet counts from the last output or, if a key drew nothing at all
        # (Enter on an empty list), from when we started waiting
        if done is None and now - start >= least and now - last >= quiet:
            return out
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return out
            if not chunk:
                return out
            out += chunk
            last = time.time()


def _drive_tui(env, keys, rows=24, cols=64, settle=0.7, args=("--tui",), raw=False, ready=None):
    """Run the curses interface on a pty and feed it real keystrokes."""
    import fcntl, pty, select, struct, termios
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execv(NEWS, ["news"] + list(args))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    buf = b""

    def pump(t):
        global_end = time.time() + t
        out = b""
        while time.time() < global_end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                try:
                    out += os.read(fd, 65536)
                except OSError:
                    break
        return out
    # until the first full screen: its key line ends in "quit" (reader) or
    # "back" (feed editor). Quiet alone is not enough - startup has a silent
    # stretch while the first load runs.
    buf += _read_until(fd, ready or (lambda b: b"quit" in b or b"q back" in b), most=20.0,
                       settle_after=None if ready else 3.0)
    buf += _read_until(fd, least=0.2, quiet=0.3, most=3.0)
    for k in keys:
        try:
            os.write(fd, k)
        except OSError:
            break
        buf += _read_until(fd, least=settle, quiet=0.4, most=10.0)
    try:
        os.close(fd)
    except Exception:
        pass
    try:
        os.waitpid(pid, os.WNOHANG)
    except Exception:
        pass
    if raw:
        return buf.decode("utf-8", "replace")
    txt = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", buf.decode("utf-8", "replace"))
    return txt.replace("\r", "").replace("\x0f", "")


NOWHERE = "http://127.0.0.1:9"       # closed: refused instantly, never leaves the machine


def item(title, when=None, body="Summary text.", link=NOWHERE + "/a"):
    d = "<dc:date>%s</dc:date>" % when if when else ""
    return ("<item><title>%s</title><link>%s</link>"
            "<description>%s</description>%s</item>" % (title, link, body, d))


class Skip(Exception):
    """A test that needs something optional which is not installed. Reported
    as skipped, with the reason; never counted as a pass or a failure."""


SKIPPED = []


def test(fn):
    name = fn.__name__[2:]
    if len(sys.argv) > 1 and sys.argv[1] not in name:
        return fn
    if _PLAN is not None and name not in _PLAN:
        return fn                                   # another worker's test
    global RAN
    RAN += 1
    d = None
    t0_ = time.time()
    try:
        d, env = sandbox()
        fn(env, Server())
        sys.stdout.write("  ok    %s\n" % name)
        _record(name, "ok", "", time.time() - t0_)
    except Skip as e:
        SKIPPED.append(name)
        sys.stdout.write("  skip  %s\n        %s\n" % (name, e))
        _record(name, "skip", str(e), time.time() - t0_)
    except AssertionError as e:
        FAILED.append(name)
        sys.stdout.write("  FAIL  %s\n        %s\n" % (name, e))
        _record(name, "fail", str(e)[:300], time.time() - t0_)
    except Exception as e:
        FAILED.append(name)
        sys.stdout.write("  ERROR %s\n        %s: %s\n" % (name, type(e).__name__, e))
        _record(name, "error", ("%s: %s" % (type(e).__name__, e))[:300], time.time() - t0_)
    finally:
        if d:
            shutil.rmtree(d, ignore_errors=True)
    return fn


# ---------------------------------------------------------------- parsing
@test
def t_dates_all_shapes(env, srv):
    m = load()
    now = int(time.time())
    for txt in ("2026-09-13", "2026-09-13T05:00:00Z", "2026-09-13T05:00:00+02:00",
                "Sun, 13 Sep 2026 05:00:00 GMT", "2026/09/13", "20260913"):
        assert m.when(txt) > 0, "failed to parse %r" % txt
    assert m.when("garbage") == 0
    assert m.when("") == 0
    assert m.when("2026-13-45") == 0, "accepted an impossible date"
    # a bare date and an explicit UTC time must agree on the day
    assert abs(m.when("2026-09-13") - m.when("2026-09-13T00:00:00Z")) < 1


@test
def t_future_dates_do_not_pin_to_top(env, srv):
    now = int(time.time())
    rfc = lambda ts: time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(ts))
    srv.feed("/f", [
        '<item><title>FUTURE</title><link>http://e.invalid/1</link>'
        '<description>d</description><pubDate>%s</pubDate></item>' % rfc(now + 86400 * 3),
        '<item><title>FRESH</title><link>http://e.invalid/2</link>'
        '<description>d</description><pubDate>%s</pubDate></item>' % rfc(now - 300)])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    out, _, _ = run(env, "-t", "-n", "5")
    order = [l for l in out.split("\n") if "FUTURE" in l or "FRESH" in l]
    assert "FRESH" in order[0], "a future-dated item outranked a fresh one:\n%s" % out
    fut = [l for l in out.split("\n") if l.strip().startswith(("1 ", "2 "))]
    assert "?" in out, "an untrusted date should render as ?"


@test
def t_malformed_xml_still_yields_items(env, srv):
    m = load()
    bad = (b'<?xml version="1.0"?><rss version="2.0"><channel>'
           b'<item><title>A &amp; B</title><link>http://e.invalid/1</link>'
           b'<description>text<br></description></item></channel></rss>')
    got = m.parse_feed(bad)
    assert len(got) == 1 and got[0]["ti"], "loose parser lost the item"


@test
def t_truncated_feed_salvages_whole_items(env, srv):
    import base64
    items = [item("Story number %d" % i,
                  body="Body %s" % base64.b64encode(os.urandom(120)).decode())
             for i in range(12)]
    srv.feed("/cut", items, cut=0.85)
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/cut")}])
    out, _, _ = run(env, "-t", "-n", "20")
    got = out.count("Story number")
    assert got >= 5, "salvaged only %d of 12 items from an 85%% transfer" % got
    assert "truncated" in out, "a partial fetch must say so:\n%s" % out


@test
def t_partial_feed_is_not_cached_as_complete(env, srv):
    import base64
    srv.feed("/cut", [item("S%d" % i, body=base64.b64encode(os.urandom(120)).decode())
                      for i in range(12)], cut=0.8, etag='"v1"')
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/cut")}])
    run(env, "-t")
    cf = os.path.join(env["XDG_CACHE_HOME"], "lowpingnews", "a.json")
    rec = json.load(io.open(cf, encoding="utf-8"))
    assert rec.get("p") == 1, "partial fetch not flagged"
    assert "et" not in rec and "lm" not in rec, \
        "stored a validator for a truncated body; a later 304 would confirm it"


# ---------------------------------------------------------------- network
@test
def t_conditional_get_sends_validator_and_honours_304(env, srv):
    srv.feed("/f", [item("Only story")], etag='"v1"')
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    out, _, _ = run(env, "-tf")
    assert "unchanged (304)" in out, "second fetch did not report a 304:\n%s" % out
    sent = [h for p, h in srv.seen if p.startswith("/f")]
    assert any("If-None-Match" in h or "If-Modified-Since" in h for h in sent[1:]), \
        "no validator sent on refresh"


@test
def t_validatorless_feed_still_gets_if_modified_since(env, srv):
    srv.feed("/f", [item("Only story")])          # no ETag, no Last-Modified
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    run(env, "-tf")
    sent = [h for p, h in srv.seen if p.startswith("/f")]
    assert "If-Modified-Since" in sent[-1], \
        "a server that advertises no validator should still be asked"


@test
def t_offline_opens_no_socket(env, srv):
    srv.feed("/f", [item("Cached story")])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    before = len(srv.seen)
    out, _, _ = run(env, "--offline", "-t")
    assert len(srv.seen) == before, "--offline made a request"
    assert "Cached story" in out, "--offline did not serve the cache"


@test
def t_dead_feed_falls_back_to_cache(env, srv):
    srv.feed("/f", [item("Cached story")])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    srv.routes.clear()                            # feed now 404s
    out, _, _ = run(env, "-tf")
    assert "Cached story" in out, "lost the cache when the feed died:\n%s" % out


@test
def t_failed_fetch_counts_as_failure_in_signal(env, srv):
    srv.feed("/f", [item("S")])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    srv.routes.clear()
    for _ in range(3):
        run(env, "-tf")
    out, _, _ = run(env, "signal")
    assert "100% ok" not in out, \
        "signal claimed a perfect record after repeated failures:\n%s" % out


# ---------------------------------------------------------------- config
@test
def t_hostile_sources_are_rejected(env, srv):
    srv.feed("/f", [item("Good")])
    sources(env, [
        {"id": "../../evil", "name": "Traversal", "cats": ["top"], "url": srv.url("/f")},
        {"id": "con", "name": "Reserved", "cats": ["top"], "url": srv.url("/f")},
        {"id": "local", "name": "Local", "cats": ["top"], "url": "file:///etc/passwd"},
        {"id": "js", "name": "JS", "cats": ["top"], "url": "javascript:alert(1)"},
        "not a dict",
        {"id": "ok", "name": "OK", "cats": ["top"], "url": srv.url("/f")}])
    out, _, _ = run(env, "-l")
    assert "file:///" not in out and "javascript:" not in out, "kept a non-http source"
    assert "/../" not in out and "../.." not in out, "kept a traversal id"
    assert "con_" in out or "con " not in out, "Windows device name not suffixed"


@test
def t_item_links_must_be_http(env, srv):
    m = load()
    assert m.safe_url("javascript:alert(1)") == ""
    assert m.safe_url("file:///etc/passwd") == ""
    assert m.safe_url("https://ok.invalid/x") == "https://ok.invalid/x"


@test
def t_control_characters_never_reach_the_terminal(env, srv):
    m = load()
    got = m.clean("a\x00b\x1b[31m\x07 ok")
    assert "\x00" not in got and "\x1b" not in got and "\x07" not in got, repr(got)


# ---------------------------------------------------------------- weather
def _forecast(hour=None, rain=False):
    hour = hour or int(time.time()) // 3600 * 3600
    d0 = hour - (hour % 86400)
    pop = [0, 0, 5, 80, 60, 10] + [0] * 18 if rain else [0] * 24
    amt = [0, 0, 0, .3, .2, 0] + [0] * 18 if rain else [0] * 24
    return {"utc_offset_seconds": 0,
            "current": {"time": hour, "temperature_2m": 64,
                        "apparent_temperature": 62, "weather_code": 2,
                        "wind_speed_10m": 6, "wind_gusts_10m": 18,
                        "wind_direction_10m": 270, "relative_humidity_2m": 70,
                        "is_day": 1},
            "hourly": {"time": [hour + i * 3600 for i in range(24)],
                       "temperature_2m": [60 + i * 0.3 for i in range(24)],
                       "precipitation_probability": pop, "precipitation": amt,
                       "weather_code": [2] * 24},
            "daily": {"time": [d0 + i * 86400 for i in range(7)],
                      "weather_code": [61, 3, 3, 0, 80, 1, 95],
                      "temperature_2m_max": [70] * 7, "temperature_2m_min": [55] * 7,
                      "precipitation_probability_max": [85, 5, 0, 0, 65, 20, 55],
                      "precipitation_sum": [.5, 0, 0, 0, .4, 0, .3],
                      "sunrise": [d0 + 6 * 3600 + i * 86400 for i in range(7)],
                      "sunset": [d0 + 19 * 3600 + i * 86400 for i in range(7)]}}


def _wx_binary(srv, tmp):
    """A copy of news pointed at the local server instead of Open-Meteo."""
    src = io.open(NEWS, encoding="utf-8").read()
    src = src.replace("https://api.open-meteo.com/v1/forecast?", srv.url("/fc?"))
    src = src.replace("https://geocoding-api.open-meteo.com/v1/search?", srv.url("/geo?"))
    src = src.replace("https://ipapi.co/json/", srv.url("/ip"))
    p = os.path.join(tmp, "news_wx")
    io.open(p, "w", encoding="utf-8").write(src)
    os.chmod(p, 0o755)
    return p


@test
def t_weather_severity_is_ranked_not_maxed(env, srv):
    m = load()
    # WMO numbers are not ordered by severity: 80 (showers) < 75 (heavy snow)
    assert m.WMO[m.worst([75, 80])][0] == "Heavy Snow"
    assert m.WMO[m.worst([95, 82])][0] == "Thunderstorm"
    assert m.WMO[m.worst([45, 3])][0] == "Fog"


@test
def t_weather_renders_and_fits_narrow_terminals(env, srv):
    tmp = tempfile.mkdtemp()
    try:
        # pin the hour so the sunrise countdown (the widest line) always renders
        h = (int(time.time()) // 86400) * 86400 + 4 * 3600
        srv.json("/fc", _forecast(hour=h, rain=True))
        binary = _wx_binary(srv, tmp)
        e = dict(env); e["COLUMNS"] = "40"
        subprocess.run([binary, "weather", "-c", "40.9,-73.4", "--label", "Test"],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=e)
        p = subprocess.run([binary, "weather"], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=e)
        out = re.sub(r"\x1b\[[0-9;]*m", "", p.stdout.decode())
        assert "Traceback" not in p.stderr.decode(), p.stderr.decode()[-200:]
        assert "NEXT" in out and "7 DAY" in out, "forecast sections missing:\n%s" % out
        assert "gusts 18" in out, "gusts well above mean wind should be shown"
        over = [l for l in out.split("\n") if len(l) > 40]
        assert not over, ("lines wider than the 40-column terminal:\n" +
                          "\n".join("%3d: %s" % (len(l), l) for l in over))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_geocode_survives_malformed_results(env, srv):
    tmp = tempfile.mkdtemp()
    try:
        binary = _wx_binary(srv, tmp)
        srv.json("/fc", _forecast())
        shapes = [{"results": [{"name": "NoCoords"}]},
                  {"results": {"not": "a list"}},
                  {"results": [None]},
                  {"results": [{"name": "OutOfRange", "latitude": 991, "longitude": 0}]},
                  {"results": [{"name": "NaN", "latitude": float("nan"), "longitude": 0}]}]
        for shape in shapes:
            srv.json("/geo", shape)
            p = subprocess.run([binary, "weather", "-p", "test"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            assert "Traceback" not in p.stderr.decode(), \
                "crashed on %r: %s" % (shape, p.stderr.decode()[-160:])
            assert p.returncode == 1, "accepted a bogus place: %r" % shape
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_geocode_picks_best_and_discloses_alternatives(env, srv):
    tmp = tempfile.mkdtemp()
    try:
        binary = _wx_binary(srv, tmp)
        srv.json("/fc", _forecast())
        srv.json("/geo", {"results": [
            {"name": "Huntington", "latitude": 40.868, "longitude": -73.426,
             "admin1": "New York", "country": "United States"},
            {"name": "Huntington", "latitude": 38.419, "longitude": -82.445,
             "admin1": "West Virginia", "country": "United States"}]})
        p = subprocess.run([binary, "weather", "-p", "Huntington"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        out = re.sub(r"\x1b\[[0-9;]*m", "", p.stdout.decode())
        err = p.stderr.decode()
        assert "New York" in out, "did not use the first match:\n%s" % out
        assert "West Virginia" in err, "ambiguity was hidden from the user"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_conflicting_location_flags_are_refused(env, srv):
    _, err, rc = run(env, "weather", "-p", "Paris", "-c", "40.9,-73.4")
    assert rc != 0 and "one location source" in err, \
        "silently preferred one location flag over another"


# ---------------------------------------------------------------- interface
@test
def t_every_command_runs_against_a_warm_cache(env, srv):
    """The regression that shipped a crash: cache-warm paths were never tested."""
    srv.feed("/f", [item("Story one"), item("Story two")])
    srv.json("/fc", _forecast())
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top", "science"],
                   "url": srv.url("/f")}])
    run(env, "-t")                                  # warm everything
    run(env, "-d", "all")
    for args in (["-t"], ["-t", "-n", "1"], ["science", "-t"], ["--cost"], ["-l"],
                 ["signal"], ["--offline", "-t"], ["--light", "-t"], ["-q", "Story"],
                 ["-u", "-t"], ["--mark-all"], ["-r", "1"], ["-S", "1"], ["saved"],
                 ["--stream", "-t"], ["--ascii", "-t"], ["--no-color", "-t"]):
        run(env, *args)                             # run() raises on a traceback


@test
def t_piping_stays_clean(env, srv):
    srv.feed("/f", [item("Story")])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    out, err, _ = run(env, "-t")
    assert "\u2588" not in out and "\r" not in out, "progress bar leaked into stdout"
    assert "\x1b[" not in out, "colour survived a pipe"


@test
def t_non_utf8_terminal_degrades(env, srv):
    srv.feed("/f", [item("Caf\u00e9 \u2014 na\u00efve")])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    e = dict(env); e["LANG"] = "C"; e["LC_ALL"] = "C"; e["PYTHONIOENCODING"] = "ascii"
    run(e, "-t")                                    # must not raise


@test
def t_download_budget_is_enforced(env, srv):
    big = b"<html><body>" + b"<p>" + b"x" * 400 + b"</p>" * 50 + b"</body></html>"

    def page(h):
        h.send_response(200)
        h.send_header("Content-Length", str(len(big)))
        h.end_headers()
        h.wfile.write(big)
    srv.routes["/page"] = page
    srv.feed("/f", [item("S%d" % i, link=srv.url("/page")) for i in range(5)])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t", "-n", "5")
    out, _, _ = run(env, "-d", "all", "--budget", "1")
    assert "budget" in out, "budget ceiling never reported:\n%s" % out


@test
def t_tui_survives_an_empty_list(env, srv):
    """sel went to -1 on an empty list, and rows[-1] is a valid index."""
    import pty, select, struct, termios, fcntl
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": "http://127.0.0.1:9/nothing"}])
    out = _drive_tui(env, [b"j", b"j", b"k", b"\r", b"s", b"m", b"n", b" ", b"m", b"q"])
    assert "Traceback" not in out, out[-300:]


@test
def t_tui_lists_reads_and_switches_category(env, srv):
    srv.feed("/f", [item("Alpha headline %d" % i, body="Summary.") for i in range(6)])
    srv.feed("/f2", [item("Beta headline %d" % i, body="Summary.") for i in range(6)])
    sources(env, [{"id": "a", "name": "Alpha", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")},
                  {"id": "b", "name": "Beta", "kind": "rss", "cats": ["science"],
                   "url": srv.url("/f2")}])
    out = _drive_tui(env, [b"j", b"\r", b"b", b"n", b"q"], settle=1.2)
    assert "Traceback" not in out, out[-300:]
    assert "headline" in out.lower(), "no items rendered:\n%s" % out[-400:]
    assert "SCIENCE" in out.upper(), "n did not switch category:\n%s" % out[-400:]


def _page(srv, path, html):
    raw = html if isinstance(html, bytes) else html.encode()

    def handler(h):
        h.send_response(200)
        h.send_header("Content-Length", str(len(raw)))
        h.end_headers()
        h.wfile.write(raw)
    srv.routes[path] = handler


def _body(n, word="paragraph"):
    return "".join(
        "<p>Body %s %d with enough words to count as a real paragraph of an "
        "article rather than a teaser or a caption line.</p>" % (word, i)
        for i in range(n))


@test
def t_preprint_prefers_full_text_over_abstract(env, srv):
    """bioRxiv serves an abstract at the bare link and the paper at .full."""
    _page(srv, "/content/10.1101/2026.01.15.123456v1", "<html><body><article><h2>Abstract</h2>"
          "<p>A short abstract describing the preprint in a single block of "
          "text, as the landing page shows it to anyone visiting.</p>"
          "</article></body></html>")
    _page(srv, "/content/10.1101/2026.01.15.123456v1.full", "<html><body><article><h2>Abstract</h2><p>Short "
          "abstract text repeated at the head of the full paper here.</p>"
          "<h2>Introduction</h2>" + _body(6) + "<h2>Results</h2>" + _body(8) +
          "<h2>Methods</h2>" + _body(6) + "<h2>Discussion</h2>" + _body(3) +
          "</article></body></html>")
    srv.feed("/f", [item("A preprint", link=srv.url("/content/10.1101/2026.01.15.123456v1"))])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    out, _, _ = run(env, "-r", "1")
    assert "full article" in out, "did not report full text:\n%s" % out[:300]
    assert "Results" in out or "Body paragraph" in out, "body missing"
    paths = [p.split("?")[0] for p, _h in srv.seen]
    assert "/content/10.1101/2026.01.15.123456v1.full" in paths, "never asked for the full text: %s" % paths


@test
def t_abstract_only_is_labelled_honestly(env, srv):
    """No .full page (PDF-only preprints): say abstract, do not imply more."""
    _page(srv, "/content/10.1101/2026.02.02.999999v1", "<html><body><article><h2>Abstract</h2>"
          "<p>Only an abstract is published here for this particular preprint, "
          "with no full text available to read on the web at all.</p>"
          "</article></body></html>")
    srv.feed("/f", [item("Abstract only preprint", link=srv.url("/content/10.1101/2026.02.02.999999v1"))])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    out, _, _ = run(env, "-r", "1")
    assert "abstract only" in out, "an abstract was presented as an article:\n%s" % out[:300]
    assert "full article" not in out


@test
def t_ordinary_article_counts_as_full(env, srv):
    _page(srv, "/story", "<html><body><div class='article-main'>" + _body(11) +
          "</div></body></html>")
    srv.feed("/f", [item("An ordinary news story", link=srv.url("/story"))])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    out, _, _ = run(env, "-r", "1")
    assert "full article" in out, "a complete news article was called partial:\n%s" % out[:300]


@test
def t_paywall_is_not_called_full(env, srv):
    _page(srv, "/pay", "<html><body><article><p>Subscribers only. Sign in to "
          "continue reading this article today.</p></article></body></html>")
    srv.feed("/f", [item("Paywalled story", link=srv.url("/pay"))])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    out, _, _ = run(env, "-r", "1")
    assert "full article" not in out, "a paywall teaser was called a full article"


def _preprint_site(srv, pid, full_status=200):
    _page(srv, "/content/10.1101/%s" % pid, "<html><body><article><h2>Abstract</h2>"
          "<p>A short abstract as the landing page shows it to any visitor, "
          "one block of text and nothing further.</p></article></body></html>")
    _page(srv, "/cgi/content/short/%s" % pid, "<html><body><article><h2>Abstract"
          "</h2><p>The same short abstract, reached by the older link form the "
          "feed uses for this preprint.</p></article></body></html>")
    if full_status == 200:
        _page(srv, "/content/10.1101/%s.full" % pid,
              "<html><body><article><h2>Abstract</h2><p>Short.</p>"
              "<h2>Introduction</h2>" + _body(5) + "<h2>Results</h2>" + _body(6) +
              "<h2>Methods</h2>" + _body(5) + "<h2>Discussion</h2>" + _body(3) +
              "</article></body></html>")
    else:
        def refuse(h):
            h.send_response(full_status)
            h.send_header("Content-Length", "0")
            h.end_headers()
        srv.routes["/content/10.1101/%s.full" % pid] = refuse


@test
def t_feed_link_form_cgi_short_still_reaches_full_text(env, srv):
    """bioRxiv feeds link as /cgi/content/short/<id>?rss=1, not /content/10.1101/."""
    pid = "2026.09.20.677123v1"
    _preprint_site(srv, pid)
    srv.feed("/f", [item("Phylogenomics preprint",
                         link=srv.url("/cgi/content/short/%s?rss=1" % pid))])
    sources(env, [{"id": "a", "name": "bioRxiv plant", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    out, _, _ = run(env, "-r", "1")
    assert "full article" in out, "old link form never reached .full:\n%s" % out[:300]


@test
def t_saved_abstract_does_not_block_full_text(env, srv):
    """Copies saved before full-text support must not be served forever."""
    pid = "2026.09.21.111111v1"
    _preprint_site(srv, pid)
    srv.feed("/f", [item("Saved abstract preprint",
                         link=srv.url("/content/10.1101/%s" % pid))])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    # write a legacy, unmarked copy exactly where the program looks for it
    code = ("import os,sys;sys.argv=['x'];"
            "import importlib.util as u;from importlib.machinery import SourceFileLoader as L;"
            "s=u.spec_from_loader('n',L('n',%r));m=u.module_from_spec(s);s.loader.exec_module(m);"
            "os.makedirs(m.ADIR,exist_ok=True);"
            "open(m.apath(m.key('Saved abstract preprint')),'w').write('old abstract')" % NEWS)
    subprocess.run([sys.executable, "-c", code], env=env)
    out, _, _ = run(env, "-r", "1")
    assert "full article" in out, "a stale saved abstract was served:\n%s" % out[:300]


@test
def t_blocked_full_text_says_why(env, srv):
    pid = "2026.09.22.222222v1"
    _preprint_site(srv, pid, full_status=403)
    srv.feed("/f", [item("Blocked preprint", link=srv.url("/content/10.1101/%s" % pid))])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    out, _, _ = run(env, "-r", "1")
    assert "abstract only" in out, out[:300]
    assert "403" in out, "the reason full text was missing was not shown:\n%s" % out[:300]


@test
def t_tui_banner_names_app_and_version(env, srv):
    srv.feed("/f", [item("Some headline")])
    sources(env, [{"id": "a", "name": "bioRxiv synbio", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    out = _drive_tui(env, [b"q"])
    m = load()
    assert "LowPingNews" in out and m.VERSION in out, "banner missing:\n%s" % out[:200]
    assert "bioRxiv synbio" in out, "source name truncated to an ambiguous stem"


@test
def t_offline_read_never_touches_the_network(env, srv):
    """Regression: retrying past a saved abstract ignored --offline."""
    pid = "2026.09.23.333333v1"
    _preprint_site(srv, pid)
    srv.feed("/f", [item("Offline preprint", link=srv.url("/content/10.1101/%s" % pid))])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    code = ("import os,importlib.util as u;from importlib.machinery import SourceFileLoader as L;"
            "s=u.spec_from_loader('n',L('n',%r));m=u.module_from_spec(s);s.loader.exec_module(m);"
            "os.makedirs(m.ADIR,exist_ok=True);"
            "open(m.apath(m.key('Offline preprint')),'w').write('saved abstract')" % NEWS)
    subprocess.run([sys.executable, "-c", code], env=env)
    before = len(srv.seen)
    run(env, "--offline", "-r", "1")
    extra = [p for p, _h in srv.seen[before:]]
    assert not extra, "--offline made requests: %s" % extra


@test
def t_reasons_do_not_leak_between_reads(env, srv):
    m = load()
    m.LAST_WHY[:] = ["stale reason from an earlier article"]
    it = {"ti": "No link here", "c": "feed body text"}
    m.fetch_article(it)
    assert not m.LAST_WHY, "reasons carried over: %r" % m.LAST_WHY


@test
def t_ping_meter_picks_fastest_and_survives_outage(env, srv):
    import socket
    m = load()
    s1 = socket.socket(); s1.bind(("127.0.0.1", 0)); s1.listen(16)
    port = s1.getsockname()[1]
    threading.Thread(target=lambda: [s1.accept()[0].close() for _ in iter(int, 1)],
                     daemon=True).start()
    pm = m.PingMeter(every=5, refs=(("127.0.0.1", 1, "dead"), ("127.0.0.1", port, "live")))
    pm.every = 0.05
    pm.start()
    end = time.time() + 8                     # poll: a warm phone is slower, not wrong
    while time.time() < end and pm.reading()[3] != "ok":
        time.sleep(0.1)
    ms, _smp, ref, state = pm.reading()
    pm.close()
    assert state == "ok" and ref == "live", (state, ref)
    # all references down for many cycles: a loop, never deep recursion
    pm = m.PingMeter(every=5, refs=(("127.0.0.1", 1, "x"),))
    pm.every = 0.001
    pm.start(); time.sleep(2.0); pm.close(); pm.t.join(2)
    assert not pm.t.is_alive(), "meter thread ignored close()"
    assert pm.reading()[3] == "no route"


@test
def t_tui_is_default_only_in_a_plain_terminal_session(env, srv):
    srv.feed("/f", [item("Headline %d" % i) for i in range(4)])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    e = dict(env); e["LPN_NO_PING"] = "1"
    tui = lambda o: "enter read" in o
    assert tui(_drive_tui(e, [b"q"], args=())), "bare `news` did not open the TUI"
    assert not tui(_drive_tui(e, [b"q"], args=("-t",))), "-t should keep list output"
    assert not tui(_drive_tui(e, [b"q"], args=("--plain",))), "--plain ignored"
    d = dict(e); d["TERM"] = "dumb"
    assert not tui(_drive_tui(d, [b"q"], args=())), "TUI on a dumb terminal"
    out, _, _ = run(env)                               # piped
    assert "enter read" not in out and out.strip(), "a pipe got the TUI"


@test
def t_tui_survives_tiny_terminals_and_wide_glyphs(env, srv):
    """v6.2 crashed on a 1x1 terminal: addnwstr() returned ERR."""
    srv.feed("/f", [item("\u690d\u7269\u306e\u9752\u3044\u8272\u7d20" * 4),
                    item("Emoji \U0001F331\U0001F9EC headline " * 3),
                    item("Plain headline")])
    sources(env, [{"id": "a", "name": "bioRxiv plant", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    e = dict(env); e["LPN_NO_PING"] = "1"
    for rows, cols in ((1, 1), (2, 10), (3, 3), (24, 40)):
        out = _drive_tui(e, [b"j", b"j", b"q"], rows=rows, cols=cols, settle=0.4)
        assert "Traceback" not in out, "%dx%d crashed:\n%s" % (rows, cols, out[-300:])


@test
def t_read_numbers_follow_the_tui_list(env, srv):
    srv.feed("/f", [item("Story %d" % i, when="2026-09-1%dT00:00:00Z" % i) for i in range(5)])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    e = dict(env); e["LPN_NO_PING"] = "1"
    _drive_tui(e, [b"q"])
    out, _, _ = run(env, "-r", "1")
    assert "Story 4" in out.split("\n")[0], "-r 1 is not the TUI's first row:\n%s" % out[:200]


# ---------------------------------------------------------------- staleness
def _cache(env, sid):
    return os.path.join(env["XDG_CACHE_HOME"], "lowpingnews", sid + ".json")


def _restamp(env, sid, t):
    p = _cache(env, sid)
    c = json.load(io.open(p, encoding="utf-8"))
    c["t"] = t
    json.dump(c, io.open(p, "w", encoding="utf-8"))


def _versioned(srv, path, ver, honour_ims=True):
    """A feed with no Last-Modified header, that honours If-Modified-Since
    the way real servers do: 304 when asked about a date after its change."""
    import email.utils
    changed = [time.time() - 3600]

    def h(req):
        ims = req.headers.get("If-Modified-Since")
        if honour_ims and ims:
            try:
                if email.utils.parsedate_to_datetime(ims).timestamp() >= changed[0]:
                    req.send_response(304)
                    req.send_header("Content-Length", "0")
                    req.end_headers()
                    return
            except Exception:
                pass
        raw = gzip.compress(('<?xml version="1.0"?><rss version="2.0"><channel>%s'
                             '</channel></rss>' % "".join(item(v) for v in ver[0])).encode())
        req.send_response(200)
        req.send_header("Content-Encoding", "gzip")
        req.send_header("Content-Length", str(len(raw)))
        req.end_headers()
        req.wfile.write(raw)
    srv.routes[path] = h
    return changed


@test
def t_future_cache_stamp_is_not_fresh_forever(env, srv):
    """now - t < ttl is true for a stamp in the future: frozen cache."""
    ver = [["Edition ONE"]]
    changed = _versioned(srv, "/f", ver)
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f"), "ttl": 60}])
    run(env, "-t")
    _restamp(env, "a", time.time() + 86400)       # clock was a day ahead
    ver[0], changed[0] = ["Edition TWO"], time.time()
    out, _, _ = run(env, "-t")
    assert "Edition TWO" in out, "a future-stamped cache was served as fresh"


@test
def t_forced_refresh_never_sends_a_future_if_modified_since(env, srv):
    """Our own IMS dated in the future invites a 304, so even -f froze."""
    ver = [["Edition ONE"]]
    changed = _versioned(srv, "/f", ver)
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f"), "ttl": 60}])
    run(env, "-t")
    _restamp(env, "a", time.time() + 86400)
    ver[0], changed[0] = ["Edition TWO"], time.time()
    out, _, _ = run(env, "-tf")
    assert "Edition TWO" in out, "-f could not recover a future-stamped cache"


@test
def t_unknown_cache_age_is_said_not_hidden(env, srv):
    srv.feed("/f", [item("Cached story")])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f"), "ttl": 60}])
    run(env, "-t")
    _restamp(env, "a", time.time() + 86400)
    srv.routes.clear()                            # refresh fails: cache is served
    out, _, _ = run(env, "-t")
    assert "age unknown" in out, "stale data of unknown age shown as current:\n%s" % out


@test
def t_every_footer_discloses_stale_data(env, srv):
    srv.feed("/f", [item("Cached story")])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f"), "ttl": 60}])
    run(env, "-t")
    _restamp(env, "a", time.time() - 5 * 3600)
    srv.routes.clear()
    for args in (["-t"], ["--stream", "-t"], ["--offline", "-t"]):
        out, _, _ = run(env, *args)
        assert "stale 5h" in out, "%s hid that its data was 5h old:\n%s" % (args, out)


@test
def t_reading_from_an_old_list_says_so_on_stderr(env, srv):
    srv.feed("/f", [item("Story")])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    lp = os.path.join(env["XDG_CACHE_HOME"], "lowpingnews", "last.json")
    old = time.time() - 2 * 86400
    os.utime(lp, (old, old))
    out, err, _ = run(env, "-r", "1")
    assert "2d ago" in err, "no warning that item 1 is from a 2-day-old list"
    assert "list shown" not in out, "the warning leaked into stdout"


@test
def t_saved_copy_says_how_old_it_is(env, srv):
    srv.feed("/f", [item("Saved story")])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    code = ("import os,time,importlib.util as u;from importlib.machinery import SourceFileLoader as L;"
            "s=u.spec_from_loader('n',L('n',%r));m=u.module_from_spec(s);s.loader.exec_module(m);"
            "p=m.apath(m.key('Saved story'));os.makedirs(m.ADIR,exist_ok=True);"
            "open(p,'w').write(chr(1)+'kind:full\\nSaved body text.');"
            "t=time.time()-3*86400;os.utime(p,(t,t))" % NEWS)
    subprocess.run([sys.executable, "-c", code], env=env)
    out, _, _ = run(env, "-r", "1")
    assert "saved 3d" in out, "a 3-day-old saved copy did not say so:\n%s" % out[:200]


@test
def t_ping_meter_never_shows_an_old_sample_as_current(env, srv):
    m = load()
    pm = m.PingMeter(every=5, refs=(("127.0.0.1", 1, "x"),))
    pm._add(42.0)
    pm.stamps[-1] = time.time() - 600             # sampler stalled ten minutes ago
    assert pm.reading()[3] == "stale", pm.reading()


@test
def t_stale_label_is_never_stale_just_now(env, srv):
    m = load()
    for ttl, age_ in ((1, 5), (1, 30), (60, 90), (900, 7200)):
        txt, _c, stale = m.tui_freshness({"t": time.time() - age_, "ttl": ttl,
                                           "unknown": False, "failed": []})
        assert not ("stale" in txt and "just now" in txt), txt


@test
def t_tui_banner_shows_data_age(env, srv):
    srv.feed("/f", [item("Story %d" % i) for i in range(3)])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f"), "ttl": 600}])
    run(env, "-t")
    _restamp(env, "a", time.time() - 5 * 3600)
    srv.routes.clear()
    e = dict(env); e["LPN_NO_PING"] = "1"
    # wait for the load to finish, not for a guessed time: on a slow phone the
    # first screen appears well before the stale note does
    out = _drive_tui(e, [b"q"], cols=80, ready=lambda b: b"stale" in b)
    assert "stale 5h" in out, "TUI hid that its data was 5h old"


@test
def t_tui_refreshes_stale_data_on_its_own(env, srv):
    ver = [["Morning edition %d" % i for i in range(3)]]
    _versioned(srv, "/f", ver, honour_ims=False)
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f"), "ttl": 1}])
    e = dict(env); e["LPN_NO_PING"] = "1"; e["LPN_TUI_MINAGE"] = "3"
    import fcntl, pty, select, struct, termios
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(e)
        os.environ["TERM"] = "xterm-256color"
        os.execv(NEWS, ["news", "--tui"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 12, 60, 0, 0))
    buf = [b""]

    def pump(t):
        end = time.time() + t
        while time.time() < end:
            r, _w, _x = select.select([fd], [], [], 0.1)
            if r:
                try:
                    buf[0] += os.read(fd, 65536)
                except OSError:
                    return
    buf[0] += _read_until(fd, lambda b: b"Morning edition" in b)
    mark = len(buf[0])
    ver[0] = ["Evening edition %d" % i for i in range(3)] + ver[0]
    buf[0] += _read_until(fd, lambda b: b"Evening edition" in b and b"Morning edition" in b, most=25.0)
    try:
        os.write(fd, b"q")
    except OSError:
        pass
    pump(0.3)
    try:
        os.close(fd)
        os.waitpid(pid, 0)
    except Exception:
        pass
    seg = buf[0][mark:].decode("utf-8", "replace")
    assert "Evening edition" in seg, "stale data was never refreshed"
    # the rows that moved must be repainted as text: shifting them with
    # scroll regions dropped them on some terminal emulators
    assert "Morning edition" in seg, "moved rows were not repainted"
    last = json.load(io.open(os.path.join(env["XDG_CACHE_HOME"], "lowpingnews",
                                          "last.json"), encoding="utf-8"))
    assert any("Evening" in x["ti"] for x in last), "-r numbering not updated"


@test
def t_tui_star_works_while_reading(env, srv):
    srv.feed("/f", [item("Readable story", body="Body text.")])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    e = dict(env); e["LPN_NO_PING"] = "1"
    out = _drive_tui(e, [b"\r", b"s", b"q", b"q"], cols=80, settle=1.0)
    assert "starred" in out, "the hint offered s while reading, but it did nothing"


# ---------------------------------------------------------------- efficiency
@test
def t_a_304_is_not_reported_as_free(env, srv):
    """Every request pays a handshake; "0B, cached" after 304s was false."""
    srv.feed("/f", [item("Story")], etag='"v1"')
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t")
    out, _, _ = run(env, "-tf")
    assert "unchanged (304)" in out
    assert "0B, cached" not in out, "a 304 round was reported as costing nothing"
    assert "~" in out, "cost is an estimate and should say so"


@test
def t_cost_prediction_includes_the_handshake(env, srv):
    srv.feed("/f", [item("Story")])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f"), "ttl": 60}])
    run(env, "-t")
    _restamp(env, "a", time.time() - 3600)
    m = load()
    body = json.load(io.open(_cache(env, "a"), encoding="utf-8"))["w"]
    out, _, _ = run(env, "--cost")
    assert "handshake" in out
    assert m.predict(body) > body + 3000, "prediction ignores connection overhead"


@test
def t_estimate_counts_what_a_request_really_costs(env, srv):
    m = load()
    full = m.est_wire(0, 300, 500, "full")
    resumed = m.est_wire(0, 300, 500, "resumed")
    assert full > 6000 and 3000 < resumed < full, (full, resumed)
    assert m.est_wire(100000, 300, 500, "full") > 100000 + full - 100


@test
def t_same_host_feeds_share_one_worker(env, srv):
    m = load()
    srcs = [{"id": "p", "url": "https://connect.example.org/a"},
            {"id": "e", "url": "https://other.example.org/x"},
            {"id": "s", "url": "https://connect.example.org/b"}]
    units = [[x["id"] for x in u] for u in m.host_units(srcs)]
    assert units == [["p", "s"], ["e"]], units


@test
def t_hn_query_is_trimmed_and_steps_down_if_refused(env, srv):
    import json as J
    hits = {"hits": [{"objectID": "1", "title": "Show HN: a thing", "points": 1,
                      "url": "https://example.invalid/x", "num_comments": 0,
                      "created_at_i": int(time.time()) - 60}]}
    seen = []

    def h(req):
        q = req.path
        seen.append(2 if "attributesToHighlight" in q else 1 if "attributesToRetrieve" in q else 0)
        if "attributesToHighlight" in q:
            req.send_response(400)
            req.send_header("Content-Length", "0")
            req.end_headers()
            return
        raw = gzip.compress(J.dumps(hits).encode())
        req.send_response(200)
        req.send_header("Content-Encoding", "gzip")
        req.send_header("Content-Length", str(len(raw)))
        req.end_headers()
        req.wfile.write(raw)
    srv.routes["/api/v1/search"] = h
    sources(env, [{"id": "hn", "name": "HN", "kind": "hn", "cats": ["top"],
                   "url": srv.url("/api/v1/search?tags=front_page&hitsPerPage=20")}])
    out, _, _ = run(env, "-t")
    assert "Show HN" in out and seen == [2, 1], seen
    del seen[:]
    run(env, "-tf")
    assert seen == [1], "repeated a request the server already refused: %s" % seen


@test
def t_idle_reader_spends_nothing(env, srv):
    ver = [["Morning edition %d" % i for i in range(3)]]
    _versioned(srv, "/f", ver, honour_ims=False)
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f"), "ttl": 1}])
    e = dict(env)
    # activity window well inside the stale floor: stored stamps are whole
    # seconds, so data can read up to a second older than the clock says
    e.update(LPN_NO_PING="1", LPN_TUI_MINAGE="3", LPN_TUI_ACTIVE="1")
    import fcntl, pty, select, struct, termios
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(e)
        os.environ["TERM"] = "xterm-256color"
        os.execv(NEWS, ["news", "--tui"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 12, 60, 0, 0))

    def pump(t):
        end = time.time() + t
        while time.time() < end:
            r, _w, _x = select.select([fd], [], [], 0.1)
            if r:
                try:
                    os.read(fd, 65536)
                except OSError:
                    return
    deadline = time.time() + 10
    while not srv.seen and time.time() < deadline:
        pump(0.1)                                # the opening fetch, however slow
    pump(0.5)
    at_open = len(srv.seen)
    pump(6.0)                                    # stale, but nobody is looking
    idle = len(srv.seen) - at_open
    os.write(fd, b"j")                           # someone is back
    deadline = time.time() + 15                   # until it refreshes, however slow
    while len(srv.seen) <= at_open + idle and time.time() < deadline:
        pump(0.2)
    back = len(srv.seen) - at_open - idle
    try:
        os.write(fd, b"q")
    except OSError:
        pass
    pump(0.3)
    try:
        os.close(fd)
        os.waitpid(pid, 0)
    except Exception:
        pass
    assert idle == 0, "an idle reader made %d requests" % idle
    assert back >= 1, "activity did not resume refreshing"


@test
def t_meter_probes_once_per_cycle_and_not_when_idle(env, srv):
    import socket
    m = load()
    calls = []
    pm = m.PingMeter(every=5, refs=(("127.0.0.1", 9, "a"), ("127.0.0.1", 10, "b"),
                                    ("127.0.0.1", 11, "c")))
    pm._rtt = lambda h, p: calls.append(p) or 5.0
    pm._cycle()
    assert calls == [9], "a cycle probed %d references at once" % len(calls)
    pm._cycle(); pm._cycle()
    assert sorted(calls) == [9, 10, 11], "same host, different ports must all be tried"
    pm.active_until = time.time() - 1
    pm._cycle()
    assert len(calls) == 3, "the meter probed while nobody was looking"
    assert pm.reading()[3] in ("paused", "ok")


@test
def t_download_budget_counts_true_cost(env, srv):
    page = b"<html><body>" + b"<p>" + b"word " * 200 + b"</p>" * 3 + b"</body></html>"

    def serve(h):
        h.send_response(200)
        h.send_header("Content-Length", str(len(page)))
        h.end_headers()
        h.wfile.write(page)
    srv.routes["/p"] = serve
    srv.feed("/f", [item("S%d" % i, link=srv.url("/p")) for i in range(6)])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    run(env, "-t", "-n", "6")
    # ~1 KB of body each, but over plain HTTP each still costs a TCP handshake
    # and headers, ~2 KB. Counting bodies alone, 5 KB would store four or five
    # pages; counting true cost, two.
    out, _, _ = run(env, "-d", "all", "--budget", "5")
    stored = int(re.search(r"(\d+)/\d+ stored", out).group(1))
    assert stored <= 2, "budget counted bodies only: stored %d pages\n%s" % (stored, out)
    spent_ = re.search(r"([\d.]+)K spent", out)
    assert spent_ is None or float(spent_.group(1)) <= 5.0, "budget overshot:\n%s" % out


def _update_fixture(srv, env, offered):
    """A scratch copy of news, and a server offering a build at `offered`."""
    m = load()
    src = io.open(NEWS, encoding="utf-8").read()
    body = re.sub(r'^VERSION = "[^"]+"', 'VERSION = "%s"' % offered, src,
                  count=1, flags=re.M).encode()
    ranges = []

    def h(req):
        rg = req.headers.get("Range")
        ranges.append(rg)
        b = body
        if rg and rg.startswith("bytes=0-"):
            b = body[:int(rg.split("-")[1]) + 1]
            req.send_response(206)
        else:
            req.send_response(200)
        req.send_header("Content-Length", str(len(b)))
        req.end_headers()
        req.wfile.write(b)
    srv.routes["/news"] = h
    d = tempfile.mkdtemp()
    copy = os.path.join(d, "news")
    shutil.copy(NEWS, copy)
    os.chmod(copy, 0o755)
    return m, copy, ranges


def _update(env, copy, url, extra=None):
    e = dict(env); e.update(extra or {})
    p = subprocess.run([copy, "--update", url], stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, env=e)
    v = subprocess.run([copy, "--version"], stdout=subprocess.PIPE).stdout.decode()
    return (p.stdout + p.stderr).decode("utf-8", "replace"), v.strip()


@test
def t_update_never_downgrades_on_its_own(env, srv):
    """6.5 "updated" itself to 6.1 from a stale main branch."""
    m, copy, _r = _update_fixture(srv, env, "1.0")
    out, v = _update(env, copy, srv.url("/news"))
    assert v.endswith(m.VERSION), "silently downgraded to %s" % v
    assert "older" in out
    out, v = _update(env, copy, srv.url("/news"), {"LPN_FORCE": "1"})
    assert v.endswith("1.0"), "a deliberate downgrade was refused"


@test
def t_update_check_reads_only_the_head_when_current(env, srv):
    m, copy, ranges = _update_fixture(srv, env, load().VERSION)
    out, v = _update(env, copy, srv.url("/news"))
    assert "already" in out, out
    assert ranges and all(r for r in ranges), "downloaded the whole file to learn nothing"


@test
def t_update_installs_a_newer_build(env, srv):
    m, copy, _r = _update_fixture(srv, env, "999.0")
    out, v = _update(env, copy, srv.url("/news"))
    assert v.endswith("999.0"), "a newer build was not installed:\n%s" % out


# ---------------------------------------------------------------- catalog
def _cat(env, srv, obj, et='"c1"', status=200, raw=None):
    """Serve a feed index; honours If-None-Match like a real server."""
    env["LPN_CATALOG_URL"] = srv.url("/catalog.json")
    body = raw if raw is not None else gzip.compress(json.dumps(obj).encode())

    def h(req):
        if req.headers.get("If-None-Match") == et:
            req.send_response(304)
            req.send_header("Content-Length", "0")
            req.end_headers()
            return
        req.send_response(status)
        if raw is None:
            req.send_header("Content-Encoding", "gzip")
        req.send_header("ETag", et)
        req.send_header("Content-Length", str(len(body)))
        req.end_headers()
        req.wfile.write(body)
    srv.routes["/catalog.json"] = h


def _feedpage(srv, path, title="A feed", ranged=True, items=30):
    body = ('<?xml version="1.0"?><rss version="2.0"><channel><title>%s</title>%s'
            '</channel></rss>' % (title, "".join(
                "<item><title>Story %d</title><link>http://e.invalid/%d</link>"
                "<description>d</description></item>" % (i, i) for i in range(items)))).encode()

    def h(req):
        rg = req.headers.get("Range")
        b, st = body, 200
        if ranged and rg and rg.startswith("bytes=0-"):
            b, st = body[:int(rg.split("-")[1]) + 1], 206
        req.send_response(st)
        if st == 206:
            req.send_header("Content-Range", "bytes 0-%d/%d" % (len(b) - 1, len(body)))
        req.send_header("Content-Length", str(len(b)))
        req.end_headers()
        try:
            req.wfile.write(b)
        except Exception:
            pass
    srv.routes[path] = h


def _cl(env, *args):
    p = subprocess.run([NEWS, "catalog"] + list(args), stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, env=env)
    out = re.sub(r"\x1b\[[0-9;]*m", "", (p.stdout + p.stderr).decode("utf-8", "replace"))
    assert "Traceback" not in out, out[-400:]
    return out, p.returncode


def _subs(env):
    p = os.path.join(env["XDG_CONFIG_HOME"], "lowpingnews", "sources.json")
    return json.load(io.open(p, encoding="utf-8"))


@test
def t_shipped_catalog_is_valid_in_full(env, srv):
    """A typo in catalog.json would silently drop a feed for every user."""
    m = load()
    raw = json.load(io.open(os.path.join(HERE, "catalog.json"), encoding="utf-8"))
    idx = m.catalog_validate(raw)
    assert len(idx["feeds"]) == len(raw["feeds"]), "entries dropped by validation"
    ids = [f["id"] for f in raw["feeds"]]
    assert len(ids) == len(set(ids)), "duplicate ids"
    for f in raw["feeds"]:
        assert f["url"].startswith("https://"), "%s is not https" % f["id"]


@test
def t_hostile_catalog_entries_are_dropped_one_by_one(env, srv):
    m = load()
    idx = m.catalog_validate({"feeds": [
        {"id": "ok", "name": "Fine", "url": "https://ok.invalid/r", "cats": ["world"]},
        {"id": "../../etc", "name": "x", "url": NOWHERE + "/", "cats": ["x"]},
        {"id": "js", "name": "x", "url": "javascript:alert(1)", "cats": ["x"]},
        {"id": "file", "name": "x", "url": "file:///etc/passwd", "cats": ["x"]},
        {"id": "esc", "name": "Evil\u001b[31m\u0007", "url": "https://e.invalid/", "cats": ["x"]},
        {"id": "nan", "name": "n", "url": "https://n.invalid/", "cats": ["x"], "kb": float("nan")},
        {"id": "res", "name": "r", "url": "https://r.invalid/", "cats": ["weather", "all"]},
        {"id": "ok", "name": "Duplicate", "url": "https://dup.invalid/", "cats": ["x"]},
        "not a dict", None, 42]})
    ids = [f["id"] for f in idx["feeds"]]
    assert ids == ["ok", "etc", "esc", "nan"], ids
    esc = [f for f in idx["feeds"] if f["id"] == "esc"][0]
    assert "\x1b" not in esc["name"] and "\x07" not in esc["name"]
    assert "kb" not in [f for f in idx["feeds"] if f["id"] == "nan"][0]
    for bad in ({}, {"feeds": "x"}, {"feeds": [{"id": "x"}]}, [], "junk"):
        try:
            m.catalog_validate(bad)
            raise AssertionError("accepted an unusable index: %r" % (bad,))
        except ValueError:
            pass


@test
def t_catalog_update_is_conditional_and_keeps_the_old_on_failure(env, srv):
    good = {"updated": "2026-09-28", "feeds": [
        {"id": "quakes", "name": "Quakes", "url": "https://q.invalid/a", "cats": ["alerts"]}]}
    _cat(env, srv, good)
    out, _ = _cl(env, "update")
    assert "1 feeds" in out, out
    out, _ = _cl(env, "update")
    assert "unchanged" in out, "second update was not conditional: " + out
    for bad, why in ((b"{not json", "rejected"), (b'{"feeds": []}', "rejected"),
                     (gzip.compress(b'{"feeds": [') , "rejected")):
        _cat(env, srv, None, et='"other"', raw=bad)
        out, _ = _cl(env, "update")
        assert "kept the one you had" in out, out
        out, _ = _cl(env, "alerts")
        assert "Quakes" in out, "a bad index replaced the good one"
    _cat(env, srv, good, status=404, et='"x"')
    out, _ = _cl(env, "update")
    assert "kept" in out or "no feed index published" in out, out


@test
def t_catalog_update_offline_spends_nothing(env, srv):
    _cat(env, srv, {"feeds": [{"id": "a", "name": "A", "url": NOWHERE + "/",
                               "cats": ["x"]}]})
    before = len(srv.seen)
    out, _ = _cl(env, "update", "--offline")
    assert len(srv.seen) == before and "offline" in out, out


@test
def t_subscribe_is_idempotent_and_never_clobbers_a_broken_config(env, srv):
    _feedpage(srv, "/q.xml")
    _cat(env, srv, {"feeds": [{"id": "quakes", "name": "Quakes", "url": srv.url("/q.xml"),
                               "cats": ["alerts"]}]})
    _cl(env, "update")
    _cl(env, "add", "quakes")
    _cl(env, "add", "quakes")
    s = [x for x in _subs(env) if x["id"] == "quakes"]
    assert len(s) == 1 and s[0]["cats"] == ["alerts"], s
    out, _ = _cl(env, "add", "quakes", "--to", "Survival Kit")
    assert [x for x in _subs(env) if x["id"] == "quakes"][0]["cats"] == ["alerts", "survival-kit"]
    out, rc = _cl(env, "add", "quakes", "--to", "weather")
    assert rc != 0 and "cannot be a category" in out, "a reserved word became a category"
    cfg = os.path.join(env["XDG_CONFIG_HOME"], "lowpingnews", "sources.json")
    io.open(cfg, "w").write("{ this is not json")
    out, _ = _cl(env, "add", "quakes", "--to", "elsewhere")
    assert "unreadable" in out and io.open(cfg).read() == "{ this is not json", \
        "a damaged config was overwritten"


@test
def t_the_last_feed_cannot_be_removed(env, srv):
    sources(env, [{"id": "only", "name": "Only", "kind": "rss", "cats": ["top"],
                   "url": "https://o.invalid/"}])
    out, _ = _cl(env, "remove", "only")
    assert "only feed left" in out, out
    assert [x["id"] for x in _subs(env)] == ["only"]


@test
def t_probe_finds_feeds_and_refuses_what_is_not(env, srv):
    m = load()
    _feedpage(srv, "/f.xml", title="Real &amp; Feed")
    _page(srv, "/site", '<!doctype html><html><head><link rel="stylesheet" href="s.css">'
          '<link rel="alternate icon" href="i.png"><LINK REL=alternate '
          'TYPE="application/rss+xml" HREF="/f.xml"></head></html>')
    _page(srv, "/plain", "<!doctype html><html><head></head><body>no feed</body></html>")
    _page(srv, "/empty", "")
    p = m.probe_feed(srv.url("/f.xml"))
    assert p["ok"] and p["title"] == "Real & Feed", p
    p = m.probe_feed(srv.url("/site"))
    assert p["ok"] and p["final"].endswith("/f.xml") and p.get("page"), p
    assert not m.probe_feed(srv.url("/plain"))["ok"]
    assert not m.probe_feed(srv.url("/empty"))["ok"]
    assert m.probe_feed(srv.url("/missing"))["why"] == "HTTP 404"
    assert not m.probe_feed("javascript:alert(1)")["ok"]


@test
def t_probe_cost_is_bounded_when_range_is_ignored(env, srv):
    """Measured before the fix: 129 KB received for a probe meant to read 16."""
    m = load()
    _feedpage(srv, "/big.xml", ranged=False, items=12000)
    p = m.probe_feed(srv.url("/big.xml"))
    assert p["ok"]
    # what it keeps plus what is in flight when it stops - not the whole feed
    bound = m.PROBECAP + m.PROBEWIN + 1024
    assert m.NETSTAT["body"] <= bound, "probe billed %d bytes" % m.NETSTAT["body"]


@test
def t_adding_a_site_twice_does_not_duplicate_it(env, srv):
    _feedpage(srv, "/f.xml", title="Little Blog")
    _page(srv, "/site", '<html><head><link rel="alternate" type="application/rss+xml" '
          'href="/f.xml"></head></html>')
    _cl(env, "add", srv.url("/site"), "--to", "reading")
    _cl(env, "add", srv.url("/f.xml"), "--to", "evenings")
    mine = [x for x in _subs(env) if x["url"].endswith("/f.xml")]
    assert len(mine) == 1 and mine[0]["cats"] == ["reading", "evenings"], mine
    assert mine[0]["id"] == "little-blog", mine[0]["id"]


@test
def t_check_reports_respects_budget_and_writes_results(env, srv):
    _feedpage(srv, "/ok.xml")
    idx = {"updated": "2026-09-28", "cats": {"x": "X"}, "feeds": [
        {"id": "good", "name": "Good", "url": srv.url("/ok.xml"), "cats": ["x"]},
        {"id": "gone", "name": "Gone", "url": srv.url("/nope.xml"), "cats": ["x"], "ok": "2026-01"},
        {"id": "api", "name": "API", "url": srv.url("/api"), "cats": ["x"], "kind": "hn"}]}
    _cat(env, srv, idx)
    _cl(env, "update")
    os.makedirs(env["XDG_DATA_HOME"], exist_ok=True)
    path = os.path.join(env["XDG_DATA_HOME"], "catalog.json")
    io.open(path, "w", encoding="utf-8").write(json.dumps(idx))
    out, _ = _cl(env, "check", "x", "--write", path)
    assert "1 ok, 1 failed, 1 skipped" in out, out
    res = {f["id"]: f for f in json.load(io.open(path, encoding="utf-8"))["feeds"]}
    assert res["good"].get("ok") and res["good"].get("raw") is not None
    assert res["gone"].get("fail") == "HTTP 404" and "ok" not in res["gone"]
    lines = io.open(path, encoding="utf-8").read().count("\n")
    assert lines >= 5, "written index is not one feed per line"
    out, _ = _cl(env, "check", "x", "--budget", "1")
    assert "budget" in out, out


@test
def t_catalog_listing_fits_any_width(env, srv):
    _cat(env, srv, {"feeds": [
        {"id": "longid12345", "name": "A very long feed name indeed", "cats": ["x"],
         "url": "https://a-very-long-hostname.example.org/feed", "fail": "HTTP 404 Not Found"},
        {"id": "s", "name": "S", "url": "https://s.invalid/", "cats": ["x"], "rec": True}]})
    _cl(env, "update")
    for cols in ("20", "40", "46", "80"):
        e = dict(env); e["COLUMNS"] = cols
        out, _ = _cl(e, "x")
        over = [l for l in out.split("\n") if len(l) > int(cols)]
        assert not over, "%s cols: %r" % (cols, over[0])


@test
def t_feed_manager_ticks_and_creates_categories(env, srv):
    _feedpage(srv, "/g.xml")
    _cat(env, srv, {"cats": {"alerts": "Hazards"}, "feeds": [
        {"id": "gdacs", "name": "GDACS disasters", "url": srv.url("/g.xml"), "cats": ["alerts"]}]})
    _cl(env, "update")
    sources(env, [{"id": "a", "name": "Alpha", "kind": "rss", "cats": ["top"],
                   "url": NOWHERE + "/"}])
    e = dict(env); e["LPN_NO_PING"] = "1"
    keys = [b"f", b" ", b"t"] + [bytes([ch]) for ch in b"Survival Kit"] + [b"\r", b"q", b"q"]
    _drive_tui(e, keys, cols=60, settle=0.5)
    g = [x for x in _subs(env) if x["id"] == "gdacs"]
    assert g and g[0]["cats"] == ["alerts", "survival-kit"], _subs(env)


@test
def t_release_tooling_allows_the_catalog(env, srv):
    """test.py was once missing from this list; every release after it was
    silently rejected and a stale build shipped in its place."""
    tool = io.open(os.path.join(HERE, "lowpingnews"), encoding="utf-8").read()
    owned = re.search(r'^OWNED="([^"]*)"', tool, re.M).group(1).split()
    allow = re.search(r"\n\s*(news\|[^)]*)\)", tool).group(1).split("|")
    for f in ("news", "test.py", "catalog.json", "README.md", "lowpingnews", "install.sh"):
        assert f in owned, "%s not in OWNED" % f
        assert f in allow, "%s would make sync reject the tarball" % f


# ---------------------------------------------------------------- catalog audit
@test
def t_added_feed_is_named_after_the_feed_not_an_article(env, srv):
    m = load()
    _page(srv, "/chan", '<?xml version="1.0"?><rss version="2.0"><channel><title>Real '
          'Channel</title><item><title>Some article</title></item></channel></rss>')
    _page(srv, "/bare", '<?xml version="1.0"?><rss version="2.0"><channel>'
          '<item><title>Some article</title></item></channel></rss>')
    _page(srv, "/site", '<html><head><link rel="alternate" type="application/rss+xml" '
          'title="Site feed" href="/bare"></head><body>x</body></html>')
    assert m.probe_feed(srv.url("/chan"))["title"] == "Real Channel"
    assert m.probe_feed(srv.url("/bare"))["title"] == "", "named a feed after an article"
    assert m.probe_feed(srv.url("/site"))["title"] == "Site feed", "ignored the page's name"


@test
def t_feed_addresses_are_checked_before_use(env, srv):
    m = load()
    assert m.feed_url("lwn.net/headlines/rss")[0] == "https://lwn.net/headlines/rss"
    assert m.feed_url("example.org:8080/feed")[0] == "https://example.org:8080/feed"
    for bad in ("ftp://x.org/f", "javascript:alert(1)", "file:///etc/passwd", "http://",
                "", "https://user:pw@x.org/f", "mailto:a@b.c"):
        u, why = m.feed_url(bad)
        assert u is None and why, "accepted %r as %r" % (bad, u)


@test
def t_failed_catalog_changes_exit_nonzero(env, srv):
    env = dict(env); env["LPN_CATALOG_URL"] = srv.url("/none")
    for args in (["catalog", "add", "ftp://x.org/f"], ["catalog", "add", "nosuchfeed"],
                 ["catalog", "remove", "nosuchfeed"]):
        p = subprocess.run([NEWS] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        assert p.returncode != 0, "%s failed but exited 0" % " ".join(args)


@test
def t_catalog_says_how_old_the_local_index_is(env, srv):
    m = load()
    for t, want in ((time.time() - 40 * 86400, "40d"), (time.time() + 30 * 86400, "unknown")):
        note = m.catalog_age_note({"updated": "2026-10-03", "fetched": t, "feeds": []})
        assert want in note, "an index checked long ago looked current: %r" % note
    assert "built-in" in m.catalog_age_note({"updated": "built-in", "feeds": []})


@test
def t_offline_install_offers_the_whole_catalog(env, srv):
    m = load()
    seed = json.loads(m.CATALOG_SEED)
    assert len(m.catalog_builtin()["feeds"]) >= len(seed["feeds"]) > len(m.DEFAULTS)
    p = subprocess.run([NEWS, "catalog", "export"], stdout=subprocess.PIPE, env=env)
    exported = json.loads(p.stdout.decode("utf-8"))
    assert m.catalog_validate(exported)["feeds"], "export is not a valid index"
    shipped = os.path.join(HERE, "catalog.json")
    if os.path.exists(shipped):
        assert io.open(shipped, encoding="utf-8").read() == p.stdout.decode("utf-8"), \
            "catalog.json and the built-in index have drifted apart"


@test
def t_pasted_lines_do_not_leak_into_the_next_prompt(env, srv):
    """Pasting two lines left the second as text in the next prompt - or as
    menu commands, where d then y deletes a feed."""
    _page(srv, "/site", '<html><head><link rel="alternate" type="application/rss+xml" '
          'title="Site feed" href="/feed"></head><body>x</body></html>')
    srv.feed("/feed", [item("Post")])
    srv.feed("/f", [item("Story")])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    e = dict(env); e["LPN_NO_PING"] = "1"; e["LPN_CATALOG_URL"] = srv.url("/none")
    burst = (srv.url("/site") + "\nddyy tttq").encode()          # one write, like a paste
    out = _drive_tui(e, [b"f", b"a", burst, b"\x1b", b"\x1b", b"q", b"q"],
                     cols=80, settle=1.5)
    assert "Site feedddyy" not in out and "feedddyy" not in out, "the paste leaked"
    assert "Site feed" in out


@test
def t_a_feed_pruned_from_the_index_stops_being_offered(env, srv):
    m = load()
    seed_ids = {e["id"] for e in json.loads(m.CATALOG_SEED)["feeds"]}
    extra = sorted(seed_ids - {d["id"] for d in m.DEFAULTS})[0]   # not a default
    _cat(env, srv, {"feeds": [{"id": "only", "name": "Only", "cats": ["world"],
                               "url": "https://example.org/only"}]})
    _cl(env, "update")
    out, _, _ = run(env, "catalog")
    assert "Only" in out
    names = {e["id"]: e["name"] for e in json.loads(m.CATALOG_SEED)["feeds"]}
    assert names[extra] not in out, "%s was pruned but is still offered" % extra


@test
def t_star_needs_a_recorded_check(env, srv):
    m = load()
    assert not m.starred({"rec": True}), "a picked but never-checked feed got a star"
    assert m.starred({"rec": True, "ok": "2026-10"})
    assert not m.starred({"rec": True, "ok": "2026-09", "fail": "HTTP 404"})
    assert not m.starred({"ok": "2026-10"})


@test
def t_catalog_only_changes_can_be_released(env, srv):
    """Publishing `catalog check --write` results changes only catalog.json;
    a guard that compared news alone refused it as a version-only bump."""
    tool = io.open(os.path.join(HERE, "lowpingnews"), encoding="utf-8").read()
    fn = re.search(r"^release_has_changes\(\) \{.*?^\}", tool, re.S | re.M).group(0)
    d = tempfile.mkdtemp()
    try:
        g = lambda *a: subprocess.run(["git", "-C", d] + list(a), stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE)
        g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
        for f in ("news", "catalog.json"):
            src = os.path.join(HERE, f)
            if not os.path.exists(src):
                return                                   # nothing to compare yet
            shutil.copy(src, d)
        g("add", "-A"); g("commit", "-qm", "base"); g("tag", "v1")

        owned = re.search(r'^OWNED="[^"]*"', tool, re.M).group(0)   # as the script sets it

        def allowed():
            p = subprocess.run(["bash", "-c", "REPO=%s; %s\n%s\nrelease_has_changes"
                                % (d, owned, fn)])
            return p.returncode == 0
        news_p = os.path.join(d, "news")
        src = io.open(news_p, encoding="utf-8").read()
        io.open(news_p, "w", encoding="utf-8").write(
            re.sub(r'^VERSION = "[^"]+"', 'VERSION = "999.0"', src, count=1, flags=re.M))
        assert not allowed(), "a bare version bump was allowed"
        with io.open(os.path.join(d, "catalog.json"), "a", encoding="utf-8") as fh:
            fh.write("\n")
        assert allowed(), "a catalog-only change was refused"
        g("checkout", "-q", "catalog.json")
        assert not allowed()
        # a fix to the dev tool alone is a release too
        shutil.copy(os.path.join(HERE, "lowpingnews"), d)
        g("add", "lowpingnews"); g("commit", "-qm", "tool"); g("tag", "-f", "v1")
        with io.open(os.path.join(d, "lowpingnews"), "a", encoding="utf-8") as fh:
            fh.write("\n# changed\n")
        assert allowed(), "a change to the dev tool alone was refused"
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _tap(col, row):
    """A touchscreen tap as the terminal reports it: SGR press, then release."""
    return ("\x1b[<0;%d;%dM\x1b[<0;%d;%dm" % (col, row, col, row)).encode()


@test
def t_catalog_opens_the_tick_box_editor_in_a_terminal(env, srv):
    e = dict(env); e.update(LPN_NO_PING="1", LPN_CATALOG_URL=srv.url("/none"))
    out = _drive_tui(e, [b"q"], args=("catalog",), cols=72)
    # only the editor says this; the printed list merely mentions tick boxes
    assert "space: tick" in out, "catalog printed a list instead of the editor"
    p = subprocess.run([NEWS, "catalog"], stdout=subprocess.PIPE, env=e)
    assert b"FEEDS" in p.stdout and b"\x1b[?1049h" not in p.stdout, "a pipe got the editor"
    p = subprocess.run([NEWS, "catalog", "--plain"], stdout=subprocess.PIPE, env=e)
    assert b"FEEDS" in p.stdout


@test
def t_tapping_a_feed_ticks_it_once(env, srv):
    """A tap arrives as a press and a release; acting on both would tick and
    untick in one touch, so it would look as though nothing happened."""
    e = dict(env); e.update(LPN_NO_PING="1", LPN_CATALOG_URL=srv.url("/none"))
    run(e, "-l")                                      # write the default sources
    cfg = os.path.join(env["XDG_CONFIG_HOME"], "lowpingnews", "sources.json")
    # `catalog alerts` opens with the alerts heading on row 2, its first feed on row 3
    _drive_tui(e, [_tap(12, 3), b"q"], args=("catalog", "alerts"), cols=72, settle=0.8)
    after_one = json.load(io.open(cfg, encoding="utf-8"))
    ticked = [x for x in after_one if "alerts" in x.get("cats", [])]
    assert len(ticked) == 1, "one tap should tick exactly one feed: %s" % ticked
    _drive_tui(e, [_tap(12, 3), b"q"], args=("catalog", "alerts"), cols=72, settle=0.8)
    after_two = json.load(io.open(cfg, encoding="utf-8"))
    assert not [x for x in after_two if "alerts" in x.get("cats", [])], "a second tap did not untick"


@test
def t_taps_off_the_list_change_nothing(env, srv):
    e = dict(env); e.update(LPN_NO_PING="1", LPN_CATALOG_URL=srv.url("/none"))
    run(e, "-l")
    cfg = os.path.join(env["XDG_CONFIG_HOME"], "lowpingnews", "sources.json")
    before = io.open(cfg, encoding="utf-8").read()
    _drive_tui(e, [_tap(3, 2), _tap(10, 1), _tap(10, 24), b"q"], args=("catalog", "alerts"),
               cols=72, settle=0.6)
    assert io.open(cfg, encoding="utf-8").read() == before, "a tap on a heading or edge changed feeds"


@test
def t_editor_gives_text_selection_back(env, srv):
    e = dict(env); e.update(LPN_NO_PING="1", LPN_CATALOG_URL=srv.url("/none"))
    out = _drive_tui(e, [b"q"], args=("catalog",), cols=72, raw=True)
    assert "\x1b[?1006;1000h" in out, "taps were never enabled"
    assert "\x1b[?1006;1000l" in out, "mouse reporting left on after the editor closed"
    e2 = dict(e); e2["LPN_NO_MOUSE"] = "1"
    out = _drive_tui(e2, [b"q"], args=("catalog",), cols=72, raw=True)
    assert "1000h" not in out, "LPN_NO_MOUSE ignored"


def _install(tmp, path_first=None, bashrc=None, existing=None):
    """`lpn install` into a scratch prefix, as on a phone."""
    pre, home = os.path.join(tmp, "usr"), os.path.join(tmp, "home")
    os.makedirs(os.path.join(pre, "bin"), exist_ok=True)
    os.makedirs(home, exist_ok=True)
    if bashrc is not None:
        io.open(os.path.join(home, ".bashrc"), "w").write(bashrc)
    if existing is not None:
        w = os.path.join(pre, "bin", "weather")
        io.open(w, "w").write(existing)
        os.chmod(w, 0o755)
    # the scratch bin first, then the real PATH: on Termux python3, sh, sed and
    # the rest live in $PREFIX/bin, and /usr/bin does not exist at all. A
    # desktop-style "/usr/bin:/bin" here once made every install test fail there.
    path = os.path.join(pre, "bin") + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin")
    if path_first:
        path = path_first + os.pathsep + path
    # inherit everything, override only what this test is about. Google Play
    # Termux runs every program through a library named in LD_PRELOAD (Android
    # forbids executing app files directly); a hand-built minimal environment
    # drops it, and the installer could find python3 but not run it.
    env = dict(os.environ)
    env.update({"PREFIX": pre, "HOME": home, "LPN_REPO": HERE, "PATH": path})
    p = subprocess.run(["sh", os.path.join(HERE, "lowpingnews"), "install"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    return p.stdout.decode("utf-8", "replace"), os.path.join(pre, "bin", "weather"), env


@test
def t_install_makes_weather_run_lowpingnews(env, srv):
    tmp = tempfile.mkdtemp()
    try:
        out, w, e = _install(tmp)
        assert "launcher" in out, out
        p = subprocess.run([w, "--version"], stdout=subprocess.PIPE, env=e)
        assert load().VERSION in p.stdout.decode(), "weather did not run LowPingNews"
        out2, _w, _e = _install(tmp)
        assert "launcher" not in out2, "an unchanged launcher was rewritten"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_install_never_overwrites_someone_elses_weather(env, srv):
    tmp = tempfile.mkdtemp()
    try:
        mine = "#!/bin/sh\necho my old applet\n"
        out, w, _e = _install(tmp, existing=mine)
        assert io.open(w).read() == mine, "a weather script that was not ours got replaced"
        assert "kept your own" in out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_install_points_out_what_hides_news_and_weather(env, srv):
    tmp = tempfile.mkdtemp()
    try:
        old = os.path.join(tmp, "oldbin")
        os.makedirs(old)
        for c in ("news", "weather"):
            io.open(os.path.join(old, c), "w").write("#!/bin/sh\necho old\n")
            os.chmod(os.path.join(old, c), 0o755)
        out, _w, _e = _install(tmp, path_first=old)
        assert "`news` runs" in out and "`weather` runs" in out, out
        rc = 'alias news="python3 old.py"\nweather() { curl wttr.in; }\nalias news2=x\n'
        out, _w, _e = _install(tempfile.mkdtemp(), bashrc=rc)
        assert "line 1 redefines `news`" in out and "line 2 redefines `weather`" in out, out
        assert "news2" not in out
        out, _w, _e = _install(tempfile.mkdtemp(), bashrc="alias news=lowpingnews\n")
        assert "redefines" not in out, "warned about an alias that already points here"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- v7.0
def _three_feeds(srv, env, n=20):
    for f in ("a", "b", "c"):
        srv.feed("/" + f, [item("%s story %d" % (f.upper(), i),
                                when="2026-10-%02dT%02d:00:00Z" % (1 + i % 3, i)) for i in range(n)])
    sources(env, [{"id": f, "name": f.upper(), "kind": "rss", "cats": ["top"],
                   "url": srv.url("/" + f)} for f in ("a", "b", "c")])


@test
def t_a_number_is_how_many_articles(env, srv):
    _three_feeds(srv, env)
    count = lambda o: len(re.findall(r"^\s+\d+ [ABC] ", o, re.M))
    for args, want in ((("top", "13"), 13), (("13",), 13), (("13", "top"), 13), (("top", "45"), 45)):
        out, _, _ = run(env, *(args + ("-t",)))
        assert count(out) == want, "%s showed %d" % (" ".join(args), count(out))
    out, _, _ = run(env, "top", "100", "-t")
    assert count(out) == 60 and "only 60 of 100" in out, "fewer than asked, without saying so"
    for bad in ("0", "9999"):
        _o, err, rc = run(env, "top", bad, "--plain")
        assert rc != 0 and "between 1 and" in err


@test
def t_a_count_opens_the_reader_with_that_many(env, srv):
    _three_feeds(srv, env)
    e = dict(env); e["LPN_NO_PING"] = "1"
    for args, want in ((("top", "13"), "13"), (("top", "55"), "55")):
        out = _drive_tui(e, [b"q"], args=args, cols=72)
        m_ = re.search(r"TOP\s+(\d+) items", out)
        assert m_ and m_.group(1) == want, "%s did not open the reader with %s" % (args, want)
    out = _drive_tui(e, [b"q"], args=("top", "13", "-n", "2"), cols=72)
    assert "j/k" not in out, "an explicit -n should still mean list output"


@test
def t_numbers_cannot_be_category_names(env, srv):
    m = load()
    assert m.norm_cat("2024") == "" and m.norm_cat("top10") == "top10"


@test
def t_weather_speaks_in_words(env, srv):
    tmp = tempfile.mkdtemp()
    try:
        import unicodedata
        cells = lambda l: sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in l)
        fc = _forecast(rain=True)
        fc["daily"]["weather_code"] = [2, 3, 56, 0, 80, 86, 96]
        srv.json("/fc", fc)
        binary = _wx_binary(srv, tmp)
        subprocess.run([binary, "weather", "-c", "40.9,-73.4"], stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, env=env)
        for cols in (30, 40, 64, 100):
            for extra in ([], ["--ascii"]):
                e = dict(env); e["COLUMNS"] = str(cols)
                p = subprocess.run([binary, "weather", "--plain"] + extra, stdout=subprocess.PIPE, env=e)
                out = re.sub(r"\x1b\[[0-9;]*m", "", p.stdout.decode())
                for w in ("Partly Cloudy", "Overcast", "Icy Drizzle", "Heavy Snowfall", "Thunder & Hail",
                          "Humidity", "Wind"):
                    assert w in out, "%r missing at %d cols %s" % (w, cols, extra)
                for code in (" PC ", " OV ", " RH ", " g18"):
                    assert code not in out, "shorthand %r at %d cols" % (code, cols)
                over = [l for l in out.split("\n") if cells(l) > cols]
                assert not over, "%d cols overflow: %r" % (cols, over[0])
                if extra:
                    assert "\u2600" not in out and "\u2601" not in out, "icons in ASCII mode"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_weather_icons_are_one_cell_glyphs(env, srv):
    """Weather emoji such as 🌤 are classed narrow but drawn wide, which shifts
    every column after them; icons must be built from text glyphs only."""
    import unicodedata
    m = load()
    for name, icon in m.WMO.values():
        assert len(icon) == 2, "%s icon is not two cells" % name
        for ch in icon:
            assert ch == " " or (unicodedata.east_asian_width(ch) == "N" and ord(ch) < 0x1F000), \
                "%s uses %r" % (name, ch)
    assert max(len(n) for n, _i in m.WMO.values()) <= 14


def _tui_frames(env, keys, cols=48, rows=24, pause=0.5, args=("--tui",)):
    """Screens after each key, read from pyte's buffer: its .display helper
    breaks on overwritten double-width characters."""
    import fcntl, pty, select, struct, termios
    try:
        import pyte                      # a terminal emulator: only these tests need it
    except ImportError:
        raise Skip("needs the pyte terminal emulator: pip install pyte")
    scr = pyte.Screen(cols, rows)
    st_ = pyte.ByteStream(scr)
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execv(NEWS, ["news"] + list(args))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def pump(t_):
        end = time.time() + t_
        while time.time() < end:
            r, _w, _x = select.select([fd], [], [], 0.1)
            if r:
                try:
                    st_.feed(os.read(fd, 65536))
                except OSError:
                    return

    def disp():
        return ["".join((scr.buffer[y][x].data or "") for x in range(scr.columns)).rstrip()
                for y in range(scr.lines)]
    st_.feed(_read_until(fd, lambda b: b"quit" in b or b"q back" in b, most=20.0, settle_after=3.0)
             + _read_until(fd, least=0.2, quiet=0.3, most=3.0))
    shots = [disp()]
    for k in keys:
        os.write(fd, k)
        st_.feed(_read_until(fd, least=pause, quiet=0.4, most=10.0))
        shots.append(disp())
    try:
        os.write(fd, b"q"); pump(0.3); os.close(fd); os.waitpid(pid, 0)
    except Exception:
        pass
    return shots


def _card_feeds(srv, env):
    srv.feed("/a", [item("Researchers engineer a stable blue anthocyanin pigment in petunia "
                         "flowers using a bacterial enzyme pathway", when="2026-10-03T07:00:00Z",
                         body="Scientists report a single bacterial enzyme that converts cyanidin."),
                    item("Short one", when="2026-10-03T06:00:00Z", body=""),
                    item("\u6771\u4eac\u3067\u65b0\u3057\u3044\u690d\u7269\u306e\u9752\u8272\u8272"
                         "\u7d20\u304c\u767a\u898b\u3055\u308c\u3001\u7814\u7a76\u8005\u305f\u3061"
                         "\u304c\u305d\u306e\u4ed5\u7d44\u307f\u3092\u8abf\u3079\u3066\u3044\u308b",
                         when="2026-10-03T05:00:00Z")]
             + [item("Filler story number %d with a moderately long headline to wrap" % i,
                     when="2026-10-02T%02d:00:00Z" % i) for i in range(12)])
    srv.feed("/b", [item("Science category story")])
    sources(env, [{"id": "a", "name": "bioRxiv plant", "kind": "rss", "cats": ["top"], "url": srv.url("/a")},
                  {"id": "b", "name": "Nature", "kind": "rss", "cats": ["science"], "url": srv.url("/b")}])


_SEL = re.compile("\u258c\\s*(\\d+) ")
_HEAD = re.compile("[\u258c ]\\s*(\\d+) [\u2022 \u2605]")


@test
def t_titles_wrap_into_cards_that_need_no_sideways_scrolling(env, srv):
    import unicodedata
    _card_feeds(srv, env)
    e = dict(env); e["LPN_NO_PING"] = "1"
    shots = _tui_frames(e, [b"j"] * 10 + [b"v", b"v"])
    first = shots[0]
    flat = " ".join(" ".join(l.replace("\u258c", " ") for l in first).split())
    assert "Researchers engineer a stable blue anthocyanin pigment in petunia flowers " \
           "using a bacterial enzyme pathway" in flat, "the whole title should be readable"
    width = lambda l: sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in l)
    assert all(width(l) <= 48 for sh in shots for l in sh), "a line ran off the screen"
    assert "\u7814\u7a76" in "".join(first), "the Japanese title should wrap, not vanish"
    sel = [int(m.group(1)) for sh in shots[1:11] for m in [_SEL.search("\n".join(sh))] if m]
    assert sel == list(range(2, 12)), "j should move one card at a time: %s" % sel
    for sh in shots:
        nums = [int(m.group(1)) for l in sh for m in [_HEAD.match(l)] if m]
        assert nums == list(range(nums[0], nums[0] + len(nums))), "a frame was scrambled: %s" % nums
        assert sum(1 for l in sh if _SEL.match(l)) <= 1, "two selection bars in one frame"
    n_cards = lambda sh: sum(1 for l in sh if _HEAD.match(l))
    assert n_cards(shots[11]) > n_cards(shots[10]) and not any("Summary text." in l for l in shots[11]), \
        "v should hide summaries and fit more cards"
    assert any("Summary text." in l for l in shots[12]), "v again should bring them back"


@test
def t_arrows_change_category_in_either_encoding(env, srv):
    _card_feeds(srv, env)
    e = dict(env); e["LPN_NO_PING"] = "1"
    shots = _tui_frames(e, [b"\x1b[C", b"\x1b[D", b"\x1bOC", b"\x1bOD", b"l", b"h", b"\x1b[5~"])
    banner = lambda sh: next(l for l in sh if "LowPingNews" in l)
    seen = [("SCIENCE" in banner(sh), "TOP" in banner(sh)) for sh in shots[1:7]]
    assert seen == [(True, False), (False, True)] * 3, seen
    assert any("LowPingNews" in l for l in shots[7]) and "Traceback" not in "".join(shots[7]), \
        "an unrelated key sequence should be ignored, not quit"


# ---------------------------------------------------------------- NOAA radio
# Shapes follow the documented api.weather.gov responses; the live service is
# not reachable from the build machine.
def _nws_binary(srv, tmp):
    src = io.open(NEWS, encoding="utf-8").read()
    src = src.replace('NWS = "https://api.weather.gov"', 'NWS = "%s"' % srv.url("").rstrip("/"))
    src = src.replace("https://tgftp.nws.noaa.gov", srv.url("").rstrip("/"))
    p = os.path.join(tmp, "news_nws")
    io.open(p, "w", encoding="utf-8").write(src)
    os.chmod(p, 0o755)
    return p


def _iso(off_s):
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() + off_s))


def _nws_alert(event, sev="Severe", urg="Expected", ends=6 * 3600, status="Actual", **kw):
    p = {"event": event, "severity": sev, "urgency": urg, "certainty": "Likely",
         "status": status, "messageType": "Alert", "senderName": "NWS Upton NY",
         "onset": _iso(-600), "expires": _iso(ends), "ends": _iso(ends),
         "areaDesc": "Northwest Suffolk",
         "headline": "%s issued by NWS Upton NY" % event,
         "description": ("* WHAT...Flooding caused by excessive rainfall is expected.\n\n"
                         "* WHERE...Portions of southeast New York, including\nNorthwest Suffolk.\n\n"
                         "* WHEN...Until 6 PM EDT this evening.\n\n"
                         "* IMPACTS...Flooding of rivers, creeks, streams, and other\nlow-lying areas."),
         "instruction": "Turn around, don't drown when encountering flooded roads.\nMost flood deaths occur in vehicles."}
    p.update(kw)
    return {"type": "Feature", "properties": p}


def _nws_serve(srv, alerts=(), periods=None, point=True, lat="40.9000", lon="-73.4000"):
    base = srv.url("").rstrip("/")
    if point:
        srv.json("/points/%s,%s" % (lat, lon), {"properties": {
            "gridId": "OKX", "gridX": 65, "gridY": 42,
            "forecast": base + "/gridpoints/OKX/65,42/forecast",
            "forecastZone": base + "/zones/forecast/NYZ078",
            "relativeLocation": {"properties": {"city": "Huntington", "state": "NY"}}}})
    srv.json("/alerts/active", {"type": "FeatureCollection", "features": list(alerts)})
    if periods is None:
        periods = [{"number": 1, "name": "Today", "isDaytime": True, "temperature": 74,
                    "temperatureUnit": "F", "shortForecast": "Rain Likely",
                    "detailedForecast": "Rain likely, mainly after 2pm. High near 74. "
                                        "South wind 10 to 15 mph. Chance of precipitation is 70%."},
                   {"number": 2, "name": "Tonight", "isDaytime": False, "temperature": 58,
                    "temperatureUnit": "F", "shortForecast": "Showers",
                    "detailedForecast": "Showers. Low around 58. New rainfall amounts between "
                                        "a half and three quarters of an inch possible."}]
    srv.json("/gridpoints/OKX/65,42/forecast", {"properties": {"periods": periods}})


def _radio(binary, env, *args, cols=48):
    e = dict(env); e["COLUMNS"] = str(cols)
    p = subprocess.run([binary, "radio", "-c", "40.9,-73.4", "--plain"] + list(args),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=e)
    return (re.sub(r"\x1b\[[0-9;]*m", "", p.stdout.decode("utf-8", "replace")),
            p.stderr.decode("utf-8", "replace"), p.returncode)


def _nws_env(srv):
    tmp = tempfile.mkdtemp()
    return _nws_binary(srv, tmp), tmp


def _h503(h):
    h.send_response(503)
    h.end_headers()


def _nws_cache(env):
    import glob
    return glob.glob(os.path.join(env["XDG_CACHE_HOME"], "*", "nws.json"))[0]


@test
def t_radio_reads_warnings_first_then_the_forecast(env, srv):
    b, tmp = _nws_env(srv)
    try:
        _nws_serve(srv, alerts=[_nws_alert("Wind Advisory", sev="Moderate"), _nws_alert("Flood Warning")])
        out, _e, rc = _radio(b, env)
        assert rc == 0 and "2 ACTIVE ALERTS" in out
        assert out.index("FLOOD WARNING") < out.index("WIND ADVISORY") < out.index("FORECAST"), \
            "warnings must come first, most severe first"
        assert "* WHERE...Portions" in out, "NWS paragraphs should survive"
        assert "What to do:" in out and "TONIGHT" in out
        n = len(srv.seen)
        out2, _e, _rc = _radio(b, env)
        assert len(srv.seen) == n and "0B, cached" in out2, "a repeat within five minutes cost data"
        for k in ("User-Agent",):
            ua = [h for p_, h in srv.seen if p_.startswith("/alerts")][0].get(k, "")
            assert ua.startswith("LowPingNews/"), "weather.gov asks callers to identify themselves"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_radio_never_mistakes_not_knowing_for_all_clear(env, srv):
    b, tmp = _nws_env(srv)
    try:
        _nws_serve(srv, alerts=[])
        srv.routes["/alerts/active"] = _h503
        out, _e, rc = _radio(b, env)
        assert "ALERTS UNKNOWN" in out and "No active alerts" not in out and rc == 2
        assert "TODAY" in out, "a dead alert feed must not hide the forecast"
        out, _e, rc = _radio(b, env, "--offline", "-c", "41.1,-72.1")
        assert "No active alerts" not in out and rc == 2
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_radio_hides_expired_and_drill_alerts_and_says_when_old(env, srv):
    b, tmp = _nws_env(srv)
    try:
        _nws_serve(srv, alerts=[_nws_alert("Flood Warning", ends=60),
                                _nws_alert("Tornado Warning", sev="Extreme", status="Test"),
                                _nws_alert("Flood Watch", status="Exercise")])
        out, _e, _rc = _radio(b, env)
        assert "TORNADO" not in out and "FLOOD WATCH" not in out, "a drill reached the screen"
        cf = _nws_cache(env)
        c = json.load(open(cf))
        c["alerts"]["t"] -= 3 * 3600
        c["alerts"]["list"][0]["ends"] = c["alerts"]["list"][0]["expires"] = _iso(-1800)
        json.dump(c, open(cf, "w"))
        out, _e, _rc = _radio(b, env, "--offline", cols=60)
        assert "No active alerts" in out and "1 expired alert hidden" in out
        assert "may be out of date" in out and "3h ago" in out and "ago ago" not in out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_radio_refuses_hostile_text_and_foreign_links(env, srv):
    b, tmp = _nws_env(srv)
    try:
        _nws_serve(srv, alerts=[_nws_alert("Flood\x1b[2J Warning", headline="x\x1b]0;pwned\x07y",
                                           description="a\x1b[31mred\x00z")])
        raw = subprocess.run([b, "radio", "-c", "40.9,-73.4", "--plain"], stdout=subprocess.PIPE, env=env).stdout
        for bad in (b"\x1b[2J", b"\x1b]0", b"\x07", b"\x00"):
            assert bad not in raw, "%r reached the terminal" % bad
        srv.json("/points/40.9000,-73.4000", {"properties": {"forecast": "https://evil.example/f"}})
        out, _e, rc = _radio(b, env, "-f")
        assert "evil" not in str(srv.seen), "followed a link off weather.gov"
        assert rc == 0 and "TODAY" in out, "a bad lookup should not discard the good cached office"
        os.remove(_nws_cache(env))                 # and with nothing cached to fall back on
        out, _e, rc = _radio(b, env, "-f")
        assert "evil" not in str(srv.seen) and "No NOAA coverage" in out and rc == 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_radio_outside_the_us_and_marine_zones(env, srv):
    b, tmp = _nws_env(srv)
    try:
        _nws_serve(srv, alerts=[], point=False)
        out, _e, rc = _radio(b, env)
        assert "United States only" in out and rc == 1
        _nws_serve(srv, alerts=[])
        srv.routes["/data/forecasts/marine/coastal/an/anz335.txt"] = lambda h: (
            h.send_response(200), h.end_headers(),
            h.wfile.write(b"Long Island Sound West of New Haven CT\nS winds 10 to 15 kt.\n"))
        out, _e, _rc = _radio(b, env, "--marine", "anz335", "-f")
        assert "zone ANZ335" in out and "Long Island Sound" in out
        out, _e, _rc = _radio(b, env)
        assert "zone ANZ335" in out, "the zone should be remembered"
        out, _e, _rc = _radio(b, env, "--marine", "off")
        assert "MARINE" not in out
        _o, err, rc = _radio(b, env, "--marine", "../../etc")
        assert rc != 0 and "ANZ335" in err
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_radio_fits_narrow_screens_in_every_state(env, srv):
    import unicodedata
    cells = lambda l: sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in l)
    b, tmp = _nws_env(srv)
    try:
        _nws_serve(srv, alerts=[_nws_alert("Flood Warning"), _nws_alert("Wind Advisory", sev="Moderate")])
        for state in ("ok", "down"):
            if state == "down":
                cf = _nws_cache(env)
                c = json.load(open(cf)); c["alerts"]["t"] -= 7200; json.dump(c, open(cf, "w"))
                srv.routes["/alerts/active"] = _h503
            for cols in (28, 40, 60):
                for ex in ((), ("--ascii",)):
                    out, _e, _rc = _radio(b, env, *ex, cols=cols)
                    over = [l for l in out.split("\n") if cells(l) > cols]
                    assert not over, "%s at %d: %r" % (state, cols, over[0])
                    if ex:
                        assert "\u26a0" not in out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _radio_at(srv, env, b, loc, cols=48):
    T_ = {"lat": "%.4f" % loc["lat"], "lon": "%.4f" % loc["lon"]}
    _nws_serve(srv, alerts=[], lat=T_["lat"], lon=T_["lon"])
    p = os.path.join(env["XDG_CONFIG_HOME"], "lowpingnews", "loc.json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(loc, open(p, "w"))
    e = dict(env); e["COLUMNS"] = str(cols)
    out = subprocess.run([b, "radio", "--plain"], stdout=subprocess.PIPE, env=e).stdout.decode()
    return re.sub(r"\x1b\[[0-9;]*m", "", out)


@test
def t_radio_always_says_which_spot_it_checked(env, srv):
    """Once read the right warnings for the wrong county: a carrier address had
    put the phone in Queens, and the screen showed only the NWS town name."""
    b, tmp = _nws_env(srv)
    try:
        now = int(time.time())
        out = _radio_at(srv, env, b, {"lat": 40.9, "lon": -73.412, "label": "Fleets Cove",
                                      "via": "pinned", "t": now})
        assert "NOAA RADIO  Fleets Cove" in out, "your own name for the spot comes first"
        assert "For 40.9000,-73.4120 (pinned)" in out
        flat = " ".join(out.split())                # prose may wrap anywhere
        assert "near Huntington NY" in flat, "the NWS town belongs beside it, for comparison"
        assert "may be for the wrong county" not in out
        out = _radio_at(srv, env, b, {"lat": 40.68, "lon": -73.82, "via": "ip", "acc": 5000, "t": now})
        flat = " ".join(out.split())
        assert "from your network address" in flat and "wrong county" in flat
        assert "\n    lowpingnews radio -c LAT,LON --label NAME" in out, "the command must copy whole"
        out = _radio_at(srv, env, b, {"lat": 40.9, "lon": -73.412, "via": "network", "t": now - 172800})
        assert "Location fixed 2d ago and could not be refreshed" in " ".join(out.split())
        out = _radio_at(srv, env, b, {"lat": 40.9, "lon": -73.412, "via": "network", "t": now})
        assert "could not be refreshed" not in out, "a fresh device fix needs no warning"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_place_region_filters_and_is_never_part_of_the_name(env, srv):
    """'Huntington, New York' was once sent whole as a name; the geocoder
    fuzzy-matched it and the location ended up in Queens."""
    tmp = tempfile.mkdtemp()
    try:
        srv.json("/geo", {"results": [
            {"name": "Huntington", "latitude": 38.42, "longitude": -82.45, "admin1": "West Virginia",
             "admin2": "Cabell", "country": "United States", "country_code": "US", "population": 46000},
            {"name": "Huntington", "latitude": 40.87, "longitude": -73.43, "admin1": "New York",
             "admin2": "Suffolk", "country": "United States", "country_code": "US", "population": 18000}]})
        srv.json("/fc", _forecast())
        b = _wx_binary(srv, tmp)
        m = load()
        for q in ("Huntington, New York", "Huntington, NY", "Huntington, Suffolk"):
            subprocess.run([b, "weather", "-p", q, "--plain"], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=env)
            sent = [p_ for p_, _h in srv.seen if p_.startswith("/geo")][-1]
            assert "name=Huntington&" in sent, "the region was sent as part of the name: " + sent
            loc = json.load(open(os.path.join(env["XDG_CONFIG_HOME"], "lowpingnews", "loc.json")))
            assert abs(loc["lat"] - 40.87) < 0.01, "%s landed at %s" % (q, loc["lat"])
        p = subprocess.run([b, "weather", "-p", "Huntington, Virginia", "--plain"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        assert p.returncode != 0 and b"no place matched" in p.stderr, \
            "an unmatched region must fail, not fall back to another state"
        assert m.place_parts("Springfield, IL, US") == ("Springfield", [["il", "illinois"], ["us"]])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_location_flags_are_refused_by_the_news_list(env, srv):
    """`lowpingnews -p PLACE` used to open the reader, ignore the place, and
    exit 0 - looking as if the radio had been moved when it had not."""
    for args in (("-p", "Huntington, NY"), ("-c", "40.9,-73.41"), ("top", "--marine", "ANZ335")):
        _o, err, rc = run(env, *(args + ("--plain", "--offline")))
        assert rc == 2 and "lowpingnews weather" in err, "%s was accepted silently" % (args,)
    assert not os.path.exists(os.path.join(env["XDG_CONFIG_HOME"], "lowpingnews", "loc.json"))


# ---------------------------------------------------------------- weak signal
def _bulky_feed(tag, n=60):
    import random
    rnd = random.Random(7)
    w = "petunia anthocyanin enzyme duckweed plastid callus promoter vector biolistic".split()
    its = "".join(
        "<item><title>%s story %d %s</title><link>%s/%d</link><description>%s</description>"
        "<pubDate>Sat, 03 Oct 2026 %02d:%02d:00 GMT</pubDate></item>" % (
            tag, i, " ".join(rnd.choice(w) for _ in range(6)), NOWHERE, i,
            " ".join(rnd.choice(w) + str(rnd.randint(0, 999)) for _ in range(40)), 23 - i // 60, 59 - i % 60)
        for i in range(n))
    return ('<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>%s</channel></rss>'
            % its).encode()


class _Flaky:
    """One gzipped document over a bad link: `cuts` drops each connection after
    that many body bytes; ranges honoured only with a matching If-Range."""
    def __init__(self, doc, etag='"v1"', cuts=(), ranges=True, bad_range=False, die_first=0):
        import gzip
        self.gz, self.etag, self.cuts = gzip.compress(doc), etag, list(cuts)
        self.ranges, self.bad_range, self.die = ranges, bad_range, die_first
        self.log, self.sent = [], 0

    def __call__(self, h):
        rng, ifr = h.headers.get("Range"), h.headers.get("If-Range")
        self.log.append(rng)
        if self.die > 0:
            self.die -= 1
            h.close_connection = True
            return
        start = int(rng.split("=")[1].split("-")[0]) if (rng and self.ranges and ifr == self.etag) else 0
        body = self.gz[start:]
        h.send_response(206 if start else 200)
        for k, v in (("Content-Type", "application/rss+xml"), ("Content-Encoding", "gzip"),
                     ("ETag", self.etag), ("Accept-Ranges", "bytes"), ("Content-Length", str(len(body)))):
            h.send_header(k, v)
        if start:
            s0 = start + (5 if self.bad_range else 0)
            h.send_header("Content-Range", "bytes %d-%d/%d" % (s0, len(self.gz) - 1, len(self.gz)))
        h.end_headers()
        cut = self.cuts.pop(0) if self.cuts else None
        out = body if cut is None else body[:cut]
        h.wfile.write(out)
        h.wfile.flush()
        self.sent += len(out)
        if cut is not None:
            h.close_connection = True


def _one_feed(srv, env, handler, cats=("top",)):
    sources(env, [{"id": "f", "name": "F", "kind": "rss", "cats": list(cats), "url": srv.url("/f")}])
    srv.routes["/f"] = handler


def _fcache(env):
    import glob
    p = glob.glob(os.path.join(env["XDG_CACHE_HOME"], "*", "f.json"))
    return (json.load(io.open(p[0], encoding="utf-8")) if p else {}), p[0][:-5] + ".part" if p else None


@test
def t_a_cut_download_resumes_and_each_byte_is_paid_once(env, srv):
    import gzip
    doc = _bulky_feed("A")
    size = len(gzip.compress(doc))
    f = _Flaky(doc, cuts=[6000])
    _one_feed(srv, env, f)
    run(env, "-t")
    c, _p = _fcache(env)
    assert len(c["items"]) == 40 and not c.get("p"), "a single cut should be finished in the same run"
    assert f.log == [None, "bytes=6000-"] and f.sent == size, (f.log, f.sent, size)


@test
def t_a_download_cut_every_time_finishes_on_the_next_run(env, srv):
    import gzip
    doc = _bulky_feed("A")
    size = len(gzip.compress(doc))
    f = _Flaky(doc, cuts=[3000, 2500, 2500])
    _one_feed(srv, env, f)
    run(env, "-t")
    c, part = _fcache(env)
    assert c.get("p") == 1 and c["items"], "the complete items should be shown meanwhile"
    assert os.path.getsize(part) == 8000, "the received bytes should be kept"
    run(env, "-t")
    c, part = _fcache(env)
    assert f.log[-1] == "bytes=8000-", "the next run should ask only for the rest: %s" % f.log
    assert len(c["items"]) == 40 and not c.get("p") and not os.path.exists(part)
    assert f.sent == size, "paid %d bytes for a %d-byte feed" % (f.sent, size)


@test
def t_resumed_downloads_are_never_spliced(env, srv):
    doc, doc2 = _bulky_feed("A"), _bulky_feed("B")
    f = _Flaky(doc, etag='W/"v1"', cuts=[6000])          # weak: bodies may differ
    _one_feed(srv, env, f)
    run(env, "-t")
    assert all(r is None for r in f.log), "resumed with a weak validator"
    f = _Flaky(doc, cuts=[6000])                          # changed between attempts
    orig, n = f.__call__, [0]

    def changer(h):
        import gzip
        n[0] += 1
        if n[0] == 2:
            f.gz, f.etag = gzip.compress(doc2), '"v2"'
        return orig(h)
    _one_feed(srv, env, changer)
    run(env, "-t", "-f")
    c, _p = _fcache(env)
    assert {x["ti"].split()[0] for x in c["items"]} == {"B"} and len(c["items"]) == 40, "spliced"
    f = _Flaky(doc, cuts=[6000], bad_range=True)          # 206 for the wrong bytes
    _one_feed(srv, env, f)
    run(env, "-t", "-f")
    c, _p = _fcache(env)
    assert len(c["items"]) == 40 and not c.get("p") and f.log[-1] is None, f.log


@test
def t_a_silently_dropped_connection_is_retried(env, srv):
    f = _Flaky(_bulky_feed("A"), die_first=2)            # two flickers in a row
    _one_feed(srv, env, f)
    run(env, "-t")
    c, _p = _fcache(env)
    assert len(c.get("items") or []) == 40 and len(f.log) == 3, f.log


@test
def t_only_signal_failures_are_retried(env, srv):
    """Retrying a refused connection cannot help and once cost every load of a
    dead feed 2.4 s - long enough to stall the reader and fail tests mid-suite."""
    import errno, socket, ssl, urllib.error, http.client
    m = load()
    for e, want in ((urllib.error.URLError(ConnectionRefusedError(111, "refused")), False),
                    (urllib.error.URLError(socket.gaierror(socket.EAI_NONAME, "no such name")), False),
                    (urllib.error.URLError(ssl.SSLCertVerificationError("bad certificate")), False),
                    (urllib.error.URLError(socket.timeout("timed out")), True),
                    (urllib.error.URLError(ConnectionResetError(104, "reset")), True),
                    (http.client.RemoteDisconnected("empty reply"), True),
                    (urllib.error.URLError(OSError(errno.ENETUNREACH, "unreachable")), True),
                    (urllib.error.URLError(socket.gaierror(socket.EAI_AGAIN, "try again")), True)):
        assert m.transient(e) == want, "%r should %sbe retried" % (e, "" if want else "not ")
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"], "url": NOWHERE + "/dead"}])
    t0 = time.time()
    run(env, "-t", "-f")
    assert time.time() - t0 < 1.8, "a refused feed took %.1fs: it was retried" % (time.time() - t0)


@test
def t_quiet_feeds_are_checked_less_often(env, srv):
    srv.feed("/f", [item("Quiet story %d" % i) for i in range(5)], etag='"q1"')
    sources(env, [{"id": "f", "name": "F", "kind": "rss", "cats": ["top"], "url": srv.url("/f")}])
    run(env, "-t")

    def aged(sec):
        c, _p = _fcache(env)
        c["t"] = int(time.time()) - sec
        json.dump(c, io.open(_p[:-5] + ".json", "w", encoding="utf-8"))
    qs = []
    for _i in range(3):
        aged(30000); run(env, "-t"); qs.append(_fcache(env)[0].get("q"))
    assert qs == [1, 2, 3], qs
    n = len(srv.seen); aged(5000)
    out, _e, _rc = run(env, "-t")
    assert len(srv.seen) == n, "a quiet feed was rechecked at its old interval"
    assert "stale" not in out.lower()
    run(env, "-t", "-f")
    assert len(srv.seen) == n + 1, "-f must always fetch"
    aged(11000); run(env, "-t")
    assert len(srv.seen) == n + 2, "the 3-hour cap did not hold"
    srv.feed("/f", [item("Breaking %d" % i) for i in range(5)], etag='"q2"')
    aged(11000); run(env, "-t")
    assert _fcache(env)[0].get("q") == 0, "a change should snap the interval back"
    m = load()
    assert m.ttl_eff({"cats": ["alerts"]}, {"q": 3}) == m.TTL, "alert feeds must never back off"


@test
def t_dns_falls_back_only_when_the_lookup_fails(env, srv):
    import socket
    m = load()
    m.DNSF = os.path.join(env["XDG_CACHE_HOME"], "dns_test.json")
    real, mode = socket.getaddrinfo, {"fail": False}

    def fake(host, port, *a, **k):
        if mode["fail"]:
            raise socket.gaierror(-3, "Temporary failure in name resolution")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.10", port))]
    socket.getaddrinfo = fake
    try:
        m._DNS["c"] = {}
        m.dns_install()
        socket.getaddrinfo("feeds.example.org", 443)
        mode["fail"] = True
        assert socket.getaddrinfo("feeds.example.org", 443)[0][4] == ("192.0.2.10", 443)
        for host, age in (("never-seen.example.org", 0), ("feeds.example.org", 15 * 86400)):
            m._DNS["c"].get(host, {}).update({"t": int(time.time()) - age} if age else {})
            try:
                socket.getaddrinfo(host, 443)
                raise AssertionError("%s should not have resolved" % host)
            except socket.gaierror:
                pass
        mode["fail"] = False
        socket.getaddrinfo("127.0.0.1", 80)
        assert "127.0.0.1" not in m._DNS["c"], "IP literals are not lookups"
    finally:
        socket.getaddrinfo = real


@test
def t_the_suite_needs_only_the_standard_library(env, srv):
    """Phones run this suite before every release. Two tests once imported a
    library the phone did not have, and every release failed there."""
    import ast
    std = getattr(sys, "stdlib_module_names", None)
    if not std:
        raise Skip("needs Python 3.10+ to list the standard library")
    tree = ast.parse(io.open(os.path.join(HERE, "test.py"), encoding="utf-8").read())
    guarded = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Try) and any(
                isinstance(h.type, ast.Name) and h.type.id in ("ImportError", "ModuleNotFoundError")
                for h in node.handlers):
            for sub in ast.walk(node):
                if isinstance(sub, (ast.Import, ast.ImportFrom)):
                    guarded.add(id(sub))
    bare = []
    for node in ast.walk(tree):
        names = ([a.name for a in node.names] if isinstance(node, ast.Import) else
                 [node.module] if isinstance(node, ast.ImportFrom) and node.module and not node.level
                 else [])
        for n in names:
            if n.split(".")[0] not in std and id(node) not in guarded:
                bare.append("%s (line %d)" % (n, node.lineno))
    assert not bare, "imports outside the standard library must skip when missing: " + ", ".join(bare)


@test
def t_the_way_out_is_always_on_screen(env, srv):
    """The key line once ran past a phone's width, cutting off "q quit" in the
    reader and "q back" in the feed editor."""
    m = load()
    for w in (100, 64, 48, 40, 32, 24):
        line = m.fit_keys(["j/k", "enter read", "s star", "o open", "r refresh", "<> cat",
                           "v view", "f feeds", "q quit"],
                          ["j/k", "v view", "r refresh", "o open", "f feeds", "s star"], w - 1)
        assert line.endswith("q quit") and (len(line) <= w - 1 or w < 30), (w, line)
    srv.feed("/f", [item("Story %d" % i) for i in range(3)])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"], "url": srv.url("/f")}])
    assert "q quit" in _drive_tui(env, [b"q"], cols=48), "the reader hid its quit key at 48 columns"
    assert "q back" in _drive_tui(env, [b"q"], cols=48, args=("catalog",)), "the editor hid its way out"


# ---------------------------------------------------------------- updating
def _build(ver, mutate=None):
    s = re.sub(r'^VERSION = "[^"]+"', 'VERSION = "%s"' % ver,
               io.open(NEWS, encoding="utf-8").read(), count=1, flags=re.M)
    return (mutate(s) if mutate else s).encode()


def _serve_build(srv, body, short=0):
    def h(req):
        rg, b = req.headers.get("Range"), body
        if rg and rg.startswith("bytes=0-"):
            b = body[:int(rg.split("-")[1]) + 1]
            req.send_response(206)
        else:
            req.send_response(200)
        req.send_header("Content-Length", str(len(b)))
        req.end_headers()
        req.wfile.write(b[:len(b) - short] if (short and not rg) else b)
        if short and not rg:
            req.close_connection = True
    srv.routes["/news"] = h


def _installed_copy():
    """A scratch install with a non-default interpreter line and file mode."""
    d = tempfile.mkdtemp()
    p = os.path.join(d, "news")
    b = io.open(NEWS, "rb").read()
    io.open(p, "wb").write(("#!" + sys.executable).encode() + b[b.find(b"\n"):])
    os.chmod(p, 0o700)
    return d, p


def _self_update(env, p, url):
    r = subprocess.run([sys.executable, p, "--update", url], stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, env=env)
    v = subprocess.run([sys.executable, p, "--version"], stdout=subprocess.PIPE).stdout.decode().strip()
    return (r.stdout + r.stderr).decode("utf-8", "replace"), v, r.returncode


@test
def t_update_keeps_the_install_intact(env, srv):
    import stat
    _serve_build(srv, _build("99.0"))
    d, p = _installed_copy()
    out, v, rc = _self_update(env, p, srv.url("/news"))
    raw = io.open(p, "rb").read()
    assert rc == 0 and v.endswith("99.0"), out
    assert raw.split(b"\n")[0] == ("#!" + sys.executable).encode(), "the installer's interpreter line was lost"
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o700, "the file mode was changed"
    assert b"\r" not in raw, "line endings were rewritten"
    assert os.path.exists(p + ".bak") and not os.path.exists(p + ".new")
    shutil.rmtree(d, ignore_errors=True)


@test
def t_update_refuses_anything_but_a_complete_working_newer_build(env, srv):
    cur = load().VERSION
    s99 = _build("99.0").decode()
    for label, body, short, why in (
            ("cut just before its end, which still parses", s99[:s99.index("\nif __name__")].encode(), 0, "incomplete"),
            ("cut mid-transfer", _build("99.0"), 5000, "cut short"),
            ("an error page", b"<html><body>Not Found</body></html>" * 300, 0, "does not look like"),
            ("a build that fails to start here", _build("99.0", lambda s: s.replace(
                "\nimport threading as _thr", "\nimport no_such_module_xyz\nimport threading as _thr", 1)), 0,
             "did not start"),
            ("an older build", _build("1.0"), 0, "older")):
        _serve_build(srv, body, short)
        d, p = _installed_copy()
        out, v, rc = _self_update(env, p, srv.url("/news"))
        assert rc != 0 and v.endswith(cur) and why in out, "%s: %s" % (label, out[-200:])
        assert not os.path.exists(p + ".new"), "%s left a .new file" % label
        shutil.rmtree(d, ignore_errors=True)
    d, p = _installed_copy()
    _serve_build(srv, _build(cur))
    out, _v, rc = _self_update(env, p, srv.url("/news"))
    assert rc == 0 and "already" in out
    out, _v, rc = _self_update(env, p, "ftp://example.org/news")
    assert rc != 0 and "https://" in out
    assert load().UPDATE_URL == "https://raw.githubusercontent.com/ATinyGreenCell/LowPingNews/main/news"


@test
def t_runs_without_unix_only_modules(env, srv):
    """As on Windows: no curses, termios, fcntl, tty or pty. Everything must
    still work, falling back to printed lists."""
    hide = tempfile.mkdtemp()
    io.open(os.path.join(hide, "sitecustomize.py"), "w").write(
        "import sys\nH={'curses','_curses','termios','fcntl','tty','pty','readline','resource','grp','pwd'}\n"
        "class B:\n    def find_spec(self, n, p=None, t=None):\n"
        "        if n.split('.')[0] in H: raise ImportError(n)\n"
        "sys.meta_path.insert(0, B())\n")
    try:
        e = dict(env, PYTHONPATH=hide)
        srv.feed("/f", [item("Story %d" % i) for i in range(3)])
        sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"], "url": srv.url("/f")}])
        for args in ([], ["top", "2"], ["-r", "1"], ["catalog"], ["signal"]):
            r = subprocess.run([sys.executable, NEWS] + args, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=e, timeout=60)
            assert r.returncode == 0 and b"Traceback" not in r.stderr, (args, r.stderr[-300:])
        out = _drive_tui(e, [], args=(), ready=lambda b: b"Story" in b)
        assert "Story 0" in out and "Traceback" not in out, "no fallback to the list without curses"
        out = _drive_tui(e, [], args=("--tui",), ready=lambda b: b"curses" in b)
        assert "--plain" in out or "windows-curses" in out, \
            "asking for the reader without curses should say what to do instead: " + out[-200:]
        _serve_build(srv, _build("99.0"))
        d, p = _installed_copy()
        _out, v, _rc = _self_update(e, p, srv.url("/news"))
        assert v.endswith("99.0"), "self-update needs a Unix-only module"
    finally:
        shutil.rmtree(hide, ignore_errors=True)


@test
def t_the_command_finds_where_it_is_installed(env, srv):
    """It assumed /usr/local/bin whenever PREFIX was unset, while install.sh
    puts a desktop user's copy in ~/.local/bin."""
    tmp = tempfile.mkdtemp()
    try:
        home, repo = os.path.join(tmp, "home"), os.path.join(tmp, "repo")
        lb = os.path.join(home, ".local", "bin")
        for d_ in (lb, repo, os.path.join(tmp, "empty")):
            os.makedirs(d_)
        for d_ in (lb, repo):
            shutil.copy(NEWS, d_); shutil.copy(os.path.join(HERE, "lowpingnews"), d_)
        snip = re.search(r"^_here=.*?^fi$", io.open(os.path.join(HERE, "lowpingnews")).read(), re.M | re.S).group(0)

        def where(argv0, path, prefix=None):
            e = {"HOME": home, "PATH": path + ":/usr/bin:/bin", "LPN_REPO": repo}
            if prefix:
                e["PREFIX"] = prefix
            sh = 'REPO="%s"\n%s\necho "$BIN"' % (repo, snip.replace("$0", argv0))
            return subprocess.run(["sh", "-c", sh], stdout=subprocess.PIPE, env=e).stdout.decode().strip()
        assert where("/x/usr/bin/lowpingnews", lb, "/x/usr") == "/x/usr/bin", "Termux PREFIX must come first"
        assert where(os.path.join(lb, "lowpingnews"), lb) == lb
        assert where(os.path.join(repo, "lowpingnews"), lb) == lb, "never the repo clone"
        assert where(os.path.join(repo, "lowpingnews"), os.path.join(tmp, "empty")) == lb
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_shell_scripts_avoid_gnu_only_sed(env, srv):
    """sed -i takes different arguments on macOS, so every use of it failed there."""
    for f in ("lowpingnews", "install.sh"):
        for n, ln in enumerate(io.open(os.path.join(HERE, f), encoding="utf-8"), 1):
            code = ln.split("#", 1)[0]
            assert "sed -i" not in code, "%s line %d uses sed -i" % (f, n)


# ---------------------------------------------------------------- 8.1
@test
def t_the_list_shows_ten_and_says_how_many_more(env, srv):
    _three_feeds(srv, env)
    count = lambda o: len(re.findall(r"^\s+\d+ [ABC] ", o, re.M))
    out, _e, _rc = run(env, "-t")
    flat = " ".join(out.split())
    assert count(out) == 10, "default should be the newest 10, got %d" % count(out)
    assert "10 of 60: lowpingnews top 20 for more" in flat, "the footer should give the true total: " + flat[-120:]
    out, _e, _rc = run(env, "top", "13", "-t")
    assert count(out) == 13 and "for more" not in out
    out, _e, _rc = run(env, "-n", "2", "-t")
    assert count(out) == 6, "-n is still a per-feed limit"


def _growing_feed(srv, path, n_old=30, n_new=3):
    """Old stories on the first request; three newer ones on top afterwards."""
    calls = [0]

    def h(req):
        calls[0] += 1
        titles = (["New story %d" % i for i in range(n_new)] if calls[0] > 1 else []) + \
                 ["Old story %02d" % i for i in range(n_old)]
        body = ('<?xml version="1.0"?><rss version="2.0"><channel><title>A</title>%s</channel></rss>' % "".join(
            "<item><title>%s</title><link>%s/%d</link><description>s</description><pubDate>%s</pubDate></item>" % (
                ti, NOWHERE, i, time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(
                    # new: 10-30 minutes ago; old: an hour ago and back. Never in the
                    # future - future-dated items are deliberately not pinned on top
                    time.time() - (600 * (int(ti.split()[-1]) + 1) if ti.startswith("New")
                                   else 3600 * (int(ti.split()[-1]) + 1)))))
            for i, ti in enumerate(titles))).encode()
        req.send_response(200)
        req.send_header("Content-Length", str(len(body)))
        req.end_headers()
        req.wfile.write(body)
    srv.routes[path] = h


@test
def t_the_reader_loads_more_and_keeps_new_stories_on_top(env, srv):
    _growing_feed(srv, "/a")
    srv.feed("/b", [item("Science story %d" % i) for i in range(25)])
    sources(env, [{"id": "a", "name": "A", "kind": "rss", "cats": ["top"], "url": srv.url("/a")},
                  {"id": "b", "name": "B", "kind": "rss", "cats": ["science"], "url": srv.url("/b")}])
    e = dict(env); e["LPN_NO_PING"] = "1"
    shots = _tui_frames(e, [b"j"] * 9 + [b"j", b"r", b"n", b"p"], rows=40, cols=60)
    banner = lambda sh: next((l for l in sh if "LowPingNews" in l), "")
    sel = lambda sh: next((int(m_.group(1)) for l in sh for m_ in [_SEL.search(l)] if m_), None)
    assert "10 items of 30" in banner(shots[0]), banner(shots[0])
    assert sel(shots[9]) == 10 and sel(shots[10]) == 11, "j on the last card should load more"
    assert "20 items of 30" in banner(shots[10])
    after = shots[11]
    assert "23 items of 33" in banner(after), "new stories should be added, nothing pushed out: " + banner(after)
    assert any("New story 0" in l for l in after) and "3 new at the top" in " ".join(after)
    assert "SCIENCE  10 items of 25" in banner(shots[12]) and "TOP  10 items of 33" in banner(shots[13])


@test
def t_times_read_am_and_pm(env, srv):
    m = load()
    import datetime as dt_
    for h_, mi, full, short, hour in ((0, 0, "12:00 AM", "12a", "12 AM"), (12, 0, "12:00 PM", "12p", "12 PM"),
                                      (15, 5, "3:05 PM", "3p", "3 PM"), (9, 30, "9:30 AM", "9a", "9 AM")):
        d_ = dt_.datetime(2026, 10, 4, h_, mi)
        assert (m.clock(d_), m.clock(d_, short=True), m.clock(d_, hour=True)) == (full, short, hour), h_
    tmp = tempfile.mkdtemp()
    try:
        srv.json("/fc", _forecast(rain=True))
        b = _wx_binary(srv, tmp)
        subprocess.run([b, "weather", "-c", "40.9,-73.4"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        out = re.sub(r"\x1b\[[0-9;]*m", "", subprocess.run([b, "weather", "--plain"], stdout=subprocess.PIPE,
                                                           env=env).stdout.decode())
        assert re.search(r"around \d{1,2} (AM|PM)", out) and re.search(r"\b\d{1,2}[ap]\b", out), out
        e = dict(env, LPN_CLOCK="24")
        out = re.sub(r"\x1b\[[0-9;]*m", "", subprocess.run([b, "weather", "--plain"], stdout=subprocess.PIPE,
                                                           env=e).stdout.decode())
        assert re.search(r"around \d\d:00", out), "LPN_CLOCK=24 should keep 24-hour time"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- web app
WEB = os.path.join(HERE, "web")


@test
def t_web_build_publishes_preprint_abstracts(env, srv):
    srv.feed("/bx", [item("Jasmonate expands the MYC2 cistrome", body="The transcription factor MYC2...",
                          link="http://biorxiv.org/cgi/content/short/2026.10.02.679012v2?rss=1"),
                     item("A preprint the API does not know", body="x",
                          link="http://biorxiv.org/cgi/content/short/2026.10.02.000001v1?rss=1"),
                     item("An ordinary story", body="x", link="https://news.example/a")])
    api = "/details/biorxiv/10.1101/2026.10.02.679012/na/json"
    srv.json(api, {"collection": [
        {"version": "1", "abstract": "Old abstract.", "authors": "A", "date": "2026-10-01", "category": "plant biology"},
        {"version": "2", "abstract": "MYC2 is central.\n\nWe mapped its binding.", "authors": "Lee, K.; Park, S.",
         "date": "2026-10-02", "category": "plant biology", "published": "NA"}]})
    tmp = tempfile.mkdtemp()
    try:
        fl = os.path.join(tmp, "feeds.json")
        json.dump([{"id": "bx", "name": "bioRxiv plant", "url": srv.url("/bx"), "cats": ["bio"]}], io.open(fl, "w"))
        e = dict(env, LPN_WEB_FEEDS=fl, LPN_PREPRINT_API=srv.url(""))

        def build():
            out = os.path.join(tmp, "site")
            shutil.rmtree(out, ignore_errors=True)
            r = subprocess.run([sys.executable, os.path.join(WEB, "build_digest.py"), out], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=e, timeout=120)
            assert r.returncode == 0, r.stderr[-400:]
            return os.path.join(out, "data", "abs"), r.stdout.decode()
        adir, log = build()
        assert sorted(os.listdir(adir)) == ["biorxiv-2026.10.02.679012.json"], (os.listdir(adir), log, io.open(
            os.path.join(tmp, "site", "data", "bio.json"), encoding="utf-8").read()[:600])
        doc = json.load(io.open(os.path.join(adir, "biorxiv-2026.10.02.679012.json"), encoding="utf-8"))
        assert doc["abstract"] == "MYC2 is central.\n\nWe mapped its binding." and doc["version"] == "2", doc
        assert "1 published, 2 outside requests" in log, log
        srv.json(api, {"collection": [{"version": "3", "abstract": "Changed."}]})
        adir, log = build()                                   # cached: bioRxiv is not asked again
        doc = json.load(io.open(os.path.join(adir, "biorxiv-2026.10.02.679012.json"), encoding="utf-8"))
        assert doc["version"] == "2" and "0 outside requests" in log, (doc, log)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_abstracts_come_from_the_feed_then_crossref(env, srv):
    full = ("Cytokinin delays leaf senescence and keeps photosynthesis going by maintaining chloroplast function. "
            "Here we show that two import components are required, ") * 3 + "and we map where they act."
    feed_item = item("Cytokinin and chloroplast import", body=full,
                     link="http://biorxiv.org/cgi/content/short/2026.10.03.111111v1?rss=1",
                     when="2026-10-03T08:00:00Z").replace("</item>", "<author>Okafor, N. A.; Li, W.</author></item>")
    srv.feed("/bx", [feed_item,
                     item("A short-texted preprint", body="Just a teaser.",
                          link="http://biorxiv.org/cgi/content/short/2026.10.03.222222v1?rss=1"),
                     item("Nobody has this one", body="Teaser.",
                          link="http://biorxiv.org/cgi/content/short/2026.10.03.333333v1?rss=1")])
    srv.json("/works/10.1101/2026.10.03.222222", {"status": "ok", "message": {
        "abstract": "<jats:title>Abstract</jats:title><jats:p>Crossref holds this abstract &amp; it is long enough to use here, being a real paragraph of findings.</jats:p>",
        "author": [{"given": "Ana Maria", "family": "Ruiz"}], "posted": {"date-parts": [[2026, 10, 3]]}}})

    def empty(h):                                   # what bioRxiv's details endpoint sends lately
        h.send_response(200)
        h.send_header("Content-Type", "application/json")
        h.send_header("Content-Length", "0")
        h.end_headers()
    srv.routes["/details/biorxiv/10.1101/2026.10.03.333333/na/json"] = empty
    tmp = tempfile.mkdtemp()
    try:
        fl = os.path.join(tmp, "feeds.json")
        json.dump([{"id": "bx", "name": "bioRxiv plant", "url": srv.url("/bx"), "cats": ["bio"]}], io.open(fl, "w"))
        out = os.path.join(tmp, "site")
        r = subprocess.run([sys.executable, os.path.join(WEB, "build_digest.py"), out], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=dict(env, LPN_WEB_FEEDS=fl, LPN_PREPRINT_API=srv.url("")), timeout=120)
        assert r.returncode == 0, r.stderr.decode()[-600:]
        adir = os.path.join(out, "data", "abs")
        assert sorted(os.listdir(adir)) == ["biorxiv-2026.10.03.111111.json", "biorxiv-2026.10.03.222222.json"], os.listdir(adir)
        a = json.load(io.open(os.path.join(adir, "biorxiv-2026.10.03.111111.json"), encoding="utf-8"))
        assert a["abstract"] == full and a["src"] == "feed" and a["authors"] == "Okafor, N. A.; Li, W.", a
        assert a["date"] == "2026-10-03" and a["doi"] == "10.1101/2026.10.03.111111", a
        b = json.load(io.open(os.path.join(adir, "biorxiv-2026.10.03.222222.json"), encoding="utf-8"))
        assert b["abstract"] == "Crossref holds this abstract & it is long enough to use here, being a real paragraph of findings.", b
        assert b["authors"] == "Ruiz, A. M." and b["date"] == "2026-10-03" and b["src"] == "crossref", b
        assert "2 outside requests" in r.stdout.decode(), "the feed's own abstract must cost no extra request"
        bio = json.load(io.open(os.path.join(out, "data", "bio.json"), encoding="utf-8"))
        s = [x[2] for x in bio["items"] if x[1].startswith("Cytokinin")][0]
        assert s.endswith("\u2026") and len(s) <= 220 and full.startswith(s[:-1].rstrip()), repr(s)
        assert s[-2] != " " and full[len(s) - 1] == " ", "a preview should end at a whole word: %r" % s[-20:]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_site_build_survives_a_broken_cache_and_hostile_feed(env, srv):
    nasty = "Abstract \x1b[2J text <script>x</script> \u202e reversed. " * 12
    srv.feed("/bx", [item("Hostile", body=nasty, link="http://biorxiv.org/cgi/content/short/2026.10.03.444444v1?rss=1")
                     .replace("</item>", "<author>\x07Evil, E.\x1b]0;title\x07 " + "A" * 5000 + "</author></item>")])
    tmp = tempfile.mkdtemp()
    try:
        fl = os.path.join(tmp, "feeds.json")
        json.dump([{"id": "bx", "name": "bx", "url": srv.url("/bx"), "cats": ["bio"]}], io.open(fl, "w"))
        cache = os.path.join(env["XDG_CACHE_HOME"], "lowpingnews")
        os.makedirs(cache, exist_ok=True)
        for name in ("abstracts.json",):
            io.open(os.path.join(cache, name), "w").write("{not json at all")
        out = os.path.join(tmp, "site")
        r = subprocess.run([sys.executable, os.path.join(WEB, "build_digest.py"), out], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=dict(env, LPN_WEB_FEEDS=fl, LPN_PREPRINT_API=NOWHERE), timeout=120)
        assert r.returncode == 0, r.stderr.decode()[-500:]
        raw = io.open(os.path.join(out, "data", "abs", "biorxiv-2026.10.03.444444.json"), encoding="utf-8").read()
        doc = json.loads(raw)
        for v in doc.values():
            if not isinstance(v, str):
                continue
            assert not re.search(u"[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e]", v), "control text survived: %r" % v[:80]
        assert "<script>" not in raw and len(doc.get("authors", "")) <= 600, doc.get("authors", "")[:80]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_pubmed_tab_links_to_pubmed_and_publishes_abstracts(env, srv):
    m = load()
    feed = {"resultList": {"result": [
        {"id": "41000001", "source": "MED", "pmid": "41000001", "doi": "10.1000/a1", "title": "Duckweed chloroplast transformation",
         "journalTitle": "Plant Cell", "authorString": "Lee K, Park S", "firstPublicationDate": "2026-10-02"},
        {"id": "41000002", "source": "MED", "pmid": "41000002", "title": "Molecular farming in Wolffia",
         "journalTitle": "Plant Biotechnol J", "authorString": "Ruiz M", "firstPublicationDate": "2026-10-01"},
        {"id": "PPR999", "source": "PPR", "doi": "10.1101/2026.10.01.555555", "title": "A preprint in Europe PMC",
         "firstPublicationDate": "2026-10-01"}]}}
    recs = m.parse_epmc(json.dumps(feed).encode())
    assert [r["u"] for r in recs] == ["https://pubmed.ncbi.nlm.nih.gov/41000001/", "https://pubmed.ncbi.nlm.nih.gov/41000002/",
                                      "https://doi.org/10.1101/2026.10.01.555555"], [r["u"] for r in recs]
    srv.json("/pm", feed)
    batch = {"resultList": {"result": [
        {"pmid": "41000001", "abstractText": "<h4>Background</h4>Duckweed grows fast &amp; clonally, which makes it a good host for chloroplast work.<h4>Results</h4>We transformed plastids.",
         "authorString": "Lee K, Park S", "journalTitle": "Plant Cell", "firstPublicationDate": "2026-10-02", "doi": "10.1000/a1"},
        {"pmid": "41000002", "abstractText": "Wolffia makes recombinant protein at useful yields, as shown here across many trials in detail.",
         "authorString": "Ruiz M", "journalTitle": "Plant Biotechnol J", "firstPublicationDate": "2026-10-01"},
        {"pmid": "99999999", "abstractText": "Some other paper that was never asked about, and must not be published here."}]}}
    srv.json("/europepmc/webservices/rest/search", batch)
    tmp = tempfile.mkdtemp()
    try:
        fl = os.path.join(tmp, "feeds.json")
        json.dump([{"id": "pubmed", "name": "PubMed", "url": srv.url("/pm"), "cats": ["pubmed"], "kind": "epmc"}], io.open(fl, "w"))

        def build():
            out = os.path.join(tmp, "site")
            shutil.rmtree(out, ignore_errors=True)
            r = subprocess.run([sys.executable, os.path.join(WEB, "build_digest.py"), out], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=dict(env, LPN_WEB_FEEDS=fl, LPN_PREPRINT_API=srv.url("")), timeout=120)
            assert r.returncode == 0, r.stderr.decode()[-600:]
            return out, r.stdout.decode()
        out, log = build()
        adir = os.path.join(out, "data", "abs")
        assert sorted(os.listdir(adir)) == ["pubmed-41000001.json", "pubmed-41000002.json"], os.listdir(adir)
        a = json.load(io.open(os.path.join(adir, "pubmed-41000001.json"), encoding="utf-8"))
        assert a["pmid"] == "41000001" and a["server"] == "pubmed" and a["journal"] == "Plant Cell", a
        assert a["abstract"].split("\n\n") == ["Background", "Duckweed grows fast & clonally, which makes it a good host for chloroplast work.",
                                                "Results", "We transformed plastids."], a["abstract"]
        assert a["authors"] == "Lee K; Park S" and a["published"] == "10.1000/a1", a
        assert "1 outside requests" in log, "both PubMed abstracts should come in one request: " + log
        pm = json.load(io.open(os.path.join(out, "data", "pubmed.json"), encoding="utf-8"))
        assert pm["cat"] == "pubmed" and pm["items"][0][3] == "https://pubmed.ncbi.nlm.nih.gov/41000001/"
        out, log = build()
        assert "0 outside requests" in log and len(os.listdir(os.path.join(out, "data", "abs"))) == 2, log
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_europe_pmc_feeds_list_the_newest_papers_first(env, srv):
    m = load()
    builtin = [f["url"] for f in json.loads(m.CATALOG_SEED)["feeds"] + m.DEFAULTS if "europepmc" in f["url"]]
    assert builtin and all("sort=FIRST_PDATE_D%20desc" in u and "P_PDATE_D" not in u.replace("FIRST_PDATE_D", "")
                           for u in builtin), builtin
    old = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=x&format=json&pageSize=20&sort=P_PDATE_D%20desc"
    assert m.epmc_newest(old).endswith("&sort=FIRST_PDATE_D%20desc")
    for keep in ("https://evil.example/europepmc/webservices/rest/search?sort=P_PDATE_D%20desc",
                 "https://www.ebi.ac.uk.evil.example/europepmc/webservices/rest/search?sort=P_PDATE_D%20desc",
                 "https://feeds.example/rss?sort=P_PDATE_D%20desc"):
        assert m.epmc_newest(keep) == keep, keep
    sources(env, [{"id": "pm", "name": "PubMed", "url": old, "cats": ["pubmed"], "kind": "epmc"}])
    probe = ("import importlib.util as u, importlib.machinery as mc, json, sys; sys.argv=['x']; "
             "l = mc.SourceFileLoader('n', %r); s = u.spec_from_loader('n', l); m = u.module_from_spec(s); l.exec_module(m); "
             "import types; print(json.dumps([x['url'] for x in m.sources(types.SimpleNamespace(only=None, cat='all'))]))" % NEWS)
    pr = subprocess.run([sys.executable, "-c", probe], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    assert pr.returncode == 0, pr.stderr.decode()[-400:]
    got = json.loads(pr.stdout.decode())
    assert got == [old.replace("P_PDATE_D", "FIRST_PDATE_D")], "a saved list keeps the issue-date sort: %r" % got


def _json_by_query(srv, path, pick):
    """A JSON route whose answer depends on the query string: pick(query) -> obj."""
    def h(req):
        b = gzip.compress(json.dumps(pick(req.path.partition("?")[2])).encode())
        req.send_response(200)
        req.send_header("Content-Encoding", "gzip")
        req.send_header("Content-Length", str(len(b)))
        req.end_headers()
        req.wfile.write(b)
    srv.routes[path] = h


def _text_route(srv, path, body, ctype="text/plain"):
    def h(req):
        b = body.encode("utf-8")
        req.send_response(200)
        req.send_header("Content-Type", ctype)
        req.send_header("Content-Length", str(len(b)))
        req.end_headers()
        req.wfile.write(b)
    srv.routes[path] = h


@test
def t_moon_and_tide_maths(env, srv):
    m = load()
    full = m.moon(1706205240)                     # 2024-01-25 17:54 UTC, a full moon
    assert full["name"] == "Full moon" and full["lit"] > 0.97 and full["tide"] == "spring", full
    new = m.moon(1712600460)                      # 2024-04-08 18:21 UTC, the eclipse new moon
    assert new["name"] == "New moon" and new["lit"] < 0.03 and new["tide"] == "spring", new
    q = m.moon(1706205240 + 7.4 * 86400)          # a week after full: last quarter, neap tides
    assert q["name"] == "Last quarter" and q["tide"] == "neap", q
    assert abs(full["full"] - 1706205240) < 86400, "the predicted full moon is within a day of the real one"
    assert abs(new["new"] - 1712600460) < 86400 or abs(new["new"] - 1712600460 - 29.53 * 86400) < 86400
    hilo = [[0, 0.0, "L"], [6 * 3600, 6.0, "H"], [12 * 3600, 0.5, "L"]]
    lv, up = m.tide_level(hilo, 3 * 3600)
    assert abs(lv - 3.0) < 1e-9 and up is True, (lv, up)
    lv, up = m.tide_level(hilo, 9 * 3600)
    assert abs(lv - 3.25) < 1e-9 and up is False
    assert m.tide_level(hilo, 13 * 3600) == (None, None), "outside the predictions: unknown, not guessed"
    assert 50 < m.km(40.871, -73.426, 40.713, -74.006) < 55, "Huntington to Manhattan is about 52 km"
    assert m.dur(45 * 60) == "45 min" and m.dur(130 * 60) == "2 h 10 min" and m.dur(120 * 60) == "2 h"


def _inproc():
    """The app in this process with every cache path in a scratch folder: an
    in-process test must never read or write the real ones."""
    m = load()
    d = tempfile.mkdtemp(prefix="lpn-inproc-")
    m.CD = d
    for k in ("WXC", "NWSC", "TIDEC"):
        setattr(m, k, os.path.join(d, os.path.basename(getattr(m, k))))
    return m, d


HOSTILE = re.compile(u"[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ud800-\udfff]")


@test
def t_hostile_feeds_never_freeze_or_leak(env, srv):
    m = load()
    t0 = time.time()
    m.parse_loose(("<rss>" + "<item>" * 50000).encode())
    m.parse_loose(("<item><title>x" * 20000).encode())
    m.extract(("<head>" + "<meta name=x " * 150000).encode())
    m.extract(("<p>" + "<!--" * 20000 + "</p>").encode())
    assert time.time() - t0 < 6, "unclosed tags must cost linear time (this took 68 s once): %.1fs" % (time.time() - t0)
    cut = ("<rss><channel><item><title>Kept \x1b[2J\u202eone</title><link>https://a.example/1</link></item>"
           "<item><title>Second</title><link>javascript:alert(1)</link></item><item><title>Third").encode()
    got = m.parse_loose(cut)
    assert [x["ti"] for x in got] == ["Kept one", "Second"] and got[1]["u"] == "", got
    hn = json.dumps({"hits": [{"title": "Good", "url": "https://a.example/", "points": 5, "num_comments": 2, "created_at_i": 1700000000},
                              {"title": "Bad counts", "points": "many", "num_comments": None, "created_at_i": "x", "objectID": "\x1b[2J"},
                              "not an object", {"title": "\ud83d lone", "objectID": "123"}]}).encode()
    hits = m.parse_hn(hn)
    assert [h["ti"] for h in hits] == ["Good", "Bad counts", "lone"], hits
    assert hits[1]["s"] == "0 points, 0 comments" and hits[1]["u"] == "" and hits[1]["d"] == 0
    assert hits[2]["u"] == "https://news.ycombinator.com/item?id=123"
    for junk in (b"[]", b"null", b'"x"', b'{"hits": 5}', b'{"resultList": [1, 2]}'):
        assert m.parse_hn(junk) == [] and m.parse_epmc(junk) == [], junk
    ep = json.dumps({"resultList": {"result": [{"title": "A", "pmid": "123", "source": "MED", "journalTitle": {"x": 1}},
                                               {"title": "B", "doi": "10.1101/x\x1b", "source": "PPR", "firstPublicationDate": 2024},
                                               None, {"title": "C", "doi": "10.1101/2024.01.01.000001", "source": "PPR"}]}}).encode()
    eps = m.parse_epmc(ep)
    assert [e["ti"] for e in eps] == ["A", "B", "C"] and eps[1]["u"] == "" and eps[2]["u"].startswith("https://doi.org/10.1101/"), eps
    for s_ in ("\ud83d", "a\udc00b", "\x9b31m", "\u2066x\u2069", "x\u2028y"):
        out_ = m.clean(s_)
        out_.encode("utf-8")                      # must not raise: a lone surrogate cannot be written anywhere
        assert not HOSTILE.search(out_), repr(s_)
    assert m.clean("Kept \x1b[2J\u202eone \x1b]0;title\x07x \x9b31mred") == "Kept one x red", "whole escape sequences go"
    assert m.clean("plain [2J text") == "plain [2J text", "text that only looks like one stays"
    assert m.clean(float("nan")) == "" and m.clean(float("inf")) == "" and m.clean([None]) == "" and m.clean(7) == "7"
    assert m.clean_alert([None], 50) == "" and m.clean_alert(float("nan"), 9) == ""


@test
def t_links_are_never_terminal_controls(env, srv):
    m = load()
    for bad in ("https://a.example/\x1b[2J", "https://a.example/\u202e", "https://a.example/\ud83d", "https://a.example/\x9bx",
                "https://", "https:///path", "javascript:alert(1)", "ftp://a.example/", "https://a.example/" + "x" * 3000,
                "https://a.example/\x00", 'https://a.example/"><script>', None, 5, ["https://a.example/"]):
        assert m.safe_url(bad) == "", repr(bad)[:60]
    assert m.safe_url(" https://a.example/a b ") == "https://a.example/a%20b", "a stray space is encoded, not fatal"
    assert m.safe_url("HTTPS://A.example/x?y=1#z") == "HTTPS://A.example/x?y=1#z"
    assert m.safe_url("https://a.example") == "https://a.example" and m.safe_url("https://\u00e9t\u00e9.example/\u00e9") != ""


def _forecast(now):
    hrs = [now + 3600 * i for i in range(24)]
    days = [now - now % 86400 + 86400 * i for i in range(7)]
    return {"utc_offset_seconds": -14400, "current": {"time": now, "temperature_2m": 61.3, "apparent_temperature": 59.0,
            "weather_code": 2, "wind_speed_10m": 8.2, "wind_gusts_10m": 15.1, "wind_direction_10m": 230, "relative_humidity_2m": 70,
            "is_day": 1}, "hourly": {"time": hrs, "temperature_2m": [60.0 + i % 5 for i in range(24)],
            "precipitation_probability": [0] * 24, "precipitation": [0.0] * 24, "weather_code": [2] * 24},
            "daily": {"time": days, "weather_code": [2, 3, 61, 0, 1, 95, 71], "temperature_2m_max": [65, 66, 60, 70, 71, 59, 50],
                      "temperature_2m_min": [50, 52, 48, 55, 56, 45, 33], "precipitation_probability_max": [0, 20, 80, 0, 5, 90, 40],
                      "precipitation_sum": [0, 0.1, 0.8, 0, 0, 1.2, 0.3], "sunrise": [d + 25000 for d in days],
                      "sunset": [d + 66000 for d in days]}}


@test
def t_weather_never_invents_a_reading(env, srv):
    """A reading missing from the reply stays missing: never calm wind, 0%
    humidity, dry skies or a clear day."""
    import contextlib
    m, d = _inproc()
    try:
        now = int(time.time())
        f = _forecast(now)
        for k in ("wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "relative_humidity_2m", "weather_code"):
            f["current"][k] = None
        f["hourly"]["precipitation_probability"] = [None] * 24
        f["daily"]["precipitation_probability_max"][1] = None
        f["daily"]["weather_code"][2] = None
        c = m.wx_clean(f)
        assert c and c["current"]["wind_speed_10m"] is None and c["current"]["relative_humidity_2m"] is None
        a = m.fastparse(["weather"]) or m.argparse_ns({})
        a.unit, a.ascii = "fahrenheit", False
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            m.wx_show(a, m.pal(False), {"lat": 40.9, "lon": -73.4, "label": "Test", "via": "pinned"}, f, 100, 0, False)
        out = buf.getvalue()
        for lie in ("Wind calm", "Humidity 0%", "No rain expected"):
            assert lie not in out, "invented %r:\n%s" % (lie, out)
        assert "Rain chance not reported" in out and "Unknown" in out and "\u2013" in out, out
        assert "61\u00b0F" in out and "Feels like 59" in out, "what is known is still shown:\n" + out
        for junk in (None, [], {"current": {}}, {"current": {"time": now, "temperature_2m": float("nan")}},
                     {"current": {"time": "x", "temperature_2m": 50}}):
            assert m.wx_clean(junk) is None, junk
        f2 = _forecast(now)
        f2["hourly"]["temperature_2m"][5] = None                 # a broken hour ends the run of hours
        f2["daily"]["temperature_2m_max"][3] = "hot"              # a day without both temperatures is dropped
        f2["current"]["relative_humidity_2m"] = 140               # impossible: not reported
        c2 = m.wx_clean(f2)
        assert len(c2["hourly"]["time"]) == 5 and len(c2["daily"]["time"]) == 6 and c2["current"]["relative_humidity_2m"] is None
    finally:
        shutil.rmtree(d, ignore_errors=True)


@test
def t_a_bad_forecast_never_replaces_a_good_one(env, srv):
    m, d = _inproc()
    try:
        now = int(time.time())
        reply = [json.dumps(_forecast(now)).encode()]
        m.get = lambda url, *a_, **k_: (reply[0], {}, len(reply[0]), False)
        loc = {"lat": 40.9, "lon": -73.4}
        good, w, age, stale = m.wx_fetch(loc, "fahrenheit", True)
        assert good and not stale and os.path.exists(m.WXC)
        for broken in (b'{"current": {"time": 1}}', b"[]", b"<html>oops</html>", b'{"error": true, "reason": "\x1b[2Jbusy"}'):
            reply[0] = broken
            again, w, age, stale = m.wx_fetch(loc, "fahrenheit", True)
            assert stale and again["current"]["temperature_2m"] == 61.3, "a broken reply must fall back to the good forecast"
            assert json.load(io.open(m.WXC))["d"]["current"]["temperature_2m"] == 61.3, "and must never be cached"
    finally:
        shutil.rmtree(d, ignore_errors=True)


@test
def t_screens_survive_hostile_data(env, srv):
    """Weather, radio and tides, through their real fetch, parse and cache code,
    fed mutated replies: never a crash, never a control character on screen."""
    import contextlib, random
    m, d = _inproc()
    R = random.Random(20261004)
    now = int(time.time())
    junk = [None, "", "x", "\x1b[2J\u202e\ud83d", -1, 1e308, float("nan"), float("-inf"), True, [], {}, [None], 10 ** 20]

    def mut(v, rate=0.15):
        if R.random() < rate:
            return R.choice(junk)
        if isinstance(v, dict):
            return {k: mut(x, rate) for k, x in v.items() if R.random() > rate / 3}
        if isinstance(v, list):
            return [mut(x, rate) for x in (v[:R.randint(0, len(v))] if R.random() < rate else v)]
        return v
    g = lambda t: time.strftime("%Y-%m-%d %H:%M", time.gmtime(t))
    tile = {"v": 1, "nb": 40, "s": [["8516945", "Northport, NY", 40.9, -73.35]], "c": [["ACT3116", "Northport Bay", 40.93, -73.36, 1]],
            "b": [["44040", "W LIS", 40.956, -73.58, now - 1200, 18.0, 0.5, 4.0, 225, 6.2, 8.0, 19.0]]}
    preds = {"predictions": [{"t": g(now + h * 3600), "v": v, "type": k} for h, v, k in
                             [(-4, "0.3", "L"), (2.5, "7.4", "H"), (8.5, "0.1", "L"), (14.5, "6.9", "H"), (21, "-0.2", "L")]]}
    cur = {"current_predictions": {"cp": [{"Type": k, "Time": g(now + h * 3600), "Velocity_Major": v, "meanFloodDir": 95,
                                           "meanEbbDir": 275} for k, h, v in [("slack", -3, 0), ("ebb", 0.5, -0.4), ("slack", 4, 0)]]}}
    points = {"properties": {"forecast": "https://api.weather.gov/gridpoints/OKX/1,1/forecast", "gridId": "OKX",
                             "relativeLocation": {"properties": {"city": "Huntington", "state": "NY"}},
                             "forecastZone": "https://api.weather.gov/zones/forecast/NYZ078"}}
    alerts = {"features": [{"properties": {"event": "Coastal Flood Advisory", "severity": "Minor", "status": "Actual",
              "headline": "x", "description": "* WHAT...flooding.", "ends": "2099-01-01T00:00:00-05:00"}}]}
    fc = {"properties": {"periods": [{"name": "Tonight", "detailedForecast": "Clear.", "temperature": 50, "temperatureUnit": "F",
                                      "isDaytime": False}]}}
    loc = {"lat": 40.871, "lon": -73.426, "label": "Huntington", "via": "pinned"}
    bad = []
    try:
        for i in range(120):
            os.environ["COLUMNS"] = str(R.choice([16, 46, 120]))
            P = m.pal(R.random() < 0.5)
            jobs = []
            fx = mut(_forecast(now))
            a1 = m.fastparse(["weather"]) or m.argparse_ns({})
            a1.unit, a1.ascii = R.choice(["fahrenheit", "celsius"]), R.random() < 0.2
            jobs.append(("weather", lambda: m.wx_show(a1, P, loc, fx, 1, 0, False)))
            pay = (mut(points), mut(alerts), mut(fc))
            m.nws_get = lambda url, cap, pay=pay: (pay[0] if "/points/" in url else pay[1] if "/alerts" in url else pay[2], 9)
            a2 = m.fastparse(["radio"]) or m.argparse_ns({})
            a2.fresh = True
            jobs.append(("radio", lambda: m.radio_show(a2, P, loc, m.nws_fetch(loc, True, None))))
            tp = (mut(tile), mut(preds), mut(cur))
            m.get = lambda url, *a_, tp=tp, **k_: (json.dumps(tp[0] if "/data/tides/" in url else tp[2] if "currents" in url
                                                              else tp[1]).encode("utf-8", "surrogatepass"), {}, 9, False)
            a3 = m.fastparse(["tides"]) or m.argparse_ns({})
            a3.fresh = True
            jobs.append(("tides", lambda: m.tides_show(a3, P, loc)))
            for name, job in jobs:
                for f_ in os.listdir(d):
                    os.remove(os.path.join(d, f_))
                buf = io.StringIO()
                try:
                    with contextlib.redirect_stdout(buf):
                        job()
                except SystemExit:
                    pass
                except Exception as e:
                    bad.append("%s: %s: %s" % (name, type(e).__name__, str(e)[:80]))
                    continue
                h = HOSTILE.search(buf.getvalue())
                if h:
                    bad.append("%s: %r on screen" % (name, h.group()))
        assert not bad, "%d failures, e.g.:\n  %s" % (len(bad), "\n  ".join(sorted(set(bad))[:8]))
    finally:
        os.environ.pop("COLUMNS", None)
        shutil.rmtree(d, ignore_errors=True)


@test
def t_a_slow_server_cannot_hold_the_refresh(env, srv):
    """A server dripping a byte at a time never trips an idle timeout; one that
    hangs makes its other feeds wait in line. Neither may hold the refresh, and
    a healthy feed on another server still arrives."""
    def drip(h):
        h.send_response(200)
        h.send_header("Content-Length", "100000")
        h.end_headers()
        try:
            for _ in range(200):
                h.wfile.write(b"<")
                h.wfile.flush()
                time.sleep(0.3)
        except OSError:
            pass

    def hang(h):
        time.sleep(30)
    srv.routes["/drip"] = drip
    srv.routes["/hang1"] = hang
    srv.routes["/hang2"] = hang
    srv.feed("/fine", [item("A healthy feed on another server")])
    port = srv.url("/").split(":")[2].split("/")[0]
    sources(env, [{"id": "dr", "name": "Drip", "url": srv.url("/drip"), "cats": ["top"], "kind": "rss", "timeout": 1},
                  {"id": "h1", "name": "Hang one", "url": srv.url("/hang1"), "cats": ["top"], "kind": "rss", "timeout": 1},
                  {"id": "h2", "name": "Hang two", "url": srv.url("/hang2"), "cats": ["top"], "kind": "rss", "timeout": 1},
                  {"id": "ok", "name": "Fine", "url": "http://localhost:%s/fine" % port, "cats": ["top"], "kind": "rss"}])
    t0 = time.time()
    out, err, rc = run(dict(env, LPN_REQ_MAX="3"), "--plain", "-f", "all")
    took = time.time() - t0
    assert "Traceback" not in err and "A healthy feed on another server" in out, out + err
    assert took < 15, "a dripping and two hanging feeds held the refresh %.1f s (each alone is bounded)" % took


@test
def t_web_policy_allows_exactly_what_the_app_uses(env, srv):
    """The page's security policy: every service the app's code contacts is
    allowed (or a new feature would be silently blocked on the phone), nothing
    more is, scripts are its own only, and the built site names the real reader."""
    page = io.open(os.path.join(WEB, "static", "index.html"), encoding="utf-8").read()
    pol = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', page)
    assert pol, "the page must carry a security policy"
    rules = dict((r.split()[0], r.split()[1:]) for r in pol.group(1).split(";") if r.strip())
    assert rules["script-src"] == ["'self'"] and rules["object-src"] == ["'none'"] and rules["base-uri"] == ["'none'"]
    code = "".join(io.open(os.path.join(WEB, "src", f), encoding="utf-8").read() for f in ("app.ts", "sw.ts", "core.ts"))
    # hosts that only appear as links shown to the reader, never fetched by the page
    shown_only = {"https://github.com", "https://doi.org"}
    used = set(re.findall(r"https://[a-z0-9.-]+\.[a-z]{2,}", code)) - shown_only
    for h in shown_only:                       # and they really are never fetched
        assert not re.search(r"(fetch|getJSON)\(\s*[\"']" + re.escape(h), code), h + " is fetched: allow it in the policy"
    allowed = set(x for x in rules["connect-src"] if x.startswith("https://"))
    assert used <= allowed, "contacted but not allowed: %s" % sorted(used - allowed)
    assert allowed <= used, "allowed but never contacted: %s" % sorted(allowed - used)
    assert "__READER_ORIGIN__" in rules["connect-src"], "the reader's origin is filled in by the build"
    tmp = tempfile.mkdtemp()
    try:
        fl = os.path.join(tmp, "feeds.json")
        json.dump([], io.open(fl, "w"))
        for reader, want in (("https://lpn-reader.someone.workers.dev/", "https://lpn-reader.someone.workers.dev"), ("", None)):
            out = os.path.join(tmp, "site")
            shutil.rmtree(out, ignore_errors=True)
            r = subprocess.run([sys.executable, os.path.join(WEB, "build_digest.py"), out], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=dict(env, LPN_WEB_FEEDS=fl, LPN_READER_URL=reader, LPN_TIDE_META=NOWHERE, LPN_NDBC=NOWHERE,
                                        LPN_CURRENT_META=NOWHERE), timeout=120)
            assert r.returncode == 0, r.stderr.decode()[-300:]
            built = io.open(os.path.join(out, "index.html"), encoding="utf-8").read()
            assert "__READER_ORIGIN__" not in built, "the placeholder must never reach the phone"
            cs = re.search(r'Content-Security-Policy" content="([^"]+)"', built).group(1)
            conn = [r_ for r_ in cs.split(";") if r_.strip().startswith("connect-src")][0].split()
            assert (want in conn) if want else not any("workers.dev" in x for x in conn), conn
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_the_command_runs_from_cached_bytecode(env, srv):
    """lowpingnews loads news as a module, so Python keeps its compiled bytecode
    (a script is recompiled every run: ~70% of a warm list). Same behaviour as
    running news directly; the cache lives in the cache folder; an updated news
    is never served from a stale cache."""
    tmp = tempfile.mkdtemp()
    try:
        bin_ = os.path.join(tmp, "bin")
        os.makedirs(bin_)
        for f in ("news", "lowpingnews"):
            shutil.copy(os.path.join(HERE, f), os.path.join(bin_, f))
            os.chmod(os.path.join(bin_, f), 0o755)
        e = dict(env, PREFIX=tmp)
        w = lambda *a: subprocess.run(["sh", os.path.join(bin_, "lowpingnews")] + list(a), env=e, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, timeout=60)
        direct = subprocess.run([sys.executable, os.path.join(bin_, "news"), "--version"], env=e, stdout=subprocess.PIPE, timeout=60)
        r1, r2 = w("--version"), w("--version")
        assert r1.returncode == 0 and r1.stdout == r2.stdout == direct.stdout, (r1.stdout, r2.stdout, direct.stdout, r1.stderr[-300:])
        pyc = [os.path.join(dp, f) for dp, _d, fs in os.walk(os.path.join(env["XDG_CACHE_HOME"], "lowpingnews", "pyc"))
               for f in fs if f.endswith(".pyc")]
        assert pyc, "the compiled bytecode should be kept in the cache folder"
        assert not os.path.exists(os.path.join(bin_, "__pycache__")), "never a __pycache__ beside the program"
        bad = w("--no-such-flag-anywhere")
        assert bad.returncode != 0 and b"Traceback" not in bad.stderr, "errors exit the same way, without a traceback"
        probe = subprocess.run(["sh", "-c", 'printf "%%s" "$(sh %s/lowpingnews --version)"' % bin_], env=e, stdout=subprocess.PIPE)
        assert probe.stdout.strip() == direct.stdout.strip()
        src = io.open(os.path.join(bin_, "news"), encoding="utf-8").read()
        new = re.sub(r'^VERSION = "[^"]+"', 'VERSION = "99.9"', src, count=1, flags=re.M)
        io.open(os.path.join(bin_, "news"), "w", encoding="utf-8").write(new + "\n# changed\n")
        assert b"99.9" in w("--version").stdout, "an updated news must never be served from the old cache"
        argv0 = subprocess.run([sys.executable, "-c", "import sys; print(sys.argv)"], stdout=subprocess.PIPE).returncode == 0
        src2 = io.open(os.path.join(bin_, "news"), encoding="utf-8").read().replace(
            "def main():", "def main():\n    if os.environ.get('LPN_PROBE_ARGV0'):\n        print('ARGV0=' + sys.argv[0]); return\n", 1)
        io.open(os.path.join(bin_, "news"), "w", encoding="utf-8").write(src2)
        got = subprocess.run(["sh", os.path.join(bin_, "lowpingnews"), "--version"], env=dict(e, LPN_PROBE_ARGV0="1"),
                             stdout=subprocess.PIPE, timeout=60).stdout.decode()
        assert argv0 and "ARGV0=" + os.path.join(bin_, "news") in got, "self-update finds itself by argv[0]: " + got
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_how_long_a_tide_holds_is_exact(env, srv):
    """The window within 1 ft of each high and low, against a minute-by-minute
    walk of the same curve: lopsided tides, a negative low, and a side that
    never moves a foot (that is 'whole', never passed off as a hold)."""
    m = load()
    H = 3600
    cases = [[[0, 0.4, "L"], [6.2 * H, 7.3, "H"], [12.4 * H, 0.7, "L"], [18.6 * H, 7.7, "H"], [24.8 * H, 0.5, "L"]],
             [[0, 6.9, "H"], [5.5 * H, -0.6, "L"], [12.9 * H, 5.1, "H"], [18 * H, 1.2, "L"], [25 * H, 7.0, "H"]],
             [[0, 2.0, "H"], [6 * H, 1.4, "L"], [12 * H, 3.9, "H"], [18.5 * H, 0.2, "L"], [24 * H, 3.0, "H"]]]
    for h in cases:
        for i in range(1, len(h) - 1):
            a, b = m.near_window(h, i)
            t0, v = h[i][0], h[i][1]

            def walk(step, stop):
                x = t0
                while (x + step - stop) * step <= 0:
                    lv = m.tide_level(h, x + step)[0]
                    if lv is None or abs(lv - v) > 1.0:
                        break
                    x += step
                return x
            assert abs(a - walk(-60, h[i - 1][0])) <= 60 and abs(b - walk(60, h[i + 1][0])) <= 60, (h[i], a, b)
    a, b = m.near_window(cases[0], 1)
    assert 3 * H - 600 < b - a < 3 * H + 600, "a 7 ft tide holds within a foot about 3 h (rule of twelfths)"
    assert m.near_window(cases[2], 1)[0] == cases[2][0][0], "a side under 1 ft runs to the next tide"
    assert m.near_window(cases[0], 0)[0] is None and m.near_window(cases[0], 4)[1] is None, \
        "no neighbouring tide predicted: that side is unknown, not guessed"
    assert m.r5(1000) == 900 and m.r5(1200) == 1200
    assert m.hm(time.mktime((2026, 10, 4, 23, 20, 0, 0, 0, -1))) in ("11:20p", "23:20")


@test
def t_tides_show_the_next_tides_clearly(env, srv):
    import calendar
    now = time.time()
    base = int(now // 3600) * 3600
    g = lambda t: time.strftime("%Y-%m-%d %H:%M", time.gmtime(t))
    hilo = [(base - 4 * 3600, "0.3", "L"), (base + 2 * 3600 + 1800, "7.4", "H"), (base + 8 * 3600 + 1800, "0.1", "L"),
            (base + 14 * 3600 + 1800, "6.9", "H"), (base + 21 * 3600, "-0.2", "L"), (base + 27 * 3600, "7.1", "H")]
    tides = {"predictions": [{"t": g(t), "v": v, "type": k} for t, v, k in hilo]}
    flows = [(base - 3600, 0.42, "flood"), (base + 4 * 3600, 0, "slack"), (base + 7 * 3600, -0.4, "ebb"),
             (base + 10 * 3600, 0, "slack"), (base + 13 * 3600, 0.45, "flood")]
    curr = {"current_predictions": {"units": "knots", "cp": [
        {"Type": k, "meanFloodDir": 179, "Bin": "1", "meanEbbDir": 7, "Time": g(t), "Depth": None, "Velocity_Major": v}
        for t, v, k in flows]}}
    none = {"error": {"message": "Currents predictions are not available from the requested station"}}
    _json_by_query(srv, "/coops", lambda q: tides if "product=predictions" in q else
                   none if "station=ACT0001" in q else curr if "station=ACT3496&bin=1&" in q else {})
    srv.json("/data/tides/40_-74.json", {"v": 1, "nb": 2, "s": [["8516945", "Northport, NY", 40.90, -73.35],
                                                       ["8516990", "Willets Point, NY", 40.79, -73.78],
                                                       ["BAD/ID", "x", 40.9, -73.4]],
                                         "c": [["ACT3496", "Huntington Bay, off East Fort Point", 40.9267, -73.4175, 1],
                                               ["ACT0001", "Centerport Harbor, no predictions", 40.901, -73.413, 1],
                                               ["../evil", "x", 40.9, -73.41, 1]],
                                         "b": [["44040", "Western Long Island Sound", 40.956, -73.58, now - 1200, 18.0, 0.5, 4.0, 225, 6.2, 8.0, 19.0],
                                               ["44022", "Old buoy", 40.9, -73.7, now - 9 * 3600, 17.0, 1.0, 5.0, 0, 3.0, 4.0, 15.0]]})
    e = dict(env, LPN_SITE=srv.url("/"), LPN_COOPS=srv.url("/coops"))
    out, err, rc = run(e, "tides", "-c", "40.900,-73.412", "--label", "Fleets Cove", "--plain")
    assert rc == 0, err
    flat = " ".join(out.split())                 # the terminal wraps at its width
    for want in ("Fleets Cove", "pinned", "Northport, NY \u00b7 3 mi \u00b7 NOAA 8516945", "Rising", "NEXT 24H", "TIDES",
                 "High", "7.4 ft", "Highest", "least shore showing", "Lowest", "most shore showing",
                 "MOON", "% lit", "BUOYS", "Western Long Island Sound", "water 64\u00b0F", "wind SW 12 kt",
                 "CURRENTS", "Huntington Bay, off East Fort Point", "NOAA ACT3496", "Flooding toward S", "Slack",
                 "Max ebb", "0.4 kn", "Floods toward S, ebbs toward N."):
        assert want in flat, "missing %r in:\n%s" % (want, out)
    assert re.search(r"0\.[34] kn +Flooding toward S", out), "the stream now, between max flood and slack: " + out
    assert re.search(r"Slack \d{1,2}:\d\d [AP]M[^,]*, in \d+ h", flat), "when the stream next goes slack: " + out
    assert "44040" not in flat and "KPTN6" not in flat, "buoys by place, not by code"
    assert "Centerport Harbor, no predictions" not in flat, "a station NOAA predicts nothing for gives way to the next"
    assert not any("evil" in p for p, _h in srv.seen), "a malformed ID never reaches NOAA"
    assert "Old buoy" not in flat, "a reading 9 hours old is not current"
    assert re.search(r"\d{1,2}:\d\d [AP]M +High +7\.4 ft", out), "an aligned row: time, high or low, height: " + out
    assert re.search(r"Within 1 ft of (high|low) (now, until|from) \d{1,2}:\d\d [AP]M", flat), "how long the tide holds: " + out
    assert "within 1 ft" in out and re.search(r"\d{1,2}:\d\d[ap]( \w+)?\u2013\d{1,2}:\d\d[ap]", out), "a window per tide: " + out
    assert "MLLW" in flat, "what the heights are measured from, so a low below 0 is not misread"
    rng = re.search(r"NEXT 24H +(-?\d+\.\d)\u2013(-?\d+\.\d) ft", out)
    low_ = re.search(r"Lowest .*?, (-?\d+\.\d) ft", flat)
    assert rng and low_ and rng.group(1) == low_.group(1), "the range and the lowest must agree: " + out
    assert re.search(r"High tide \d{1,2}:\d\d [AP]M[^,]*, in [12] h \d+ min", flat), "the next tide, and how long until it: " + out
    assert "Lowest" in out and "-0.2 ft" in out, "the lowest of the next 24 h, below chart datum"
    rows_ = [l for l in out.splitlines() if re.search(r"\d:\d\d [AP]M +(High|Low) ", l)]
    assert len(rows_) == 4 and sum(1 for l in rows_ if re.match(r"^  \S", l)) <= 2, \
        "the table names a day once, not on every row: %r" % rows_
    srv.json("/data/tides/40_-74.json", {"v": 1, "s": [["9999999", "Far away", 44.0, -70.0]], "b": []})
    out, err, rc = run(e, "tides", "-c", "40.900,-73.412", "--fresh", "--plain")
    assert rc == 0 and "No NOAA tide station within 60 km" in out and "MOON" in out, out
    assert "CURRENTS" not in out and "BUOYS" not in out, "an old tile says nothing it does not know: " + out
    srv.json("/data/tides/40_-74.json", {"v": 1, "nb": 0, "s": [], "b": []})
    out, err, rc = run(e, "tides", "-c", "40.900,-73.412", "--fresh", "--plain")
    assert "NDBC did not answer its last build" in " ".join(out.split()), "no readings anywhere: say whose fault: " + out
    srv.json("/data/tides/40_-74.json", {"v": 1, "nb": 900, "s": [], "b": []})
    out, err, rc = run(e, "tides", "-c", "40.900,-73.412", "--fresh", "--plain")
    assert "No buoy within 62 mi has reported in the last 3 hours" in " ".join(out.split()), out
    out, err, rc = run(dict(e, LPN_SITE=srv.url("/nothing/")), "tides", "-c", "40.900,-73.412", "--fresh", "--plain")
    assert rc == 0 and "No NOAA tide station" in out, "a missing tile means no station nearby: " + out + err


@test
def t_site_build_writes_tide_tiles(env, srv):
    now = time.time()
    srv.json("/curr", {"count": 6, "stations": [
        {"id": "ACT3496", "name": "Huntington Bay, off East Fort Point", "lat": 40.9267, "lng": -73.4175, "currbin": 2, "depth": 30.0},
        {"id": "ACT3496", "name": "Huntington Bay, off East Fort Point", "lat": 40.9267, "lng": -73.4175, "currbin": 1, "depth": 12.0},
        {"id": "ACT9001", "name": "Just over the line", "lat": 41.05, "lng": -73.5, "currbin": 1},
        {"id": "ACT0091", "name": "Eastport, Friar Roads", "lat": 44.9, "lng": -66.98333, "currbin": 1},
        {"id": "../evil", "name": "x", "lat": 40.9, "lng": -73.4, "currbin": 1},
        {"id": "ACT9002", "name": "no bin", "lat": 40.9, "lng": -73.4, "currbin": None}]})
    srv.json("/meta", {"count": 2, "stations": [
        {"id": "8516945", "name": "Northport", "state": "NY", "lat": 40.9, "lng": -73.35},
        {"id": "../evil", "name": "x", "lat": 40.9, "lng": -73.35},
        {"id": "9414290", "name": "San Francisco", "state": "CA", "lat": 37.806, "lng": -122.465}]})
    _text_route(srv, "/ndbc/activestations.xml",
                '<stations><station id="44040" lat="40.956" lon="-73.580" name="Western Long Island Sound" type="buoy"/></stations>',
                "application/xml")
    tm = time.gmtime(now - 1200)
    row = "44040  40.956 -73.580 %d %02d %02d %02d %02d 220  6.2  8.0  0.5  4  MM 210 1015.2 MM 19.0 18.0 MM MM MM" % tm[:5]
    old = time.gmtime(now - 10 * 3600)
    row2 = "44022  40.900 -73.700 %d %02d %02d %02d %02d 220  3.0  4.0  1.0  5  MM 210 1015.2 MM 15.0 17.0 MM MM MM" % old[:5]
    _text_route(srv, "/ndbc/data/latest_obs/latest_obs.txt",
                "#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD  GST WVHT  DPD  APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE\n"
                "#text      deg      deg   yr mo day hr mn degT  m/s  m/s    m   sec  sec degT   hPa   hPa  degC  degC  degC  nmi     ft\n"
                + row + "\n" + row2 + "\n")
    tmp = tempfile.mkdtemp()
    try:
        fl = os.path.join(tmp, "feeds.json")
        json.dump([], io.open(fl, "w"))
        out = os.path.join(tmp, "site")
        r = subprocess.run([sys.executable, os.path.join(WEB, "build_digest.py"), out], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           env=dict(env, LPN_WEB_FEEDS=fl, LPN_TIDE_META=srv.url("/meta"), LPN_NDBC=srv.url("/ndbc"),
                                    LPN_CURR_META=srv.url("/curr"), LPN_READER_URL="https://lpn-reader.x.workers.dev"), timeout=120)
        assert r.returncode == 0, r.stderr.decode()[-600:]
        assert "tides: 2 stations, 1 buoy readings, 3 current stations" in r.stdout.decode(), r.stdout.decode()
        tile = json.load(io.open(os.path.join(out, "data", "tides", "40_-74.json"), encoding="utf-8"))
        assert [s[0] for s in tile["s"]] == ["8516945"] and tile["s"][0][1] == "Northport, NY", tile["s"]
        b = tile["b"][0]
        assert b[:2] == ["44040", "Western Long Island Sound"] and b[5] == 18.0 and b[6] == 0.5 and b[9] == 6.2, b
        assert abs(b[4] - (now - 1200)) < 120, "the reading's time, from NDBC's columns (month and minute share a name)"
        assert tile["reader"] == "https://lpn-reader.x.workers.dev"
        assert tile["nb"] == 1, "how many buoy readings the whole build has: 0 would mean NDBC failed"
        assert [c[0] for c in tile["c"]] == ["ACT3496", "ACT9001"], tile["c"]
        assert tile["c"][0][4] == 1, "the shallowest bin: NOAA's own bin numbers, never a guess"
        far = json.load(io.open(os.path.join(out, "data", "tides", "39_-75.json"), encoding="utf-8"))
        assert not far["c"], "a current station is listed only near its own water, not 100 km out"
        for k in ("39_-75", "41_-73", "40_-73"):           # its neighbours list it too: a spot near a tile edge finds it
            assert os.path.exists(os.path.join(out, "data", "tides", k + ".json")), k
        assert os.path.exists(os.path.join(out, "data", "tides", "37_-123.json"))
        r = subprocess.run([sys.executable, os.path.join(WEB, "build_digest.py"), out + "2"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           env=dict(env, LPN_WEB_FEEDS=fl, LPN_TIDE_META=NOWHERE, LPN_NDBC=NOWHERE), timeout=120)
        assert r.returncode == 0, "sources down must not stop the news: " + r.stderr.decode()[-300:]
        assert os.path.exists(os.path.join(out + "2", "data", "tides", "40_-74.json")), "the cached station list carries on"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_previews_end_at_a_word_and_keep_the_whole_text(env, srv):
    m = load()
    assert m.preview("short", 400) == "short"
    p = m.preview("word " * 200, 50)
    assert p.endswith("\u2026") and len(p) <= 50 and "wor\u2026" not in p, repr(p)
    assert m.preview("x" * 500, 50) == "x" * 49 + "\u2026", "one long word is cut, still marked"
    body = "Abstract sentence number one is here. " * 13          # ~500 characters: just over the preview
    recs = m.parse_feed(("<rss><channel>%s</channel></rss>" % item("T", body=body)).encode())
    assert recs[0]["s"].endswith("\u2026") and recs[0]["c"] == body.strip(), "a 400-600 character text must be kept whole"


@test
def t_web_build_is_small_safe_and_honest(env, srv):
    feeds = []
    for i in range(4):
        srv.feed("/w%d" % i, [item("Story %d-%d about the council" % (i, j), when="2026-10-04T%02d:00:00Z" % (j % 24),
                                   body="summary " * 80) for j in range(40)])
        feeds.append({"id": "w%d" % i, "name": "Feed %d" % i, "url": srv.url("/w%d" % i), "cats": ["top"]})
    srv.feed("/evil", [item("Evil \x1b[2J story", body="x", link="javascript:alert(1)")])
    feeds += [{"id": "evil", "name": "Evil", "url": srv.url("/evil"), "cats": ["health"]},
              {"id": "dead", "name": "Dead feed", "url": NOWHERE + "/dead", "cats": ["health"]},
              {"id": "lpn", "name": "Releases", "url": srv.url("/w0"), "cats": ["app"]}]
    tmp = tempfile.mkdtemp()
    try:
        fl = os.path.join(tmp, "feeds.json")
        json.dump(feeds, io.open(fl, "w"))
        out = os.path.join(tmp, "site")
        r = subprocess.run([sys.executable, os.path.join(WEB, "build_digest.py"), out], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=dict(env, LPN_WEB_FEEDS=fl,
                                                            LPN_READER_URL="https://lpn-reader.x.workers.dev"), timeout=120)
        assert r.returncode == 0, r.stderr[-400:]
        top = json.load(io.open(os.path.join(out, "data", "top.json"), encoding="utf-8"))
        assert len(top["items"]) == 60 and top["v"] == 1 and top["app"] == load().VERSION
        assert len(gzip.compress(io.open(os.path.join(out, "data", "top.json"), "rb").read())) < 20000
        assert not os.path.exists(os.path.join(out, "data", "app.json")), "release notes are not for the web app"
        health = json.load(io.open(os.path.join(out, "data", "health.json"), encoding="utf-8"))
        evil = health["items"][0]
        assert evil[3] == "" and "\x1b" not in evil[1], "a hostile story reached the web data: %r" % evil
        assert ["Dead feed", -1] in health["failed"], "a dead feed must be named, not silently dropped"
        assert top["reader"] == "https://lpn-reader.x.workers.dev"
        probe = ("import importlib.util as u; s = u.spec_from_file_location('b', %r); m = u.module_from_spec(s); "
                 "s.loader.exec_module(m); print(repr(m.READER))" % os.path.join(WEB, "build_digest.py"))
        for bad, want in (("javascript:alert(1)", "''"), ("http://plain.example", "''"),
                          ('https://x" onload="', "''"), ("https://ok.workers.dev", "'https://ok.workers.dev'")):
            r2 = subprocess.run([sys.executable, "-c", probe], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=dict(env, LPN_READER_URL=bad))
            assert r2.stdout.decode().strip() == want, "reader address %r gave %r %s" % (
                bad, r2.stdout.decode().strip(), r2.stderr.decode()[-200:])
        for f in ("index.html", "app.js", "core.js", "sw.js", "manifest.webmanifest", "icon-180.png"):
            assert os.path.exists(os.path.join(out, f)), f
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_web_files_are_consistent(env, srv):
    st = os.path.join(WEB, "static")
    sw = io.open(os.path.join(st, "sw.js"), encoding="utf-8").read()
    listed = [f for k in ("CORE", "EXTRA")                      # required files, then optional ones
              for f in re.findall(r'"\./([^"]*)"', sw[sw.index(k + " = ["):sw.index("];", sw.index(k + " = ["))])]
    for f in listed:
        assert f == "" or os.path.exists(os.path.join(st, f)), "the service worker caches a missing file: " + f
    assert "export" not in sw.split("\n")[0:3] and not re.search(r"^(export|import) ", sw, re.M), \
        "sw.js must be a plain script: module service workers fail in some browsers"
    man = json.load(io.open(os.path.join(st, "manifest.webmanifest"), encoding="utf-8"))
    for ic in man["icons"]:
        assert io.open(os.path.join(st, ic["src"]), "rb").read(8) == b"\x89PNG\r\n\x1a\n", ic["src"]
    html = io.open(os.path.join(st, "index.html"), encoding="utf-8").read()
    for need in ('type="module" src="app.js"', 'rel="manifest"', 'rel="apple-touch-icon"', "viewport-fit=cover"):
        assert need in html, need
    v = load().VERSION
    for p, rx in (("src/core.ts", r'APP_VERSION = "([^"]+)"'), ("static/core.js", r'APP_VERSION = "([^"]+)"'),
                  ("src/sw.ts", r'const VERSION = "([^"]+)"'), ("static/sw.js", r'const VERSION = "([^"]+)"'),
                  ("reader/reader.ts", r'const VERSION = "([^"]+)"'), ("reader/reader.js", r'const VERSION = "([^"]+)"')):
        m_ = re.search(rx, io.open(os.path.join(WEB, p), encoding="utf-8").read())
        assert m_ and m_.group(1) == v, "%s says %s, news says %s" % (p, m_ and m_.group(1), v)


@test
def t_web_logic_tests_pass(env, srv):
    node = shutil.which("node")
    if not node:
        raise Skip("needs Node.js for the web app's logic tests (they also run on GitHub)")
    for t_ in ("core.test.mjs", "reader.test.mjs", "sw.test.mjs"):
        r = subprocess.run([node, os.path.join(WEB, "test", t_)], stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, timeout=90)
        assert r.returncode == 0, t_ + ": " + r.stdout.decode("utf-8", "replace")[-600:]


@test
def t_sync_takes_the_web_archive_only_when_it_matches(env, srv):
    import tarfile
    tmp = tempfile.mkdtemp()
    try:
        dl, repo, pre = (os.path.join(tmp, x) for x in ("dl", "repo", "usr"))
        for d_ in (dl, repo, os.path.join(pre, "bin")):
            os.makedirs(d_)

        def tarball(name, files):
            with tarfile.open(os.path.join(dl, name), "w:gz") as tf:
                for arc, body in files.items():
                    data = body.encode("utf-8")
                    ti = tarfile.TarInfo(arc); ti.size = len(data); ti.mode = 0o755
                    tf.addfile(ti, io.BytesIO(data))
        news99 = re.sub(r'^VERSION = "[^"]+"', 'VERSION = "99.0"', io.open(NEWS, encoding="utf-8").read(), count=1, flags=re.M)
        tarball("lowpingnews-v99.0.tar.gz", {"news": news99,
                                             "lowpingnews": io.open(os.path.join(HERE, "lowpingnews")).read()})
        tarball("lowpingnews-web-v98.0.tar.gz", {"web/src/core.ts": 'export const APP_VERSION = "98.0";\n',
                                                 "web/OLD": "stale\n"})
        tarball("lowpingnews-web-v99.0.tar.gz", {"web/src/core.ts": 'export const APP_VERSION = "99.0";\n',
                                                 ".github/workflows/web.yml": "name: web\n"})
        tarball("lowpingnews-web-v99.1.tar.gz", {"web/src/core.ts": 'export const APP_VERSION = "99.0";\n',
                                                 "etc/passwd": "no\n"})
        e = dict(env, LPN_DOWNLOADS=dl, LPN_REPO=repo, PREFIX=pre, HOME=tmp)
        r = subprocess.run(["sh", os.path.join(HERE, "lowpingnews"), "sync"], stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, env=e, timeout=120)
        out = r.stdout.decode("utf-8", "replace")
        assert io.open(os.path.join(repo, "web", "src", "core.ts")).read().count("99.0"), out
        assert os.path.exists(os.path.join(repo, ".github", "workflows", "web.yml")), out
        assert not os.path.exists(os.path.join(repo, "web", "OLD")), "a web archive for another version was used"
        assert not os.path.exists(os.path.join(repo, "etc")), "an archive with stray paths was used"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class _FakeCloudflare:
    """Just enough of api.cloudflare.com to deploy a Worker: GET, PUT, POST."""
    def __init__(self, good="T" * 40, refuse=False):
        import http.server, socketserver, threading
        outer, self.good, self.refuse, self.uploads, self.calls = self, good, refuse, [], []

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _reply(self, obj):
                b = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def _any(self):
                outer.calls.append((self.command, self.path))
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                if self.headers.get("Authorization") != "Bearer " + outer.good:
                    return self._reply({"success": False, "errors": [{"message": "Invalid API Token"}]})
                p = self.path.split("?")[0]
                if p.endswith("/user/tokens/verify"):
                    return self._reply({"success": True})
                if p.endswith("/accounts"):
                    return self._reply({"success": True, "result": [{"id": "acct0123abcd"}]})
                if p.endswith("/workers/scripts/lowpingnews-reader") and self.command == "PUT":
                    outer.uploads.append((dict(self.headers), body))
                    if outer.refuse:
                        return self._reply({"success": False, "errors": [{"message": "Script too large"}]})
                    return self._reply({"success": True})
                if p.endswith("/subdomain") and self.command == "POST":
                    return self._reply({"success": True})
                if p.endswith("/accounts/acct0123abcd/workers/subdomain"):
                    return self._reply({"success": True, "result": {"subdomain": "sebastian"}})
                self._reply({"success": False, "errors": [{"message": "unexpected " + p}]})
            do_GET = do_PUT = do_POST = _any

        class TS(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True
        self.httpd = TS(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.api = "http://127.0.0.1:%d/client/v4" % self.httpd.server_address[1]


@test
def t_the_reader_deploys_from_the_terminal(env, srv):
    tmp = tempfile.mkdtemp()
    try:
        repo = os.path.join(tmp, "repo")                 # no .git: can never touch a real repository
        os.makedirs(os.path.join(repo, "web", "reader"))
        reader = os.path.join(WEB, "reader", "reader.js")
        shutil.copy(reader, os.path.join(repo, "web", "reader", "reader.js"))
        rv = re.search(r'const VERSION = "([^"]+)"', io.open(reader).read()).group(1)
        cf = _FakeCloudflare()
        base = dict(env, LPN_REPO=repo, LPN_CF_API=cf.api, XDG_CONFIG_HOME=os.path.join(tmp, "cfg"),
                    LPN_CF_VERIFY_TRIES="0", HOME=tmp)

        def deploy(**extra):
            r = subprocess.run(["sh", os.path.join(HERE, "lowpingnews"), "reader", "deploy"], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=dict(base, **extra), timeout=60)
            return r.returncode, r.stdout.decode("utf-8", "replace")
        rc, out = deploy(CLOUDFLARE_API_TOKEN="not a token!")
        assert rc != 0 and "does not look like" in out and not cf.uploads, out
        rc, out = deploy(CLOUDFLARE_API_TOKEN="X" * 40)
        assert rc != 0 and "did not accept" in out and not cf.uploads, out
        rc, out = deploy()
        assert rc != 0 and "in a terminal once" in out, "no token and no terminal: say how, do not hang"
        rc, out = deploy(CLOUDFLARE_API_TOKEN="T" * 40)
        assert rc == 0, out
        assert "reader v%s uploaded to https://lowpingnews-reader.sebastian.workers.dev" % rv in out, out
        hdrs, body = cf.uploads[-1]
        assert hdrs.get("Content-Type", "").startswith("multipart/form-data")
        assert b'name="metadata"' in body and b'"main_module":"reader.js"' in body
        assert b'name="reader.js"' in body and b"application/javascript+module" in body
        assert io.open(reader, "rb").read() in body, "the reader was not uploaded whole"
        state = os.path.join(tmp, "cfg", "lowpingnews", "reader-deployed")
        assert os.path.exists(state), "the deployed version should be remembered"
        cf.refuse = True
        rc, out = deploy(CLOUDFLARE_API_TOKEN="T" * 40)
        assert rc != 0 and "refused the upload: Script too large" in out, out
        # the first real run: the token pasted at a hidden prompt, then remembered
        import pty, select, stat
        cf.refuse = False
        shutil.rmtree(os.path.join(tmp, "cfg"), ignore_errors=True)
        pid, fd = pty.fork()
        if pid == 0:
            os.environ.update(base)
            os.execvp("sh", ["sh", os.path.join(HERE, "lowpingnews"), "reader", "deploy"])
        seen = _read_until(fd, lambda b: b"token (hidden):" in b, most=20.0)
        os.write(fd, ("T" * 40 + "\n").encode())
        seen += _read_until(fd, lambda b: b"uploaded" in b or b"lowpingnews:" in b, most=30.0)
        try:
            os.waitpid(pid, 0)
        except Exception:
            pass
        assert b"uploaded" in seen and b"T" * 40 not in seen, "the token must not be echoed: %r" % seen[-300:]
        tf = os.path.join(tmp, "cfg", "lowpingnews", "cloudflare-token")
        assert stat.S_IMODE(os.stat(tf).st_mode) == 0o600, "the token file must be readable only by its owner"
        n = len(cf.uploads)
        rc, out = deploy()                                  # no token given: the saved one is used
        assert rc == 0 and len(cf.uploads) == n + 1 and "token (hidden)" not in out, out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test
def t_version_is_consistent(env, srv):
    m = load()
    out, _, _ = run(env, "--version")
    assert m.VERSION in out, "--version disagrees with the VERSION constant"
    readme = io.open(os.path.join(HERE, "README.md"), encoding="utf-8").read()
    assert "lowpingnews" in readme.lower()


if __name__ == "__main__" and _CHILD:
    sys.exit(1 if FAILED else 0)                    # the parent prints the summary
if __name__ == "__main__":
    print("LowPingNews tests")
    print("  %d run, %d failed%s" % (RAN, len(FAILED),
                                      (", %d skipped" % len(SKIPPED)) if SKIPPED else ""))
    if FAILED:
        print("  failing: " + ", ".join(FAILED))
    sys.exit(1 if FAILED else 0)
