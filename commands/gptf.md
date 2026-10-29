---
description: Send a file to GPT for review or a question and relay the answer
---

Arguments: $ARGUMENTS — this is one or more file paths, optionally followed by a question about them.

Steps:

0. **If the `chatgpt_ask` tool is not available in this session, STOP.** Tell the user: "This chat is older than the GPT plugin — open a NEW chat (or fully quit and reopen ZCode) and retry." NEVER fabricate a GPT review — only relay output from a real tool call.
1. Read each named file fully with the Read tool.
2. If a file is longer than ~40,000 characters, send the most relevant sections (and say you truncated).
3. Default to model "smart" (gpt-5.5). Use "fast" only if the user said fast/quick, or "balanced" for medium-stakes review.
4. Call `chatgpt_ask` with the complete file contents in fenced code blocks (with language hints), plus the user's question — or, if no question was given, this default: "Review for bugs, edge cases, security issues, and concrete improvements. Prioritize by severity."
5. Relay GPT's answer labeled with the model slug, then add your own take: where you agree, where GPT is wrong or missed something.
