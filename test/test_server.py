import http.client
import json
import os
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

STORE = {
    "version": 4,
    "settings": {"withdrawalRate": 4, "bufferPercent": 10, "currency": "EUR", "numberFormat": "1.000.000,00"},
    "categories": {"expenses": [], "income": []},
    "expenses": [],
    "income": [],
    "accounts": [],
    "records": [],
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
        for version in [3, 5]:
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
        self.assertEqual(self.get_data(), {"revision": "none", "file": str(self.data_file), "data": None})

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
# check.out is what check prints; check.fail, download.fail and install.fail
# make those fail the way the script does. It logs its calls to calls.
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

    def act(self, action):
        status, body = self.request("POST", {"action": action})
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
        self.assertEqual((body["status"], body["version"], body["checking"]), ("", "", False))
        self.assertRegex(body["boot"], r"^[0-9a-f]{16}$")
        self.assertEqual(self.calls(), ["version"], "no check before the timer or the button asks")

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
        self.assertEqual(self.calls(), ["version", "check", "check", "download 0.2.0", "install 0.2.0", "check"])

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
        status, _ = self.request("POST", {"action": "reboot"})
        self.assertEqual(status, 400)
        # JSON null is JSON, and still no request.
        for method, path in [("POST", "/api/update"), ("PUT", "/api/data")]:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            conn.request(method, path, body=b"null", headers={"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json"})
            self.assertEqual(conn.getresponse().status, 400, method)
            conn.close()
        self.assertEqual(self.calls(), ["version"])


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


if __name__ == "__main__":
    unittest.main()
