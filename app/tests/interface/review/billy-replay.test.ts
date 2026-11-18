import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vite-plus/test'
import { createBillyReplayReader } from '../../../backend/tools/billy-replay/reader.ts'
import { projectReplayCase } from '../../../backend/tools/billy-replay/transcript.ts'
import { compareReplayCases } from '../../../renderer/review/billy-replay/comparison.ts'

function transcript(args: string, result: string, playbook?: string) {
  const calls = [{ name: 'listen', args, content: result, finished: true, is_error: false }]
  return {
    scenario_id: 'first',
    user_id: 'fixture',
    messages: [
      { role: 'system', content: 'Fixture identity' },
      { role: 'user', content: 'What does this clip say?' },
      { role: 'assistant', content: 'Hello.', tool_calls: calls },
    ],
    evidence:
      playbook === undefined
        ? [{}]
        : [
            {
              model_inputs: [
                {
                  agent: 'billy',
                  model: 'recorded-model',
                  prompt_composition: {
                    provider: 'recorded-provider',
                    loaded_playbook_ids: [playbook],
                    bound_tool_count: 0,
                    context_blocks: [{ id: 'ctx-fixture', tokens: 0 }],
                  },
                },
              ],
            },
          ],
    delta: 'held',
  }
}

test('Replay comparison uses retained observations and compares bytes beyond the shown preview', () => {
  const body = 'Test '.repeat(350)
  const baseline = projectReplayCase(transcript('{"b":1,"a":2}', body, 'video'), 'first')
  const missingCapture = projectReplayCase(transcript('{ "a": 2, "b": 1 }', body), 'first')
  const candidate = projectReplayCase(transcript('{ "a": 2, "b": 1 }', `${body}More`, 'audio'), 'first')
  assert.equal(baseline.turns[0]?.models?.[0]?.composition?.toolCount, 0)
  assert.equal(missingCapture.turns[0]?.models, null)
  assert.equal(baseline.turns[0]?.calls?.[0]?.result?.truncated, true)
  assert.equal(baseline.turns[0]?.calls?.[0]?.result?.preview, candidate.turns[0]?.calls?.[0]?.result?.preview)
  assert.equal(compareReplayCases(baseline, missingCapture), null)
  assert.deepEqual(compareReplayCases(baseline, candidate), {
    turn: 1,
    observations: ['A tool, its input, or its recorded outcome changed', 'Loaded playbooks changed'],
  })
})

test('Replay reader authorizes exact run manifests and selected scenarios with no guessed source attribution', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'diffpane-replay-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'contracts/domain/agent'), { recursive: true })
  const playbook = 'services/ai/agent/prompts/system/tools/audio.j2'
  await writeFile(
    path.join(root, 'contracts/domain/agent/playbooks.toml'),
    `
[[playbook]]
id = "audio"
title = "Working with audio"
trigger = "Hear the user"
path = "system/tools/audio.j2"
surface_for = [
  "audio",
]
owning_eval = "media_fluency"
`,
  )
  const runPath = path.join(root, 'run.json')
  const reader = createBillyReplayReader(async () => runPath)
  const route = await reader.playbook(root, playbook)
  assert.deepEqual(route?.routes, [{ kind: 'Surface', values: ['audio'] }])
  assert.equal(route?.owningEval, 'media_fluency')
  assert.equal(await reader.playbook(root, playbook.replace('audio', 'video')), null)
  assert.equal(await reader.playbook(root, playbook.replace('tools', '../tools')), null)
  await writeFile(runPath, JSON.stringify({ build: 'local', commit: 'head', scenarios: ['first', 'linked'] }))
  await writeFile(path.join(root, 'first.json'), JSON.stringify(transcript('{}', 'hello', 'audio')))
  await assert.rejects(reader.readCase('unselected', 'first'), /Choose a scenario/u)
  const run = await reader.pickRun()
  assert.ok(run)
  assert.deepEqual(run.scenarios, ['first', 'linked'])
  assert.equal((await reader.readCase(run.id, 'first')).scenario, 'first')
  await assert.rejects(reader.readCase(run.id, '../first'), /Choose a scenario/u)
  await assert.rejects(reader.readCase(run.id, 'run'), /Choose a scenario/u)
  if (process.platform === 'win32') return
  await symlink(path.join(root, 'first.json'), path.join(root, 'linked.json'))
  await assert.rejects(reader.readCase(run.id, 'linked'), /symbolic link/u)
})
