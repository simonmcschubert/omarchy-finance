// What the update button shows (app/update.mjs). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { updateButton } from "../app/update.mjs";

const idle = { checking: false, error: "", current: false };
const server = (fields) => ({ status: "", version: "", error: "", installed: "0.1.0", checking: false, boot: "b", ...fields });

test("the button checks for updates when there is nothing to offer", () => {
  assert.deepEqual(updateButton(server({}), idle), {
    icon: "refresh", text: "", tone: "", tip: "Finance 0.1.0 is installed. Click to check for updates.",
  });
  assert.equal(updateButton(server({ installed: "" }), idle).tip, "Click to check for updates.", "before the first release");
  assert.equal(updateButton(null, idle).tip, "Click to check for updates.", "before the server answers");
  assert.equal(updateButton(server({ checking: true }), idle).busy, true, "the timer's check turns it too");
});

test("the button says what the check it asked for found", () => {
  assert.deepEqual(updateButton(server({}), { ...idle, checking: true }), {
    icon: "refresh", text: "", tone: "", tip: "Checking for updates…", busy: true,
  });
  assert.deepEqual(updateButton(server({}), { ...idle, current: true }), {
    icon: "refresh", text: "Up to date", tone: "", tip: "Finance 0.1.0 is up to date.",
  });
  assert.deepEqual(updateButton(server({}), { ...idle, error: "can't reach origin" }), {
    icon: "alert", text: "Can't check", tone: "red", tip: "Can't check for updates: can't reach origin. Click to try again.",
  });
});

test("the button offers a release step by step", () => {
  const steps = ["available", "downloading", "downloaded", "installing"].map((status) => updateButton(server({ status, version: "0.2.0" }), idle));
  assert.deepEqual(steps.map((b) => b.text), ["Update", "Downloading", "Restart to update", "Updating"]);
  assert.deepEqual(steps.map((b) => b.tone), ["accent", "accent", "accent", "accent"]);
  assert.equal(steps[2].tip, "Finance 0.2.0 is downloaded. Click to restart Finance with it. Your data stays as it is.");
  assert.equal(steps[3].busy, true);
});

test("a failed update says why as a sentence", () => {
  const failed = (error) => updateButton(server({ status: "failed", version: "0.2.0", error }), idle);
  assert.equal(failed("can't download Finance 0.2.0").tip, "Can't download Finance 0.2.0. Click to try again.");
  assert.equal(failed("Finance 0.2.0 did not start, so Finance stays as it was. See: journalctl --user -u omarchy-finance.service").tip,
    "Finance 0.2.0 did not start, so Finance stays as it was. See: journalctl --user -u omarchy-finance.service. Click to try again.");
  assert.equal(failed("").tip, "Can't update to Finance 0.2.0. Click to try again.");
  assert.equal(failed("x").tone, "red");
});
