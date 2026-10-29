#!/usr/bin/env node
/**
 * PostToolUse hook: whenever a Write/Edit touches a file inside the
 * chatgpt-headless plugin, fire a background brain-sync so changes land on
 * GitHub immediately. Fire-and-forget — never blocks or fails the edit.
 *
 * Smoke test:
 *   printf '%s\n' '{"hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"/x"}}' \
 *     | node hooks/sync-plugin-changes.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

const PLUGIN_ROOT = process.env.ZCODE_PLUGIN_ROOT || "";
const dir = path.join(PLUGIN_ROOT || ".", "scripts");
const script = path.join(dir, "brain-sync.mjs");

try {
  const input = raw.trim() ? JSON.parse(raw) : {};
  const eventName = input.hook_event_name || "";
  const file = input.tool_input && input.tool_input.file_path;
  // PostToolUse: sync only when the edit touched this plugin.
  // Stop (session end): always run one final sync.
  const inPlugin =
    PLUGIN_ROOT &&
    file &&
    path.resolve(file).startsWith(path.resolve(PLUGIN_ROOT) + path.sep);
  const forceSync = eventName === "Stop" || eventName === "SessionEnd";
  if ((inPlugin || forceSync) && PLUGIN_ROOT && fs.existsSync(script)) {
    // Debounce edit bursts: skip if a sync started <60s ago. Session-end
    // (forceSync) always runs — it's the final chance to catch anything.
    let debounced = false;
    if (!forceSync) {
      try {
        const stamp = path.join(os.homedir(), ".chatgpt-headless", "brain-sync-last-run");
        const last = parseInt(fs.readFileSync(stamp, "utf8"), 10);
        debounced = Number.isFinite(last) && Date.now() - last < 60_000;
      } catch { /* no stamp yet — run */ }
    }
    if (!debounced) {
      // detached: the hook returns instantly; sync runs in the background
      const child = spawn(process.execPath, [script], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.on("error", (e) =>
        process.stderr.write(`[chatgpt-headless] brain-sync spawn failed: ${e.message}\n`)
      );
      child.unref();
      process.stderr.write(
        `[chatgpt-headless] brain-sync ${forceSync ? "final (session end)" : `triggered by edit to ${path.basename(file)}`}\n`
      );
    } else {
      process.stderr.write("[chatgpt-headless] brain-sync debounced (ran <60s ago)\n");
    }
  }
} catch (e) {
  process.stderr.write(`[chatgpt-headless] sync hook skipped: ${e.message}\n`);
}
process.stdout.write("{}");
