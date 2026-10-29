#!/usr/bin/env node
/**
 * PreToolUse guard: BEFORE an Edit/Write lands, scan it for dangerous
 * patterns. Extreme patterns hard-block instantly (no GPT call). Suspicious
 * ones get a fast GPT verdict — "high" danger blocks, "medium" warns.
 * Benign edits pass through silently with zero latency added.
 *
 * Modes via CHATGPT_HL_GUARD_MODE: "block" (default) | "warn" | "off".
 *
 * Manual smoke tests:
 *   printf '%s\n' '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"x","new_string":"a = 1"}}' | node hooks/guard-dangerous-edits.mjs
 *   printf '%s\n' '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"x.sh","content":"rm -rf /"}}' | node hooks/guard-dangerous-edits.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatgptAsk, logActivity } from "../mcp/lib.mjs";

const MODE = (process.env.CHATGPT_HL_GUARD_MODE || "block").toLowerCase();
const GUARD_TIMEOUT_MS = 20000;
const MAX_CODE_CHARS = 6000;
const GPT_COOLDOWN_MS = 60000;
const STATE_FILE = path.join(os.tmpdir(), "chatgpt-headless-guard-state.json");

// Patterns that block instantly — no model call needed.
const EXTREME_PATTERNS = [
  [/(^|\s|["'&])(rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|\$HOME|\*))/, "recursive delete of root/home"],
  [/:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;:/, "fork bomb"],
  [/mkfs(\.|\s)/, "filesystem format"],
  [/dd\s+[^;|&]*of=\/dev\/(disk|sd|nvme|hd)/, "raw disk overwrite"],
  [/-----BEGIN[ A-Z]*PRIVATE KEY-----/, "private key written into file"],
];

// Patterns that trigger a GPT verdict.
const SUSPICIOUS_PATTERNS = [
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/, "recursive rm"],
  [/\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i, "destructive SQL"],
  [/git\s+(reset\s+--hard|push\s+--force|clean\s+-fd|checkout\s+--\s)/, "destructive git"],
  [/\bsudo\b/, "sudo usage"],
  [/chmod\s+(-R\s+)?777/, "world-writable permissions"],
  [/(curl|wget)[^;\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, "pipe-to-shell install"],
  [/AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}/, "hardcoded credential"],
  [/\bos\.system\s*\(|subprocess\.call\s*\([^)]*shell\s*=\s*True/, "shell execution"],
  [/eval\s*\(\s*(user|input|request|raw)/i, "eval on user input"],
];

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

function finish(output) {
  if (output) process.stdout.write(JSON.stringify(output));
  process.exit(0);
}
function decision(eventName, permissionDecision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision,
      permissionDecisionReason: reason || undefined,
    },
  };
}

let input = {};
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  finish();
}
const eventName = input.hook_event_name || input.hookEventName || "PreToolUse";
if (MODE === "off") finish();
const toolName = input.tool_name || input.toolName || "";
if (toolName !== "Edit" && toolName !== "Write") finish();

const ti = input.tool_input || input.toolInput || {};
const file = ti.file_path || ti.filePath || "unknown file";
const changed =
  toolName === "Write"
    ? String(ti.content || "")
    : String(ti.new_string || ti.newString || "");

// 1) Extreme patterns → instant deny (even in warn mode these block;
//    downgrade to warn only via CHATGPT_HL_GUARD_MODE=warn explicitly).
for (const [re, why] of EXTREME_PATTERNS) {
  if (re.test(changed)) {
    logActivity({ kind: "guard", verdict: "deny-extreme", file: path.basename(file), reason: why });
    if (MODE === "warn") {
      finish(decision(eventName, "allow", undefined));
      // allow + context below is nicer, but keep it simple: warn mode allows.
    }
    finish(
      decision(
        eventName,
        "deny",
        `[chatgpt-headless guard] BLOCKED edit to ${file}: ${why}. ` +
          "If this is truly intended, ask the user to set CHATGPT_HL_GUARD_MODE=warn and retry."
      )
    );
  }
}

// 2) Suspicious patterns → GPT verdict (throttled).
const hits = [];
for (const [re, why] of SUSPICIOUS_PATTERNS) {
  if (re.test(changed)) hits.push(why);
}
if (hits.length === 0) finish(); // benign: silent allow, zero latency

try {
  const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (Date.now() - st.lastCheck < GPT_COOLDOWN_MS) {
    process.stderr.write("[chatgpt-headless] guard: GPT check skipped (cooldown)\n");
    finish(); // fail-open during cooldown
  }
} catch {
  /* no state */
}
try {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastCheck: Date.now() }));
} catch {
  /* best effort */
}

const prompt =
  `A code edit to "${path.basename(file)}" matched these risk signals: ${hits.join(", ")}. ` +
  "Judge whether the change AS WRITTEN could destroy data, break the system, or leak secrets " +
  "(not style, not hypotheticals — the actual code). " +
  "First line exactly: DANGER: high | DANGER: medium | DANGER: low — then max 2 short sentences.\n\n" +
  "```\n" + changed.slice(0, MAX_CODE_CHARS) + "\n```";

let level = null;
let reason = "";
try {
  const r = await chatgptAsk({
    prompt,
    model: "fast",
    instructions: "You are a security-minded code reviewer. Answer in the exact format requested.",
    timeout_ms: GUARD_TIMEOUT_MS,
  });
  const m = /DANGER:\s*(high|medium|low)/i.exec(r.text || "");
  level = m ? m[1].toLowerCase() : null;
  reason = (r.text || "").replace(/\s+/g, " ").slice(0, 300);
} catch (e) {
  process.stderr.write(`[chatgpt-headless] guard GPT check failed (allowed): ${e.message}\n`);
  finish(); // fail-open
}

if (level === "high" && MODE === "block") {
  logActivity({ kind: "guard", verdict: "deny-gpt", file: path.basename(file), reason: reason.slice(0, 120) });
  finish(
    decision(
      eventName,
      "deny",
      `[chatgpt-headless guard] GPT rated this edit HIGH danger (${hits.join(", ")}): ${reason} ` +
        "Rework it, or if truly intended ask the user to set CHATGPT_HL_GUARD_MODE=warn."
    )
  );
}
if (level === "high" || level === "medium") {
  logActivity({ kind: "guard", verdict: level === "high" ? "warn" : "warn", level, file: path.basename(file), reason: reason.slice(0, 120) });
  const out = decision(eventName, "allow", undefined);
  out.hookSpecificOutput.additionalContext =
    `[chatgpt-headless guard warning for ${file}] risk signals: ${hits.join(", ")}. GPT: ${reason}`;
  finish(out);
}
process.stderr.write(`[chatgpt-headless] guard: ok (${level || "unparsed"}) for ${file}\n`);
finish();
