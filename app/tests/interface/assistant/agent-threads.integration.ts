import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { createServer } from 'vite-plus'

// Run from the repository root with:
// node_modules/.bin/electron app/tests/interface/assistant/agent-threads.integration.ts
const profile = await mkdtemp(path.join(tmpdir(), 'diffpane-agent-threads-'))
app.setPath('userData', profile)
app.setAppLogsPath(path.join(profile, 'logs'))

const route = '/__agent-threads-integration__'
async function run(): Promise<void> {
  const server = await createServer({
    configFile: fileURLToPath(new URL('../../../../vite.config.ts', import.meta.url)),
    cacheDir: path.join(profile, 'vite'),
    optimizeDeps: { entries: ['tests/interface/assistant/agent-threads.fixture.ts'] },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'agent-threads-integration',
        configureServer({ middlewares }) {
          middlewares.use(route, (_request, response) => {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><title>Agent Threads integration</title><div id="app"></div>')
          })
        },
      },
    ],
  })
  let browser: BrowserWindow | undefined
  try {
    await server.listen()
    app.dock?.hide()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('The Agent Threads test page did not start.')
    browser = new BrowserWindow({
      width: 1100,
      height: 820,
      show: false,
      webPreferences: { backgroundThrottling: false },
    })
    await browser.loadURL(new URL(route, url).href)
    await browser.webContents.executeJavaScript(
      'import("/tests/interface/assistant/agent-threads.fixture.ts").then(module => module.run())',
    )
    console.info('Agent Threads integration passed.')
  } finally {
    browser?.destroy()
    await server.close()
  }
}

app.on('window-all-closed', () => {})
async function runAndCleanUp(): Promise<void> {
  try {
    await app.whenReady()
    await run()
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}
runAndCleanUp().then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  },
)
