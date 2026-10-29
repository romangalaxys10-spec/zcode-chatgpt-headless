#!/usr/bin/env node
/**
 * launchd-driven backup watchdog (LaunchAgent com.chatgpt-headless.brain-alert,
 * every 15 min). Two alert modes — works with NO browser open:
 *   1. FAILED backups: error/partial events in brain-sync-history.jsonl newer
 *      than ~/.chatgpt-headless/last-fail-alert → macOS notification.
 *   2. STALE backups: no sync run at all in 25h+ (brain-sync-last-run stamp)
 *      → notification, re-firing every 12h while still stale
 *      (last-stale-alert stamp).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DIR = path.join(os.homedir(), ".chatgpt-headless");
const HISTORY = path.join(DIR, "brain-sync-history.jsonl");
const FAIL_STAMP = path.join(DIR, "last-fail-alert");
const STALE_STAMP = path.join(DIR, "last-stale-alert");
const LAST_RUN = path.join(DIR, "brain-sync-last-run");
const STALE_AFTER_MS = 25 * 3600_000;
const RE_ALERT_MS = 12 * 3600_000;

function readStamp(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}
function writeStamp(file, value) {
  try {
    fs.writeFileSync(file, String(value));
  } catch { /* next run re-alerts; acceptable */ }
}
function notify(title, body) {
  try {
    execFileSync("osascript", [
      "-e",
      `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Basso"`,
    ]);
  } catch { /* headless — stamps still update */ }
}

// --- 1. failed backups since last alert ---
let events = [];
try {
  events = fs
    .readFileSync(HISTORY, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
} catch { /* no history yet */ }

const sinceFail = readStamp(FAIL_STAMP);
const bad = events.filter(
  (e) => (e.status === "error" || e.status === "partial") && e.t > sinceFail
);
if (bad.length) {
  const latest = bad[bad.length - 1];
  const title = bad.length === 1 ? "⚠️ brain-sync failed" : `⚠️ ${bad.length} brain-sync failures`;
  const body = `${latest.status}: ${latest.detail || "check the viewer"} · ${new Date(latest.t).toLocaleTimeString()}`;
  notify(title, body);
  writeStamp(FAIL_STAMP, latest.t);
}

// --- 2. stale backups: nothing has synced in 25h+ ---
try {
  const lastRun = parseInt(readStamp(LAST_RUN), 10);
  if (Number.isFinite(lastRun) && Date.now() - lastRun > STALE_AFTER_MS) {
    let lastStaleAlert = parseInt(readStamp(STALE_STAMP), 10);
    if (!Number.isFinite(lastStaleAlert)) lastStaleAlert = 0;
    if (Date.now() - lastStaleAlert > RE_ALERT_MS) {
      const hours = Math.round((Date.now() - lastRun) / 3600_000);
      notify("⏳ brain-sync stale", `last successful sync was ${hours}h ago — check the nightly job / server`);
      writeStamp(STALE_STAMP, Date.now());
    }
  }
} catch { /* no stamp yet */ }
