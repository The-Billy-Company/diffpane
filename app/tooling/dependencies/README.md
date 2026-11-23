---
doc_radar:
  sentinels:
    - file: app/tooling/dependencies/setup-howmany.ts
      contains: ['verifyHowManySource']
    - file: app/tooling/dependencies/howmany-tool.json
      contains: ['"version": "3.2.0"']
---

# Tool setup and pins

`setup-howmany.ts` verifies and builds the released HowMany source using the hash in `howmany-tool.json`. HowMany 3.2.0 includes generated-output detection and Lean/C++ support. A local checkout can be selected with `--source`. `setup-languages.ts` uses `language-tools.json` to select language tool versions. The workspace service discovers the installed tools when opening a supported file.

From the repository root, run `pnpm run setup:howmany` to prepare the bundled counter or `pnpm run setup:languages` to prepare language servers for integration checks.

To bundle local HowMany changes, run `pnpm run setup:howmany --source /path/to/howmany`. Setup snapshots the checkout's tracked and nonignored untracked files, builds that snapshot, and records its revision and content SHA-256 in `resources/howmany/build.json`. It detects uncommitted edits and excludes ignored build output from that identity.

Subsequent setup and app installation keep using the selected local checkout. Set `DIFFPANE_HOWMANY_SOURCE=/path/to/howmany` when running `pnpm run install:app` to select it directly. Run `pnpm run setup:howmany --released` to return to the pinned release. Local binaries and provenance stay ignored by Git. App packaging includes the provenance beside the scanner and updates the executable hash after signing.
