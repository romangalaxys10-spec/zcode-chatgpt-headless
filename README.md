# chatgpt-headless

A ZCode plugin that gives the coding agent headless access to **GPT models from your
ChatGPT account** — for brainstorming, second opinions, and independent review.
No API key, no UI automation, no screen interruption.

## How it works

1. You sign in once with the Codex CLI (`codex login`, "Sign in with ChatGPT").
   That stores ChatGPT-plan OAuth tokens in `~/.codex/auth.json`.
2. The plugin's MCP server reuses those tokens to call OpenAI's official Codex
   backend (`chatgpt.com/backend-api/codex/responses`) — the same headless surface
   the Codex CLI itself uses. Tokens are refreshed automatically when expired
   (written back in the Codex CLI format).
3. The agent gets three tools: `chatgpt_ask`, `chatgpt_models`, `chatgpt_status`,
   plus a `second-opinion` skill and the `/gpt` slash command.

Everything runs in the background. It never activates windows, types, or clicks.

## Tools

| Tool | Purpose |
| --- | --- |
| `chatgpt_ask` | Send a prompt, get the full GPT reply. Default model `gpt-5.6-terra`. |
| `chatgpt_panel` | Same prompt to multiple models in parallel (default fast + smart), side by side. |
| `chatgpt_models` | List model slugs available to your account. |
| `chatgpt_status` | Auth health: token expiry, masked account, default model. |

### Model aliases

Use plain words instead of slugs: `fast` (gpt-5.6-luna), `balanced` (gpt-5.6-terra,
default), `smart` (gpt-5.5), `mini` (gpt-5.4-mini). Raw slugs also work.

## Commands

- `/gpt <question>` — ask GPT and relay the labeled answer.
- `/gptf <file> [question]` — send a whole file to GPT for review and relay the answer.
- `/debate <topic>` — 3-way: your position, fast + smart GPT attack it in parallel, honest verdict.
- `/usage [days]` — GPT-call dashboard: what's eating your plan quota (also `chatgpt_usage` tool).
- `/report` — "what did I break today": guard blocks, warnings, flagged reviews.

## Activity log

All GPT calls and guard/review outcomes are logged (metadata only — models, file
names, verdicts; never prompts or code) to `~/.chatgpt-headless/activity.jsonl`,
auto-rotated at 1 MB. This powers `/usage` and `/report`. A nightly automation
can run the daily report for you.

## Live preview (`/preview`)

`http://localhost:8788` — streams every GPT interaction live: prompt, reply,
model, timing. Includes **search/filter** across all history, an **ask box**
to chat with GPT directly from the page (tagged 🌐 from web), and a live
model selector. Full prompts and replies are stored in
`~/.chatgpt-headless/transcripts.jsonl` with secrets auto-redacted; disable
with `CHATGPT_HL_TRANSCRIPTS=off`. The page is bound to localhost only.

## Local OpenAI-compatible API

Point any IDE or OpenAI SDK at `http://localhost:8788/v1` — no API key needed:

- `GET /v1/models` — aliases (fast/balanced/smart/mini) + real slugs
- `POST /v1/chat/completions` — standard OpenAI format, streaming (`"stream": true`)
  and non-streaming; calls are tagged 🔌 from API in the preview page

Works with Cursor, Continue, Zed, openai-python, etc. (set as OpenAI base URL).

## macOS apps

- **GPT Live** (Applications) — one click: starts the server if needed + opens the page
- **GPT Live Bar** (menu bar ⚡) — Open / Restart shortcuts + live server status

## Guard hook (pre-edit)

Before any Edit/Write: extreme danger (recursive root `rm -rf`, fork bombs, raw disk
writes, private keys) is hard-blocked instantly. Suspicious patterns (destructive SQL,
force pushes, hardcoded credentials, sudo, pipe-to-shell installs) get a fast GPT
verdict — high blocks, medium warns, low passes. Benign edits add zero latency.
Set `CHATGPT_HL_GUARD_MODE=warn` to never block, or `off` to disable.

## Auto-review hook (post-edit)

After any Edit/Write over ~400 chars, a PostToolUse hook quietly asks GPT (fast model)
to scan for obvious bugs. Findings are injected as context for the agent; LGTM stays
silent. Throttled to one review per 5 minutes. Tune via env:
`CHATGPT_HL_REVIEW_MIN_CHARS`, `CHATGPT_HL_REVIEW_COOLDOWN_MS`.

## Configuration (plugin settings)

- **model** — default model slug (`gpt-5.6-terra`)
- **instructions** — default system instructions
- **timeout_ms** — per-request timeout (`120000`)

Environment overrides for the MCP server: `CHATGPT_HL_MODEL`,
`CHATGPT_HL_INSTRUCTIONS`, `CHATGPT_HL_TIMEOUT_MS`, `CHATGPT_HL_AUTH_FILE`
(default `~/.codex/auth.json`).

## Requirements

- `codex login` completed once (auth_mode `chatgpt` in `~/.codex/auth.json`)
- Node.js ≥ 18

## Notes

- This uses your ChatGPT subscription through the same official endpoints as the
  Codex CLI. Usage counts against your plan like normal Codex usage.
- If calls start failing with auth errors, run `codex login` again to refresh
  credentials, or ask the agent to use `chatgpt_status`.

## Install from this repo

1. Clone or download this repo to a folder.
2. In ZCode: Plugin Marketplace -> Add -> Add Plugin Marketplace, paste that folder path.
3. Install *ChatGPT Headless* from the market.

(Also available on the official ZCode plugin marketplace.)

## Note on how it works

This plugin drives GPT through browser-overlay-free headless calls: it reuses the
OAuth tokens your ChatGPT plan already issued to the Codex CLI and talks to
OpenAI's official Codex backend, the same surface the Codex CLI itself uses.
It is supported automation of your own account, not a workaround or a hack. It
never activates windows, types, or clicks, and your tokens stay in
`~/.codex/auth.json`.

---

<p align="center">
  <a href="https://z.ai/subscribe?ic=R0K78RJKNW"><img alt="z.ai coding plans - 10% OFF coupon" src="https://img.shields.io/badge/z.ai%20coding%20plans-10%25%20OFF%20coupon-blueviolet" /></a>
  <a href="https://zcode.z.ai/invite/ALWM9JUA"><img alt="Try ZCode free" src="https://img.shields.io/badge/Try%20ZCode-free%20invite-0969da" /></a>
</p>

## License

MIT.
