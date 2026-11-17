#!/usr/bin/env python3
"""Finance: serves the web app and saves its data file.

Listens on 127.0.0.1 only. The data lives in one JSON file,
~/.local/state/omarchy-finance/finance.json, in a directory only the owner
can open. With the lock on, the data is shown only once the system has
confirmed it's you. The page's colors come from the current Omarchy theme.
Updates come from the update script next to this file.

Python standard library only (3.11 or newer).
"""

import argparse
import datetime
import hashlib
import http.cookies
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
VERSION = 13  # data file version; matches VERSION in app/finance.mjs
NO_BODY = object()  # read_json found none it accepts, and said so

# Dated copies of the data file kept in backups/ next to it: one a day.
BACKUPS_KEPT = 30

# Seconds: the first check for a release after the server starts, and then.
FIRST_CHECK = 15
CHECK_EVERY = 4 * 60 * 60
# The install restarts omarchy-finance.service, so it runs as a unit of its own.
INSTALL_UNIT = "omarchy-finance-update"
# Which updates Finance offers: releases, or previews of main (update script).
CHANNELS = ("stable", "preview")

# The lock (Lock below). The system confirms it's you through polkit, in
# Omarchy's own dialog: the fingerprint when one is set up, the password
# otherwise. setup installs the action from polkit/.
UNLOCK_ACTION = "io.github.simonmcschubert.omarchy-finance.unlock"
POLICY_FILE = Path("/usr/share/polkit-1/actions/io.github.simonmcschubert.omarchy-finance.policy")
IDLE_LOCK = 20 * 60  # seconds without use, then Finance locks again
# Seconds the boot clock may gain on the monotonic one, which stops while
# the computer sleeps, before Finance counts it as sleep.
SLEPT = 5
CONFIRM_TIMEOUT = 120  # seconds the dialog may stay open
SESSION_COOKIE = "finance-session"

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


def backup_dir(data_file):
    return Path(data_file).parent / "backups"


def today():
    """The local date, as backups are named: 2026-11-16."""
    return datetime.date.today().isoformat()


def back_up(data_file, raw):
    """Before the first save of a day, keeps the file as it was in
    backups/<name>-<date>.json, and the BACKUPS_KEPT newest of those. A later
    save that day keeps the copy from before the first one, so a bad import
    or a slip can be undone with the file from that morning."""
    if raw is None:
        return
    data_file = Path(data_file)
    directory = backup_dir(data_file)
    target = directory / f"{data_file.stem}-{today()}.json"
    if target.exists():
        return
    write_atomic(target, raw)
    copies = sorted(directory.glob(f"{data_file.stem}-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json"))
    for old in copies[:-BACKUPS_KEPT]:
        old.unlink(missing_ok=True)


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
    """Offers updates of Finance the way a desktop app offers them: it checks
    shortly after the server starts, every four hours, and when the update
    button asks; it downloads an update when asked, and installs it with a
    restart of the server. An update is a release, or on the preview channel
    the newest preview. The update script does the work; the page shows the
    state (app/update.mjs)."""

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
        # What status is about: a release X.Y.Z, or a preview's commit id.
        self.version = ""
        self.error = ""
        self.checking = False
        ok, out, _ = self.run("version")
        # The installed release: "" before the first or without a checkout.
        self.installed = out.strip() if ok else ""
        ok, out, _ = self.run("channel")
        # stable or preview; "" without a checkout.
        self.channel = out.strip() if ok else ""

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
                "channel": self.channel,
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

    def set_channel(self, channel):
        """Offers releases (stable) or previews from now on. Returns why it
        can't, or "". Check next: what was found before is forgotten."""
        busy = "can't change the channel while Finance updates; try again when it is done"
        with self.lock:
            if self.status in ("downloading", "installing"):
                return busy  # without waiting for the install to end
        with self.work:
            with self.lock:
                if self.status in ("downloading", "installing"):
                    return busy
            ok, _, why = self.run("channel", channel)
            if not ok:
                return why
            with self.lock:
                self.channel = channel
                # A download clicked meanwhile finishes for the channel before.
                if self.status not in ("downloading", "installing"):
                    self.status, self.version, self.error = "", "", ""
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


def ask_polkit():
    """Asks the system to confirm it's the user, in its own dialog.
    Returns (confirmed, why): why is "" when the dialog was dismissed."""
    pid = os.getpid()
    try:
        # Field 22 of /proc/<pid>/stat, the start time, after the name in
        # parentheses: pkcheck can't be fooled by a new process of that pid.
        start = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
        result = subprocess.run(
            ["pkcheck", "--action-id", UNLOCK_ACTION, "--process", f"{pid},{start},{os.getuid()}", "--allow-user-interaction"],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=CONFIRM_TIMEOUT,
        )  # fmt: skip
    except subprocess.TimeoutExpired:
        return False, f"no answer within {CONFIRM_TIMEOUT // 60} minutes"
    except (OSError, IndexError) as error:
        return False, f"can't ask the system: {getattr(error, 'strerror', None) or error}"
    if result.returncode == 0:
        return True, ""
    if result.returncode == 3:  # dismissed
        return False, ""
    lines = [line.strip() for line in result.stderr.splitlines() if line.strip()]
    return False, lines[-1] if lines else "not confirmed"


def sleep_offset():
    """How far the boot clock is ahead of the monotonic one: it grows by the
    time the computer sleeps."""
    return time.clock_gettime(time.CLOCK_BOOTTIME) - time.clock_gettime(time.CLOCK_MONOTONIC)


class Lock:
    """Finance's lock. When it is on, the data goes only to requests with a
    session, and a session starts once the system has confirmed it's you
    (ask_polkit). Every session ends after IDLE_LOCK without use, after the
    computer slept, when the page locks, and with the server. The lock is on
    when setup has installed the polkit action, unless turned off in
    Settings, which the system confirms too."""

    def __init__(self, settings, policy=POLICY_FILE, confirm=ask_polkit, clock=time.monotonic, slept=sleep_offset):
        self.settings = Path(settings)  # {"enabled": false} when turned off
        self.policy = None if policy is None else Path(policy)
        self.confirm = confirm
        self.clock = clock
        self.slept = slept
        self.mutex = threading.Lock()  # guards the fields below
        self.sessions = set()
        self.used = 0.0  # self.clock() of the last use
        self.offset = slept()
        self.asking = False  # one dialog at a time

    def available(self):
        """Whether the system can be asked: setup installed the action."""
        return self.policy is not None and self.policy.is_file()

    def enabled(self):
        if not self.available():
            return False
        try:
            return json.loads(self.settings.read_text()).get("enabled") is not False
        except (OSError, ValueError, AttributeError):
            return True

    def expire(self):
        """Ends every session after the idle time or a sleep. Holds mutex."""
        offset = self.slept()
        slept, self.offset = offset - self.offset > SLEPT, offset
        if slept or self.clock() - self.used > IDLE_LOCK:
            self.sessions.clear()

    def unlocked(self, session):
        if not self.enabled():
            return True
        with self.mutex:
            self.expire()
            return session in self.sessions

    def use(self, session):
        """Counts as use: the idle time starts again."""
        with self.mutex:
            self.expire()
            if session in self.sessions:
                self.used = self.clock()

    def lock(self):
        with self.mutex:
            self.sessions.clear()

    def start(self):
        """A new session, and the idle time from now."""
        session = secrets.token_urlsafe(32)
        with self.mutex:
            self.expire()
            self.sessions.add(session)
            self.used = self.clock()
        return session

    def ask(self):
        """(confirmed, why) from the system's dialog; why is None while
        another dialog is open."""
        with self.mutex:
            if self.asking:
                return False, None
            self.asking = True
        try:
            return self.confirm()
        finally:
            with self.mutex:
                self.asking = False

    def set_enabled(self, enabled):
        write_atomic(self.settings, (json.dumps({"enabled": enabled}) + "\n").encode())

    def state(self, session):
        """What GET /api/lock says: nothing about the data."""
        return {
            "available": self.available(),
            "enabled": self.enabled(),
            "locked": not self.unlocked(session),
            "idleMinutes": IDLE_LOCK // 60,
        }


class FinanceServer(http.server.ThreadingHTTPServer):
    """A thread per connection, so an idle browser connection blocks nothing.
    Saves hold a lock, so they never overlap."""

    daemon_threads = True

    def __init__(self, port, data_file, theme_path, updater=None, lock=None):
        self.data_file = Path(data_file)
        self.theme_path = Path(theme_path)
        self.updater = updater
        # Without one: no lock, as for a server started without setup.
        self.lock = lock or Lock(self.data_file.parent / "lock.json", policy=None)
        self.saving = threading.Lock()
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

    def send_json(self, status, value, extra=None):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_body(status, body, "application/json; charset=utf-8", extra)

    def session(self):
        """The session from the page's cookie, or None."""
        try:
            morsel = http.cookies.SimpleCookie(self.headers.get("Cookie", "")).get(SESSION_COOKIE)
        except http.cookies.CookieError:
            return None
        return morsel.value if morsel else None

    def unlocked(self):
        """Whether this request may see the data; says no if not."""
        if self.server.lock.unlocked(self.session()):
            return True
        self.send_json(401, {"error": "Finance is locked", "locked": True})
        return False

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
            if self.unlocked():
                self.get_data()
        elif path == "/api/lock":
            self.send_json(200, self.server.lock.state(self.session()))
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
        result = {
            "revision": revision_of(raw),
            "file": str(self.server.data_file),
            "backups": str(backup_dir(self.server.data_file)),
            "data": None,
        }
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
        path = self.path.split("?", 1)[0]
        if path == "/api/lock":
            self.post_lock()
            return
        updater = self.server.updater
        if path != "/api/update" or not updater:
            self.send_json(404, {"error": "Not found"})
            return
        body = self.read_json()
        if body is NO_BODY or not self.unlocked():
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
        elif action == "channel" and body.get("channel") in CHANNELS:
            why = updater.set_channel(body["channel"])
            if why:
                self.send_json(409, {"error": why})
                return
            why = updater.check(asked=True)
            self.send_json(200, {**updater.snapshot(), "checkError": why})
        else:
            channels = " or ".join(CHANNELS)
            self.send_json(400, {"error": f"Expected {{action: check, download, install, or channel with channel: {channels}}}"})

    def post_lock(self):
        """Unlocks once the system confirms it's you, locks, counts a use,
        or turns the lock on or off (off needs the system's confirmation)."""
        body = self.read_json()
        if body is NO_BODY:
            return
        action = body.get("action") if isinstance(body, dict) else None
        lock, session = self.server.lock, self.session()
        cookie = None  # the Set-Cookie header of a new session
        if action == "lock":
            lock.lock()
        elif action == "use":
            lock.use(session)
        elif action == "unlock":
            if not lock.unlocked(session):
                confirmed, why = lock.ask()
                if not confirmed:
                    self.not_confirmed(why)
                    return
                session, cookie = self.start_session()
        elif action in ("on", "off"):
            if not lock.available():
                self.send_json(409, {"error": "the unlock prompt is not installed: run setup again"})
                return
            if not self.unlocked():
                return
            if action == "off" and lock.enabled():
                confirmed, why = lock.ask()
                if not confirmed:
                    self.not_confirmed(why)
                    return
            try:
                lock.set_enabled(action == "on")
            except OSError as error:
                self.log_error("saving the lock setting failed: %s", error)
                self.send_json(500, {"error": f"Could not save: {error.strerror}"})
                return
            if action == "on":
                session, cookie = self.start_session()
        else:
            self.send_json(400, {"error": "Expected {action: unlock, lock, use, on or off}"})
            return
        self.send_json(200, lock.state(session), cookie)

    def start_session(self):
        """A new session, and the header that sets it as the page's cookie:
        HttpOnly, so the page's scripts never see it, and kept until the
        browser closes."""
        session = self.server.lock.start()
        return session, {"Set-Cookie": f"{SESSION_COOKIE}={session}; Path=/; HttpOnly; SameSite=Strict"}

    def not_confirmed(self, why):
        if why is None:
            self.send_json(409, {"error": "Finance is asking already: confirm in the open dialog"})
        else:
            # "" when the dialog was dismissed: the page then says nothing.
            self.send_json(401, {"error": why})

    def do_PUT(self):
        if not self.allowed():
            return
        if self.path.split("?", 1)[0] != "/api/data":
            self.send_json(404, {"error": "Not found"})
            return
        body = self.read_json()
        if body is NO_BODY:
            return
        # Once the body is in: a slow one must not outlast the lock.
        if not self.unlocked():
            return
        self.server.lock.use(self.session())
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, dict) or data.get("version") != VERSION:
            # Also refuses a window still running an older version of the page.
            self.send_json(400, {"error": f"Expected {{revision, data}} with data.version {VERSION}; reload the page"})
            return

        out = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode()
        with self.server.saving:
            current = self.current()
            if body.get("revision") != current["revision"] or "error" in current:
                # Another window saved first, or the file was edited by hand.
                # Same shape as GET, so the page can show the latest.
                status, reply = 409, {**current, "conflict": True}
            else:
                try:
                    back_up(self.server.data_file, read_file(self.server.data_file))
                except OSError as error:
                    # A missing copy is no reason to lose the change.
                    self.log_error("backup failed: %s", error)
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
    lock = Lock(data_file.parent / "lock.json")
    try:
        server = FinanceServer(args.port, data_file, theme_file(), updater, lock)
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
