import { appendFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vite-plus/test'
import { claudeSource } from '../../../electron/tools/assistant/agent-threads/claude.ts'

const { run } = vi.hoisted(() => ({ run: vi.fn<() => Promise<{ stdout: string }>>() }))
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: run }),
}))

test('attaches to an open Claude Code session before its transcript exists', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-claude-threads-')))
  const cwd = path.join(root, 'project with spaces')
  await mkdir(cwd)
  vi.stubEnv('CLAUDE_CONFIG_DIR', root)
  t.onTestFinished(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })
  const id = 'cda5083e-c9eb-4b86-8917-d9cae2377aba'
  run.mockResolvedValue({ stdout: JSON.stringify([{ sessionId: id, cwd, name: 'Proof', status: 'idle' }]) })

  const [session] = await claudeSource.list()
  expect(session).toMatchObject({ id, cwd, title: 'Proof', provider: 'claude', active: true })
  if (!session) throw new Error('Missing Claude Code session')
  const reader = claudeSource.open(session)
  expect(await reader.read()).toEqual([])
  await mkdir(path.dirname(session.locator), { recursive: true })
  const writeRecords = (...records: object[]) =>
    appendFile(session.locator, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
  await writeRecords(
    { type: 'user', message: { content: 'Edit the example.' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will update the example.' },
          { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: 'example.txt' } },
        ],
      },
    },
  )
  const file = path.join(cwd, 'example.txt')
  expect(await reader.read()).toEqual([
    { kind: 'user', text: 'Edit the example.' },
    { kind: 'assistant', text: 'I will update the example.' },
    { kind: 'tool', text: 'Edit', files: [{ path: file }] },
  ])

  await writeRecords({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_edit' }] },
    toolUseResult: { filePath: file, structuredPatch: [{ newStart: 3 }] },
  })
  expect(await reader.read()).toEqual([{ kind: 'edit', text: 'Updated file', files: [{ path: file, line: 3 }] }])
  await writeRecords({ type: 'system', subtype: 'turn_duration' })
  expect(await reader.read()).toEqual([{ kind: 'status', text: 'Turn finished' }])
  expect(await reader.read()).toEqual([])
})
