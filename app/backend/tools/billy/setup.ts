import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify, stripVTControlCharacters } from 'node:util'
import type { BillySetupAction, BillySetupCheck, BillySetupStatus } from '../../../shared/billy/setup.ts'
import { billySetupActions } from '../../../shared/billy/setup.ts'
import type { TerminalCommand } from '../../runtime/terminal/dock.ts'
import { resolveBillyTool } from './native.ts'

const execute = promisify(execFile)
const doctorArgs = ['onboard', 'doctor'] as const
const actions = {
  'igor-auth': ['auth'],
  google: ['auth', 'google'],
  'google-adc': ['auth', 'google-adc'],
  firebase: ['auth', 'firebase'],
  github: ['auth', 'github'],
  doctor: doctorArgs,
  'repair-env': ['run', 'onboard-env'],
} satisfies Record<BillySetupAction, readonly string[]>

function setupEnvironment(root: string): NodeJS.ProcessEnv {
  const home = homedir()
  const userData = process.env['XDG_DATA_HOME'] ?? path.join(home, '.local/share')
  const paths = new Set([
    ...(process.env['PATH'] ?? '').split(path.delimiter),
    path.join(home, '.local/bin'),
    path.join(process.env['MISE_DATA_DIR'] ?? path.join(userData, 'mise'), 'shims'),
    path.join(home, '.cargo/bin'),
    path.join(home, 'go/bin'),
    path.join(home, '.docker/bin'),
    path.join(home, '.nix-profile/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ])
  const search = [...paths].filter(directory => {
    if (!path.isAbsolute(directory)) return false
    const relative = path.relative(root, directory)
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  })
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: search.join(path.delimiter) }
  for (const key of [
    'USER',
    'LOGNAME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'TMP',
    'TEMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'DBUS_SESSION_BUS_ADDRESS',
    'MISE_DATA_DIR',
    'CLOUDSDK_CONFIG',
    'GH_CONFIG_DIR',
    'DOCKER_CONFIG',
    'BILLY_DEV_CONTAINER',
  ]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

async function present(root: string, filename: string, mode: number = constants.F_OK) {
  const absolute = path.join(root, filename)
  const file = await stat(absolute).catch(() => null)
  if (!file?.isFile()) return false
  return access(absolute, mode).then(
    () => true,
    () => false,
  )
}

async function localSetup(root: string): Promise<BillySetupCheck> {
  const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'
  const files = ['.env', 'infra/docker/.env', 'services/ai/.env']
  const [runtime, ...envFiles] = await Promise.all([
    present(root, python, constants.X_OK),
    ...files.map(file => present(root, file)),
  ])
  const missing = [...(runtime ? [] : ['Python virtual environment']), ...files.filter((_, index) => !envFiles[index])]
  return {
    label: 'Local setup',
    state: missing.length ? 'attention' : 'ready',
    detail: missing.length
      ? `Missing ${missing.join(', ')}.`
      : 'The Python virtual environment and three local environment files are present.',
  }
}

function doctorChecks(stdout: string): BillySetupCheck[] {
  const lines = stripVTControlCharacters(stdout)
    .split(/\r?\n/u)
    .map(line => line.trim())
  const missing = lines.flatMap(line => {
    const match = /^✗ ([\w.-]{1,64})\s{2,}missing \(required\)/u.exec(line)
    return match?.[1] ? [match[1]] : []
  })
  // The remaining probes are advisory and may take longer than the tool inventory.
  const inventoryComplete = lines.some(
    line => line === '✓ all required tools present' || line.startsWith('── infra / e2e readiness'),
  )
  const missingSummary = lines.find(line => /^✗ \d+ required tool\(s\) missing\b/u.test(line))
  const tools: BillySetupCheck = {
    label: 'Required tools',
    state: 'unavailable',
    detail: 'Igor did not finish the tool check. Run Onboarding doctor for details.',
  }
  if (missingSummary || missing.length) {
    const summary = missingSummary?.slice(2).split(' — ')[0] ?? 'Required tools are missing'
    const examples = missing.slice(0, 6).join(', ')
    tools.state = 'attention'
    tools.detail = examples ? `${summary}. ${examples}${missing.length > 6 ? ', …' : ''}` : `${summary}.`
  } else if (inventoryComplete) {
    tools.state = 'ready'
    tools.detail = 'Igor found every required tool on PATH.'
  }
  const daemon = lines.find(line => /^[✓!] docker daemon\s{2,}/u.test(line))
  const compose = lines.find(line => /^[✓!] compose config\s{2,}/u.test(line))
  const stack: BillySetupCheck = {
    label: 'Local stack prerequisites',
    state: 'unavailable',
    detail: 'Igor did not finish checking Docker and Compose.',
  }
  if (daemon?.startsWith('!')) {
    stack.state = 'attention'
    stack.detail = 'Docker is missing or its daemon is unreachable.'
  } else if (compose?.startsWith('!')) {
    stack.state = 'attention'
    stack.detail = 'Docker is reachable, but the Compose configuration needs attention.'
  } else if (compose?.startsWith('✓')) {
    stack.state = 'ready'
    stack.detail = 'Docker is reachable and the Compose configuration is valid.'
  } else if (daemon?.startsWith('✓')) {
    stack.detail = 'Docker is reachable. Igor did not finish checking Compose.'
  }
  return [tools, stack]
}

export async function checkBillySetup(root: string, signal: AbortSignal): Promise<BillySetupStatus> {
  const env = setupEnvironment(root)
  const [setup, executable] = await Promise.all([
    localSetup(root),
    resolveBillyTool(root, 'igor', env['PATH']).catch(() => null),
  ])
  signal.throwIfAborted()
  const igor: BillySetupCheck = {
    label: 'Igor CLI',
    state: executable ? 'ready' : 'attention',
    detail: executable ? 'Igor was found on this machine.' : 'Install Igor using Billy’s developer setup.',
  }
  if (!executable) return { checks: [igor, setup, ...doctorChecks('')] }
  const timeout = AbortSignal.timeout(15_000)
  let stdout = ''
  try {
    const output = await execute(executable, [...doctorArgs, '--workspace', root, '--timeout', '13'], {
      cwd: root,
      env: { ...env, NO_COLOR: '1' },
      encoding: 'utf8',
      signal: AbortSignal.any([signal, timeout]),
      maxBuffer: 256 * 1024,
      windowsHide: true,
    })
    stdout = output.stdout
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') stdout = error.stdout
  }
  return { checks: [igor, setup, ...doctorChecks(stdout)] }
}

export async function billySetupCommand(root: string, input: unknown): Promise<TerminalCommand> {
  const action = billySetupActions.find(({ id }) => id === input)
  if (!action) throw new Error('Choose a Billy setup action.')
  const env = setupEnvironment(root)
  const executable = await resolveBillyTool(root, 'igor', env['PATH'])
  const args = actions[action.id]
  return {
    executable,
    args: [...args, '--workspace', root],
    env,
    cwd: root,
    label: action.label,
    description: action.description,
    display: `igor ${args.join(' ')}`,
  }
}
