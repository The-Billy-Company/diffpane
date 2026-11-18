---
doc_radar:
  sentinels:
    - file: app/renderer/panels/assistant/assistant.js
      contains: ['createAssistant']
---

# The Creature

The workspace supplies selected project context and routes links opened from the conversation. The panel talks to the workspace Claude session through the typed bridge. Edit mode shows a single review card with a diff for each changed or new file and applies the changes together.
The greeting draws the Creature beside a source page and uses the small panel glyph in short layouts. The settings sketch accompanies the API key status.

- [`assistant.js`](assistant.js) — Owns the conversation, streaming request lifecycle, settings, and selected context.
- [`assistant-content.js`](assistant-content.js) — Renders sanitized messages, tool activity, and edit proposals.
- [`assistant.css`](assistant.css) — Styles the conversation, composer, and activity cards.
- [`agent-threads.ts`](agent-threads.ts) — Opens a full window view of local Codex, Claude Code, Antigravity, and Cursor threads, with project and agent filters and manual refresh.
- [`agent-thread-conversation.ts`](agent-thread-conversation.ts) — Groups adjacent tool calls in the conversation and follows new output while you are at the bottom. Filenames with recorded edits disclose their diffs inline. Other repository file links open the workspace editor.
- [`creature-glyph.ts`](creature-glyph.ts) — Defines the Creature glyph used in the panel and its entry points.

Agent threads shows live macOS memory pressure while the page is visible. It reads the running Billy Box Windows app's local feed when available and falls back to the macOS pressure level. Active threads show their latest recorded tool action when available. Resident memory is measured for verified local agent processes, some of which serve multiple threads.

Run `pnpm run dev .` and open The Creature or Agent threads from the workspace title bar.
