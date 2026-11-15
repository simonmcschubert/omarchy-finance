import http.client
import json
import os
import socket
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

STORE = {"version": 1, "settings": {"withdrawalRate": 4, "bufferPercent": 10}, "expenses": [], "income": [], "accounts": [], "records": []}


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
        response, _ = self.request("PUT", "/api/data", {"revision": "none", "data": {"version": 2}})
        self.assertEqual(response.status, 400)

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
        changed = {**STORE, "settings": {"withdrawalRate": 3, "bufferPercent": 10}}
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
