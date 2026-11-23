// Copyright (c) 2026 The Billy Company
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { runDesktop } from './desktop/runner.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const server = await createServer({
  configFile: path.join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
try {
  await server.listen()
  server.printUrls()
  process.exitCode = await runDesktop(
    process.execPath,
    [path.join(root, 'node_modules/.bin/tauri'), 'dev', '--', '--locked', '--', ...process.argv.slice(2)],
    {
      cwd: root,
      env: {
        ...process.env,
        CARGO_TARGET_DIR: path.join(root, 'target/diffpane-tauri'),
        DIFFPANE_NODE: process.execPath,
      },
    },
  )
} finally {
  await server.close()
}
