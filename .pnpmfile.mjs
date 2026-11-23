// Copyright (c) 2026 The Billy Company
const runtimeSingletons = ['react', 'react-dom', 'yjs', '@codemirror/state', '@codemirror/view']

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} lockfile */
function checkLockfile(lockfile) {
  if (!isRecord(lockfile)) throw new Error('Invalid pnpm lockfile document')
  const packages = isRecord(lockfile.packages) ? lockfile.packages : {}
  const snapshots = isRecord(lockfile.snapshots) ? lockfile.snapshots : {}
  const singletons = new Map(runtimeSingletons.map(name => [name, new Set()]))
  const violations = []

  for (const key of [...Object.keys(packages), ...Object.keys(snapshots)]) {
    const base = key.replace(/\(.*/, '')
    const separator = base.lastIndexOf('@')
    singletons.get(base.slice(0, separator))?.add(base.slice(separator + 1))
  }

  for (const [key, metadata] of Object.entries(packages)) {
    const resolution = isRecord(metadata) && isRecord(metadata.resolution) ? metadata.resolution : {}
    if (resolution.type === 'git' || 'tarball' in resolution) {
      violations.push(`${key} resolves from Git or a direct tarball URL`)
    } else if (resolution.type !== 'directory' && (typeof resolution.integrity !== 'string' || !resolution.integrity)) {
      violations.push(`${key} has no registry integrity hash`)
    }
  }

  for (const [name, versions] of singletons) {
    if (versions.size > 1) violations.push(`${name} resolves to multiple versions: ${[...versions].join(', ')}`)
  }

  if (violations.length) throw new Error(`pnpm lockfile policy violations:\n- ${violations.join('\n- ')}`)
}

export const hooks = {
  /** @template T @param {T} lockfile */
  afterAllResolved(lockfile) {
    checkLockfile(lockfile)
    return lockfile
  },
}

// CI checks the committed lockfile after a frozen install, which can skip resolution.
if (import.meta.main) {
  const [{ readFile }, { parseAllDocuments }] = await Promise.all([import('node:fs/promises'), import('yaml')])
  const documents = parseAllDocuments(await readFile(new URL('./pnpm-lock.yaml', import.meta.url), 'utf8'))
  for (const document of documents) {
    const [error] = document.errors
    if (error) throw error
    checkLockfile(document.toJS())
  }
}
