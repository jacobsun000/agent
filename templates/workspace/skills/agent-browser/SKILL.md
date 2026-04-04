---
name: agent-browser
description: Prefer the built-in computer_use tool for website automation in this agent workspace. Read this only when browser automation is needed.
---

# Browser Automation

This workspace has a built-in `computer_use` tool that implements OpenAI's native code-execution computer-use pattern with a persistent Playwright browser.

Use `computer_use` first for web browsing, web apps, login flows, screenshots, and browser-driven research.

Important:
- The shared browser profile lives at `<workspace>/browser/profile`.
- If `computer_use` returns `status: "awaiting_user"`, ask the user the exact question and later resume that same session.
- Only fall back to external `agent-browser` shell commands if the user explicitly asks for that CLI or the built-in tool is unavailable.
