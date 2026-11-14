---
doc_radar:
  sentinels:
    - file: app/renderer/panels/assistant/assistant.js
      contains: ['createAssistant']
---

# The Creature

The workspace supplies selected project context and routes links opened from the conversation. The panel talks to the Electron Claude session through the preload API. Edit mode shows a single review card with a diff for each changed or new file and applies the changes together.

- [`assistant.js`](assistant.js) — Owns the conversation, streaming request lifecycle, settings, and selected context.
- [`assistant-content.js`](assistant-content.js) — Renders sanitized messages, tool activity, and edit proposals.
- [`assistant.css`](assistant.css) — Styles the conversation, composer, and activity cards.
- [`agent-threads.ts`](agent-threads.ts) — Opens local Claude Code, Cursor, and Codex threads and follows their published events. File links open the workspace editor or a read-only text preview.
- [`creature-glyph.ts`](creature-glyph.ts) — Defines the Creature glyph used in the panel and its entry points.

Run `pnpm run dev .` and open The Creature from the workspace title bar to inspect the panel.
