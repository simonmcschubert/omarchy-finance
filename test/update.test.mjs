// Tests for the update script against real git repositories: an "origin"
// with releases and an installed checkout cloned from it. systemctl, curl
// and notify-send are stand-ins that log their calls. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../update", import.meta.url).pathname;

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "finance-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  const app = join(root, "app"); // the installed checkout
  mkdirSync(bin);
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const logged = (name, body = "") => stub(name, `echo "${name} $*" >> "${log}"\n${body}`);
  // The service runs the server.py named in the file "served", as setup
  // sets it up: by default the installed checkout's.
  stub("systemctl", `
if [[ $2 == show ]]; then
  served=$(cat "${root}/served" 2>/dev/null || echo "${app}/server.py")
  echo "{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 $served --port 47219 ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }"
  exit 0
fi
echo "systemctl $*" >> "${log}"`);
  // A release with a file named "broken" does not answer once started.
  logged("curl", `[[ ! -e "${app}/broken" ]] || exit 7`);
  logged("notify-send");
  stub("sleep", "");

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };

  const origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, "init", "--quiet", "--initial-branch=main");
  // Each commit carries the script, as every real release does.
  const commit = (message, files = {}) => {
    copyFileSync(SCRIPT, join(origin, "update"));
    writeFileSync(join(origin, "server.py"), "# server\n");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(origin, name), text);
    git(origin, "add", "-A");
    git(origin, "commit", "--quiet", "--allow-empty", "-m", message);
    return git(origin, "rev-parse", "HEAD");
  };
  const release = (version, files) => {
    commit(`Release ${version}`, files);
    git(origin, "tag", "--annotate", `v${version}`, "--message", `v${version}`);
  };

  const install = (ref) => {
    git(root, "clone", "--quiet", origin, app);
    if (ref) git(app, "reset", "--quiet", "--hard", ref);
  };

  // stdin and stderr are pipes, as when the server runs it: no terminal.
  const run = (...args) => spawnSync(join(app, "update"), args, { env, encoding: "utf8" });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const head = () => git(app, "rev-parse", "HEAD");
  const restarts = () => calls().filter((call) => call === "systemctl --user restart omarchy-finance.service").length;

  return { root, origin, app, git, commit, release, install, run, calls, head, restarts };
}

test("check finds the newest release on origin", (t) => {
  const s = sandbox(t);
  s.commit("Initial");
  s.install();
  assert.equal(s.run("check").stdout, "current\n", "no releases yet");

  s.release("0.9.0");
  s.release("0.10.0");
  s.git(s.origin, "tag", "v2.0.0-rc.1"); // candidates and other tags are no releases
  s.git(s.origin, "tag", "latest");
  const r = s.run("check");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "available 0.10.0\n");
});

test("check reads lightweight tags too", (t) => {
  const s = sandbox(t);
  s.commit("Initial");
  s.install();
  s.commit("Change");
  s.git(s.origin, "tag", "v0.2.0");
  assert.equal(s.run("check").stdout, "available 0.2.0\n");
});

test("check says current at or past the newest release", (t) => {
  const s = sandbox(t);
  s.release("0.1.0");
  s.commit("Unreleased");
  s.install("v0.1.0");
  assert.equal(s.run("check").stdout, "current\n");

  rmSync(s.app, { recursive: true });
  s.install(); // main, ahead of v0.1.0
  assert.equal(s.run("check").stdout, "current\n");
});

test("check fails when origin can't be reached", (t) => {
  const s = sandbox(t);
  s.release("0.1.0");
  s.install();
  s.git(s.app, "remote", "set-url", "origin", join(s.root, "gone"));
  const r = s.run("check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /update: can't reach origin\n$/);
});

test("download fetches the release and changes no files", (t) => {
  const s = sandbox(t);
  s.release("0.1.0");
  s.install();
  s.release("0.2.0", { "new.txt": "new\n" });
  const before = s.head();

  const r = s.run("download", "0.2.0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.head(), before);
  assert.equal(existsSync(join(s.app, "new.txt")), false);
  assert.equal(s.run("check").stdout, "downloaded 0.2.0\n");
  assert.deepEqual(s.calls(), []);
});

test("install moves to the release, restarts the server, and says so", (t) => {
  const s = sandbox(t);
  s.release("0.1.0");
  s.install();
  s.release("0.2.0", { "new.txt": "new\n" });
  s.commit("Unreleased", { "unreleased.txt": "not yet\n" });

  const r = s.run("install", "0.2.0"); // downloads first when needed
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "Finance 0.2.0 is installed.\n");
  assert.equal(s.head(), s.git(s.origin, "rev-parse", "v0.2.0^{commit}"));
  assert.equal(existsSync(join(s.app, "new.txt")), true);
  assert.equal(existsSync(join(s.app, "unreleased.txt")), false);
  assert.equal(s.git(s.app, "branch", "--show-current"), "main");
  assert.deepEqual(s.calls(), [
    "systemctl --user restart omarchy-finance.service",
    "curl -fs -o /dev/null http://127.0.0.1:47219/",
    "notify-send Finance updated Version 0.2.0 is installed.",
  ]);
  assert.equal(s.run("check").stdout, "current\n");
});

test("install goes back when the new server does not answer", (t) => {
  const s = sandbox(t);
  s.release("0.1.0");
  s.install();
  s.release("0.2.0", { broken: "x\n" });
  const before = s.head();

  const r = s.run("install", "0.2.0");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /update: Finance 0\.2\.0 did not start, so Finance stays as it was/);
  assert.equal(s.head(), before);
  assert.equal(existsSync(join(s.app, "broken")), false);
  // Restarted with the release, which never answered, then with the old code.
  assert.equal(s.restarts(), 2);
  assert.equal(s.calls().filter((call) => call.startsWith("curl ")).length, 21);
  assert.match(s.calls().at(-1), /^notify-send Finance update failed Finance 0\.2\.0 did not start/);
});

test("install refuses a checkout the service does not run", (t) => {
  const s = sandbox(t);
  s.release("0.1.0");
  s.install();
  s.release("0.2.0", { "new.txt": "new\n" });
  const before = s.head();

  for (const served of [join(s.root, "elsewhere", "server.py"), ""]) {
    writeFileSync(join(s.root, "served"), served);
    const r = s.run("install", "0.2.0");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /omarchy-finance\.service does not run Finance from .*\/app\. Set it up with .*\/app\/setup\n$/);
    assert.equal(s.head(), before);
  }
  assert.equal(s.restarts(), 0);
});

test("install leaves a checkout with local changes alone", (t) => {
  const s = sandbox(t);
  s.release("0.1.0", { "file.txt": "one\n" });
  s.install();
  s.release("0.2.0", { "file.txt": "two\n" });
  writeFileSync(join(s.app, "file.txt"), "mine\n");
  const before = s.head();

  const r = s.run("install", "0.2.0");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /local changes/);
  assert.equal(s.head(), before);
  assert.equal(readFileSync(join(s.app, "file.txt"), "utf8"), "mine\n");
  assert.equal(s.restarts(), 0);
});

test("install keeps local changes to files the release does not touch", (t) => {
  const s = sandbox(t);
  s.release("0.1.0", { "file.txt": "one\n" });
  s.install();
  // Going back from this release would otherwise reset the whole checkout.
  s.release("0.2.0", { broken: "x\n" });
  writeFileSync(join(s.app, "file.txt"), "mine\n");
  const before = s.head();

  const r = s.run("install", "0.2.0");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /local changes/);
  assert.equal(s.head(), before);
  assert.equal(readFileSync(join(s.app, "file.txt"), "utf8"), "mine\n");
});

test("install leaves a checkout with local commits alone", (t) => {
  const s = sandbox(t);
  s.release("0.1.0");
  s.install();
  s.release("0.2.0");
  writeFileSync(join(s.app, "mine.txt"), "mine\n");
  s.git(s.app, "add", "mine.txt");
  s.git(s.app, "commit", "--quiet", "-m", "Mine");
  const before = s.head();

  const r = s.run("install", "0.2.0");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /local commits/);
  assert.equal(s.head(), before);
  assert.equal(s.restarts(), 0);
});

test("refuses a copy that is not its own checkout", (t) => {
  const s = sandbox(t);
  s.release("0.1.0");
  s.install();
  // A copy inside a repository that keeps the whole home directory.
  const nested = join(s.app, "copy");
  mkdirSync(nested, { recursive: true });
  copyFileSync(SCRIPT, join(nested, "update"));

  const r = spawnSync(join(nested, "update"), ["check"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a git checkout/);
});

test("rejects versions that are not releases", (t) => {
  const s = sandbox(t);
  s.release("0.1.0");
  s.install();
  for (const version of ["", "v0.2.0", "0.2", "0.2.0-rc.1", "0.2.0;true"]) {
    const r = s.run("install", version);
    assert.equal(r.status, 1, version);
    assert.match(r.stderr, /not a release version/);
  }
  assert.equal(s.restarts(), 0);
});

test("version names the installed release", (t) => {
  const s = sandbox(t);
  s.commit("Initial");
  s.install();
  assert.equal(s.run("version").stdout, "", "before the first release");

  s.release("0.1.0");
  s.git(s.origin, "tag", "v0.2.0-rc.1"); // a candidate is no release
  rmSync(s.app, { recursive: true });
  s.install();
  assert.equal(s.run("version").stdout, "0.1.0\n");

  s.commit("Unreleased");
  rmSync(s.app, { recursive: true });
  s.install();
  assert.match(s.run("version").stdout, /^0\.1\.0-1-g[0-9a-f]+\n$/);
});
