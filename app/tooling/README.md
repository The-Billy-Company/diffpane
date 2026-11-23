---
doc_radar:
  sentinels:
    - file: package.json
      contains: ['app/tooling/commands/dev.ts']
---

# Tooling

The root pnpm scripts are the entry points for these development and release tools.

- [Commands](commands/README.md) covers Make targets, desktop launch commands, and terminal setup.
- [Distribution](distribution/README.md) owns the macOS installer and terminal launcher.
- [Dependencies](dependencies/README.md) owns language tool setup and the bundled HowMany release pin.
- [Grammars](grammars/README.md) owns the syntax catalog and pinned grammar data.
- [Quality](quality/README.md) owns the lint profiles and source-size exception registry.
- [Copyright](copyright/README.md) checks source headers while preserving upstream notices and licenses.

The [branding index](../../branding/README.md) describes the icon generator and its output locations.
