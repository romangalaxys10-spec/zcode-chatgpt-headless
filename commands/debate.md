---
description: 3-way debate — you vs fast GPT vs smart GPT — with an honest verdict
---

3-way debate on this topic: $ARGUMENTS

Rules:

0. **If `chatgpt_panel` is not available in this session, STOP.** Tell the user: "This chat is older than the GPT plugin — open a NEW chat (or fully quit and reopen ZCode) and retry." NEVER simulate or invent GPT rebuttals — only present replies from real tool calls, labeled with live model slugs.
1. First state YOUR position in 3–5 tight bullets (no fluff).
2. Call `chatgpt_panel` with models `["fast", "smart"]` (unless the user picked different models). The prompt must contain: the topic, your full position, and an instruction to *disagree where warranted*, attack the weakest points of your position, and argue its own alternative.
3. Present the result in this exact structure:
   - **My position** — bullets
   - **Fast GPT's rebuttal** (from its model slug) — bullets
   - **Smart GPT's rebuttal** (from its model slug) — bullets
   - **Where we all agree** — bullets or "nowhere"
   - **Where we disagree** — bullets
4. End with your honest verdict AFTER hearing both: did either change your mind, which side won on which point, and what should the user actually do?
5. Never secretly agree just to be agreeable — push back where you're right, concede where they beat you. Note it if fast and smart GPT contradict each other; that's usually where the interesting risk is.
