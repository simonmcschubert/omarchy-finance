import http.client
import json
import os
import re
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

STORE = {
    "version": 18,
    "settings": {
        "withdrawalRate": 4,
        "bufferPercent": 10,
        "currency": "EUR",
        "numberFormat": "1.000.000,00",
        "expectedReturn": 8,
        "inflation": 3,
        "birthYear": None,
        "retirementAge": 67,
        "emergencyMonths": 6,
        "futurePayIn": None,
        "payInsRiseWithInflation": False,
        "coastPayIn": 0,
    },
    "categories": {"expenses": [], "income": []},
    "expenses": [],
    "income": [],
    "accounts": [],
    "records": [],
    "events": [],
    "payInChanges": [],
    "flat": None,
}


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.data_file = root / "state" / "omarchy-finance" / "finance.json"
        self.theme = root / "colors.toml"
        self.server = server.FinanceServer(0, self.data_file, self.theme)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        all_headers = {"Host": f"127.0.0.1:{self.port}"}
        if body is not None:
            all_headers["Content-Type"] = "application/json"
            body = json.dumps(body).encode()
        all_headers.update(headers or {})
        conn.request(method, path, body=body, headers=all_headers)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response, data

    def get_data(self):
        response, data = self.request("GET", "/api/data")
        self.assertEqual(response.status, 200)
        return json.loads(data)

    def test_serves_the_page_with_a_content_security_policy(self):
        response, data = self.request("GET", "/")
        self.assertEqual(response.status, 200)
        self.assertIn(b"<title>Finance</title>", data)
        self.assertIn("script-src 'self'", response.getheader("Content-Security-Policy"))
        response, _ = self.request("GET", "/app.mjs")
        self.assertEqual(response.getheader("Content-Type"), "text/javascript; charset=utf-8")

    def test_unknown_paths_and_traversal_are_not_found(self):
        for path in ["/server.py", "/../server.py", "/app/../server.py", "/%2e%2e/server.py", "/api/other"]:
            response, _ = self.request("GET", path)
            self.assertEqual(response.status, 404, path)

    def test_refuses_other_hosts(self):
        # A website that points its own name at 127.0.0.1 (DNS rebinding)
        response, _ = self.request("GET", "/api/data", headers={"Host": f"evil.example:{self.port}"})
        self.assertEqual(response.status, 403)

    def test_refuses_writes_from_other_origins(self):
        response, _ = self.request("PUT", "/api/data", {"revision": "none", "data": STORE}, {"Origin": "https://evil.example"})
        self.assertEqual(response.status, 403)
        self.assertFalse(self.data_file.exists())

    def test_refuses_non_json_writes(self):
        response, _ = self.request("PUT", "/api/data", {"revision": "none", "data": STORE}, {"Content-Type": "text/plain"})
        self.assertEqual(response.status, 415)
        for version in [STORE["version"] - 1, STORE["version"] + 1]:
            response, data = self.request("PUT", "/api/data", {"revision": "none", "data": {**STORE, "version": version}})
            self.assertEqual(response.status, 400)
            self.assertIn("reload the page", json.loads(data)["error"])
        self.assertFalse(self.data_file.exists())

    def test_an_idle_connection_blocks_nothing(self):
        # Browsers open connections ahead of time and may never use them.
        idle = socket.create_connection(("127.0.0.1", self.port))
        try:
            response, _ = self.request("GET", "/")
            self.assertEqual(response.status, 200)
        finally:
            idle.close()

    def test_no_file_yet(self):
        backups = str(self.data_file.parent / "backups")
        setup = str(Path(server.__file__).resolve().parent / "setup")
        self.assertEqual(self.get_data(), {"revision": "none", "file": str(self.data_file), "backups": backups, "setup": setup, "data": None})
        # Settings names it for the lock, to be run in a terminal.
        self.assertTrue(Path(setup).is_file())

    def test_save_and_load(self):
        origin = {"Origin": f"http://127.0.0.1:{self.port}"}
        response, data = self.request("PUT", "/api/data", {"revision": "none", "data": STORE}, origin)
        self.assertEqual(response.status, 200)
        revision = json.loads(data)["revision"]

        loaded = self.get_data()
        self.assertEqual(loaded["data"], STORE)
        self.assertEqual(loaded["revision"], revision)

        # Only the owner can open the directory or read the file.
        self.assertEqual(stat.S_IMODE(self.data_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.data_file.parent.stat().st_mode), 0o700)
        self.assertEqual(list(self.data_file.parent.iterdir()), [self.data_file], "no temporary files left")

    def save(self, revision, data):
        response, body = self.request("PUT", "/api/data", {"revision": revision, "data": data})
        self.assertEqual(response.status, 200)
        return json.loads(body)["revision"]

    def on(self, day):
        original = server.today
        server.today = lambda: day
        self.addCleanup(setattr, server, "today", original)

    def test_keeps_the_file_from_before_the_first_save_of_each_day(self):
        backups = self.data_file.parent / "backups"
        first, second, third = ({**STORE, "settings": {**STORE["settings"], "withdrawalRate": rate}} for rate in (4, 3.5, 3))
        self.on("2026-11-15")
        revision = self.save("none", first)
        self.assertFalse(backups.exists(), "nothing to keep before the first save ever")

        revision = self.save(revision, second)
        copy = backups / "finance-2026-11-15.json"
        self.assertEqual(json.loads(copy.read_text())["settings"]["withdrawalRate"], 4)
        self.assertEqual(stat.S_IMODE(copy.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(backups.stat().st_mode), 0o700)

        # Later saves that day keep the copy from the morning.
        revision = self.save(revision, third)
        self.assertEqual(json.loads(copy.read_text())["settings"]["withdrawalRate"], 4)

        self.on("2026-11-16")
        self.save(revision, first)
        self.assertEqual(json.loads((backups / "finance-2026-11-16.json").read_text())["settings"]["withdrawalRate"], 3)
        self.assertEqual(sorted(p.name for p in backups.iterdir()), ["finance-2026-11-15.json", "finance-2026-11-16.json"])

    def test_keeps_the_newest_backups_only(self):
        backups = self.data_file.parent / "backups"
        backups.mkdir(parents=True)
        old = [f"finance-2026-10-{day:02}.json" for day in range(1, 32)]
        for name in [*old, "other-2026-01-01.json", "notes.txt"]:
            (backups / name).write_text("{}")
        revision = self.save("none", STORE)
        self.on("2026-11-16")
        self.save(revision, {**STORE, "settings": {**STORE["settings"], "withdrawalRate": 3}})
        kept = sorted(p.name for p in backups.glob("finance-*.json"))
        self.assertEqual(kept, [*old[-29:], "finance-2026-11-16.json"])
        self.assertTrue((backups / "other-2026-01-01.json").exists(), "another file's backups stay")
        self.assertTrue((backups / "notes.txt").exists())

    def test_a_failed_backup_does_not_stop_the_save(self):
        revision = self.save("none", STORE)
        (self.data_file.parent / "backups").write_text("not a directory")
        changed = {**STORE, "settings": {**STORE["settings"], "withdrawalRate": 3}}
        self.save(revision, changed)
        self.assertEqual(self.get_data()["data"], changed)

    def test_stale_revision_is_a_conflict(self):
        _, data = self.request("PUT", "/api/data", {"revision": "none", "data": STORE})
        first = json.loads(data)["revision"]
        changed = {**STORE, "settings": {**STORE["settings"], "withdrawalRate": 3}}
        response, _ = self.request("PUT", "/api/data", {"revision": first, "data": changed})
        self.assertEqual(response.status, 200)

        # A second window still holds the first revision.
        response, data = self.request("PUT", "/api/data", {"revision": first, "data": STORE})
        self.assertEqual(response.status, 409)
        body = json.loads(data)
        self.assertEqual(body["data"], changed)
        self.assertTrue(body["conflict"])
        self.assertNotIn("error", body, "a conflict is not an unreadable file")
        self.assertEqual(self.get_data()["data"], changed)

    def test_an_unreadable_file_is_reported_and_never_overwritten(self):
        self.data_file.parent.mkdir(parents=True)
        self.data_file.write_text("{broken")
        loaded = self.get_data()
        self.assertIsNone(loaded["data"])
        self.assertIn("not valid JSON", loaded["error"])
        for revision in ["none", loaded["revision"]]:
            response, data = self.request("PUT", "/api/data", {"revision": revision, "data": STORE})
            self.assertEqual(response.status, 409)
            self.assertIn("not valid JSON", json.loads(data)["error"])
        self.assertEqual(self.data_file.read_text(), "{broken")

    def test_theme_css_from_omarchy_colors(self):
        self.theme.write_text('mode = "light"\nbackground = "#FFFCF0"\naccent = "#205EA6"\nforeground = "red; } body { x"\n')
        response, data = self.request("GET", "/theme.css")
        self.assertEqual(response.status, 200)
        css = data.decode()
        self.assertIn("--bg: #FFFCF0;", css)
        self.assertIn("--accent: #205EA6;", css)
        self.assertIn("--fg: #a9b1d6;", css, "an invalid value falls back to the default")
        self.assertIn("color-scheme: light;", css)
        self.assertNotIn("body", css)

    def test_theme_mode_from_background_and_missing_file(self):
        self.theme.write_text('bg = "#fafafa"\ncolor1 = "#ff0000"\n')
        css = self.request("GET", "/theme.css")[1].decode()
        self.assertIn("--bg: #fafafa;", css)
        self.assertIn("--red: #ff0000;", css)
        self.assertIn("color-scheme: light;", css)
        self.theme.unlink()
        css = self.request("GET", "/theme.css")[1].decode()
        self.assertIn("--bg: #1a1b26;", css)
        self.assertIn("color-scheme: dark;", css)


# Stands in for the update script. Files next to it decide what it does:
# check.out is what check prints; channel holds the channel; check.fail,
# download.fail, install.fail and channel.fail make those fail the way the
# script does. It logs its calls to calls.
FAKE_UPDATE = """#!/bin/bash
dir=$(dirname "$0")
echo "$*" >> "$dir/calls"
case $1 in
  version) echo 0.1.0 ;;
  check)
    [[ ! -e $dir/check.fail ]] || { echo "fatal: unable to access origin" >&2; echo "update: can't reach origin" >&2; exit 1; }
    cat "$dir/check.out" ;;
  download)
    [[ ! -e $dir/download.fail ]] || { echo "update: can't download Finance $2" >&2; exit 1; }
    echo "downloaded $2" > "$dir/check.out" ;;
  install)
    [[ ! -e $dir/install.fail ]] || { echo "update: can't update to $2: /app has local changes" >&2; exit 1; }
    echo current > "$dir/check.out" ;;
  channel)
    if [[ -n $2 ]]; then
      [[ ! -e $dir/channel.fail ]] || { echo "update: /app is not a git checkout, so there is nothing to update from" >&2; exit 1; }
      echo "$2" > "$dir/channel"
    else
      cat "$dir/channel" 2>/dev/null || echo stable
    fi ;;
esac
"""


class DirectUpdater(server.Updater):
    """Runs the install straight away, not as a systemd unit."""

    def install_command(self, version):
        return [str(self.script), "install", version]


class UpdateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.script = self.dir / "update"
        self.script.write_text(FAKE_UPDATE)
        self.script.chmod(0o755)
        self.offer("current")
        self.start(DirectUpdater)

    def start(self, kind):
        self.updater = kind(self.script, self.dir / "update.log")
        self.server = server.FinanceServer(0, self.dir / "finance.json", self.dir / "colors.toml", self.updater)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def offer(self, line):
        (self.dir / "check.out").write_text(line + "\n")

    def calls(self):
        path = self.dir / "calls"
        return path.read_text().split("\n")[:-1] if path.exists() else []

    def request(self, method, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        all_headers = {"Host": f"127.0.0.1:{self.port}", "Origin": f"http://127.0.0.1:{self.port}"}
        if body is not None:
            all_headers["Content-Type"] = "application/json"
            body = json.dumps(body).encode()
        all_headers.update(headers or {})
        conn.request(method, "/api/update", body=body, headers=all_headers)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, json.loads(data)

    def act(self, action, **fields):
        status, body = self.request("POST", {"action": action, **fields})
        self.assertEqual(status, 200, body)
        return body

    def settled(self):
        """The state once the install has finished."""
        for _ in range(100):
            body = self.request("GET")[1]
            if body["status"] != "installing":
                return body
            time.sleep(0.05)
        self.fail("the install did not finish")

    def test_reports_the_installed_release(self):
        status, body = self.request("GET")
        self.assertEqual(status, 200)
        self.assertEqual(body["installed"], "0.1.0")
        self.assertEqual(body["channel"], "stable")
        self.assertEqual((body["status"], body["version"], body["checking"]), ("", "", False))
        self.assertRegex(body["boot"], r"^[0-9a-f]{16}$")
        self.assertEqual(self.calls(), ["version", "channel"], "no check before the timer or the button asks")

    def test_check_download_and_install(self):
        body = self.act("check")
        self.assertEqual((body["status"], body["checkError"]), ("", ""), "up to date")

        self.offer("available 0.2.0")
        body = self.act("check")
        self.assertEqual((body["status"], body["version"], body["checkError"]), ("available", "0.2.0", ""))

        body = self.act("download")
        self.assertEqual((body["status"], body["version"]), ("downloaded", "0.2.0"))

        body = self.act("install")
        self.assertEqual(body["status"], "installing")
        # Still here after a successful install: not run by the service, so
        # it was not restarted. It checks again.
        self.assertEqual(self.settled()["status"], "")
        self.assertEqual(self.calls(), ["version", "channel", "check", "check", "download 0.2.0", "install 0.2.0", "check"])

    def test_install_and_download_only_in_turn(self):
        self.offer("available 0.2.0")
        self.act("check")
        self.assertEqual(self.act("install")["status"], "available", "not downloaded yet")
        self.act("download")
        self.assertEqual(self.act("download")["status"], "downloaded")
        self.assertNotIn("install 0.2.0", self.calls())
        self.assertEqual(self.calls().count("download 0.2.0"), 1)

    def test_a_failed_check_says_why_and_keeps_the_release(self):
        self.offer("available 0.2.0")
        self.act("check")
        (self.dir / "check.fail").touch()
        body = self.act("check")
        self.assertEqual(body["checkError"], "can't reach origin")
        self.assertEqual((body["status"], body["version"]), ("available", "0.2.0"))
        self.assertEqual(self.updater.check(), "can't reach origin", "the timer's check too")
        self.assertEqual(self.request("GET")[1]["status"], "available")

    def test_a_failed_download_says_why_until_clicked(self):
        self.offer("available 0.2.0")
        self.act("check")
        (self.dir / "download.fail").touch()
        body = self.act("download")
        self.assertEqual((body["status"], body["error"]), ("failed", "can't download Finance 0.2.0"))
        self.updater.check()
        self.assertEqual(self.request("GET")[1]["status"], "failed", "the timer leaves it on show")

        # Clicking it downloads again.
        (self.dir / "download.fail").unlink()
        body = self.act("download")
        self.assertEqual((body["status"], body["error"]), ("downloaded", ""))

    def test_a_failed_install_says_why(self):
        self.offer("available 0.2.0")
        self.act("check")
        self.act("download")
        (self.dir / "install.fail").touch()
        self.act("install")
        body = self.settled()
        self.assertEqual((body["status"], body["version"]), ("failed", "0.2.0"))
        self.assertEqual(body["error"], "can't update to 0.2.0: /app has local changes")

    def test_the_install_reason_comes_from_its_log(self):
        log = self.dir / "update.log"
        commands = [
            # As under systemd-run: the script's output goes to the log.
            f"echo 'fatal: git said' > {log}; echo 'update: reason from the log' >> {log}; exit 1",
            # systemd-run itself failed: its own reason, not an earlier log's.
            "echo 'Failed to start transient service unit' >&2; exit 1",
        ]

        class SystemdUpdater(server.Updater):
            def install_command(self, version):
                return ["bash", "-c", commands.pop(0)]

        self.server.shutdown()
        self.server.server_close()
        self.start(SystemdUpdater)
        self.offer("downloaded 0.2.0")
        self.act("check")
        self.act("install")
        self.assertEqual(self.settled()["error"], "reason from the log")

        self.act("download")  # as the button does after a failure
        log.write_text("update: an earlier install\n")
        self.act("install")
        self.assertEqual(self.settled()["error"], "Failed to start transient service unit")

    def test_the_install_runs_as_its_own_systemd_unit(self):
        command = server.Updater(self.script, "/run/user/1000/omarchy-finance-update.log").install_command("0.2.0")
        self.assertEqual(command[:2], ["systemd-run", "--user"])
        self.assertIn("--wait", command)
        self.assertIn("--unit=omarchy-finance-update", command)
        self.assertIn("--property=StandardOutput=truncate:/run/user/1000/omarchy-finance-update.log", command)
        self.assertEqual(command[-3:], [str(self.script), "install", "0.2.0"])

    def test_refuses_other_origins_and_anything_but_json(self):
        status, _ = self.request("POST", {"action": "check"}, {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.request("POST", {"action": "check"}, {"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        for body in [{"action": "reboot"}, {"action": "channel"}, {"action": "channel", "channel": "beta"}]:
            status, _ = self.request("POST", body)
            self.assertEqual(status, 400, body)
        # JSON null is JSON, and still no request.
        for method, path in [("POST", "/api/update"), ("PUT", "/api/data")]:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            conn.request(method, path, body=b"null", headers={"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json"})
            self.assertEqual(conn.getresponse().status, 400, method)
            conn.close()
        self.assertEqual(self.calls(), ["version", "channel"])

    def test_switching_the_channel_checks_it(self):
        self.offer("available 0.2.0")
        self.act("check")
        preview = "1a2b3c4d" * 5
        self.offer(f"available {preview}")
        body = self.act("channel", channel="preview")
        self.assertEqual((body["channel"], body["status"], body["version"], body["checkError"]), ("preview", "available", preview, ""))
        self.assertEqual(self.calls()[-2:], ["channel preview", "check"])
        self.assertEqual(self.request("GET")[1]["channel"], "preview")

        # A new server reads it back.
        self.server.shutdown()
        self.server.server_close()
        self.start(DirectUpdater)
        self.assertEqual(self.request("GET")[1]["channel"], "preview")

    def test_switching_the_channel_forgets_what_the_other_one_found(self):
        self.offer("available 0.2.0")
        self.act("check")
        (self.dir / "check.fail").touch()
        body = self.act("channel", channel="preview")
        self.assertEqual(body["checkError"], "can't reach origin")
        self.assertEqual((body["channel"], body["status"], body["version"]), ("preview", "", ""))

    def test_the_channel_stays_while_finance_updates(self):
        with self.updater.lock:
            self.updater.status = "installing"
        status, body = self.request("POST", {"action": "channel", "channel": "preview"})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"], "can't change the channel while Finance updates; try again when it is done")
        self.assertEqual(self.request("GET")[1]["channel"], "stable")
        self.assertNotIn("channel preview", self.calls())

    def test_a_failed_channel_change_says_why(self):
        (self.dir / "channel.fail").touch()
        status, body = self.request("POST", {"action": "channel", "channel": "preview"})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"], "/app is not a git checkout, so there is nothing to update from")
        self.assertEqual(self.request("GET")[1]["channel"], "stable")


class FakeUpdater:
    def snapshot(self):
        return {"status": "", "installed": "0.2.0"}

    def check(self, asked=False):
        return ""


class LockTest(unittest.TestCase):
    """The lock, with a stand-in for the system's dialog and clocks that
    move only when the test says so."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.data_file = root / "state" / "finance.json"
        self.policy = root / "unlock.policy"
        self.policy.write_text("<policyconfig/>")
        self.answers = []  # what the dialog answers, in turn
        self.asked = 0
        self.now = 1000.0
        self.offset = 0.0  # how long the computer has slept
        self.lock = server.Lock(self.data_file.parent / "lock.json", policy=self.policy, confirm=self.confirm,
                                clock=lambda: self.now, slept=lambda: self.offset)  # fmt: skip
        self.server = server.FinanceServer(0, self.data_file, root / "colors.toml", FakeUpdater(), self.lock)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def confirm(self):
        self.asked += 1
        return self.answers.pop(0)

    def request(self, method, path, body=None, session=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        all_headers = {"Host": f"127.0.0.1:{self.port}", "Origin": f"http://127.0.0.1:{self.port}"}
        if body is not None:
            all_headers["Content-Type"] = "application/json"
            body = json.dumps(body).encode()
        if session:
            all_headers["Cookie"] = f"{server.SESSION_COOKIE}={session}"
        all_headers.update(headers or {})
        conn.request(method, path, body=body, headers=all_headers)
        response = conn.getresponse()
        data = json.loads(response.read() or b"null")
        conn.close()
        return response, data

    def unlock(self):
        """A session, after the dialog said yes."""
        self.answers.append((True, ""))
        response, state = self.request("POST", "/api/lock", {"action": "unlock"})
        self.assertEqual(response.status, 200, state)
        self.assertFalse(state["locked"])
        cookie = response.getheader("Set-Cookie")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        return cookie.split(";")[0].split("=", 1)[1]

    def data_status(self, session=None):
        return self.request("GET", "/api/data", session=session)[0].status

    def test_without_the_prompt_installed_nothing_is_locked(self):
        self.policy.unlink()
        self.assertEqual(self.data_status(), 200)
        response, state = self.request("GET", "/api/lock")
        self.assertEqual(state, {"available": False, "enabled": False, "locked": False, "idleMinutes": 20})
        response, _ = self.request("POST", "/api/lock", {"action": "on"})
        self.assertEqual(response.status, 409)

    def test_shows_and_saves_nothing_until_the_system_confirms(self):
        response, body = self.request("GET", "/api/data")
        self.assertEqual((response.status, body), (401, {"error": "Finance is locked", "locked": True}))
        response, _ = self.request("PUT", "/api/data", {"revision": "none", "data": STORE})
        self.assertEqual(response.status, 401)
        self.assertFalse(self.data_file.exists())
        response, _ = self.request("POST", "/api/update", {"action": "check"})
        self.assertEqual(response.status, 401)
        # What the update button shows says nothing about the data.
        self.assertEqual(self.request("GET", "/api/update")[0].status, 200)
        self.assertEqual(self.request("GET", "/api/lock")[1], {"available": True, "enabled": True, "locked": True, "idleMinutes": 20})

        session = self.unlock()
        self.assertEqual(self.asked, 1)
        self.assertEqual(self.data_status(session), 200)
        self.assertEqual(self.request("PUT", "/api/data", {"revision": "none", "data": STORE}, session)[0].status, 200)
        self.assertEqual(self.request("POST", "/api/update", {"action": "check"}, session)[0].status, 200)
        # Other programs, without the page's cookie, or with a made-up one.
        self.assertEqual(self.data_status(), 401)
        self.assertEqual(self.data_status("made-up"), 401)
        # Unlocked already: no second dialog.
        response, state = self.request("POST", "/api/lock", {"action": "unlock"}, session)
        self.assertEqual((response.status, state["locked"], self.asked), (200, False, 1))

    def test_a_dismissed_or_refused_dialog_unlocks_nothing(self):
        self.answers += [(False, ""), (False, "Not authorized.")]
        for error in ["", "Not authorized."]:
            response, body = self.request("POST", "/api/lock", {"action": "unlock"})
            self.assertEqual((response.status, body), (401, {"error": error}))
            self.assertIsNone(response.getheader("Set-Cookie"))
        self.assertEqual(self.data_status(), 401)

    def test_one_dialog_at_a_time(self):
        self.lock.asking = True
        response, body = self.request("POST", "/api/lock", {"action": "unlock"})
        self.assertEqual(response.status, 409)
        self.assertIn("open dialog", body["error"])
        self.assertEqual(self.asked, 0)

    def test_locks_again_after_the_idle_time(self):
        session = self.unlock()
        self.now += server.IDLE_LOCK - 1
        self.assertEqual(self.request("POST", "/api/lock", {"action": "use"}, session)[1]["locked"], False)
        self.now += server.IDLE_LOCK - 1
        self.assertEqual(self.request("PUT", "/api/data", {"revision": "none", "data": STORE}, session)[0].status, 200)
        self.now += server.IDLE_LOCK - 1
        # Only use counts: reading the data or the lock's state does not.
        self.assertEqual(self.data_status(session), 200)
        self.assertEqual(self.request("GET", "/api/lock", session=session)[1]["locked"], False)
        self.now += 2
        self.assertEqual(self.data_status(session), 401)
        self.assertEqual(self.request("POST", "/api/lock", {"action": "use"}, session)[1]["locked"], True)

    def test_locks_after_the_computer_slept(self):
        session = self.unlock()
        self.offset += server.SLEPT  # a busy moment, not sleep
        self.assertEqual(self.data_status(session), 200)
        self.offset += 60
        self.assertEqual(self.data_status(session), 401)

    def test_locking_ends_every_session(self):
        first, second = self.unlock(), self.unlock()
        self.assertEqual((self.data_status(first), self.data_status(second)), (200, 200))
        self.assertEqual(self.request("POST", "/api/lock", {"action": "lock"})[1]["locked"], True)
        self.assertEqual((self.data_status(first), self.data_status(second)), (401, 401))

    def test_turning_the_lock_off_needs_the_system_too(self):
        response, _ = self.request("POST", "/api/lock", {"action": "off"})
        self.assertEqual((response.status, self.asked), (401, 0), "locked: no dialog")
        session = self.unlock()
        self.answers.append((False, ""))
        self.assertEqual(self.request("POST", "/api/lock", {"action": "off"}, session)[0].status, 401)
        self.assertTrue(self.lock.enabled())

        self.answers.append((True, ""))
        response, state = self.request("POST", "/api/lock", {"action": "off"}, session)
        self.assertEqual((response.status, state["enabled"], state["locked"]), (200, False, False))
        self.assertEqual(json.loads((self.data_file.parent / "lock.json").read_text()), {"enabled": False})
        self.assertEqual(self.data_status(), 200)

        # On again: the window that turned it on stays unlocked.
        response, state = self.request("POST", "/api/lock", {"action": "on"})
        self.assertEqual((response.status, state["enabled"], state["locked"]), (200, True, False))
        session = response.getheader("Set-Cookie").split(";")[0].split("=", 1)[1]
        self.assertEqual(self.data_status(session), 200)
        self.assertEqual(self.data_status(), 401)
        self.assertEqual(self.asked, 3)

    def test_a_slow_save_is_checked_once_its_body_is_in(self):
        session = self.unlock()
        body = json.dumps({"revision": "none", "data": STORE}).encode()
        slow = socket.create_connection(("127.0.0.1", self.port))
        try:
            slow.sendall(
                f"PUT /api/data HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(body)}\r\nCookie: {server.SESSION_COOKIE}={session}\r\n\r\n".encode()
            )
            time.sleep(0.2)
            self.request("POST", "/api/lock", {"action": "lock"})
            slow.sendall(body)
            reply = slow.makefile("rb").read().decode()
        finally:
            slow.close()
        self.assertTrue(reply.startswith("HTTP/1.0 401"), reply[:40])
        self.assertFalse(self.data_file.exists())

    def test_other_sites_and_anything_but_json_reach_no_dialog(self):
        response, _ = self.request("POST", "/api/lock", {"action": "unlock"}, headers={"Origin": "https://evil.example"})
        self.assertEqual(response.status, 403)
        response, _ = self.request("POST", "/api/lock", {"action": "unlock"}, headers={"Content-Type": "text/plain"})
        self.assertEqual(response.status, 415)
        response, _ = self.request("POST", "/api/lock", {"action": "open sesame"})
        self.assertEqual(response.status, 400)
        self.assertEqual(self.asked, 0)


class SetupAgreesTest(unittest.TestCase):
    def test_the_server_looks_for_the_action_setup_installs(self):
        root = Path(__file__).resolve().parent.parent
        setup = (root / "setup").read_text()
        name = next(line.split("=", 1)[1] for line in setup.splitlines() if line.startswith("POLICY="))
        self.assertEqual(server.POLICY_FILE, Path("/usr/share/polkit-1/actions") / name)
        self.assertIn("POLICY_FILE=/usr/share/polkit-1/actions/$POLICY", setup)
        policy = (root / "polkit" / name).read_text()
        self.assertIn(f'<action id="{server.UNLOCK_ACTION}">', policy)
        self.assertIn("<allow_active>auth_self</allow_active>", policy)


FAKE_PKCHECK = """#!/usr/bin/env bash
printf '%s\\n' "$@" > "$PKCHECK_ARGS"
[[ -z $PKCHECK_ERROR ]] || echo "$PKCHECK_ERROR" >&2
exit "$PKCHECK_EXIT"
"""


class AskPolkitTest(unittest.TestCase):
    """ask_polkit against a stand-in for pkcheck."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        bin_dir = Path(self.tmp.name)
        (bin_dir / "pkcheck").write_text(FAKE_PKCHECK)
        (bin_dir / "pkcheck").chmod(0o755)
        self.args = bin_dir / "args"
        self.environ = dict(os.environ)
        os.environ.update(PATH=f"{bin_dir}:{os.environ['PATH']}", PKCHECK_ARGS=str(self.args), PKCHECK_ERROR="")

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.environ)
        self.tmp.cleanup()

    def answer(self, code, error=""):
        os.environ.update(PKCHECK_EXIT=str(code), PKCHECK_ERROR=error)
        return server.ask_polkit()

    def test_asks_for_this_process_with_the_dialog(self):
        self.assertEqual(self.answer(0), (True, ""))
        start = Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()[19]
        self.assertEqual(self.args.read_text().split("\n")[:-1], [
            "--action-id", server.UNLOCK_ACTION,
            "--process", f"{os.getpid()},{start},{os.getuid()}",
            "--allow-user-interaction",
        ])  # fmt: skip

    def test_dismissed_refused_or_failed(self):
        self.assertEqual(self.answer(3), (False, ""))
        self.assertEqual(self.answer(1, "Not authorized."), (False, "Not authorized."))
        self.assertEqual(self.answer(127, "Error checking for authorization: no agent"), (False, "Error checking for authorization: no agent"))
        self.assertEqual(self.answer(1), (False, "not confirmed"))

    def test_without_pkcheck(self):
        os.environ["PATH"] = self.tmp.name + "/none"
        confirmed, why = server.ask_polkit()
        self.assertFalse(confirmed)
        self.assertIn("can't ask the system", why)

    def test_sleep_offset_measures_time_only_the_boot_clock_counted(self):
        clocks = {time.CLOCK_BOOTTIME: 125, time.CLOCK_MONOTONIC: 120}
        with patch.object(server.time, "clock_gettime", side_effect=clocks.__getitem__):
            self.assertEqual(server.sleep_offset(), 5)
            clocks[time.CLOCK_BOOTTIME] += 30
            clocks[time.CLOCK_MONOTONIC] += 30
            self.assertEqual(server.sleep_offset(), 5)
            clocks[time.CLOCK_BOOTTIME] += 15
            self.assertEqual(server.sleep_offset(), 20)


class WriteAtomicTest(unittest.TestCase):
    def test_keeps_the_old_file_when_writing_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "finance.json"
            path.write_text("old")
            original = os.replace

            def fail(*args):
                raise OSError("disk full")

            server.os.replace = fail
            try:
                with self.assertRaises(OSError):
                    server.write_atomic(path, b"new")
            finally:
                server.os.replace = original
            self.assertEqual(path.read_text(), "old")
            self.assertEqual(list(Path(tmp).iterdir()), [path])


class VersionTest(unittest.TestCase):
    def test_the_server_and_the_app_write_the_same_version(self):
        # The server refuses data of any other version, so a version raised
        # in one and not the other stops every save.
        source = (server.APP_DIR / "finance.mjs").read_text()
        found = re.search(r"^export const VERSION = (\d+);$", source, re.MULTILINE)
        self.assertIsNotNone(found, "VERSION in app/finance.mjs")
        self.assertEqual(int(found.group(1)), server.VERSION)
        self.assertEqual(STORE["version"], server.VERSION)


if __name__ == "__main__":
    unittest.main()
