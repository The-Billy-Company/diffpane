---
doc_radar:
  sentinels:
    - file: app/tooling/copyright/check.py
      contains: ['def check(', 'def add_notice(']
---

# Source copyright headers

Use Python 3.11 or newer from the repository root:

```sh
python3 app/tooling/copyright/check.py --root .
python3 app/tooling/copyright/check.py --root . --fix
python3 app/tooling/copyright/test-check.py
```

The check covers tracked source files and new, nonignored source files. CI runs the same checker and its tests without installing project dependencies. New company-owned files receive `Copyright (c) YEAR The Billy Company` in their language's comment syntax. Existing company notices and publication years remain valid.

The updater inserts copyright comments without changing license declarations or upstream attribution. `.copyright.json` records reviewed exclusions and their reasons. Pinned grammar snapshots and legal notices retain their existing bytes. Review ownership before adding an exception or importing third-party code.

The committed theme token stylesheet gets its header from [the theme generator](../appearance/theme-css.ts); regenerate it with `node app/tooling/appearance/theme-css.ts`.
