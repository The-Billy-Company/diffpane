// Copyright (c) 2026 The Billy Company
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** @typedef {{mode: string, oid: string, headOid: string}} RenameSource */
/** @typedef {{from: string, to: string, oid: string}} WorkingRename */
/** @typedef {(args: string[], input: Buffer | undefined, environment: NodeJS.ProcessEnv) => Promise<Buffer>} ReadGit */

export const MAX_WORKING_RENAME_INPUTS = 4096
const WORKING_RENAME_SIMILARITY_LIMIT = 512

/** @param {string} directory */
function quoteAlternate(directory) {
  // Git accepts C-style quoted paths, including paths with the platform's list separator.
  const quoted = Array.from(directory, character => {
    const code = character.charCodeAt(0)
    return character === '"' || character === '\\' || code < 32 ? `\\${code.toString(8).padStart(3, '0')}` : character
  }).join('')
  return `"${quoted}"`
}

/**
 * @param {string} commonDir
 * @param {Map<string, RenameSource>} sources
 * @param {Set<string>} targets
 * @param {ReadGit} readGit
 * @returns {Promise<WorkingRename[]>}
 */
export async function detectWorkingRenames(commonDir, sources, targets, readGit) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'diffpane-renames-'))
  try {
    const objects = path.join(scratch, 'objects')
    await mkdir(objects)
    const environment = {
      GIT_INDEX_FILE: path.join(scratch, 'index'),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: quoteAlternate(path.join(commonDir, 'objects')),
    }
    const config = ['-c', 'core.splitIndex=false', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${scratch}`]
    const deletions = Array.from(sources, ([filename, { mode, oid }]) => `${mode} ${oid}\t${filename}\0`).join('')
    await readGit([...config, 'update-index', '-z', '--index-info'], Buffer.from(deletions), environment)
    // Intent-to-add makes destinations visible to Git's worktree rename detector.
    const additions = Array.from(targets, filename => `${filename}\0`).join('')
    await readGit(
      [...config, 'add', '-N', '--pathspec-from-file=-', '--pathspec-file-nul'],
      Buffer.from(additions),
      environment,
    )
    const output = await readGit(
      [
        ...config,
        'diff',
        '--raw',
        '-z',
        '--no-abbrev',
        '--no-ext-diff',
        '--no-textconv',
        '--no-relative',
        '--find-renames',
        '--diff-filter=R',
        `-l${WORKING_RENAME_SIMILARITY_LIMIT}`,
      ],
      undefined,
      environment,
    )
    const fields = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output).split('\0')
    /** @type {WorkingRename[]} */
    const renames = []
    for (let index = 0; index < fields.length - 1; index += 3) {
      const oid = fields[index]?.split(' ')[3]
      const from = fields[index + 1]
      const to = fields[index + 2]
      if (oid && from && to && sources.has(from) && targets.has(to)) renames.push({ from, to, oid })
    }
    return renames
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
