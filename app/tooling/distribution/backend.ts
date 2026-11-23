import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { appError } from '../../shared/recovery/app-errors.ts'
import { collectDesktopNotices } from './licenses/collect.ts'

const execute = promisify(execFile)
// This maintained LTS line ships official macOS binaries that support Ventura 13.0.
const nodeVersion = '22.23.5'
const nodeChecksums = {
  arm64: 'd0c68c321161bb2c6483efea9a343010dea8e5e7f60d73c6a7eba140016d662f',
  x64: 'd68bf234a07781141dfca61ae4461c24560f70bd53223d76a41529eb02e8554e',
}

async function stageNode(scratch: string, backend: string, arch: keyof typeof nodeChecksums) {
  const filename = `node-v${nodeVersion}-darwin-${arch}`
  const archive = `${filename}.tar.xz`
  const downloads = path.resolve('target/node-runtime')
  await mkdir(downloads, { recursive: true })
  const cached = path.join(downloads, archive)
  const archiveBytes = await readFile(cached).catch(() => undefined)
  const matches = (data: Buffer) => createHash('sha256').update(data).digest('hex') === nodeChecksums[arch]
  let source = cached
  if (!archiveBytes || !matches(archiveBytes)) {
    const link = `https://nodejs.org/dist/v${nodeVersion}/${archive}`
    const response = await fetch(link, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Could not download the packaged Node.js runtime (${response.status}).`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!matches(bytes)) throw new Error('The packaged Node.js runtime checksum did not match.')
    source = path.join(scratch, archive)
    await writeFile(source, bytes)
    await copyFile(source, cached)
  }

  await execute('/usr/bin/tar', ['-xJf', source, '-C', scratch, `${filename}/bin/node`, `${filename}/LICENSE`])
  await mkdir(path.join(backend, 'bin'), { recursive: true })
  await copyFile(path.join(scratch, filename, 'LICENSE'), path.join(backend, 'LICENSE.Node.js'))
  const node = path.join(backend, 'bin/node')
  await copyFile(path.join(scratch, filename, 'bin/node'), node)
  await execute('/usr/bin/strip', ['-S', '-x', node])
}

const sources = [
  'app/desktop',
  'app/backend',
  'app/shared',
  'legal/NOTICE',
  'legal/GPL-3.0',
  'legal/ogg',
  'node_modules/@parcel/watcher',
  'node_modules/basedpyright',
  'node_modules/detect-libc',
  'node_modules/diff',
  'node_modules/fsevents',
  'node_modules/is-extglob',
  'node_modules/is-glob',
  'node_modules/marked',
  'node_modules/node-addon-api',
  'node_modules/node-pty/LICENSE',
  'node_modules/node-pty/lib',
  'node_modules/node-pty/package.json',
  'node_modules/picomatch',
  'node_modules/smol-toml',
  'node_modules/typescript',
  'node_modules/typescript-language-server',
  'node_modules/yaml',
  'resources/howmany/howmany',
  'resources/howmany/build.json',
]

export async function stageBackend(scratch: string) {
  const arch = process.arch
  if (process.platform !== 'darwin' || (arch !== 'arm64' && arch !== 'x64'))
    throw new Error('Diffpane packaging requires macOS on Apple Silicon or Intel.')
  const backend = path.join(scratch, 'backend')
  await mkdir(backend, { recursive: true })
  const exclusions = [
    'README.md',
    '*.map',
    '/node_modules/typescript/bin/tsc',
    '/node_modules/typescript/lib/tsc.js',
    '/node_modules/typescript/lib/_tsc.js',
    '/node_modules/basedpyright/dist/pyright.js',
  ]
  const operations = await Promise.allSettled([
    stageNode(scratch, backend, arch),
    collectDesktopNotices(path.join(backend, 'legal', 'desktop-dependencies'), arch),
    execute('/usr/bin/rsync', [
      '--recursive',
      '--relative',
      '--perms',
      '--copy-links',
      ...exclusions.map(pattern => `--exclude=${pattern}`),
      '--',
      ...sources,
      `node_modules/@parcel/watcher-darwin-${arch}`,
      `node_modules/node-pty/prebuilds/darwin-${arch}`,
      `${backend}/`,
    ]),
  ])
  for (const operation of operations) if (operation.status === 'rejected') throw appError(operation.reason)
  await chmod(path.join(backend, `node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`), 0o755)
  // The Node sidecar and imported JavaScript use the same ESM semantics as the source tree.
  await writeFile(path.join(backend, 'package.json'), '{"type":"module"}\n')
  return backend
}
