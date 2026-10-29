/**
 * Shared library for chatgpt-headless: auth handling + headless GPT calls
 * against OpenAI's official Codex backend (chatgpt.com/backend-api/codex),
 * reusing OAuth tokens from ~/.codex/auth.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const API_BASE = "https://chatgpt.com/backend-api/codex";
export const AUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_SCOPE =
  "openid profile email offline_access model.request model.read organization.read organization.write";

export const DEFAULT_MODEL = "gpt-5.6-terra";
export const DEFAULT_INSTRUCTIONS =
  "You are a concise, expert assistant. Give direct, well-reasoned answers.";
export const DEFAULT_TIMEOUT_MS = 120000;

/** Friendly model aliases the agent/user can use in plain words. */
export const MODEL_ALIASES = {
  fast: "gpt-5.6-luna",
  quick: "gpt-5.6-luna",
  balanced: "gpt-5.6-terra",
  default: "gpt-5.6-terra",
  smart: "gpt-5.5",
  deep: "gpt-5.5",
  frontier: "gpt-5.5",
  mini: "gpt-5.4-mini",
  cheap: "gpt-5.4-mini",
};

export function resolveModel(m) {
  if (!m || typeof m !== "string") return null;
  return MODEL_ALIASES[m.trim().toLowerCase()] || m.trim();
}

export function envSetting(name, fallback) {
  const v = process.env[name];
  // Unsubstituted ${user_config.*} placeholders mean "not configured".
  if (!v || v.startsWith("${")) return fallback;
  return v;
}

export const CONFIG = {
  model: envSetting("CHATGPT_HL_MODEL", DEFAULT_MODEL),
  instructions: envSetting("CHATGPT_HL_INSTRUCTIONS", DEFAULT_INSTRUCTIONS),
  timeoutMs:
    parseInt(envSetting("CHATGPT_HL_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS)), 10) ||
    DEFAULT_TIMEOUT_MS,
};

export function authFilePath() {
  return (
    process.env.CHATGPT_HL_AUTH_FILE ||
    process.env.CODEX_AUTH_FILE ||
    path.join(os.homedir(), ".codex", "auth.json")
  );
}

// ---------------------------------------------------------------------------
// Activity log: metadata only (kind/model/file basename/verdict) — never
// prompts or code. Powers the nightly report and the usage dashboard.
// ---------------------------------------------------------------------------
export function activityFilePath() {
  return process.env.CHATGPT_HL_ACTIVITY_FILE ||
    path.join(os.homedir(), ".chatgpt-headless", "activity.jsonl");
}

export function logActivity(event) {
  try {
    const file = activityFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Rotate at ~1 MB so it can't grow forever.
    try {
      const st = fs.statSync(file);
      if (st.size > 1_000_000) fs.renameSync(file, file + ".old");
    } catch {
      /* not there yet */
    }
    fs.appendFileSync(
      file,
      JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n"
    );
  } catch {
    /* logging must never break the actual work */
  }
}

export function readActivity(days) {
  const cutoff = Date.now() - days * 86400_000;
  const events = [];
  try {
    const lines = fs.readFileSync(activityFilePath(), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (Date.parse(e.t) >= cutoff) events.push(e);
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* no file yet */
  }
  return events;
}

// ---------------------------------------------------------------------------
// Transcript log (optional, ON by default): full prompts + replies for the
// live preview page. Disable with CHATGPT_HL_TRANSCRIPTS=off. Local-only.
// ---------------------------------------------------------------------------
export function transcriptFilePath() {
  return process.env.CHATGPT_HL_TRANSCRIPT_FILE ||
    path.join(os.homedir(), ".chatgpt-headless", "transcripts.jsonl");
}

const SECRET_RE =
  /(sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{15,}|eyJ[A-Za-z0-9_-]{25,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----)/g;

function redact(s) {
  return String(s).replace(SECRET_RE, "[REDACTED]");
}

export function logTranscript(entry) {
  if ((process.env.CHATGPT_HL_TRANSCRIPTS || "on").toLowerCase() === "off") return;
  try {
    const file = transcriptFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const st = fs.statSync(file);
      if (st.size > 5_000_000) fs.renameSync(file, file + ".old");
    } catch {
      /* not there yet */
    }
    // entry first so the truncated+redacted fields below always win.
    fs.appendFileSync(
      file,
      JSON.stringify({
        ...entry,
        t: new Date().toISOString(),
        prompt: redact(entry.prompt || "").slice(0, 4000),
        reply: redact(entry.reply || "").slice(0, 8000),
      }) + "\n"
    );
  } catch {
    /* never break the actual work */
  }
}

/** Usage dashboard: GPT calls by feature, model, and day. */
export function usageReport(days = 7) {
  const events = readActivity(days).filter((e) =>
    ["ask", "panel", "review", "guard"].includes(e.kind)
  );
  const byFeature = {};
  const byModel = {};
  const byDay = {};
  let errors = 0;
  for (const e of events) {
    byFeature[e.kind] = (byFeature[e.kind] || 0) + 1;
    if (e.model) byModel[e.model] = (byModel[e.model] || 0) + 1;
    const day = e.t.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    if (e.ok === false) errors++;
  }
  return {
    days,
    windowStart: new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10),
    totalCalls: events.length,
    errors,
    byFeature,
    byModel,
    byDay,
    activityFile: activityFilePath(),
  };
}

/** Nightly report: what the guard blocked/warned and what reviews flagged (last 24h). */
export function dailyReport() {
  const events = readActivity(1);
  const blocks = [];
  const warns = [];
  const flagged = [];
  for (const e of events) {
    if (e.kind === "guard" && (e.verdict === "deny-extreme" || e.verdict === "deny-gpt")) {
      blocks.push(`${e.t.slice(11, 16)} ${e.verdict === "deny-extreme" ? "EXTREME" : "HIGH"} ${e.file}: ${e.reason || ""}`.trim());
    } else if (e.kind === "guard" && e.verdict === "warn") {
      warns.push(`${e.t.slice(11, 16)} ${e.file}: ${e.reason || ""}`.trim());
    } else if (e.kind === "review" && e.flagged) {
      flagged.push(`${e.t.slice(11, 16)} ${e.file}`);
    }
  }
  const asks = events.filter((e) => e.kind === "ask" || e.kind === "panel").length;
  return { blocks, warns, flaggedReviews: flagged, gptCalls: asks, activityFile: activityFilePath() };
}

export function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export async function loadAuth({ forceRefresh = false } = {}) {
  const file = authFilePath();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(
      `Cannot read ChatGPT auth at ${file}. Run "codex login" once to create it.`
    );
  }
  const tokens = raw && raw.tokens;
  if (!tokens || !tokens.access_token || !tokens.account_id) {
    throw new Error(
      `${file} has no ChatGPT OAuth tokens (auth_mode must be "chatgpt"). Run "codex login".`
    );
  }

  const payload = decodeJwtPayload(tokens.access_token);
  // Unverifiable JWT (null payload / no exp) is treated as needing a refresh,
  // not as a never-expiring token.
  const exp = payload && payload.exp ? payload.exp * 1000 : 0;
  const expiresIn = exp ? exp - Date.now() : 0;
  if (!forceRefresh && expiresIn > 120_000) {
    return { accessToken: tokens.access_token, accountId: tokens.account_id };
  }

  const refreshToken = tokens.refresh_token;
  if (!refreshToken) {
    throw new Error('No refresh_token in auth file. Run "codex login" again.');
  }

  let res;
  for (const body of [
    {
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: OAUTH_SCOPE,
    },
    { client_id: OAUTH_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken },
  ]) {
    res = await fetch(AUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok || res.status !== 400) break; // only retry without scope on 400
  }
  if (!res || !res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Token refresh failed (HTTP ${res ? res.status : "?"}). ${detail.slice(0, 200)} Run "codex login" to re-authenticate.`
    );
  }
  const refreshed = await res.json();
  const newAccess = refreshed.access_token || tokens.access_token;
  const newPayload = decodeJwtPayload(newAccess) || {};
  const authClaim = newPayload["https://api.openai.com/auth"] || {};
  const newAccount = refreshed.account_id || authClaim.chatgpt_account_id || tokens.account_id;

  // Write back in the Codex CLI format so codex and this plugin share state.
  try {
    raw.tokens = {
      id_token: refreshed.id_token || tokens.id_token,
      access_token: newAccess,
      refresh_token: refreshed.refresh_token || refreshToken,
      account_id: newAccount,
    };
    raw.last_refresh = new Date().toISOString();
    atomicWrite(file, JSON.stringify(raw, null, 2));
  } catch (e) {
    process.stderr.write(`chatgpt-headless: auth write-back failed: ${e.message}\n`);
  }
  return { accessToken: newAccess, accountId: newAccount };
}

/** POST /responses with SSE streaming; returns { text, status, model }. onDelta streams text incrementally. */
export async function streamChat({ prompt, model, instructions, timeoutMs, accessToken, accountId, onDelta }) {
  const body = {
    model,
    instructions,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
    ],
    store: false,
    stream: true,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        "Content-Type": "application/json",
        "OpenAI-Beta": "responses=experimental",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status}: ${detail.slice(0, 400)}`);
      err.statusCode = res.status;
      throw err;
    }

    let text = "";
    let status = "unknown";
    let outModel = model;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        if (evt.type === "response.output_text.delta") {
          const d = evt.delta || "";
          text += d;
          if (onDelta) onDelta(d);
        } else if (evt.type === "response.completed" || evt.type === "response.failed") {
          const r = evt.response || {};
          status = r.status || evt.type.replace("response.", "");
          outModel = r.model || outModel;
          if (status === "failed") {
            throw new Error(`Model response failed: ${(r.error && r.error.message) || "unknown"}`);
          }
        } else if (evt.type === "error") {
          throw new Error(evt.message || "stream error");
        }
      }
    }
    return { text, status, model: outModel };
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Timed out after ${timeoutMs} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Full ask flow: alias resolution, auth (with 401 retry), streaming. */
export async function chatgptAsk(args = {}) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required (non-empty string)");
  const model = resolveModel(args.model) || CONFIG.model;
  const instructions =
    typeof args.instructions === "string" && args.instructions
      ? args.instructions
      : CONFIG.instructions;
  const timeoutMs =
    Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : CONFIG.timeoutMs;

  let auth = await loadAuth();
  const t0 = Date.now();
  const source = typeof args.source === "string" && args.source ? args.source : undefined;
  try {
    const r = await streamChat({ prompt, model, instructions, timeoutMs, ...auth });
    logActivity({ kind: "ask", model: r.model || model, ok: true, source });
    logTranscript({ kind: "ask", model: r.model || model, prompt, reply: r.text, ok: true, ms: Date.now() - t0, source });
    return r;
  } catch (e) {
    if (e.statusCode === 401 || e.statusCode === 403) {
      auth = await loadAuth({ forceRefresh: true });
      const r = await streamChat({ prompt, model, instructions, timeoutMs, ...auth });
      logActivity({ kind: "ask", model: r.model || model, ok: true, source });
      logTranscript({ kind: "ask", model: r.model || model, prompt, reply: r.text, ok: true, ms: Date.now() - t0, source });
      return r;
    }
    logActivity({ kind: "ask", model, ok: false, error: e.message.slice(0, 120), source });
    logTranscript({ kind: "ask", model, prompt, reply: `Error: ${e.message}`, ok: false, ms: Date.now() - t0, source });
    throw e;
  }
}

/** Ask the same prompt at several models in parallel; one failure doesn't kill the rest. */
export async function chatgptPanel(args = {}) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required (non-empty string)");
  const rawModels = Array.isArray(args.models) && args.models.length ? args.models : ["fast", "smart"];
  const models = [...new Set(rawModels.map((m) => resolveModel(m) || CONFIG.model))];
  const instructions =
    typeof args.instructions === "string" && args.instructions
      ? args.instructions
      : CONFIG.instructions;
  const timeoutMs =
    Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : CONFIG.timeoutMs;

  const auth = await loadAuth();
  const results = await Promise.all(
    models.map(async (model) => {
      const t0 = Date.now();
      try {
        const r = await streamChat({ prompt, model, instructions, timeoutMs, ...auth });
        logActivity({ kind: "panel", model: r.model || model, ok: true });
        logTranscript({ kind: "panel", model: r.model || model, prompt, reply: r.text, ok: true, ms: Date.now() - t0 });
        return { model: r.model, ok: true, text: r.text };
      } catch (e) {
        logActivity({ kind: "panel", model, ok: false, error: e.message.slice(0, 120) });
        logTranscript({ kind: "panel", model, prompt, reply: `Error: ${e.message}`, ok: false, ms: Date.now() - t0 });
        return { model, ok: false, text: `Error: ${e.message}` };
      }
    })
  );
  return results;
}

export async function listModels() {
  const auth = await loadAuth();
  const res = await fetch(`${API_BASE}/models?client_version=0.149.0`, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.models || [])
    .filter((m) => m.visibility !== "hidden")
    .map((m) => ({
      slug: m.slug,
      name: m.display_name || m.slug,
      description: m.description || "",
      context_window: m.context_window,
    }));
}

export async function authStatus() {
  const file = authFilePath();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, error: `auth file unreadable: ${e.message}`, path: file };
  }
  const payload = raw.tokens ? decodeJwtPayload(raw.tokens.access_token) : null;
  const exp = payload && payload.exp ? new Date(payload.exp * 1000) : null;
  return {
    ok: Boolean(raw.tokens && raw.tokens.access_token),
    auth_mode: raw.auth_mode,
    path: file,
    account_id: raw.tokens ? `${raw.tokens.account_id.slice(0, 8)}…` : null,
    access_token_expires: exp ? exp.toISOString() : "unknown",
    access_token_expired: exp ? exp.getTime() < Date.now() : false,
    last_refresh: raw.last_refresh || null,
    default_model: CONFIG.model,
  };
}
