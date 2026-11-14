---
doc_radar:
  sentinels:
    - file: app/renderer/panels/art/assistant.ts
      contains: ['drawCreatureGreeting']
    - file: app/renderer/panels/art/settings.ts
      contains: ['drawThemeWindow']
---

# Panel sketches

The Creature greeting, analysis report, inactive terminal, and settings reuse the renderer's Rough.js stroke settings. Each panel supplies the palette through app theme tokens. Theme previews show the same miniature workspace in both palettes.
