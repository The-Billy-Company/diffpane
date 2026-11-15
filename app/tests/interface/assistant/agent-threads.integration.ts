import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'vite-plus'
import { AgentThreads } from '../../../electron/tools/assistant/agent-threads/threads.ts'
import type { AgentThreadEvent } from '../../../shared/agent-threads.ts'

// Run from the repository root with:
// node_modules/.bin/electron app/tests/interface/assistant/agent-threads.integration.ts
const profile = await mkdtemp(path.join(tmpdir(), 'diffpane-agent-threads-'))
app.setPath('userData', profile)
app.setAppLogsPath(path.join(profile, 'logs'))

const route = '/__agent-threads-integration__'
const transcriptRoute = `${route}/transcript`
const longCommand = `cat fixtures/${'greeting'.repeat(200)}.txt && printf 'Parser fixture read\\n'`
const snapshot: AgentThreadEvent[] = [
  { kind: 'user', text: 'How does the parser handle a greeting?' },
  { kind: 'thinking', text: 'I’ll inspect the **greeting fixture**.' },
  {
    kind: 'tool',
    toolName: 'exec_command',
    toolDescription: 'Check the parser fixture',
    text: longCommand,
    files: [{ path: '/projects/juniper/fixtures/greeting.txt' }],
  },
  { kind: 'tool', toolName: 'apply_patch', toolDescription: 'Add a parser example', text: 'Update docs/parser.md' },
  { kind: 'thinking', text: 'The fixture confirms the expected value.' },
  {
    kind: 'assistant',
    text: '## Parsed greeting\n\nThe parser returns **a value**.\n\n```js\nreturn "hello"\n```',
  },
  { kind: 'status', text: 'Turn finished' },
]
const newEvents: AgentThreadEvent[] = [
  { kind: 'assistant', text: 'This arrived after the snapshot.' },
  {
    kind: 'user',
    text: '',
    images: [
      {
        name: 'Parser screenshot.png',
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGPwa1tXvuYgAAqvA2cKS3ZXAAAAAElFTkSuQmCC',
      },
      { name: 'Unavailable screenshot.png' },
    ],
  },
]
for (let turn = 1; turn <= 12; turn++) {
  newEvents.push(
    { kind: 'user', text: `Can you check parser example ${turn}?` },
    { kind: 'assistant', text: `Example ${turn} returns the expected value.` },
  )
}
const partialThought: AgentThreadEvent = { kind: 'thinking', text: 'Checking the final example.' }
const grownThought: AgentThreadEvent = {
  kind: 'thinking',
  text: `${partialThought.text}\n\n${'The result matches the fixture.\n\n'.repeat(18)}The final check passed.`,
}
const finalReply: AgentThreadEvent = { kind: 'assistant', text: 'All examples pass.' }
const transcriptUpdates: ReadonlyMap<string, AgentThreadEvent[]> = new Map([
  ['/append', [partialThought]],
  ['/grow', [grownThought]],
  ['/reply', [grownThought, finalReply]],
  ['/late', [grownThought, finalReply, { kind: 'assistant', text: 'This update arrived after leaving.' }]],
])

async function run(): Promise<void> {
  let events = snapshot
  const tracker = new AgentThreads([
    [
      'codex',
      {
        list: async () => [
          {
            id: '1',
            provider: 'codex',
            title: 'Inspect the parser',
            cwd: '/projects/juniper',
            status: 'running',
            updatedAt: 1,
            locator: path.join(profile, 'transcript'),
          },
        ],
        open: () => ({ read: async () => structuredClone(events) }),
      },
    ],
  ])
  const server = await createServer({
    configFile: fileURLToPath(new URL('../../../../vite.config.ts', import.meta.url)),
    cacheDir: path.join(profile, 'vite'),
    optimizeDeps: { entries: ['tests/interface/assistant/agent-threads.fixture.ts'] },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'agent-threads-integration',
        configureServer({ middlewares }) {
          middlewares.use(transcriptRoute, (request, response) => {
            const update = transcriptUpdates.get(request.url ?? '')
            if (request.method !== 'POST' || !update) {
              response.writeHead(404).end()
              return
            }
            events = [...snapshot, ...newEvents, ...update]
            response.writeHead(204).end()
          })
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
    await tracker.list()
    ipcMain.handle('agent-threads-read', async (_event, id: string, selection: string) => ({
      ok: true,
      value: await tracker.read(id, selection),
    }))
    ipcMain.handle('agent-threads-update', async (_event, id: string, selection: string) => ({
      ok: true,
      value: await tracker.update(id, selection),
    }))
    ipcMain.handle('agent-threads-clear', (_event, selection: string) => {
      tracker.clear(selection)
      return { ok: true, value: undefined }
    })
    browser = new BrowserWindow({
      width: 1100,
      height: 820,
      show: false,
      webPreferences: {
        preload: fileURLToPath(new URL('../../../electron/runtime/window/preload.cjs', import.meta.url)),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    await browser.loadURL(new URL(route, url).href)
    await browser.webContents.executeJavaScript(
      `import("/tests/interface/assistant/agent-threads.fixture.ts").then(module => module.run(${JSON.stringify(longCommand)}, ${JSON.stringify(transcriptRoute)}))`,
    )
    console.info('Agent Threads integration passed.')
  } finally {
    ipcMain.removeHandler('agent-threads-read')
    ipcMain.removeHandler('agent-threads-update')
    ipcMain.removeHandler('agent-threads-clear')
    tracker.clear()
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
