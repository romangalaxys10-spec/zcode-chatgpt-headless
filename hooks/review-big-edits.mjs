#!/usr/bin/env node
/**
 * PostToolUse hook: after a LARGE Edit/Write, quietly ask GPT (fast model)
 * to scan for obvious bugs and inject findings as context. Silent unless
 * GPT flags something. Small edits are skipped; reviews are throttled so
 * long sessions don't spam the account.
 *
 * Manual smoke test:
 *   printf '%s\n' '{"hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"x.py","content":"...big code..."}}' \
 *     | node hooks/review-big-edits.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatgptAsk, logActivity } from "../mcp/lib.mjs";

const MIN_CHARS = parseInt(
  process.env.CHATGPT_HL_REVIEW_MIN_CHARS || "400",
  10
);
const COOLDOWN_MS = parseInt(
  process.env.CHATGPT_HL_REVIEW_COOLDOWN_MS || "300000",
  10
);
const REVIEW_TIMEOUT_MS = 25000;
const MAX_CODE_CHARS = 8000;
const STATE_FILE = path.join(os.tmpdir(), "chatgpt-headless-review-state.json");

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

function finish(output) {
  if (output) process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

let input = {};
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  finish(); // never block the edit flow on a bad hook payload
}

const toolName = input.tool_name || input.toolName || "";
if (toolName !== "Edit" && toolName !== "Write") finish();

const ti = input.tool_input || input.toolInput || {};
const file = ti.file_path || ti.filePath || "unknown file";
const changed =
  toolName === "Write"
    ? String(ti.content || "")
    : String(ti.new_string || ti.newString || "");
if (changed.length < MIN_CHARS) finish();

// Throttle: at most one GPT review per cooldown window.
try {
  const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (Date.now() - st.lastReview < COOLDOWN_MS) {
    process.stderr.write(
      `[chatgpt-headless] review skipped (cooldown, last ${(Date.now() - st.lastReview) / 1000 | 0}s ago)\n`
    );
    finish();
  }
} catch {
  /* no state yet */
}
try {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastReview: Date.now() }));
} catch {
  /* best effort */
}

const code = changed.slice(0, MAX_CODE_CHARS);
const prompt =
  `You are a code reviewer. Scan this just-written change to "${path.basename(file)}" for ` +
  "OBVIOUS problems only: logic errors, wrong identifiers, security issues (injection, path traversal, secret leaks), " +
  "or broken error handling. Do NOT comment on style, naming, tests, or documentation. " +
  "Reply with exactly LGTM if nothing important is wrong; otherwise max 5 short bullets, most severe first.\n\n" +
  "```\n" + code + "\n```";

try {
  const r = await chatgptAsk({
    prompt,
    model: "fast",
    instructions: "You are a laconic senior code reviewer. Be blunt and concrete.",
    timeout_ms: REVIEW_TIMEOUT_MS,
  });
  const reply = (r.text || "").trim();
  const flagged = Boolean(reply) && !/^LGTM\b/i.test(reply);
  logActivity({ kind: "review", model: r.model, ok: true, flagged, file: path.basename(file) });
  if (flagged) {
    finish({
      hookSpecificOutput: {
        hookEventName: input.hook_event_name || input.hookEventName || "PostToolUse",
        additionalContext:
          `[chatgpt-headless auto-review of ${file} by ${r.model} — fix or explicitly justify:] ` +
          reply.replace(/\s+/g, " ").slice(0, 1200),
      },
    });
  }
  process.stderr.write(`[chatgpt-headless] GPT review of ${file}: LGTM\n`);
} catch (e) {
  logActivity({ kind: "review", ok: false, error: e.message.slice(0, 120), file: path.basename(file) });
  process.stderr.write(`[chatgpt-headless] review failed (ignored): ${e.message}\n`);
}
finish();
