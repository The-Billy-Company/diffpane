// Copyright (c) 2026 The Billy Company
import { execFile, execFileSync, spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { appError } from '../../shared/recovery/app-errors.ts'
import { setupHowMany } from '../dependencies/setup-howmany.ts'
import { stageBackend } from './backend.ts'

const metadata: unknown = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
if (
  !metadata ||
  typeof metadata !== 'object' ||
  !('version' in metadata) ||
  typeof metadata.version !== 'string' ||
  !/^\d+\.\d+\.\d+$/.test(metadata.version)
)
  throw new Error('Diffpane requires a numeric release version in package.json.')
const { version } = metadata
const buildOnly = process.argv.length === 3 && process.argv[2] === '--build-only'
if (process.argv.length > 2 && !buildOnly) throw new Error('Use pnpm run install:app or pnpm run package:app.')

if (process.platform !== 'darwin')
  throw new Error('The terminal launcher installer currently targets macOS. Use pnpm start on other platforms.')

function signingIdentity() {
  const configured = process.env.DIFFPANE_CODESIGN_IDENTITY?.trim()
  if (configured) return configured

  const output = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  const identities = [...output.matchAll(/^\s*\d+\) ([\dA-F]{40}) "Developer ID Application: /gm)].map(
    match => match[1],
  )
  if (identities.length > 1)
    throw new Error(
      'Multiple Developer ID Application identities found. Set DIFFPANE_CODESIGN_IDENTITY to one of them.',
    )
  return identities[0] ?? '-'
}

const userDirectory = os.homedir()
const applications = path.join(userDirectory, 'Applications')
const destination = path.join(applications, 'Diffpane.app')
const bin = path.join(userDirectory, '.local/bin')
const shortLauncher = path.join(bin, 'dp')
const longLauncher = path.join(bin, 'diffpane')
async function existingLauncher(filename: string) {
  try {
    return await lstat(filename)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
if (!buildOnly) {
  const [existingShortLauncher, existingLongLauncher] = await Promise.all([
    existingLauncher(shortLauncher),
    existingLauncher(longLauncher),
  ])
  if (
    existingShortLauncher &&
    (!existingShortLauncher.isSymbolicLink() || (await readlink(shortLauncher)) !== 'diffpane')
  )
    throw new Error(`Cannot install the dp shortcut because ${shortLauncher} is already in use.`)
  if (existingLongLauncher && !existingLongLauncher.isFile() && !existingLongLauncher.isSymbolicLink())
    throw new Error(`Cannot install the launcher because ${longLauncher} is already in use.`)
}

const identity = signingIdentity()
const adHoc = identity === '-'
if (adHoc) console.warn('Using ad hoc signing. macOS may ask for Diffpane Keychain access again after a rebuild.')

const execute = promisify(execFile)
function run(command: string, args: string[], env = process.env) {
  const child = spawn(command, args, { env, stdio: 'inherit' })
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with status ${signal ?? code}.`))
    })
  })
}

function codesign(filename: string, entitlements?: string) {
  const args = ['--force', '--sign', identity]
  if (!adHoc) args.push('--options', 'runtime', buildOnly ? '--timestamp' : '--timestamp=none')
  if (entitlements) args.push('--entitlements', entitlements)
  execFileSync('/usr/bin/codesign', [...args, filename], { stdio: 'inherit' })
}

for (const result of await Promise.allSettled([
  run(process.execPath, [path.resolve('node_modules/.bin/vp'), 'run', 'bundle']),
  setupHowMany(),
])) {
  if (result.status === 'rejected') throw appError(result.reason, { operation: 'prepare-install' })
}

await mkdir('release', { recursive: true })
const scratch = path.resolve(await mkdtemp('release/.tauri-'))
const target = path.resolve('target/diffpane-tauri')
const bundled = path.join(target, 'release/bundle/macos/Diffpane.app')
const releaseDirectory = path.resolve(
  buildOnly ? (process.env.DIFFPANE_PACKAGE_DIR ?? 'release/box-build') : 'release',
  `Diffpane-darwin-${process.arch}`,
)
const bundleApp = path.join(releaseDirectory, 'Diffpane.app')
try {
  const backend = await stageBackend(scratch)
  const config = JSON.stringify({ bundle: { resources: { [`${backend}/`]: 'backend/' } } })
  await run(
    process.execPath,
    [
      path.resolve('node_modules/.bin/tauri'),
      'build',
      '--bundles',
      'app',
      '--no-sign',
      '--ci',
      '--config',
      config,
      '--',
      '--locked',
    ],
    {
      ...process.env,
      CARGO_TARGET_DIR: target,
    },
  )
  const resources = path.join(bundled, 'Contents/Resources/backend')
  const entitlements = path.join(scratch, 'node-entitlements.plist')
  await writeFile(
    entitlements,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>
`,
  )
  for (const binary of [
    `node_modules/@parcel/watcher-darwin-${process.arch}/watcher.node`,
    `node_modules/node-pty/prebuilds/darwin-${process.arch}/pty.node`,
    `node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`,
    'node_modules/fsevents/fsevents.node',
    'resources/howmany/howmany',
  ])
    codesign(path.join(resources, binary))
  codesign(path.join(resources, 'bin/node'), entitlements)
  codesign(bundled)
  verifyApp(bundled)
  await stageBundle(bundled)
} finally {
  await rm(scratch, { recursive: true, force: true })
}

function verifyApp(app: string) {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  const backend = path.join(app, 'Contents/Resources/backend')
  execFileSync(
    path.join(backend, 'bin/node'),
    [
      '--eval',
      `const load = require('node:module').createRequire(process.argv[1]);
       load('@parcel/watcher');
       const shell = load('node-pty').spawn('/bin/sh', ['-c', 'exit 0']);
       shell.onExit(({ exitCode, signal }) => {
         if (exitCode !== 0 || signal) throw new Error('The packaged terminal smoke test failed.');
       });`,
      path.join(backend, 'package.json'),
    ],
    { stdio: 'inherit', timeout: 10_000 },
  )
}

async function stageBundle(source: string) {
  await mkdir(releaseDirectory, { recursive: true })
  const directory = await mkdtemp(path.join(releaseDirectory, '.bundle-'))
  const incoming = path.join(directory, 'Diffpane.app')
  const previous = path.join(directory, 'Diffpane-previous.app')
  let retainPrevious = false
  try {
    await execute('/bin/cp', ['-cR', source, incoming])
    try {
      await rename(bundleApp, previous)
      retainPrevious = true
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    try {
      await rename(incoming, bundleApp)
      retainPrevious = false
    } catch (error) {
      if (retainPrevious) {
        try {
          await rename(previous, bundleApp)
          retainPrevious = false
        } catch (rollback) {
          throw new AggregateError([error, rollback], `Previous bundle kept at ${previous}`, { cause: rollback })
        }
      }
      throw error
    }
  } finally {
    if (!retainPrevious) await rm(directory, { recursive: true, force: true })
  }
}

if (buildOnly) {
  verifyApp(bundleApp)
  console.info(`Packaged ${bundleApp}`)
  process.exit(0)
}

const launcher = (await readFile(new URL('./diffpane.sh', import.meta.url), 'utf8')).replace('@VERSION@', version)
await mkdir(applications, { recursive: true })
await mkdir(bin, { recursive: true })
const staging = await mkdtemp(path.join(applications, '.diffpane-'))
const stagedApp = path.join(staging, 'Diffpane.app')
const previous = path.join(staging, 'Diffpane-previous.app')
let launcherStage: string | undefined
let shortcutCreated = false
let backup = false
let appInstalled = false
try {
  // macOS cp clones files on APFS and falls back to copying across volumes.
  await execute('/bin/cp', ['-cR', bundleApp, stagedApp])
  verifyApp(stagedApp)
  launcherStage = await mkdtemp(path.join(bin, '.diffpane-'))
  const stagedLauncher = path.join(launcherStage, 'diffpane')
  await writeFile(stagedLauncher, launcher, { mode: 0o755 })
  try {
    await symlink('diffpane', shortLauncher)
    shortcutCreated = true
  } catch (error) {
    if ((await readlink(shortLauncher).catch(() => null)) !== 'diffpane') throw error
  }
  try {
    await rename(destination, previous)
    backup = true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  try {
    await rename(stagedApp, destination)
    appInstalled = true
    await rename(stagedLauncher, longLauncher)
  } catch (error) {
    try {
      if (appInstalled) await rename(destination, stagedApp)
      if (backup) {
        await rename(previous, destination)
        backup = false
      }
    } catch (rollback) {
      const message = backup
        ? `Previous app kept at ${previous}`
        : `Could not remove the partial install at ${destination}`
      throw new AggregateError([error, rollback], message, { cause: rollback })
    }
    throw error
  }
  if (backup) {
    try {
      await rename(previous, path.join(os.tmpdir(), `Diffpane-previous-${Date.now()}.app`))
      backup = false
    } catch {
      console.info(`Previous app kept at ${previous}`)
    }
  }
} catch (error) {
  if (shortcutCreated && (await readlink(shortLauncher).catch(() => null)) === 'diffpane') {
    try {
      await rm(shortLauncher, { force: true })
    } catch (rollback) {
      throw new AggregateError([error, rollback], `Could not remove the partial shortcut at ${shortLauncher}`, {
        cause: rollback,
      })
    }
  }
  throw error
} finally {
  // Preserve the old bundle if the rollback itself fails.
  await Promise.all([
    backup ? undefined : rm(staging, { recursive: true, force: true }),
    launcherStage ? rm(launcherStage, { recursive: true, force: true }) : undefined,
  ])
}
console.info(`Installed ${destination}\nRun dp or diffpane to open Diffpane.`)
