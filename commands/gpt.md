---
description: Ask GPT (via the user's ChatGPT account, headless) and relay the answer
---

Ask GPT for its answer to the following, using the `chatgpt_ask` MCP tool:

$ARGUMENTS

Rules:

1. **If the `chatgpt_ask` tool is not available in this session, STOP.** Tell the user exactly: "This chat is older than the GPT plugin — open a NEW chat (or fully quit and reopen ZCode) and retry." Do NOT invent, simulate, or guess a "GPT answer" — that is forbidden. Only relay replies that came from an actual `chatgpt_ask` call.
2. If the question references the current workspace, files, or conversation, inline the relevant code/context into the prompt first — GPT sees nothing else.
3. Relay GPT's answer clearly labeled with the model slug it came from.
4. Add your own assessment afterward: where you agree or disagree, and anything GPT missed.
