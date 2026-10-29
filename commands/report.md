---
description: What did I break today — guard blocks, warnings, flagged reviews
---

Run today's chatgpt-headless safety report and show it to the user verbatim:

```
node "${ZCODE_PLUGIN_ROOT:-$HOME/.zcode/cli/plugins/cache/zcode-plugins-official/chatgpt-headless/current}/scripts/daily-report.mjs"
```

After showing it: if there are blocked edits or flagged reviews, briefly explain each one in plain words and whether anything still needs the user's attention. If everything is empty, reassure them in one line.
