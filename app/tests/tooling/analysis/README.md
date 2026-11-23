---
doc_radar:
  sentinels:
    - file: app/tests/tooling/analysis/howmany.test.mjs
      contains: ['automatic']
---

# HowMany tests

This suite covers the workspace source counter, including cancellation, timeouts, invalid reports, source checksum validation, local working-tree provenance, real Lean/C++ workspace filtering and real LSP diagnostics. Run `pnpm run setup:howmany --released` to enable the bundled binary cases with the pinned release. The scope fixture retains copied tests while excluding generated sources and Lean/CMake/GN output.

- [HowMany](howmany.test.mjs). Check report handling, request coalescing, manual refresh and subprocess disposal.

Run `pnpm test app/tests/tooling/analysis` from the repository root.
