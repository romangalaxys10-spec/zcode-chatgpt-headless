---
description: Open the live GPT traffic preview page (see zcode↔GPT calls stream in real time)
---

Start (or reuse) the live preview server and open it for the user:

1. Check if it's already running: `curl -s -m 2 http://localhost:8788/api/events` — if that answers, skip to step 3.
2. If not, start it in the background so it survives this chat:
   `nohup node "${ZCODE_PLUGIN_ROOT:-$HOME/.zcode/cli/plugins/cache/zcode-plugins-official/chatgpt-headless/current}/scripts/live-preview.mjs" >/dev/null 2>&1 &` then wait ~1s and verify with the curl from step 1.
3. Open the page: `open http://localhost:8788`
4. Tell the user: the page auto-updates every ~1 second; every GPT call zcode makes (ask/panel) appears there live, with prompt, reply, model, and timing. It's local-only, secrets are auto-redacted, and `CHATGPT_HL_TRANSCRIPTS=off` disables logging entirely.
