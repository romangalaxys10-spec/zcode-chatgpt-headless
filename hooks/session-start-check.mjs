#!/usr/bin/env node
/**
 * SessionStart hook: verify chatgpt-headless is healthy the moment a session
 * opens — auth valid (refreshed if expiring), plugin files intact, and NOT a
 * stale version (a newer one installed after this session's plugin loaded).
 * Result is injected as context so the agent knows immediately whether the
 * GPT tools are usable, instead of discovering a failure mid-debate.
 *
 * Manual smoke test:
 *   printf '%s\n' '{"hook_event_name":"SessionStart","source":"startup"}' \
 *     | ZCODE_PLUGIN_ROOT="$HOME/.zcode/cli/plugins/cache/zcode-plugins-official/chatgpt-headless/0.4.1" \
 *       node hooks/session-start-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { decodeJwtPayload, logActivity } from "../mcp/lib.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  /* proceed with defaults */
}
const eventName = input.hook_event_name || input.hookEventName || "SessionStart";

const root = process.env.ZCODE_PLUGIN_ROOT || path.dirname(path.dirname(import.meta.url.replace("file://", "")));
const problems = [];
let runningVersion = "?";
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".zcode-plugin", "plugin.json"), "utf8"));
  runningVersion = manifest.version;
} catch {
  problems.push("plugin manifest unreadable — reinstall the plugin");
}
for (const f of ["mcp/server.mjs", "mcp/lib.mjs"]) {
  try {
    fs.accessSync(path.join(root, f));
  } catch {
    problems.push(`missing ${f} — reinstall the plugin`);
  }
}

// Stale-version detection: is there a newer deployed version than this session loaded?
try {
  const parent = path.dirname(root);
  const versions = fs
    .readdirSync(parent)
    .filter((d) => /^\d+\.\d+\.\d+$/.test(d))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const newest = versions[versions.length - 1];
  if (newest && newest !== path.basename(root)) {
    problems.push(
      `this session runs v${path.basename(root)} but v${newest} is installed — ` +
        "GPT tools may be missing/stale; tell the user a new chat (or app restart) fixes it"
    );
    runningVersion = `${path.basename(root)} (stale, newest ${newest})`;
  }
} catch {
  /* can't compare — not fatal */
}

// Auth check: verify JWT locally (no network); refresh if unverifiable,
// expired, or expiring within 2 minutes. loadAuth performs the actual refresh.
const authFile =
  process.env.CHATGPT_HL_AUTH_FILE ||
  process.env.CODEX_AUTH_FILE ||
  path.join(process.env.HOME || "~", ".codex", "auth.json");
let authOk = false;
try {
  const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
  const payload = auth.tokens ? decodeJwtPayload(auth.tokens.access_token) : null;
  const exp = payload && payload.exp ? payload.exp * 1000 : 0;
  if (auth.tokens && auth.tokens.access_token && exp && exp - Date.now() > 120_000) {
    authOk = true; // verifiably fresh — no network needed
  } else {
    const { loadAuth } = await import("../mcp/lib.mjs");
    await loadAuth(); // refreshes (and writes back) on success, throws on failure
    authOk = true;
  }
} catch (e) {
  problems.push(`ChatGPT auth not working (${String(e.message).slice(0, 120)}) — tell the user to run "codex login"`);
}

logActivity({ kind: "session_start", version: runningVersion, ok: problems.length === 0 });

const base = authOk
  ? `chatgpt-headless v${runningVersion} ready: GPT tools (chatgpt_ask, chatgpt_panel, chatgpt_models, chatgpt_usage, chatgpt_status) and guard/review hooks are live.`
  : `chatgpt-headless v${runningVersion}: GPT tools will FAIL until auth is fixed.`;
const context = problems.length ? `${base} Issues: ${problems.join("; ")}.` : base;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: context },
  })
);
process.exit(0);
