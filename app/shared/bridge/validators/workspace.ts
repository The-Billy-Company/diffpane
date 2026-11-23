import type { InventoryFile, InventoryUpdate } from '../../../backend/runtime/session/inventory-delta.ts'
import type {
  WorkspaceCheckpoint,
  WorkspaceDocument,
  WorkspaceFile,
  WorkspaceSnapshot,
} from '../../../backend/runtime/session/workspace-types.ts'
import type { FileContent } from '../../../backend/workspace/documents/file-content.ts'
import type { ContentMatch, ContentSearchResult } from '../../../backend/workspace/repository/content-search.mjs'
import type { RenameResult } from '../../../backend/workspace/repository/file-operations.ts'
import { isWorkspaceMediaUrl } from '../../documents/media-types.ts'
import type { GitChanges, GitCommit, GitFile, GitFileContents, GitOverview, GitRef } from '../../review/git.ts'
import {
  isRecord,
  arrayOf,
  optional,
  nullable,
  isBoolean,
  isString,
  isCount,
  isPositive,
  isTimestamp,
} from './values.ts'

function isContentMatch(value: unknown): value is ContentMatch {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isPositive(value.line) &&
    isPositive(value.column) &&
    isPositive(value.length) &&
    isString(value.before) &&
    isString(value.match) &&
    isString(value.after)
  )
}

export function isContentSearchResult(value: unknown): value is ContentSearchResult {
  return isRecord(value) && arrayOf(isContentMatch)(value.matches) && isBoolean(value.truncated)
}

export function isRenameResult(value: unknown): value is RenameResult {
  return isRecord(value) && isString(value.path) && isString(value.identity)
}

export function isTrashResult(value: unknown): value is { token: string; identity: string } {
  return isRecord(value) && isString(value.token) && isString(value.identity)
}

export function isInventoryFile(value: unknown): value is InventoryFile {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isBoolean(value.submodule) &&
    optional(isBoolean)(value.ignored) &&
    optional(isBoolean)(value.directory)
  )
}

export function isInventoryUpdate(value: unknown): value is InventoryUpdate {
  return (
    isRecord(value) &&
    isCount(value.revision) &&
    isBoolean(value.reset) &&
    arrayOf(isInventoryFile)(value.files) &&
    arrayOf(isString)(value.removed)
  )
}

function isWorkspaceFile(value: unknown): value is WorkspaceFile {
  return (
    isRecord(value) &&
    isString(value.path) &&
    optional(isBoolean)(value.directory) &&
    optional(isString)(value.index) &&
    optional(isString)(value.worktree) &&
    optional(isBoolean)(value.conflicted) &&
    optional(isBoolean)(value.submodule) &&
    optional(isBoolean)(value.ignored) &&
    optional(nullable(isString))(value.originalPath) &&
    optional(isString)(value.indexPath) &&
    optional(isBoolean)(value.renameEdited) &&
    optional(isCount)(value.reviewVersion)
  )
}

function isCheckpoint(value: unknown): value is WorkspaceCheckpoint {
  return (
    isRecord(value) &&
    isCount(value.id) &&
    isTimestamp(value.capturedAt) &&
    arrayOf(isWorkspaceFile)(value.files) &&
    optional(isString)(value.error)
  )
}

function isGitId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
}

function isGitRef(value: unknown): value is GitRef {
  return (
    isRecord(value) &&
    isString(value.name) &&
    (value.kind === 'branch' || value.kind === 'remote' || value.kind === 'tag')
  )
}

function isGitCommit(value: unknown): value is GitCommit {
  return (
    isRecord(value) &&
    isGitId(value.id) &&
    arrayOf(isGitId)(value.parents) &&
    isString(value.subject) &&
    typeof value.committedAt === 'number' &&
    Number.isSafeInteger(value.committedAt) &&
    arrayOf(isGitRef)(value.refs)
  )
}

export function isGitOverview(value: unknown): value is GitOverview {
  return (
    isRecord(value) &&
    isString(value.branch) &&
    nullable(isGitId)(value.head) &&
    arrayOf(isGitCommit)(value.commits) &&
    arrayOf(isGitCommit)(value.today) &&
    nullable(isGitId)(value.dayBase) &&
    isBoolean(value.historyHasMore)
  )
}

function isGitFile(value: unknown): value is GitFile {
  return (
    isRecord(value) &&
    isString(value.path) &&
    nullable(isString)(value.originalPath) &&
    isString(value.status) &&
    nullable(isCount)(value.additions) &&
    nullable(isCount)(value.deletions)
  )
}

export function isGitChanges(value: unknown): value is GitChanges {
  return isRecord(value) && arrayOf(isGitFile)(value.files) && isCount(value.additions) && isCount(value.deletions)
}

export function isGitFileContents(value: unknown): value is GitFileContents {
  return (
    isRecord(value) &&
    isString(value.before) &&
    isString(value.after) &&
    optional(nullable(isString))(value.note) &&
    optional(isBoolean)(value.available)
  )
}

export function isSnapshot(value: unknown): value is WorkspaceSnapshot {
  return (
    isRecord(value) &&
    isString(value.root) &&
    isString(value.scope) &&
    nullable(isString)(value.initialPath) &&
    optional(isPositive)(value.initialLine) &&
    isBoolean(value.isGitRepository) &&
    isString(value.branch) &&
    nullable(isString)(value.head) &&
    arrayOf(isWorkspaceFile)(value.files) &&
    isCount(value.revision) &&
    arrayOf(isString)(value.changedPaths) &&
    isCount(value.inventoryRevision) &&
    nullable(isCheckpoint)(value.checkpoint) &&
    optional(isString)(value.watchError) &&
    isTimestamp(value.gitMs)
  )
}

function isFileContent(value: unknown): value is FileContent {
  if (
    !isRecord(value) ||
    !isCount(value.size) ||
    !nullable(isString)(value.note) ||
    !optional(isString)(value.hex) ||
    !optional(isCount)(value.hexBytes)
  )
    return false
  if (value.kind === 'unavailable') return true
  if (value.kind === 'text') return isString(value.value) && optional(isBoolean)(value.limited)
  if (value.kind === 'binary') return optional(isString)(value.mime)
  return (
    (value.kind === 'image' || value.kind === 'audio' || value.kind === 'video' || value.kind === 'pdf') &&
    isString(value.mime) &&
    optional(isString)(value.data)
  )
}

function isDecoration(value: unknown) {
  return (
    isRecord(value) &&
    isPositive(value.startLine) &&
    isPositive(value.endLine) &&
    value.endLine >= value.startLine &&
    (value.kind === 'added' || value.kind === 'modified' || value.kind === 'deleted')
  )
}

export function isWorkspaceDocument(value: unknown): value is WorkspaceDocument {
  if (!isRecord(value)) return false
  const preview = value.preview
  return (
    isString(value.path) &&
    isCount(value.revision) &&
    optional(isCount)(value.reviewVersion) &&
    isString(value.before) &&
    isString(value.after) &&
    optional(nullable(isString))(value.note) &&
    (preview === undefined || (isRecord(preview) && isFileContent(preview.before) && isFileContent(preview.after))) &&
    optional(isBoolean)(value.workingMissing) &&
    isBoolean(value.editable) &&
    isCount(value.lineCount) &&
    isTimestamp(value.elapsedMs) &&
    optional(isString)(value.diffNote) &&
    nullable(isCount)(value.additions) &&
    nullable(isCount)(value.deletions) &&
    Array.isArray(value.decorations) &&
    value.decorations.every(isDecoration) &&
    Array.isArray(value.beforeDecorations) &&
    value.beforeDecorations.every(isDecoration)
  )
}

export function isMedia(value: unknown): value is { type: string; url: string } {
  return isRecord(value) && isString(value.type) && isString(value.url) && isWorkspaceMediaUrl(value.url)
}
