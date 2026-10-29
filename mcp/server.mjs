#!/usr/bin/env node
/**
 * chatgpt-headless MCP server (stdio, newline-delimited JSON-RPC 2.0).
 * Tools: chatgpt_ask, chatgpt_models, chatgpt_status. Logic lives in lib.mjs.
 */
import readline from "node:readline";
import { chatgptAsk, chatgptPanel, listModels, authStatus, usageReport, MODEL_ALIASES } from "./lib.mjs";

const TOOLS = [
  {
    name: "chatgpt_ask",
    description:
      "Ask a GPT model from the user's ChatGPT account headlessly and get the full reply. " +
      "Use for brainstorming, second opinions on designs/decisions, or independent review of code or reasoning. " +
      "Include all relevant context in the prompt; the model sees nothing else.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The full question/prompt to send." },
        model: {
          type: "string",
          description:
            `Model slug or friendly alias. Aliases: ${Object.keys(MODEL_ALIASES).join(", ")} ` +
            `(fast=gpt-5.6-luna, balanced=gpt-5.6-terra, smart=gpt-5.5, mini=gpt-5.4-mini). ` +
            `Default: balanced. Run chatgpt_models for the live list.`,
        },
        instructions: { type: "string", description: "Optional system instructions override." },
        timeout_ms: { type: "number", description: "Optional per-request timeout override." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "chatgpt_panel",
    description:
      "Ask the SAME prompt at multiple GPT models in parallel (default fast + smart) and get " +
      "side-by-side answers. Catches cases where a cheap model is confidently wrong. " +
      "Use for high-stakes questions where a cross-check is worth double usage.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The full question/prompt to send to every model." },
        models: {
          type: "array",
          items: { type: "string" },
          description: `Model slugs or aliases (e.g. ["fast","smart"]). Default ["fast","smart"]. Aliases: ${Object.keys(MODEL_ALIASES).join(", ")}.`,
        },
        instructions: { type: "string", description: "Optional system instructions override." },
        timeout_ms: { type: "number", description: "Optional per-request timeout override." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "chatgpt_usage",
    description:
      "Show how many GPT calls this plugin made (chatgpt_ask/panel, auto-review, guard) " +
      "broken down by feature, model, and day — the usage dashboard for the user's plan quota.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Look-back window in days (default 7)." },
      },
    },
  },
  {
    name: "chatgpt_models",
    description:
      "List GPT model slugs available to this ChatGPT account on the Codex backend.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chatgpt_status",
    description: "Check ChatGPT OAuth auth status (token expiry, account, default model).",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(req) {
  const { id, method, params } = req;
  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "chatgpt-headless", version: "0.3.0" },
      });
      return;
    case "ping":
      sendResult(id, {});
      return;
    case "tools/list":
      sendResult(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        let text;
        if (name === "chatgpt_ask") {
          const r = await chatgptAsk(args);
          text = r.text || `(empty reply, status=${r.status})`;
        } else if (name === "chatgpt_panel") {
          const results = await chatgptPanel(args);
          text = results
            .map(
              (r) =>
                `=== ${r.model}${r.ok ? "" : " (FAILED)"} ===\n${r.text || "(empty reply)"}`
            )
            .join("\n\n");
        } else if (name === "chatgpt_usage") {
          const days = Number.isFinite(args.days) && args.days > 0 ? args.days : 7;
          const r = usageReport(days);
          const fmt = (obj) => Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(", ") || "none";
          text =
            `GPT calls, last ${r.days}d (since ${r.windowStart}) — total ${r.totalCalls}, errors ${r.errors}\n` +
            `by feature: ${fmt(r.byFeature)}\n` +
            `by model: ${fmt(r.byModel)}\n` +
            `by day: ${fmt(r.byDay)}\n` +
            `live preview (search + ask GPT): http://localhost:8788 — if down, /preview restarts it`;
        } else if (name === "chatgpt_models") {
          text = (await listModels())
            .map((m) => `${m.slug} — ${m.name}: ${m.description} (ctx ${m.context_window})`)
            .join("\n");
        } else if (name === "chatgpt_status") {
          text = JSON.stringify(await authStatus(), null, 2);
        } else {
          sendError(id, -32602, `Unknown tool: ${name}`);
          return;
        }
        sendResult(id, { content: [{ type: "text", text }] });
      } catch (e) {
        sendResult(id, {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        });
      }
      return;
    }
    default:
      if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
  }
}

const rlStdin = readline.createInterface({ input: process.stdin });
rlStdin.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req && req.method) {
    handleRequest(req).catch((e) => {
      if (req.id !== undefined) sendError(req.id, -32603, `Internal error: ${e.message}`);
    });
  }
});
rlStdin.on("close", () => process.exit(0));

process.stderr.write("chatgpt-headless MCP server started\n");
