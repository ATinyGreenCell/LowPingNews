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


def _drive_tui(env, keys, rows=24, cols=64, settle=0.7):
    """Run the curses interface on a pty and feed it real keystrokes."""
    import fcntl, pty, select, struct, termios
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execv(NEWS, ["news", "--tui"])
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
