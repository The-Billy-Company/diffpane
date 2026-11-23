// Copyright (c) 2026 The Billy Company
import { runDesktop } from './desktop/runner.ts'

process.exitCode = await runDesktop(
  'cargo',
  [
    'run',
    '--locked',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--target-dir',
    'target/diffpane-tauri',
    '--features',
    'custom-protocol',
    '--',
    ...process.argv.slice(2),
  ],
  { env: { ...process.env, DIFFPANE_NODE: process.execPath } },
)
