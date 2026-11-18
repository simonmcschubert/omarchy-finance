// The update button in the header. The server looks for updates of Finance
// (server.py, Updater); this shows what it found, and asks it to check,
// download and install. The button is always there: a circle of arrows that
// checks for updates when clicked. When there is an update it becomes
// Update: one click downloads and installs it, and Finance restarts. An
// update downloaded otherwise (a terminal, or a window closed during the
// download) shows Restart to update. Settings has the channel: Stable for
// releases, Preview for every change once its tests pass.

const POLL = 60 * 1000; // ms between asking the server for news
const RESTART_POLL = 1000; // ms between asks while the server restarts
const RESTART_TRIES = 120; // then give up waiting for it
const CONFIRM = 4000; // ms that "Up to date" shows after a check

// How the page names an update: a release "0.2.0", or a preview's commit
// as "preview 1a2b3c4".
export function updateName(version) {
  return /^[0-9a-f]{40}$/.test(version) ? `preview ${version.slice(0, 7)}` : version;
}

// What the button shows: icon, text, tone (accent, red or none), tip, and
// busy (the icon turns). server is GET /api/update (null before the first
// answer); asked is the last check the button asked for.
export function updateButton(server, asked) {
  const s = server ?? { status: "", version: "", error: "", installed: "", channel: "", checking: false };
  const name = `Finance ${updateName(s.version)}`;
  switch (s.status) {
    case "available":
      return { icon: "download", text: "Update", tone: "accent",
        tip: `${name} is available. Click to install it and restart Finance. Your data stays as it is.` };
    case "downloading":
      return { icon: "download", text: "Downloading", tone: "accent", tip: `Downloading ${name}. Finance restarts with it once it is downloaded.` };
    case "downloaded":
      return { icon: "restart", text: "Restart to update", tone: "accent",
        tip: `${name} is downloaded. Click to restart Finance with it. Your data stays as it is.` };
    case "installing":
      return { icon: "restart", text: "Updating", tone: "accent", tip: `Installing ${name} and restarting Finance.`, busy: true };
    case "failed":
      return { icon: "alert", text: "Update failed", tone: "red", tip: `${sentence(s.error || `can't update to ${name}`)} Click to try again.` };
  }
  const installed = `${s.installed ? `Finance ${s.installed}` : "Finance"}${s.channel === "preview" ? " (Preview)" : ""}`;
  if (asked.checking || s.checking) return { icon: "refresh", text: "", tone: "", tip: "Checking for updates…", busy: true };
  if (asked.error) return { icon: "alert", text: "Can't check", tone: "red", tip: `Can't check for updates: ${asked.error}. Click to try again.` };
  if (asked.current) return { icon: "refresh", text: "Up to date", tone: "", tip: `${installed} is up to date.` };
  return { icon: "refresh", text: "", tone: "", tip: `${s.installed ? `${installed} is installed. ` : ""}Click to check for updates.` };
}

// The line under the channel choice in Settings. choosing is the switch
// the page asked for: busy, or the error it ended with.
export function channelNote(server, choosing) {
  if (choosing.busy) return "Switching…";
  if (choosing.error) return sentence(choosing.error);
  if (!server) return "";
  if (!server.channel) return "Finance can't update itself: its folder is not a git checkout.";
  return server.installed ? `Finance ${server.installed} is installed.` : "";
}

const CHANNELS = [
  ["stable", "Stable"],
  ["preview", "Preview"],
];

function sentence(text) {
  const trimmed = text.trim().replace(/\.$/, "");
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}

// 24×24, drawn with a 2px stroke in the text color.
const ICONS = {
  refresh: ["M4 12A8 8 0 0 1 18.93 8", "M19 3v5h-5", "M20 12A8 8 0 0 1 5.07 16", "M5 21v-5h5"],
  download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
  restart: ["M20 12A8 8 0 1 1 18.93 8", "M19 3v5h-5"],
  alert: ["M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16", "M12 8v5", "M12 16.5v.01"],
};

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shows the button in root. saving() tells whether the page has a change
// on its way to the server: a restart waits for it. Returns
// channelSettings(), the channel choice for Settings, which this keeps up
// to date.
export function startUpdates(root, { saving }) {
  let server = null;
  const asked = { checking: false, error: "", current: false };
  let confirmed = null;
  let restarting = false;
  const choosing = { busy: false, error: "" };
  let choice = null; // { buttons, note } of the choice on show in Settings

  async function call(method, body) {
    try {
      const response = await fetch("/api/update", {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await response.json();
      return response.ok ? { json } : { error: json?.error ?? `HTTP ${response.status}` };
    } catch {
      return { error: "the Finance server does not answer" };
    }
  }

  function render() {
    const b = updateButton(server, asked);
    const classes = ["update-button", b.tone, b.busy ? "busy" : ""].filter(Boolean).join(" ");
    const button = document.createElement("button");
    button.type = "button";
    button.className = classes;
    button.title = b.tip;
    button.setAttribute("aria-label", b.text ? `${b.text}. ${b.tip}` : b.tip);
    if (b.busy) button.setAttribute("aria-busy", "true");
    button.append(icon(b.icon));
    if (b.text) button.append(Object.assign(document.createElement("span"), { textContent: b.text }));
    button.addEventListener("click", act);
    const hadFocus = root.contains(document.activeElement);
    root.replaceChildren(button);
    if (hadFocus) button.focus();
    renderChoice();
  }

  // In place, so focus stays on the button that was clicked.
  function renderChoice() {
    if (!choice) return;
    const channel = server?.channel ?? "";
    for (const [value, button] of choice.buttons) {
      button.className = value === channel ? "seg active" : "seg";
      button.setAttribute("aria-pressed", String(value === channel));
      button.disabled = !channel || choosing.busy || asked.checking;
    }
    choice.note.textContent = channelNote(server, choosing);
  }

  function channelSettings() {
    const buttons = CHANNELS.map(([value, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => choose(value));
      return [value, button];
    });
    const group = Object.assign(document.createElement("div"), { className: "segmented" });
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Updates");
    group.append(...buttons.map(([, button]) => button));
    const note = document.createElement("p");
    note.setAttribute("role", "status");
    choice = { buttons, note };
    renderChoice();
    const box = document.createElement("div");
    box.append(group, note);
    return box;
  }

  async function refresh() {
    if (restarting) return;
    const { json } = await call("GET");
    if (!json || restarting) return;
    if (server && json.boot !== server.boot && json.installed !== server.installed) {
      // Another window or a terminal installed a release: this page is old.
      restarting = true;
      while (saving()) await sleep(100);
      location.reload();
      return;
    }
    server = json;
    render();
  }

  async function check() {
    if (asked.checking) return;
    Object.assign(asked, { checking: true, error: "", current: false });
    clearTimeout(confirmed);
    render();
    const { json, error } = await call("POST", { action: "check" });
    asked.checking = false;
    if (json) server = json;
    found(error ?? json.checkError);
    render();
  }

  // What a check the page asked for found: the button says so for a while.
  function found(error) {
    asked.error = error;
    if (!asked.error && server.status === "") {
      asked.current = true;
      confirmed = setTimeout(() => {
        asked.current = false;
        render();
      }, CONFIRM);
    }
  }

  // Switches the channel; the server checks it straight away.
  async function choose(channel) {
    if (choosing.busy || asked.checking || channel === server?.channel) return;
    Object.assign(choosing, { busy: true, error: "" });
    Object.assign(asked, { checking: true, error: "", current: false });
    clearTimeout(confirmed);
    render();
    const { json, error } = await call("POST", { action: "channel", channel });
    Object.assign(choosing, { busy: false, error: error ?? "" });
    asked.checking = false;
    if (json) {
      server = json;
      found(json.checkError);
    }
    render();
  }

  // Clicked Update: downloads it and installs it straight away, so the
  // button needs no second click.
  async function download() {
    server = { ...server, status: "downloading" };
    render();
    const { json, error } = await call("POST", { action: "download" });
    server = json ?? { ...server, status: "failed", error: `can't download Finance ${server.version}: ${error}` };
    if (server.status === "downloaded") return install();
    render();
  }

  // Installing restarts the server; the page reloads from the new one.
  async function install() {
    restarting = true;
    const boot = server.boot;
    server = { ...server, status: "installing" };
    render();
    while (saving()) await sleep(100);
    const { json } = await call("POST", { action: "install" });
    if (json) server = json;
    let misses = 0;
    while (server.status === "installing") {
      await sleep(RESTART_POLL);
      const { json } = await call("GET");
      if (json?.boot && json.boot !== boot) {
        while (saving()) await sleep(100);
        location.reload();
        return;
      }
      if (json) {
        // Still the old server: the install is under way, or failed before
        // the restart, and then the button says why.
        server = json;
        render();
      } else if (++misses >= RESTART_TRIES) {
        server = { ...server, status: "failed", error: "Finance did not start again. See: journalctl --user -u omarchy-finance" };
        render();
      }
    }
    restarting = false;
  }

  function act() {
    const status = server?.status ?? "";
    if (status === "") check();
    else if (status === "available" || status === "failed") download();
    else if (status === "downloaded") install();
  }

  render();
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, POLL);
  addEventListener("focus", refresh);
  return { channelSettings };
}
