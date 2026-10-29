#!/usr/bin/env node
/**
 * Weekly rollup: summarizes the last 7 days of GPT usage + guard events into
 * Zcode Brain/sessions/<ISO-week>-weekly.md. Called automatically from the
 * nightly report on Sundays; force a run with CHATGPT_HL_FORCE_WEEKLY=1.
 */
import fs from "node:fs";
import path from "node:path";
import { usageReport, readActivity } from "../mcp/lib.mjs";
import { uploadFile, HAS_TOKEN } from "./brain-sync.mjs";

export async function buildWeeklyRollup() {
  const u = usageReport(7);
  const events = readActivity(7);
  let blocks = 0, warns = 0, flagged = 0;
  for (const e of events) {
    if (e.kind === "guard" && (e.verdict === "deny-extreme" || e.verdict === "deny-gpt")) blocks++;
    else if (e.kind === "guard" && e.verdict === "warn") warns++;
    else if (e.kind === "review" && e.flagged) flagged++;
  }
  const fmt = (obj) => Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(", ") || "none";
  const now = new Date();
  // ISO week number + label year
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  const label = `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;

  return {
    md:
      `# Weekly rollup — ${label}\n\n` +
      `Window: last 7 days (${u.windowStart} → ${now.toISOString().slice(0, 10)})\n\n` +
      `## GPT activity\n` +
      `- Total calls: ${u.totalCalls} (errors: ${u.errors})\n` +
      `- By feature: ${fmt(u.byFeature)}\n` +
      `- By model: ${fmt(u.byModel)}\n` +
      `- By day: ${fmt(u.byDay)}\n\n` +
      `## Safety (7 days)\n` +
      `- Blocked edits: ${blocks}\n` +
      `- Warnings: ${warns}\n` +
      `- Flagged reviews: ${flagged}\n`,
    remotePath: `Zcode Brain/sessions/${label}-weekly.md`,
    label,
  };
}

export async function main() {
  const force = process.env.CHATGPT_HL_FORCE_WEEKLY === "1";
  if (!force && new Date().getDay() !== 0) {
    console.log("weekly-rollup: not Sunday — skipped");
    return;
  }
  if (!HAS_TOKEN) {
    console.error("weekly-rollup: no token — skipped");
    return;
  }
  const { md, remotePath } = await buildWeeklyRollup();
  const r = await uploadFile(remotePath, md, `weekly rollup ${path.basename(remotePath)}`);
  console.log(`weekly-rollup: ${r.pushed ? "pushed" : "unchanged"} → ${remotePath}`);
}

// Run only when executed directly (not when imported); realpath both sides
// because the plugin dir is reached through the "current" symlink.
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
    console.error(`weekly-rollup error: ${e.message}`);
    process.exit(1);
  });
}
