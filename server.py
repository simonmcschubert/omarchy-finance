#!/usr/bin/env python3
"""Finance: serves the web app and saves its data file.

Listens on 127.0.0.1 only. The data lives in one JSON file,
~/.local/state/omarchy-finance/finance.json, in a directory only the owner
can open. The page's colors come from the current Omarchy theme. New
releases come from the update script next to this file.

Python standard library only (3.11 or newer).
"""

import argparse
import hashlib
import http.server
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
from pathlib import Path

PORT = 47219
APP_DIR = Path(__file__).resolve().parent / "app"
UPDATE_SCRIPT = Path(__file__).resolve().parent / "update"
MAX_BODY = 10 * 1024 * 1024
NO_FILE = "none"
VERSION = 2  # data file version; matches VERSION in app/finance.mjs
NO_BODY = object()  # read_json found none it accepts, and said so

# Seconds: the first check for a release after the server starts, and then.
FIRST_CHECK = 15
CHECK_EVERY = 4 * 60 * 60
# The install restarts omarchy-finance.service, so it runs as a unit of its own.
INSTALL_UNIT = "omarchy-finance-update"

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.mjs": ("app.mjs", "text/javascript; charset=utf-8"),
    "/finance.mjs": ("finance.mjs", "text/javascript; charset=utf-8"),
    "/chart.mjs": ("chart.mjs", "text/javascript; charset=utf-8"),
    "/update.mjs": ("update.mjs", "text/javascript; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
}

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)

# Tokyo Night, Omarchy's default theme: used when no theme file is found.
DEFAULT_THEME = {
    "background": "#1a1b26",
    "lighter_background": "#24283b",
    "dark_background": "#13141c",
    "foreground": "#a9b1d6",
    "bright_foreground": "#c0caf5",
    "dark_foreground": "#565f89",
    "muted": "#414868",
    "selection": "#292e42",
    "accent": "#7aa2f7",
    "red": "#f7768e",
    "green": "#9ece6a",
    "yellow": "#e0af68",
}

# CSS variable -> colors.toml keys to try, in order. The fallbacks follow
# omarchy-theme-color: canonical names, legacy short names, ANSI colors.
THEME_VARIABLES = {
    "bg": ["background", "bg", "color0"],
    "surface": ["lighter_background", "lighter_bg", "background", "bg", "color0"],
    "sunken": ["dark_background", "dark_bg", "background", "bg", "color0"],
    "fg": ["foreground", "fg", "color7"],
    "fg-strong": ["bright_foreground", "bright_fg", "color15", "foreground", "fg", "color7"],
    "fg-muted": ["dark_foreground", "dark_fg", "color8", "foreground", "fg", "color7"],
    "border": ["muted", "color8", "dark_foreground", "dark_fg"],
    "selection": ["selection", "selection_background", "color8"],
    "accent": ["accent", "blue", "color4"],
    "red": ["red", "color1"],
    "green": ["green", "color2"],
    "yellow": ["yellow", "color3"],
}

HEX_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


def state_dir():
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "omarchy-finance"


def theme_file():
    return Path.home() / ".local" / "state" / "omarchy" / "current" / "theme" / "colors.toml"


def update_log():
    base = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return Path(base) / "omarchy-finance-update.log"


def revision_of(data):
    return NO_FILE if data is None else hashlib.sha256(data).hexdigest()


def read_file(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def write_atomic(path, data):
    """Writes data to path so a crash leaves the old file or the new one."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".finance-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    dir_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def luminance_is_light(color):
    value = color.lstrip("#")
    if len(value) == 3:
        value = "".join(c * 2 for c in value)
    r, g, b = (int(value[i : i + 2], 16) for i in (0, 2, 4))
    return r + g + b > 382


def theme_css(path):
    """CSS variables from an Omarchy colors.toml; defaults for anything missing."""
    colors = {}
    try:
        with open(path, "rb") as f:
            colors = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError):
        colors = {}

    def pick(keys):
        for key in keys:
            value = colors.get(key)
            if isinstance(value, str) and HEX_COLOR.match(value.strip()):
                return value.strip()
        return None

    lines = []
    for variable, keys in THEME_VARIABLES.items():
        lines.append(f"  --{variable}: {pick(keys) or DEFAULT_THEME[keys[0]]};")

    mode = str(colors.get("mode") or colors.get("theme_type") or "").lower()
    if mode not in ("light", "dark"):
        if (Path(path).parent / "light.mode").exists():
            mode = "light"
        else:
            background = pick(THEME_VARIABLES["bg"])
            mode = "light" if background and luminance_is_light(background) else "dark"
    lines.append(f"  color-scheme: {mode};")
    return ":root {\n" + "\n".join(lines) + "\n}\n"


def reason(output):
    """The update script's reason for failing: its last line, after git's."""
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return lines[-1].removeprefix("update: ") if lines else ""


class Updater:
    """Offers new releases of Finance the way a desktop app offers its
    updates: it checks shortly after the server starts, every four hours, and
    when the update button asks; it downloads a release when asked, and
    installs it with a restart of the server. The update script does the
    work; the page shows the state (app/update.mjs)."""

    def __init__(self, script, log):
        self.script = Path(script)
        self.log = Path(log)  # what the install unit writes
        # Tells the page that the server restarted, after an install.
        self.boot = secrets.token_hex(8)
        self.lock = threading.Lock()  # guards the fields below
        self.work = threading.Lock()  # one run of the script at a time
        # "": nothing to offer (up to date, not checked yet, offline, or no
        # git checkout). Otherwise available, downloading, downloaded,
        # installing, or failed (download or install; error says why).
        self.status = ""
        self.version = ""
        self.error = ""
        self.checking = False
        ok, out, _ = self.run("version")
        # The installed release: "" before the first or without a checkout.
        self.installed = out.strip() if ok else ""

    def run(self, *args, timeout=60):
        """(ok, stdout, reason) of a run of the update script."""
        try:
            result = subprocess.run(
                [str(self.script), *args], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout
            )
        except subprocess.TimeoutExpired:
            return False, "", f"the update script did not finish within {timeout} seconds"
        except OSError as error:
            return False, "", f"can't run {self.script}: {error.strerror}"
        if result.returncode != 0:
            return False, result.stdout, reason(result.stderr) or "the update script failed"
        return True, result.stdout, ""

    def snapshot(self):
        with self.lock:
            return {
                "status": self.status,
                "version": self.version,
                "error": self.error,
                "installed": self.installed,
                "checking": self.checking,
                "boot": self.boot,
            }

    def start(self):
        def checks():
            time.sleep(FIRST_CHECK)
            while True:
                self.check()
                time.sleep(CHECK_EVERY)

        threading.Thread(target=checks, daemon=True).start()

    def check(self, asked=False):
        """Looks for a newer release. Returns why the check failed, or "".
        A check on the timer keeps what an earlier one found when it fails
        (offline is no reason to hide a release), and leaves a failed update
        on show until the button is clicked."""
        with self.lock:
            if self.status == "installing" or (self.status == "failed" and not asked):
                return ""
        with self.work:
            with self.lock:
                self.checking = True
            ok, out, why = self.run("check")
            with self.lock:
                self.checking = False
                if not ok:
                    sys.stderr.write(f"update check failed: {why}\n")
                    return why
                if self.status in ("downloading", "installing"):
                    return ""  # what those find comes next
                words = out.split()
                if len(words) == 2 and words[0] in ("available", "downloaded"):
                    self.status, self.version = words
                else:
                    self.status, self.version = "", ""
                self.error = ""
        return ""

    def download(self):
        with self.lock:
            if self.status not in ("available", "failed") or not self.version:
                return
            self.status, self.error = "downloading", ""
            version = self.version
        with self.work:
            ok, _, why = self.run("download", version, timeout=180)
        with self.lock:
            self.status = "downloaded" if ok else "failed"
            self.error = why

    def install(self):
        with self.lock:
            if self.status != "downloaded":
                return
            self.status, self.error = "installing", ""
            version = self.version
        threading.Thread(target=self.wait_for_install, args=(version,), daemon=True).start()

    def install_command(self, version):
        # --wait: it ends when the update script does. The log keeps what the
        # script says, as nothing here may be left to read it.
        return [
            "systemd-run", "--user", "--wait", "--quiet", "--collect", f"--unit={INSTALL_UNIT}",
            f"--property=StandardOutput=truncate:{self.log}", "--",
            str(self.script), "install", version,
        ]  # fmt: skip

    def wait_for_install(self, version):
        with self.work:
            self.log.unlink(missing_ok=True)
            try:
                result = subprocess.run(
                    self.install_command(version), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=600
                )
                ok, why = result.returncode == 0, reason(result.stderr)
            except subprocess.TimeoutExpired:
                ok, why = False, "the update did not finish within 10 minutes"
            except OSError as error:
                ok, why = False, f"can't start the update: {error.strerror}"
            try:
                why = reason(self.log.read_text()) or why
            except OSError:
                pass  # systemd-run did not start the script
        # A successful install restarts this server, so it is still here
        # only when the install failed, or when it restarted the service
        # while this is another server (./server.py from the same checkout).
        with self.lock:
            if ok:
                self.status, self.version = "", ""
            else:
                self.status, self.error = "failed", why or "the update script failed"
        if ok:
            self.check()


class FinanceServer(http.server.ThreadingHTTPServer):
    """A thread per connection, so an idle browser connection blocks nothing.
    Saves hold a lock, so they never overlap."""

    daemon_threads = True

    def __init__(self, port, data_file, theme_path, updater=None):
        self.data_file = Path(data_file)
        self.theme_path = Path(theme_path)
        self.updater = updater
        self.lock = threading.Lock()
        super().__init__(("127.0.0.1", port), Handler)
        bound = self.server_address[1]
        self.hosts = {f"127.0.0.1:{bound}", f"localhost:{bound}"}
        self.origins = {f"http://{host}" for host in self.hosts}


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "Finance"
    sys_version = ""
    timeout = 30  # seconds; drops connections that never send a request

    def log_message(self, format, *args):
        pass  # no access log; errors go to stderr through log_error

    def log_error(self, format, *args):
        sys.stderr.write("%s\n" % (format % args))

    def send_body(self, status, body, content_type, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_body(status, body, "application/json; charset=utf-8")

    def allowed(self):
        # The Host check stops other websites from reaching this server
        # through DNS rebinding; the Origin check stops cross-site writes.
        if self.headers.get("Host") not in self.server.hosts:
            self.send_json(403, {"error": "Unknown host"})
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in self.server.origins:
            self.send_json(403, {"error": "Unknown origin"})
            return False
        return True

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.allowed():
            return
        path = self.path.split("?", 1)[0]
        if path == "/api/data":
            self.get_data()
        elif path == "/api/update" and self.server.updater:
            self.send_json(200, self.server.updater.snapshot())
        elif path == "/theme.css":
            body = theme_css(self.server.theme_path).encode()
            self.send_body(200, body, "text/css; charset=utf-8")
        elif path in STATIC:
            name, content_type = STATIC[path]
            body = (APP_DIR / name).read_bytes()
            extra = {"Content-Security-Policy": CSP} if name.endswith(".html") else None
            self.send_body(200, body, content_type, extra)
        else:
            self.send_json(404, {"error": "Not found"})

    def current(self):
        """The file as GET returns it: revision, data, and error if unreadable."""
        raw = read_file(self.server.data_file)
        result = {"revision": revision_of(raw), "file": str(self.server.data_file), "data": None}
        if raw is not None:
            try:
                result["data"] = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                result["error"] = f"The data file is not valid JSON ({error})"
        return result

    def get_data(self):
        self.send_json(200, self.current())

    def read_json(self):
        """The request's JSON body, or NO_BODY after replying with the problem.
        Only JSON: a web page cannot send that to another site without the
        browser asking this server first, which it never allows."""
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "Send JSON"})
            return NO_BODY
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json(411, {"error": "Content-Length required"})
            return NO_BODY
        if length < 0 or length > MAX_BODY:
            self.send_json(413, {"error": "Too large"})
            return NO_BODY
        try:
            return json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
            return NO_BODY

    def do_POST(self):
        if not self.allowed():
            return
        updater = self.server.updater
        if self.path.split("?", 1)[0] != "/api/update" or not updater:
            self.send_json(404, {"error": "Not found"})
            return
        body = self.read_json()
        if body is NO_BODY:
            return
        action = body.get("action") if isinstance(body, dict) else None
        if action == "check":
            why = updater.check(asked=True)
            self.send_json(200, {**updater.snapshot(), "checkError": why})
        elif action == "download":
            updater.download()
            self.send_json(200, updater.snapshot())
        elif action == "install":
            updater.install()
            self.send_json(200, updater.snapshot())
        else:
            self.send_json(400, {"error": "Expected {action: check, download or install}"})

    def do_PUT(self):
        if not self.allowed():
            return
        if self.path.split("?", 1)[0] != "/api/data":
            self.send_json(404, {"error": "Not found"})
            return
        body = self.read_json()
        if body is NO_BODY:
            return
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, dict) or data.get("version") != VERSION:
            # Also refuses a window still running an older version of the page.
            self.send_json(400, {"error": f"Expected {{revision, data}} with data.version {VERSION}; reload the page"})
            return

        out = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode()
        with self.server.lock:
            current = self.current()
            if body.get("revision") != current["revision"] or "error" in current:
                # Another window saved first, or the file was edited by hand.
                # Same shape as GET, so the page can show the latest.
                status, reply = 409, {**current, "conflict": True}
            else:
                try:
                    write_atomic(self.server.data_file, out)
                    status, reply = 200, {"revision": revision_of(out)}
                except OSError as error:
                    self.log_error("save failed: %s", error)
                    status, reply = 500, {"error": f"Could not save: {error.strerror}"}
        self.send_json(status, reply)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--data", default=None, help="data file (default: %(default)s)")
    args = parser.parse_args()
    data_file = Path(args.data) if args.data else state_dir() / "finance.json"
    updater = Updater(UPDATE_SCRIPT, update_log())
    try:
        server = FinanceServer(args.port, data_file, theme_file(), updater)
    except OSError as error:
        sys.exit(f"finance: cannot listen on 127.0.0.1:{args.port}: {error.strerror}")
    updater.start()
    print(f"Finance on http://127.0.0.1:{server.server_address[1]}/ (data: {data_file})", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
