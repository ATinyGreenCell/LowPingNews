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


def _drive_tui(env, keys, rows=24, cols=64, settle=0.7, args=("--tui",)):
    """Run the curses interface on a pty and feed it real keystrokes."""
    import fcntl, pty, select, struct, termios
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.environ.setdefault("TERM", "xterm-256color")
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
    buf += pump(2.0)
    for k in keys:
        try:
            os.write(fd, k)
        except OSError:
            break
        buf += pump(settle)
    try:
        os.close(fd)
    except Exception:
        pass
    try:
        os.waitpid(pid, os.WNOHANG)
    except Exception:
        pass
    txt = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", buf.decode("utf-8", "replace"))
    return txt.replace("\r", "").replace("\x0f", "")


def item(title, when=None, body="Summary text.", link="http://example.invalid/a"):
    d = "<dc:date>%s</dc:date>" % when if when else ""
    return ("<item><title>%s</title><link>%s</link>"
            "<description>%s</description>%s</item>" % (title, link, body, d))


def test(fn):
    name = fn.__name__[2:]
    if len(sys.argv) > 1 and sys.argv[1] not in name:
        return fn
    global RAN
    RAN += 1
    d = None
    try:
        d, env = sandbox()
        fn(env, Server())
        sys.stdout.write("  ok    %s\n" % name)
    except AssertionError as e:
        FAILED.append(name)
        sys.stdout.write("  FAIL  %s\n        %s\n" % (name, e))
    except Exception as e:
        FAILED.append(name)
        sys.stdout.write("  ERROR %s\n        %s: %s\n" % (name, type(e).__name__, e))
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
    assert m.WMO[m.worst([75, 80])][0] == "Heavy snow"
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
        assert "g18" in out, "gusts well above mean wind should be shown"
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
    out = _drive_tui(env, [b"j", b"j", b"k", b"\r", b"s", b"n", b" ", b"q"])
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
    time.sleep(0.6)
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
    tui = lambda o: "j/k move" in o
    assert tui(_drive_tui(e, [b"q"], args=())), "bare `news` did not open the TUI"
    assert not tui(_drive_tui(e, [b"q"], args=("-t",))), "-t should keep list output"
    assert not tui(_drive_tui(e, [b"q"], args=("--plain",))), "--plain ignored"
    d = dict(e); d["TERM"] = "dumb"
    assert not tui(_drive_tui(d, [b"q"], args=())), "TUI on a dumb terminal"
    out, _, _ = run(env)                               # piped
    assert "j/k move" not in out and out.strip(), "a pipe got the TUI"


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
    out = _drive_tui(e, [b"q"], cols=80)
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
    pump(2.0)
    mark = len(buf[0])
    ver[0] = ["Evening edition %d" % i for i in range(3)] + ver[0]
    pump(6.0)
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
    pump(4.0)
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


@test
def t_version_is_consistent(env, srv):
    m = load()
    out, _, _ = run(env, "--version")
    assert m.VERSION in out, "--version disagrees with the VERSION constant"
    readme = io.open(os.path.join(HERE, "README.md"), encoding="utf-8").read()
    assert "lowpingnews" in readme.lower()


if __name__ == "__main__":
    print("LowPingNews tests")
    print("  %d run, %d failed" % (RAN, len(FAILED)))
    if FAILED:
        print("  failing: " + ", ".join(FAILED))
    sys.exit(1 if FAILED else 0)
