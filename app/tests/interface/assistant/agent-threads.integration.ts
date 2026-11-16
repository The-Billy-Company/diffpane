import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'vite-plus'
import { AgentThreads } from '../../../electron/tools/assistant/agent-threads/threads.ts'
import type { AgentMemorySnapshot } from '../../../shared/agent-memory.ts'
import type { AgentThreadEvent } from '../../../shared/agent-threads.ts'

// Run from the repository root with:
// node_modules/.bin/electron app/tests/interface/assistant/agent-threads.integration.ts
const profile = await mkdtemp(path.join(tmpdir(), 'diffpane-agent-threads-'))
app.setPath('userData', profile)
app.setAppLogsPath(path.join(profile, 'logs'))

const route = '/__agent-threads-integration__'
const transcriptRoute = `${route}/transcript`
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGPwa1tXvuYgAAqvA2cKS3ZXAAAAAElFTkSuQmCC'
const imageDataUrl = `data:image/png;base64,${imageBase64}`
const imageFile = path.join(profile, 'Example diagram.png')
const imageHref = pathToFileURL(imageFile).href
await writeFile(imageFile, Buffer.from(imageBase64, 'base64'))
const childFile = path.join(profile, 'delegate.txt')
await writeFile(childFile, 'Delegate-only file contents.')
const childEditFile = path.join(profile, 'delegate-edit.txt')
await writeFile(childEditFile, 'Delegate edit contents.')
const childEvents: AgentThreadEvent[] = [
  { kind: 'user', text: 'Check the parser example.' },
  {
    kind: 'edit',
    text: '',
    changes: [
      {
        path: childEditFile,
        operation: 'add',
        line: 1,
        diff: '@@ -0,0 +1 @@\n+Delegate edit contents.\n',
        additions: 1,
        deletions: 0,
      },
    ],
  },
  { kind: 'tool', toolName: 'Read', text: '', files: [{ path: childFile, line: 4 }] },
  { kind: 'assistant', text: 'The delegate finished checking the example.' },
]
const longCommand = `cat fixtures/${'greeting'.repeat(200)}.txt && printf 'Parser fixture read\\n'`
const turnId = 'parser-turn'
const snapshot: AgentThreadEvent[] = [
  { kind: 'user', turnId, text: 'How does the parser handle a greeting?' },
  { kind: 'thinking', turnId, text: 'I’ll inspect the **greeting fixture**.' },
  {
    kind: 'tool',
    turnId,
    toolName: 'exec_command',
    toolDescription: 'Check the parser fixture',
    text: longCommand,
  },
  {
    kind: 'tool',
    turnId,
    toolName: 'Read',
    text: '',
    files: [{ path: '/projects/juniper/fixtures/greeting.txt' }],
  },
  {
    kind: 'tool',
    turnId,
    toolName: 'WebSearch',
    toolDescription: 'Look up the parser contract',
    text: '',
  },
  {
    kind: 'edit',
    turnId,
    text: '',
    changes: [
      {
        path: 'docs/parser.md',
        operation: 'update',
        line: 3,
        diff: '@@ -3 +3,2 @@\n-Old example\n+Greeting example\n+Example description',
        additions: 2,
        deletions: 1,
      },
    ],
  },
  { kind: 'thinking', turnId, text: 'The fixture confirms the expected value.' },
  { kind: 'user', turnId, text: 'Include the legacy fixture cleanup.' },
  {
    kind: 'edit',
    turnId,
    text: '',
    changes: [
      {
        path: 'docs/parser.md',
        operation: 'update',
        line: 8,
        diff: '@@ -8,0 +8 @@\n+See the parser fixture.',
        additions: 1,
        deletions: 0,
      },
      {
        path: 'fixtures/legacy.txt',
        operation: 'delete',
        diff: '@@ -1 +0,0 @@\n-Old fixture',
        additions: 0,
        deletions: 1,
      },
    ],
  },
  {
    kind: 'assistant',
    turnId,
    text: '## Parsed greeting\n\nThe parser returns **a value**.\n\n```js\nreturn "hello"\n```',
  },
  { kind: 'status', turnId, text: 'Turn finished' },
]
const newEvents: AgentThreadEvent[] = [
  {
    kind: 'assistant',
    text: `This arrived after the snapshot. [Open diagram](${imageHref})\n\n**Before** ![Inline diagram](${imageHref}) **after**.`,
    images: [{ name: 'Generated diagram', dataUrl: imageDataUrl }],
  },
  {
    kind: 'delegate',
    text: 'I checked the parser example.',
    delegation: { threadId: 'codex:child', name: 'Euler', action: 'message', direction: 'received' },
  },
  {
    kind: 'user',
    text: '',
    images: [
      {
        name: 'Parser screenshot.png',
        dataUrl: imageDataUrl,
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
        children: async thread =>
          thread.id === '1'
            ? [
                {
                  id: 'child',
                  provider: 'codex',
                  agentName: 'Euler',
                  title: 'Check the example',
                  cwd: '/projects/juniper',
                  status: 'idle',
                  updatedAt: 1,
                  locator: path.join(profile, 'child-transcript'),
                },
              ]
            : [],
        open: thread => ({ read: async () => structuredClone(thread.id === '1' ? events : childEvents) }),
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
    ipcMain.handle('agent-threads-children', async (_event, selection: string, parentId?: string) => ({
      ok: true,
      value: await tracker.children(selection, parentId),
    }))
    ipcMain.handle('agent-threads-read', async (_event, id: string, selection: string, childId?: string) => ({
      ok: true,
      value: await tracker.read(id, selection, childId),
    }))
    ipcMain.handle('agent-threads-update', async (_event, id: string, selection: string, childId?: string) => ({
      ok: true,
      value: await tracker.update(id, selection, childId),
    }))
    ipcMain.handle('agent-threads-clear', (_event, selection: string) => {
      tracker.clear(selection)
      return { ok: true, value: undefined }
    })
    const workspaceRoot = await realpath(profile)
    ipcMain.handle('agent-threads-file', async (_event, selection: string, filename: string, childId?: string) => {
      const value = await tracker.resolveFile(
        selection,
        filename,
        { root: workspaceRoot, scope: workspaceRoot },
        childId,
      )
      if (value.kind !== 'workspace') throw new Error('The fixture file was outside its workspace.')
      return { ok: true, value }
    })
    let memoryReads = 0
    ipcMain.handle('agent-threads-memory', () => {
      const first = memoryReads++ === 0
      const sampledAt = Date.now()
      const value: AgentMemorySnapshot = {
        sampledAt,
        source: first ? 'windows' : 'system',
        pressure: first ? 'warning' : 'normal',
        usedBytes: 8 * 1024 ** 3,
        totalBytes: 16 * 1024 ** 3,
        activities: [
          {
            id: 'codex:1',
            provider: 'codex',
            title: 'Inspect the parser',
            action: first ? 'Check the parser fixture' : 'Add a parser example',
            updatedAt: sampledAt,
            process: { pid: 1234, residentBytes: 512 * 1024 ** 2, shared: true },
          },
          {
            id: 'codex:2',
            provider: 'codex',
            title: 'Review tests',
            updatedAt: sampledAt,
            process: { pid: 1234, residentBytes: 512 * 1024 ** 2, shared: true },
          },
        ],
      }
      return { ok: true, value }
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
    ipcMain.removeHandler('agent-threads-children')
    ipcMain.removeHandler('agent-threads-read')
    ipcMain.removeHandler('agent-threads-update')
    ipcMain.removeHandler('agent-threads-clear')
    ipcMain.removeHandler('agent-threads-file')
    ipcMain.removeHandler('agent-threads-memory')
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
    await rm(profile, { recursive: true, force: true, maxRetries: 3 })
  }
}
runAndCleanUp().then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  },
)
