#!/usr/bin/env node
/**
 * brain-sync.mjs — auto-sync chatgpt-headless plugin files + knowledge to the
 * "Zcode Brain" folder of the Antigravity-Brain-Backup repo via the GitHub
 * contents API (the repo is ~900MB, so git clone is impractical).
 *
 * Token: env GH_BRAIN_TOKEN or ~/.chatgpt-headless/gh-token (mode 600).
 * Only ever touches "Zcode Brain/plugin/..." paths in the repo.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const REPO = "romangalaxys10-spec/Antigravity-Brain-Backup";
const BRANCH = "main";
const REMOTE_DIR = "Zcode Brain/plugin/chatgpt-headless";
const STATE_FILE = path.join(os.homedir(), ".chatgpt-headless", "brain-sync-state.json");
const TOKEN =
  process.env.GH_BRAIN_TOKEN ||
  (() => {
    try {
      return fs.readFileSync(path.join(os.homedir(), ".chatgpt-headless", "gh-token"), "utf8").trim();
    } catch {
      return "";
    }
  })();

export const HAS_TOKEN = Boolean(TOKEN);

const ROOT = path.resolve(import.meta.dirname, "..");
const FILES = [
  "README.md",
  ".zcode-plugin/plugin.json",
  ".mcp.json",
  "mcp/lib.mjs",
  "mcp/server.mjs",
  "scripts/live-preview.mjs",
  "scripts/daily-report.mjs",
  "scripts/usage-report.mjs",
  "scripts/brain-sync.mjs",
  "scripts/weekly-rollup.mjs",
  "scripts/monthly-rollup.mjs",
  "scripts/failure-alert.mjs",
  "hooks/hooks.json",
  "hooks/guard-dangerous-edits.mjs",
  "hooks/review-big-edits.mjs",
  "hooks/session-start-check.mjs",
  "hooks/sync-plugin-changes.mjs",
  "commands/gpt.md",
  "commands/gptf.md",
  "commands/debate.md",
  "commands/preview.md",
  "commands/report.md",
  "commands/usage.md",
];

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function gh(pathname, init = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Authorization: `bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  return res;
}

async function remoteFile(remotePath) {
  try {
    const res = await gh(
      `/repos/${REPO}/contents/${encodeURIComponent(remotePath).replaceAll("%2F", "/").replaceAll("%20", "%20")}?ref=${BRANCH}`
    );
    if (!res.ok) return null;
    const d = await res.json();
    return { sha: d.sha, content: Buffer.from(d.content, "base64").toString("utf8") };
  } catch {
    return null;
  }
}

export async function uploadFile(remotePath, content, message) {
  const existing = await remoteFile(remotePath);
  if (existing && existing.content === content) return { pushed: false };
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: BRANCH,
  };
  if (existing) body.sha = existing.sha;
  const res = await gh(
    `/repos/${REPO}/contents/${encodeURIComponent(remotePath).replaceAll("%2F", "/").replaceAll("%20", "%20")}`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`upload ${remotePath}: HTTP ${res.status}`);
  return { pushed: true };
}

const HISTORY_FILE = path.join(os.homedir(), ".chatgpt-headless", "brain-sync-history.jsonl");
const LOCK_FILE = path.join(os.homedir(), ".chatgpt-headless", "brain-sync.lock");
const LOCK_STALE_MS = 10 * 60_000; // a crashed run must never block forever

/** Record one sync outcome (timestamps/status/safe summary only — no secrets). */
export function recordHistory(status, detail = "") {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(
      HISTORY_FILE,
      JSON.stringify({ t: new Date().toISOString(), status, detail: String(detail).slice(0, 160) }) + "\n"
    );
    // Keep the log bounded (~200 events).
    try {
      const lines = fs.readFileSync(HISTORY_FILE, "utf8").trim().split("\n");
      if (lines.length > 200) fs.writeFileSync(HISTORY_FILE, lines.slice(-100).join("\n") + "\n");
    } catch { /* fine */ }
  } catch { /* history must never break syncing */ }
}

/**
 * Exclusive sync lock. Atomic via wx flag (fails if the file exists).
 * A lock older than LOCK_STALE_MS is treated as stale and taken over.
 */
function acquireLock() {
  const writeLock = () => {
    try {
      // O_TRUNC+wx-equivalent: remove then create exclusively. The window is
      // tiny; wx on the fresh path keeps the common case atomic.
      fs.rmSync(LOCK_FILE, { force: true });
      const fd = fs.openSync(LOCK_FILE, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, t: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, t: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") return false; // real FS problem → fail closed
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    } catch { /* corrupt or empty */ }
    if (!info || typeof info.t !== "number" || Date.now() - info.t > LOCK_STALE_MS) {
      return writeLock(); // stale/corrupt — atomic retake
    }
    return false; // a live sync holds it
  }
}
function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

async function main() {
  if (!HAS_TOKEN) {
    console.error("brain-sync: no token (set GH_BRAIN_TOKEN or ~/.chatgpt-headless/gh-token)");
    process.exit(1);
  }
  if (!acquireLock()) {
    console.log("brain-sync skipped — another sync is running (or lock fresh).");
    recordHistory("skipped-busy");
    process.exit(0);
  }
  try {
    await runSync();
  } catch (e) {
    recordHistory("error", e.message);
    throw e;
  } finally {
    releaseLock();
  }
}

async function runSync() {
  // Stamp run time so the sync hook can debounce rapid edit bursts.
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(STATE_FILE), "brain-sync-last-run"), String(Date.now()));
  } catch { /* cosmetic */ }
  const state = loadState();
  let pushed = 0;
  const changes = [];
  let failures = 0;
  let retriedYet = false; // first failed file waits 30s before its retry, later ones 5s

  for (const rel of FILES) {
    const local = path.join(ROOT, rel);
    let content;
    try {
      content = fs.readFileSync(local, "utf8");
    } catch {
      continue; // file not present in this version
    }
    const hash = sha256(content);
    if (state[rel] === hash) continue; // unchanged since last sync

    const remotePath = `${REMOTE_DIR}/${rel}`;
    let existing = await remoteFile(remotePath);
    if (existing && existing.content === content) {
      state[rel] = hash; // remote already matches; just record it
      continue;
    }
    const putUrl = `/repos/${REPO}/contents/${encodeURIComponent(remotePath).replaceAll("%2F", "/").replaceAll("%20", "%20")}`;
    const makeInit = () => ({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `sync(chatgpt-headless): update ${rel}`,
        content: Buffer.from(content).toString("base64"),
        branch: BRANCH,
        ...(existing ? { sha: existing.sha } : {}),
      }),
    });
    let res = await gh(putUrl, makeInit());
    if (!res.ok && res.status !== 401 && res.status !== 403) {
      // one retry per file: refresh sha (409 races) and try again after a pause
      const waitMs = retriedYet ? 5_000 : 30_000;
      retriedYet = true;
      console.log(`${rel}: HTTP ${res.status} — retrying once in ${waitMs / 1000}s…`);
      await new Promise((r) => setTimeout(r, waitMs));
      const fresh = await remoteFile(remotePath);
      if (fresh && fresh.content === content) {
        state[rel] = hash; // identical content landed meanwhile (race) — done
        continue;
      }
      if (fresh) existing = fresh;
      res = await gh(putUrl, makeInit());
    }
    if (res.ok) {
      state[rel] = hash;
      pushed++;
      changes.push(rel);
      console.log(`pushed: ${rel}`);
    } else {
      failures++;
      console.error(`FAILED ${rel}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    }
  }

  saveState(state);
  recordHistory(
    failures ? "partial" : "ok",
    `${pushed} pushed, ${FILES.length - pushed} unchanged${failures ? `, ${failures} failed` : ""}`
  );
  console.log(`brain-sync done — ${pushed} file(s) pushed, ${FILES.length - pushed} unchanged.`);
}

// Run the full sync only when executed directly (not when imported for uploadFile).
// realpath on both sides: plugin dir is reached through the "current" symlink.
const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] &&
      fs.realpathSync(path.resolve(process.argv[1])) ===
        fs.realpathSync(new URL(import.meta.url).pathname)
    );
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`brain-sync error: ${e.message}`);
    process.exit(1);
  });
}
