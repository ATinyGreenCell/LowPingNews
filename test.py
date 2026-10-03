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
    # no ping meter unless a test asks for one: it probes real anycast hosts
    env["LPN_NO_PING"] = "1"
    # what Termux sets; the host's own TERM (here "linux") would test a
    # different terminal - no alternate screen, another mouse encoding
    env["TERM"] = "xterm-256color"
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


def _drive_tui(env, keys, rows=24, cols=64, settle=0.7, args=("--tui",), raw=False):
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
    if raw:
        return buf.decode("utf-8", "replace")
    txt = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", buf.decode("utf-8", "replace"))
    return txt.replace("\r", "").replace("\x0f", "")


NOWHERE = "http://127.0.0.1:9"       # closed: refused instantly, never leaves the machine


def item(title, when=None, body="Summary text.", link=NOWHERE + "/a"):
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


@test
def t_titles_scroll_sideways_with_either_arrow_encoding(env, srv):
    long_ = ("Researchers engineer a stable blue anthocyanin pigment in petunia "
             "flowers using a bacterial enzyme pathway")
    srv.feed("/f", [item(long_)])
    sources(env, [{"id": "a", "name": "bioRxiv plant", "kind": "rss", "cats": ["top"],
                   "url": srv.url("/f")}])
    e = dict(env); e["LPN_NO_PING"] = "1"
    for seq in (b"\x1bOC", b"\x1b[C", b"l"):
        out = _drive_tui(e, [seq, b"q"], cols=48)
        assert "\u00abngineer" in out, "%r did not scroll the titles" % seq
    out = _drive_tui(e, [b"\x1b[5~", b"\x1b[Z", b"j", b"q"], cols=48)
    assert "j/k" in out and "Traceback" not in out


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
