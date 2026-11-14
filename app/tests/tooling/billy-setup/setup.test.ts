import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vite-plus/test'
import { billySetupCommand, checkBillySetup } from '../../../electron/tools/billy/setup.ts'

test.skipIf(process.platform === 'win32')('keeps the tool inventory result when advisory checks time out', async () => {
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-billy-setup-')))
  const root = path.join(scratch, 'Billy checkout')
  const bin = path.join(scratch, 'bin')
  const executable = path.join(bin, 'igor')
  try {
    await Promise.all([mkdir(root), mkdir(bin)])
    await writeFile(
      executable,
      [
        '#!/bin/sh',
        '[ "$1" = onboard ] && [ "$2" = doctor ] && [ "$3" = --workspace ] && [ "$4" = "$PWD" ] || exit 9',
        'printf "%s\\n" "  ── infra / e2e readiness" "  ✓ docker daemon          reachable"',
        'exit 2',
      ].join('\n'),
      { mode: 0o700 },
    )
    vi.stubEnv('PATH', bin)
    const { checks } = await checkBillySetup(root, new AbortController().signal)
    expect(checks).toEqual([
      { label: 'Igor CLI', state: 'ready', detail: 'Igor was found on this machine.' },
      {
        label: 'Local setup',
        state: 'attention',
        detail: 'Missing Python virtual environment, .env, infra/docker/.env, services/ai/.env.',
      },
      { label: 'Required tools', state: 'ready', detail: 'Igor found every required tool on PATH.' },
      {
        label: 'Local stack prerequisites',
        state: 'unavailable',
        detail: 'Docker is reachable. Igor did not finish checking Compose.',
      },
    ])
    await expect(billySetupCommand(root, 'repair-env')).resolves.toMatchObject({
      cwd: root,
      executable,
      args: ['run', 'onboard-env', '--workspace', root],
    })
    await expect(billySetupCommand(root, ['auth', 'github'])).rejects.toThrow('Choose a Billy setup action.')
  } finally {
    vi.unstubAllEnvs()
    await rm(scratch, { recursive: true, force: true })
  }
})
