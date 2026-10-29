---
description: Show how many GPT calls the plugin made (by feature, model, day)
---

Show the user their chatgpt-headless GPT usage dashboard.

Call the `chatgpt_usage` MCP tool with `days` set to 7 (or what $ARGUMENTS asks for, e.g. "30"). If the tool is unavailable, run instead:

```
node "${ZCODE_PLUGIN_ROOT:-$HOME/.zcode/cli/plugins/cache/zcode-plugins-official/chatgpt-headless/current}/scripts/usage-report.mjs" 7
```

Present the numbers as a small readable summary. If usage looks unusually high, point out which feature is responsible (ask / panel / review / guard) and suggest which knobs to turn (e.g. raise `CHATGPT_HL_REVIEW_MIN_CHARS`, lengthen `CHATGPT_HL_REVIEW_COOLDOWN_MS`).
