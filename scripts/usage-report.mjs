#!/usr/bin/env node
/**
 * Usage dashboard: GPT calls by feature, model, and day.
 * Usage: node usage-report.mjs [days]
 */
import { usageReport } from "../mcp/lib.mjs";

const days = Number.parseInt(process.argv[2] || "7", 10) || 7;
const r = usageReport(days);
const fmt = (obj) =>
  Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(", ") || "none";
console.log(`GPT calls, last ${r.days}d (since ${r.windowStart}) — total ${r.totalCalls}, errors ${r.errors}`);
console.log(`by feature: ${fmt(r.byFeature)}`);
console.log(`by model:   ${fmt(r.byModel)}`);
console.log(`by day:     ${fmt(r.byDay)}`);
console.log(`live preview (search + ask GPT): http://localhost:8788 — if down, /preview restarts it`);
