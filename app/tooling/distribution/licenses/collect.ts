import { execFile } from 'node:child_process'
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const noticeName = /^(?:copying|licen[cs]e|notice)(?:$|[._-])/i

async function copyNotices(source: string, destination: string) {
  const entries = await readdir(source, { withFileTypes: true })
  const notices = entries.filter(entry => entry.isFile() && noticeName.test(entry.name))
  if (!notices.length) return
  await mkdir(destination, { recursive: true })
  await Promise.all(notices.map(({ name }) => copyFile(path.join(source, name), path.join(destination, name))))
}

export async function collectDesktopNotices(output: string, arch: 'arm64' | 'x64') {
  const platform = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  const { stdout } = await execute(
    'cargo',
    [
      'metadata',
      '--locked',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--format-version',
      '1',
      '--filter-platform',
      platform,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  )
  const metadata: unknown = JSON.parse(stdout)
  if (!metadata || typeof metadata !== 'object' || !('packages' in metadata) || !Array.isArray(metadata.packages))
    throw new Error('Cargo did not report the desktop dependencies for license collection.')
  const packages: unknown[] = metadata.packages
  const declarations: string[] = []
  const pending: Promise<void>[] = []
  await mkdir(output, { recursive: true })
  for (const item of packages) {
    if (!item || typeof item !== 'object' || !('source' in item) || item.source === null) continue
    if (
      !('name' in item) ||
      typeof item.name !== 'string' ||
      !/^[\w-]+$/.test(item.name) ||
      !('version' in item) ||
      typeof item.version !== 'string' ||
      !/^[\w.+-]+$/.test(item.version) ||
      !('manifest_path' in item) ||
      typeof item.manifest_path !== 'string'
    )
      throw new Error('Cargo reported invalid desktop dependency metadata.')
    const id = `${item.name}-${item.version}`
    const source = path.dirname(item.manifest_path)
    const target = path.join(output, 'rust', id)
    const license = 'license' in item && typeof item.license === 'string' ? item.license : 'see upstream license file'
    declarations.push(`${id}: ${license}`)
    pending.push(copyNotices(source, target))
  }

  for (const javascript of [
    '@tauri-apps/api',
    '@oddbird/popover-polyfill',
    '@audio/decode-opus',
    'codec-parser',
    'simple-yenc',
    '@eshaz/web-worker',
  ]) {
    pending.push(copyNotices(path.join('node_modules', javascript), path.join(output, 'javascript', javascript)))
  }
  await Promise.all([
    ...pending,
    writeFile(path.join(output, 'Cargo-licenses.txt'), `${declarations.toSorted().join('\n')}\n`),
  ])
}
