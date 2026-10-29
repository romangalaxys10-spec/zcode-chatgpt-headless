#!/usr/bin/env node
/**
 * Monthly rollup: last ~30 days of GPT usage + guard events into
 * Zcode Brain/sessions/YYYY-MM-monthly.md. Called automatically from the
 * nightly report on the 1st of each month; force with
 * CHATGPT_HL_FORCE_MONTHLY=1.
 */
import fs from "node:fs";
import path from "node:path";
import { usageReport, readActivity } from "../mcp/lib.mjs";
import { uploadFile, HAS_TOKEN } from "./brain-sync.mjs";

export async function buildMonthlyRollup() {
  const u = usageReport(30);
  const events = readActivity(30);
  let blocks = 0, warns = 0, flagged = 0;
  for (const e of events) {
    if (e.kind === "guard" && (e.verdict === "deny-extreme" || e.verdict === "deny-gpt")) blocks++;
    else if (e.kind === "guard" && e.verdict === "warn") warns++;
    else if (e.kind === "review" && e.flagged) flagged++;
  }
  const fmt = (obj) => Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(", ") || "none";
  const now = new Date();
  const label = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  return {
    md:
      `# Monthly rollup — ${label}\n\n` +
      `Window: last 30 days (${u.windowStart} → ${now.toISOString().slice(0, 10)})\n\n` +
      `## GPT activity\n` +
      `- Total calls: ${u.totalCalls} (errors: ${u.errors})\n` +
      `- By feature: ${fmt(u.byFeature)}\n` +
      `- By model: ${fmt(u.byModel)}\n` +
      `- By day: ${fmt(u.byDay)}\n\n` +
      `## Safety (30 days)\n` +
      `- Blocked edits: ${blocks}\n` +
      `- Warnings: ${warns}\n` +
      `- Flagged reviews: ${flagged}\n`,
    remotePath: `Zcode Brain/sessions/${label}-monthly.md`,
    label,
  };
}

export async function main() {
  const force = process.env.CHATGPT_HL_FORCE_MONTHLY === "1";
  if (!force && new Date().getDate() !== 1) {
    console.log("monthly-rollup: not the 1st — skipped");
    return;
  }
  if (!HAS_TOKEN) {
    console.error("monthly-rollup: no token — skipped");
    return;
  }
  const { md, remotePath } = await buildMonthlyRollup();
  const r = await uploadFile(remotePath, md, `monthly rollup ${path.basename(remotePath)}`);
  console.log(`monthly-rollup: ${r.pushed ? "pushed" : "unchanged"} → ${remotePath}`);
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
    console.error(`monthly-rollup error: ${e.message}`);
    process.exit(1);
  });
}
