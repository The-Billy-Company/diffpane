import { execFile, execFileSync, spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { packager } from '@electron/packager'
import { appError } from '../../shared/recovery/app-errors.ts'
import { setupHowMany } from '../dependencies/setup-howmany.ts'

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
if (process.argv.length > 2) throw new Error('Usage: pnpm run install:app')

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

const identity = signingIdentity()
const adHoc = identity === '-'
if (adHoc) console.warn('Using ad hoc signing. macOS may ask for Diffpane Keychain access again after a rebuild.')

const execute = promisify(execFile)
const languageServerPackages = ['basedpyright', 'typescript', 'typescript-language-server']
const languageServerPaths = languageServerPackages.map(name => `node_modules/${name}`)
const copyExclusions = [
  '*README.md',
  '*.test.mjs',
  '*.test.ts',
  '.DS_Store',
  '.git',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '*.o',
  '*.obj',
  'node_gyp_bins',
]

async function copyPayloads(target: string, sources: string[], exclusions: string[] = []) {
  await execute('/usr/bin/rsync', [
    '--recursive',
    '--relative',
    '--perms',
    '--copy-links',
    ...[...copyExclusions, ...exclusions].map(pattern => `--exclude=${pattern}`),
    '--',
    ...sources,
    `${target}/`,
  ])
}

async function buildRenderer() {
  const child = spawn('pnpm', ['run', 'build'], { stdio: 'inherit' })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Renderer build failed (${signal ?? code})`))
    })
  })
}

for (const result of await Promise.allSettled([buildRenderer(), setupHowMany()])) {
  if (result.status === 'rejected') throw appError(result.reason, { operation: 'prepare-install' })
}

await mkdir('release', { recursive: true })
const scratch = await mkdtemp('release/.packager-')
const [bundle] = await (async () => {
  try {
    return await packager({
      dir: '.',
      out: 'release',
      tmpdir: scratch,
      name: 'Diffpane',
      appBundleId: 'com.diffpane.app',
      extendInfo: fileURLToPath(new URL('./macos-info.plist', import.meta.url)),
      icon: 'branding/desktop/diffpane.icns',
      appVersion: version,
      overwrite: true,
      osxSign: adHoc
        ? undefined
        : {
            identity,
            continueOnError: false,
            preAutoEntitlements: false,
            preEmbedProvisioningProfile: false,
            optionsForFile: () => ({ timestamp: 'none' }),
          },
      // Match by basename so ASAR finds native files under the hidden staging directory.
      asar: { unpack: '{*.node,spawn-helper}' },
      beforeAsar: [
        async ({ buildPath, arch }) => {
          const pty = path.join(buildPath, 'node_modules/node-pty')
          const helper = path.join(pty, 'prebuilds', `darwin-${arch}`, 'spawn-helper')
          const info = await lstat(helper).catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
            throw error
          })
          if (info?.isFile()) await chmod(helper, (info.mode & 0o777) | 0o111)
          // Copy the large trees in one native pass per destination. Packager
          // still prunes the dependencies that Electron loads from ASAR.
          const unpacked = `${buildPath}.asar.unpacked`
          await mkdir(unpacked, { recursive: true })
          // Packager's production filter keeps the empty package roots even
          // when their contents are excluded.
          const copies = await Promise.allSettled([
            copyPayloads(buildPath, ['dist']),
            copyPayloads(
              unpacked,
              [...languageServerPaths, 'resources/howmany'],
              [
                '/node_modules/basedpyright/dist/pyright.js',
                '/node_modules/basedpyright/dist/pyright.js.map',
                '/node_modules/basedpyright/dist/pyright-langserver.js.map',
                '/node_modules/typescript/bin/tsc',
                '/node_modules/typescript/lib/tsc.js',
                '/node_modules/typescript/lib/_tsc.js',
                '/node_modules/typescript-language-server/lib/cli.mjs.map',
                '/resources/howmany/build.json',
              ],
            ),
            ...languageServerPaths.map(directory =>
              rm(path.join(buildPath, directory), { recursive: true, force: true }),
            ),
          ])
          for (const copy of copies) {
            if (copy.status === 'rejected') throw appError(copy.reason, { operation: 'prepare-install' })
          }
        },
      ],
      ignore: [
        /^\/(?!(?:app|legal|node_modules)(?:\/|$)|package\.json$)/,
        /^\/app\/(?!(?:electron|shared)(?:\/|$))/,
        /^\/node_modules\/\.vite[^/]*(?:\/|$)/,
        /^\/node_modules\/node-pty\/prebuilds\/(?!darwin-)/,
        new RegExp(`^/node_modules/(?:${languageServerPackages.join('|')})/`),
        /README\.md$/,
        /\.test\.(mjs|ts)$/,
      ],
    })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})()
if (!bundle) throw new Error('Electron Packager did not produce a macOS app.')
const app = path.join(bundle, 'Diffpane.app')
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
  await execute('/bin/cp', ['-cR', app, stagedApp])
  if (adHoc) execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', stagedApp], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp], { stdio: 'inherit' })
  // Signature verification alone does not check whether Electron can load and launch the native code.
  execFileSync(
    path.join(stagedApp, 'Contents/MacOS/Diffpane'),
    [
      '--eval',
      `const load = require('node:module').createRequire(process.argv[1]);
       load('@parcel/watcher');
       const shell = load('node-pty').spawn('/bin/sh', ['-c', 'exit 0']);
       shell.onExit(({ exitCode, signal }) => {
         if (exitCode !== 0 || signal) throw new Error('The packaged terminal smoke test failed.');
       });`,
      path.join(stagedApp, 'Contents/Resources/app.asar/package.json'),
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 10_000 },
  )
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
