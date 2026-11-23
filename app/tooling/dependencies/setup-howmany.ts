import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, rm, cp, chmod, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { parse as parseToml } from 'smol-toml'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const pinConfig: unknown = JSON.parse(await readFile(new URL('./howmany-tool.json', import.meta.url), 'utf8'))
if (
  typeof pinConfig !== 'object' ||
  pinConfig === null ||
  !('version' in pinConfig) ||
  typeof pinConfig.version !== 'string' ||
  !/^\d+\.\d+\.\d+$/.test(pinConfig.version) ||
  !('revision' in pinConfig) ||
  typeof pinConfig.revision !== 'string' ||
  !/^[0-9a-f]{40}$/.test(pinConfig.revision) ||
  !('url' in pinConfig) ||
  typeof pinConfig.url !== 'string' ||
  new URL(pinConfig.url).protocol !== 'https:' ||
  !('sha256' in pinConfig) ||
  typeof pinConfig.sha256 !== 'string' ||
  !/^[0-9a-f]{64}$/.test(pinConfig.sha256) ||
  !('patchSha256' in pinConfig) ||
  typeof pinConfig.patchSha256 !== 'string' ||
  !/^[0-9a-f]{64}$/.test(pinConfig.patchSha256)
)
  throw new Error('Invalid HowMany source pin.')
export const howmanyPin = {
  version: pinConfig.version,
  revision: pinConfig.revision,
  url: pinConfig.url,
  sha256: pinConfig.sha256,
  patchSha256: pinConfig.patchSha256,
}

export function verifyHowManySource(archive: Buffer) {
  if (createHash('sha256').update(archive).digest('hex') !== howmanyPin.sha256)
    throw new Error('HowMany source checksum mismatch')
}

export function verifyHowManyPatch(patch: Buffer) {
  if (createHash('sha256').update(patch).digest('hex') !== howmanyPin.patchSha256)
    throw new Error('HowMany source patch checksum mismatch')
}

/** Apply a checksum-verified patch without inheriting a containing checkout's path scope. */
export async function applyHowManyPatch(source: string, patchfile: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(source) }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  const options = { cwd: source, env }
  const { stdout } = await execute('git', ['apply', '--numstat', patchfile], options)
  if (!stdout.trim()) throw new Error('HowMany source patch selected no files')
  await execute('git', ['apply', '--check', '--whitespace=error', patchfile], options)
  await execute('git', ['apply', '--whitespace=error', patchfile], options)
}

/** Codesigning changes the executable bytes; stamp the copy packaged with the app afterward. */
export async function stampHowManyBinary(directory: string) {
  const marker = path.join(directory, 'build.json')
  const built: unknown = JSON.parse(await readFile(marker, 'utf8'))
  if (
    typeof built !== 'object' ||
    built === null ||
    !('identity' in built) ||
    typeof built.identity !== 'string' ||
    !('version' in built) ||
    typeof built.version !== 'string' ||
    !('sha256' in built) ||
    typeof built.sha256 !== 'string'
  )
    throw new Error('Invalid HowMany build provenance')
  const sha256 = createHash('sha256')
    .update(await readFile(path.join(directory, 'howmany')))
    .digest('hex')
  await writeFile(marker, `${JSON.stringify({ ...built, sha256 }, null, 2)}\n`)
}

interface LocalSource {
  path: string
  revision: string
  sha256: string
  version: string
  files: string[]
}

async function fingerprintHowManyFiles(directory: string, inventory: readonly string[]) {
  const hash = createHash('sha256')
  const files: string[] = []
  for (const filename of [...new Set(inventory)].toSorted()) {
    const file = path.join(directory, filename)
    let info
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Bound fingerprint reads while preserving deterministic hash order.
      info = await lstat(file)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    if (!info.isFile()) throw new Error(`HowMany source requires regular files: ${filename}`)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Hash one source file at a time to bound memory.
    const content = await readFile(file)
    hash.update(`${filename}\0${info.mode & 0o777}\0${content.length}\0`)
    hash.update(content)
    files.push(filename)
  }
  return { sha256: hash.digest('hex'), files }
}

export async function inspectHowManySource(checkout: string): Promise<LocalSource> {
  const source = await realpath(checkout)
  const { stdout: repository } = await execute('git', ['-C', source, 'rev-parse', '--show-toplevel'])
  if ((await realpath(repository.trim())) !== source) throw new Error('HowMany source must be a Git checkout root')
  const manifest = parseToml(await readFile(path.join(source, 'Cargo.toml'), 'utf8'))
  const metadata = manifest.package
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata) ||
    !('name' in metadata) ||
    metadata.name !== 'howmany' ||
    !('version' in metadata) ||
    typeof metadata.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(metadata.version)
  )
    throw new Error('Expected a HowMany source checkout with a numeric package version')
  const { stdout: revision } = await execute('git', ['-C', source, 'rev-parse', 'HEAD'])
  const { stdout: inventory } = await execute(
    'git',
    ['-C', source, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { maxBuffer: 16 * 1024 * 1024 },
  )
  const fingerprint = await fingerprintHowManyFiles(source, inventory.split('\0').filter(Boolean))
  return { path: source, revision: revision.trim(), version: metadata.version, ...fingerprint }
}

interface SetupOptions {
  source?: string
  released?: boolean
}

/** Build once for the packaging host; recipients run the bundled binary without Rust or Homebrew. */
export async function setupHowMany(options: SetupOptions = {}) {
  if (process.platform !== 'darwin') throw new Error('Bundling HowMany currently targets macOS')
  const directory = path.join(root, 'resources/howmany')
  const binary = path.join(directory, 'howmany')
  const marker = path.join(directory, 'build.json')
  if (options.source && options.released) throw new Error('Choose --source or --released')
  let built: unknown
  try {
    built = JSON.parse(await readFile(marker, 'utf8'))
  } catch {
    /* A missing or invalid marker requires a build. */
  }
  let sourcePath = options.source ?? (options.released ? undefined : process.env.DIFFPANE_HOWMANY_SOURCE)
  if (!options.released && !sourcePath && typeof built === 'object' && built !== null && 'source' in built) {
    const saved = built.source
    if (typeof saved === 'object' && saved !== null && 'path' in saved && typeof saved.path === 'string')
      sourcePath = saved.path
  }
  const local = sourcePath ? await inspectHowManySource(sourcePath) : undefined
  const version = local?.version ?? howmanyPin.version
  const sourcePatch = local ? undefined : await readFile(new URL('./howmany-source.patch', import.meta.url))
  if (sourcePatch) verifyHowManyPatch(sourcePatch)
  const sourceIdentity = local ? `local-${local.sha256}` : `${howmanyPin.revision}-${howmanyPin.patchSha256}`
  const identity = `${sourceIdentity}-${process.platform}-${process.arch}`
  try {
    const hash = createHash('sha256')
      .update(await readFile(binary))
      .digest('hex')
    if (
      typeof built === 'object' &&
      built !== null &&
      'identity' in built &&
      built.identity === identity &&
      'sha256' in built &&
      built.sha256 === hash
    ) {
      const { stdout } = await execute(binary, ['--version'], { timeout: 5000 })
      if (stdout.trim() === `howmany ${version}`) return binary
    }
  } catch {
    /* Prepare a missing, changed, or outdated bundle. */
  }
  // Rust is a source-build dependency only, like Node and pnpm. Never run editor setup:
  // HowMany belongs inside Diffpane and must not change VS Code/Neovim settings.
  try {
    await execute('cargo', ['--version'], { timeout: 10000 })
  } catch {
    throw new Error(
      'Building the app from source requires Rust 1.88+ (cargo). Install Rust, then rerun pnpm run install:app. Installed Diffpane apps include HowMany and do not require Rust.',
    )
  }
  console.info(`Building bundled HowMany ${version} (${process.arch}${local ? ', local source' : ''})`)
  const cache = path.join(root, 'target/howmany', `${process.platform}-${process.arch}`)
  await mkdir(cache, { recursive: true })
  const temporary = await mkdtemp(path.join(cache, 'source-'))
  try {
    let source: string
    if (local) {
      source = path.join(temporary, 'checkout')
      for (const filename of local.files) {
        const destination = path.join(source, filename)
        // oxlint-disable-next-line eslint/no-await-in-loop -- Snapshot serially to bound filesystem work.
        await mkdir(path.dirname(destination), { recursive: true })
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each destination directory must exist before copying.
        await cp(path.join(local.path, filename), destination)
      }
      const snapshot = await fingerprintHowManyFiles(source, local.files)
      if (snapshot.sha256 !== local.sha256 || (await inspectHowManySource(local.path)).sha256 !== local.sha256)
        throw new Error('HowMany source changed while preparing the build; rerun setup')
    } else {
      const response = await fetch(howmanyPin.url, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`HowMany source download failed: ${response.status}`)
      const archive = Buffer.from(await response.arrayBuffer())
      verifyHowManySource(archive)
      const tarball = path.join(temporary, 'source.tar.gz')
      await writeFile(tarball, archive)
      await execute('/usr/bin/tar', ['-xzf', tarball, '-C', temporary])
      source = path.join(temporary, `howmany-${howmanyPin.revision}`)
      if (!sourcePatch) throw new Error('Missing HowMany source patch')
      const patchfile = path.join(temporary, 'howmany-source.patch')
      await writeFile(patchfile, sourcePatch)
      await applyHowManyPatch(source, patchfile)
      // The pinned archive omits its declared benchmark; local checkouts include theirs.
      const manifestPath = path.join(source, 'Cargo.toml')
      const manifest = await readFile(manifestPath, 'utf8')
      await writeFile(manifestPath, manifest.replace('\n[[bench]]\nname = "throughput"\nharness = false\n', '\n'))
    }
    await new Promise<void>((resolve, reject) => {
      const build = spawn(
        'cargo',
        [
          'build',
          '--locked',
          '--release',
          '--jobs',
          '2',
          '--manifest-path',
          path.join(source, 'Cargo.toml'),
          '--target-dir',
          path.join(cache, 'build'),
        ],
        {
          cwd: source,
          stdio: 'inherit',
          shell: false,
        },
      )
      build.once('error', reject)
      build.once('exit', code => (code === 0 ? resolve() : reject(new Error(`HowMany build failed (${code})`))))
    })
    const compiled = path.join(cache, 'build/release/howmany')
    const { stdout } = await execute(compiled, ['--version'], { timeout: 5000 })
    if (stdout.trim() !== `howmany ${version}`) throw new Error('Unexpected bundled HowMany version')
    await mkdir(directory, { recursive: true })
    await cp(compiled, binary)
    await chmod(binary, 0o755)
    await cp(path.join(source, 'LICENSE'), path.join(directory, 'LICENSE'))
    const sha256 = createHash('sha256')
      .update(await readFile(binary))
      .digest('hex')
    const provenance = local
      ? { path: local.path, revision: local.revision, sha256: local.sha256 }
      : {
          revision: howmanyPin.revision,
          url: howmanyPin.url,
          sha256: howmanyPin.sha256,
          patchSha256: howmanyPin.patchSha256,
        }
    await writeFile(marker, `${JSON.stringify({ identity, sha256, version, source: provenance }, null, 2)}\n`)
    return binary
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, released: { type: 'boolean' } } })
  console.info(`HowMany ready: ${await setupHowMany(values)}`)
}
