---
name: second-opinion
description: Consult GPT (the user's ChatGPT account, headless via the chatgpt-headless MCP tools) for brainstorming, second opinions on designs or decisions, and independent review of code or reasoning. Use when the user asks to "ask GPT/ChatGPT", wants a second opinion, wants to brainstorm alternatives, or wants an independent reviewer. ALSO pair automatically with other skills — when a brainstorming skill (e.g. superpowers:brainstorming) is exploring ideas, a design skill is choosing between layouts/architectures, or a code-review skill is evaluating a change, offer/include a GPT cross-check via chatgpt_ask or chatgpt_panel. Covers /gpt, /gptf, /debate, /usage, /report.
---

# Second Opinion from GPT

You have headless access to GPT models from the user's ChatGPT account through the
`chatgpt-headless` MCP server. No API key, no UI, never touches the user's screen —
it talks to OpenAI's Codex backend with the OAuth tokens in `~/.codex/auth.json`
(refreshed automatically).

## Pairs with other skills

zcode has no other GPT-calling skills — this one IS the GPT integration, so when
another skill's workflow would benefit from external model input, route it through
these tools rather than wishing for a different provider:

- **Brainstorming skills** (e.g. superpowers:brainstorming): after generating your own
  idea list, ask GPT (`fast` for volume, `smart` to stress-test the shortlist) for
  approaches you missed; merge and dedupe before presenting.
- **Design/architecture skills** (superdesign, feature-dev:code-architect): run the
  chosen design past GPT for failure modes before committing to it.
- **Code-review skills** (feature-dev:code-reviewer, superpowers:requesting-code-review):
  add a GPT pass (`/gptf <file>` flow) on the diff for a genuinely independent set of eyes.
- **Debugging skills** (superpowers:systematic-debugging): when stuck on a hypothesis,
  give GPT the full evidence and ask what it would check next.

When pairing, still follow the skill's own process — GPT augments it, it doesn't replace it.

## Tools

- `chatgpt_ask` — send a prompt, get the full reply.
- `chatgpt_panel` — same prompt to multiple models in parallel (default fast + smart), answers side by side. Use when the stakes justify double usage.
- `chatgpt_models` — live model slugs.
- `chatgpt_usage` — GPT-call dashboard (by feature/model/day) for plan-quota questions.
- `chatgpt_status` — auth health if calls fail.

### Model aliases (use plain words)

| Alias | Slug | Use for |
| --- | --- | --- |
| `fast` | gpt-5.6-luna | quick questions, high volume |
| `balanced` (default) | gpt-5.6-terra | everyday second opinions |
| `smart` | gpt-5.5 | hard designs, deep reasoning |
| `mini` | gpt-5.4-mini | trivial checks |

Raw slugs also work. Pick the cheapest model that can do the job.

## When to use

- **Brainstorming**: ask GPT for alternative approaches when exploring a design space.
- **Second opinions**: before committing to a non-obvious architectural or debugging decision.
- **Independent review**: paste a code snippet/diff and ask for bugs — GPT shares no context with you, which makes it a genuinely independent reviewer.
- **Debates** (`/debate`): 3-way — your position, fast GPT and smart GPT attack it in parallel, show all sides honestly.
- **File reviews** (`/gptf <file>`): read the file, send it whole, relay the review.
- **Cross-checks** (`chatgpt_panel`): for high-stakes answers, ask fast + smart in parallel and compare — catches confident-but-wrong cheap models.
- **Usage** (`/usage`) and **daily report** (`/report`): plan-quota dashboard and "what did I break today".
- Direct requests: "ask GPT…", "what does ChatGPT think…", "get a second opinion…".

## How to ask well

The model sees ONLY what you put in the prompt. Always include:

1. The actual code/config/error text (not just your summary of it).
2. Surrounding constraints (language, versions, what's been tried).
3. A focused question — one topic per call.

Evaluate the answer critically: GPT's reply is input to your reasoning, not authority.
Verify claims against the codebase, and tell the user where you agree or disagree and why.

## Guard + auto-review hooks (already active)

- **Before** any Edit/Write: a PreToolUse guard scans for dangerous patterns. Extreme ones
  (recursive root delete, fork bombs, raw disk writes, private keys) are hard-BLOCKED.
  Suspicious ones (destructive SQL, `rm -rf`, force pushes, hardcoded credentials, sudo,
  pipe-to-shell) get a fast GPT verdict: high danger blocks, medium warns. Benign edits pass
  with zero added latency. Kill switch / warn-only: `CHATGPT_HL_GUARD_MODE=warn|off`.
- **After** any Edit/Write larger than ~400 chars: a PostToolUse hook silently asks GPT (fast
  model, throttled to once per 5 min) to scan for obvious bugs. If it flags something, you'll
  see `[chatgpt-headless auto-review of <file>…]` context — address it (fix, or justify why
  it's wrong). LGTM results stay silent.
- If the guard BLOCKS you and the edit is genuinely intended and user-approved, tell the user
  to set `CHATGPT_HL_GUARD_MODE=warn` and retry.

## Relaying

When the user asked for GPT's view directly, quote or summarize the reply labeled with the
model slug, then add your own take.
