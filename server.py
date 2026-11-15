#!/usr/bin/env python3
"""Finance: serves the web app and saves its data file.

Listens on 127.0.0.1 only. The data lives in one JSON file,
~/.local/state/omarchy-finance/finance.json, in a directory only the owner
can open. The page's colors come from the current Omarchy theme.

Python standard library only (3.11 or newer).
"""

import argparse
import hashlib
import http.server
import json
import os
import re
import sys
import tempfile
import threading
import tomllib
from pathlib import Path

PORT = 47219
APP_DIR = Path(__file__).resolve().parent / "app"
MAX_BODY = 10 * 1024 * 1024
NO_FILE = "none"

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.mjs": ("app.mjs", "text/javascript; charset=utf-8"),
    "/finance.mjs": ("finance.mjs", "text/javascript; charset=utf-8"),
    "/chart.mjs": ("chart.mjs", "text/javascript; charset=utf-8"),
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


class FinanceServer(http.server.ThreadingHTTPServer):
    """A thread per connection, so an idle browser connection blocks nothing.
    Saves hold a lock, so they never overlap."""

    daemon_threads = True

    def __init__(self, port, data_file, theme_path):
        self.data_file = Path(data_file)
        self.theme_path = Path(theme_path)
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

    def do_PUT(self):
        if not self.allowed():
            return
        if self.path.split("?", 1)[0] != "/api/data":
            self.send_json(404, {"error": "Not found"})
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "Send JSON"})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json(411, {"error": "Content-Length required"})
            return
        if length < 0 or length > MAX_BODY:
            self.send_json(413, {"error": "Too large"})
            return
        try:
            body = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
            return
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, dict) or data.get("version") != 1:
            self.send_json(400, {"error": "Expected {revision, data} with data.version 1"})
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
    try:
        server = FinanceServer(args.port, data_file, theme_file())
    except OSError as error:
        sys.exit(f"finance: cannot listen on 127.0.0.1:{args.port}: {error.strerror}")
    print(f"Finance on http://127.0.0.1:{server.server_address[1]}/ (data: {data_file})", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
