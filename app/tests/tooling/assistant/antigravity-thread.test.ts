import { ok } from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vite-plus/test'
import { createAntigravitySource } from '../../../electron/tools/assistant/agent-threads/antigravity.ts'

function step(step_index: number, type: string, source: string, fields: object) {
  return `${JSON.stringify({ step_index, type, source, ...fields })}\n`
}

test('reads Antigravity status, project and appended activity from live local storage', async () => {
  const gemini = await mkdtemp(path.join(tmpdir(), 'diffpane-antigravity-'))
  const product = path.join(gemini, 'antigravity')
  const id = 'a0f751b6-7a1c-4c5a-8e47-367de9a3f018'
  const projectId = 'c4456827-329a-4e95-8f00-c3740ac450a5'
  const cwd = path.join(gemini, 'Example Project')
  const projects = path.join(gemini, 'config', 'projects')
  const logs = path.join(product, 'brain', id, '.system_generated', 'logs')
  const locator = path.join(logs, 'transcript.jsonl')
  try {
    const source = createAntigravitySource(gemini)
    await expect(source.list()).rejects.toThrow('Antigravity thread data is unavailable.')
    await mkdir(logs, { recursive: true })
    await mkdir(projects, { recursive: true })
    await writeFile(
      path.join(projects, `${projectId}.json`),
      JSON.stringify({ projectResources: { resources: [{ gitFolder: { folderUri: pathToFileURL(cwd).href } }] } }),
    )
    using writer = new DatabaseSync(path.join(product, 'conversation_summaries.db'))
    writer.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, status TEXT,
        last_modified_time TEXT, killed INTEGER, not_fully_idle INTEGER, project_id TEXT
      )
    `)
    writer
      .prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'Review docs', '', 'CASCADE_RUN_STATUS_RUNNING', '2026-11-14 22:10:02.075781+00:00', 0, 1, projectId)
    const start =
      step(0, 'SYSTEM_MESSAGE', 'SYSTEM', { content: '<internal context>' }) +
      step(1, 'USER_INPUT', 'USER_EXPLICIT', { content: 'Review the docs' }) +
      step(2, 'PLANNER_RESPONSE', 'MODEL', {
        thinking: '<private reasoning>',
        tool_calls: [{ name: 'read_file', args: { Path: 'README.md', StartLine: 4 } }],
      })
    await writeFile(locator, start)
    const threads = await source.list()
    expect(threads).toEqual([
      {
        id,
        provider: 'antigravity',
        cwd,
        locator,
        title: 'Review docs',
        updatedAt: Date.parse('2026-11-14T22:10:02.075Z'),
        active: true,
        status: 'running',
        activity: 'Reading README.md',
      },
    ])
    const [thread] = threads
    ok(thread)
    const reader = source.open(thread)
    await expect(reader.read()).resolves.toEqual([
      { kind: 'user', text: 'Review the docs' },
      { kind: 'tool', text: 'Reading README.md', files: [{ path: 'README.md', line: 4 }] },
    ])

    const toolResult = step(3, 'GENERIC', 'MODEL', { content: '<raw output>' })
    const answer = step(4, 'PLANNER_RESPONSE', 'MODEL', { content: 'Review complete.' })
    await appendFile(locator, toolResult)
    await expect(reader.read()).resolves.toEqual([])
    await appendFile(locator, answer)
    await expect(reader.read()).resolves.toEqual([{ kind: 'assistant', text: 'Review complete.' }])

    const addendum = step(5, 'PLANNER_RESPONSE', 'MODEL', { content: 'One more thing.' })
    await writeFile(`${locator}.next`, start + toolResult + answer + addendum)
    await rename(`${locator}.next`, locator)
    await expect(reader.read()).resolves.toEqual([{ kind: 'assistant', text: 'One more thing.' }])
    await expect(reader.read()).resolves.toEqual([])

    writer.exec("UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE', not_fully_idle = 0")
    await expect(source.list()).resolves.toMatchObject([
      { id, active: false, status: 'idle', activity: 'One more thing.' },
    ])
  } finally {
    await rm(gemini, { force: true, recursive: true })
  }
})
