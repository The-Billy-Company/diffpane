// MONOLITHIC: The sandboxed preload is emitted from one entrypoint and validates every exposed IPC channel. Extract validators when the generator can inline them without runtime imports.
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  AgentFileView,
  AgentProvider,
  AgentThread,
  AgentThreadEvent,
  AgentThreadFile,
  AgentThreadList,
  AgentThreadUpdate,
} from '../../../shared/agent-threads.ts'
import type { BillyClaim, BillyClaimsResult } from '../../../shared/billy/claims.ts'
import type {
  BillyContractDiff,
  BillyContractFile,
  BillyContractGroup,
  BillyContractRequest,
} from '../../../shared/billy/contracts.ts'
import type {
  BillyPlaybook,
  BillyReplayCall,
  BillyReplayCase,
  BillyReplayModel,
  BillyReplayRun,
  BillyReplayText,
} from '../../../shared/billy/replay.ts'
import type { BillySiblingExcerpt, BillySiblingMatch, BillySiblingResult } from '../../../shared/billy/siblings.ts'
import type { DiagnosticEvent } from '../../../shared/diagnostics/diagnostics.ts'
import type { Idea, IdeaChange, IdeaLink } from '../../../shared/ideas/ideas.ts'
import type { ShortcutAction, ShortcutBinding, ShortcutOverrides } from '../../../shared/preferences/shortcuts.ts'
import type { ErrorDetails } from '../../../shared/recovery/app-errors.ts'
import type { ReviewAnchor, ReviewNote, ReviewNoteChange } from '../../../shared/review/review-notes.ts'
import type { RecentTarget } from '../../persistence/preferences/recent-targets.ts'
import type {
  Appearance,
  UiPreferences,
  UiPreferencesBridge,
  UiPreferenceUpdate,
  WorkspaceLayout,
} from '../../persistence/preferences/ui-preferences.ts'
import type { AnalysisState, HowManyEvent, HowManyFile, Report } from '../../tools/analysis/howmany.mjs'
import type { ClaudeCredentials } from '../../tools/assistant/claude-credentials.mjs'
import type { ClaudeActivity, ClaudePrompt } from '../../tools/assistant/claude-session.mjs'
import type { ClaudeSession } from '../../tools/assistant/claude-session.mjs'
import type {
  BillyLane,
  BillyLaneChecks,
  BillyLaneFinding,
  BillyLaneLog,
  BillyLanePage,
  BillyLaneRule,
} from '../../tools/billy-lanes/lanes.ts'
import type { FileContent } from '../../workspace/documents/file-content.ts'
import type {
  ContentMatch,
  ContentSearchRequest,
  ContentSearchResult,
} from '../../workspace/repository/content-search.mjs'
import type { InventoryFile, InventoryUpdate } from '../session/inventory-delta.ts'
import type {
  WorkspaceCheckpoint,
  WorkspaceComparison,
  WorkspaceDocument,
  WorkspaceFile,
  WorkspaceSnapshot,
} from '../session/workspace-types.ts'

type Unsubscribe = () => void
type Validator<T> = (value: unknown) => value is T
type ClaudeStatus = Awaited<ReturnType<ClaudeCredentials['status']>>
type ClaudeReply = Awaited<ReturnType<ClaudeSession['send']>>
type ClaudeApplied = Awaited<ReturnType<ClaudeSession['apply']>>
type ClaudeProposal = NonNullable<ClaudeReply['proposal']>

async function invoke<T>(channel: string, validate: Validator<T>, ...args: unknown[]): Promise<T> {
  const startedAt = performance.now()
  let result: unknown
  try {
    result = await ipcRenderer.invoke(channel, ...args)
  } catch {
    reportBridgeFailure(channel, startedAt, 'IPC_UNAVAILABLE')
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Electron preserves plain data across the context bridge.
    return Promise.reject({
      message: 'The window could not reach Diffpane. Try again.',
      code: 'IPC_UNAVAILABLE',
      operation: channel,
      recoverable: true,
    } satisfies ErrorDetails)
  }
  // The context bridge drops custom fields from Error instances.
  if (isRecord(result)) {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Keep the code and recovery fields available in the renderer.
    if (result.ok === false && isErrorDetails(result.error)) return Promise.reject(result.error)
    if (result.ok === true && 'value' in result && validate(result.value)) return result.value
  }
  reportBridgeFailure(channel, startedAt, 'INVALID_IPC_RESPONSE')
  // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Electron preserves plain data across the context bridge.
  return Promise.reject({
    message: 'Diffpane sent an invalid reply. Try again.',
    code: 'INVALID_IPC_RESPONSE',
    operation: channel,
    recoverable: true,
  } satisfies ErrorDetails)
}

function reportBridgeFailure(channel: string, startedAt: number, code: 'IPC_UNAVAILABLE' | 'INVALID_IPC_RESPONSE') {
  try {
    ipcRenderer.send('preload-diagnostic', channel, Math.round((performance.now() - startedAt) * 100) / 100, code)
  } catch {
    // Keep the original bridge error when the diagnostic channel is also unavailable.
  }
}

function reportDiagnostic(input: unknown): void {
  if (
    !isRecord(input) ||
    input.source !== 'renderer' ||
    typeof input.operation !== 'string' ||
    input.operation.length > 96
  )
    return
  const { source, operation, level, kind } = input
  if (level !== 'info' && level !== 'warn' && level !== 'error') return
  const base = { source, operation, level }
  if (kind === 'metric') {
    const { value, unit } = input
    if (isTimestamp(value) && (unit === 'ms' || unit === 'count' || unit === 'bytes' || unit === 'percent'))
      ipcRenderer.send('renderer-diagnostic', { ...base, kind, value, unit })
    return
  }
  let failure
  if (input.failure !== undefined) {
    if (!isRecord(input.failure)) return
    const { code, recoverable } = input.failure
    if (typeof code !== 'string' || code.length > 64 || typeof recoverable !== 'boolean') return
    failure = { code, recoverable }
  }
  if (kind === 'event') ipcRenderer.send('renderer-diagnostic', { ...base, kind, failure })
  if (kind === 'duration') {
    const { durationMs, outcome } = input
    if (isTimestamp(durationMs) && (outcome === 'success' || outcome === 'failure' || outcome === 'canceled'))
      ipcRenderer.send('renderer-diagnostic', { ...base, kind, durationMs, outcome, failure })
  }
}

function listen<T>(channel: string, validate: Validator<T>, callback: (value: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, value: unknown) => {
    if (validate(value)) callback(value)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isErrorDetails(value: unknown): value is ErrorDetails {
  return (
    isRecord(value) &&
    typeof value.message === 'string' &&
    typeof value.code === 'string' &&
    typeof value.recoverable === 'boolean' &&
    (value.operation === undefined || typeof value.operation === 'string')
  )
}

function arrayOf<T>(validate: Validator<T>): Validator<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every(validate)
}

function optional<T>(validate: Validator<T>): Validator<T | undefined> {
  return (value): value is T | undefined => value === undefined || validate(value)
}

function nullable<T>(validate: Validator<T>): Validator<T | null> {
  return (value): value is T | null => value === null || validate(value)
}

function isUnknown(_value: unknown): _value is unknown {
  return true
}

function isVoid(value: unknown): value is void {
  return value === undefined
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositive(value: unknown): value is number {
  return isCount(value) && value > 0
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isSide(value: unknown): value is 'working' | 'head' {
  return value === 'working' || value === 'head'
}

const appearanceFonts = {
  system: true,
  'monaspace-neon': true,
  'monaspace-argon': true,
  'monaspace-krypton': true,
  'monaspace-radon': true,
  'monaspace-xenon': true,
  menlo: true,
  monaco: true,
  courier: true,
  wingdings: true,
} satisfies Record<Appearance['font'], true>

function isUiAppearance(value: unknown): value is Appearance {
  return (
    isRecord(value) &&
    (value.theme === 'dark' || value.theme === 'light' || value.theme === 'system') &&
    (value.layout === 'automatic' || value.layout === 'split' || value.layout === 'inline') &&
    isString(value.font) &&
    Object.hasOwn(appearanceFonts, value.font) &&
    isCount(value.fontSize) &&
    value.fontSize >= 10 &&
    value.fontSize <= 28 &&
    (value.wordWrap === 'automatic' || value.wordWrap === 'on' || value.wordWrap === 'off') &&
    isBoolean(value.lineNumbers)
  )
}

function isUiLayout(value: unknown): value is WorkspaceLayout {
  if (!isRecord(value)) return false
  const order: unknown = value.order
  return (
    isTimestamp(value.ideas) &&
    isTimestamp(value.files) &&
    isTimestamp(value.right) &&
    isTimestamp(value.rightHeight) &&
    Array.isArray(order) &&
    order.length === 4 &&
    ['ideas', 'files', 'code', 'right'].every(pane => order.includes(pane))
  )
}

function isUiPreferences(value: unknown): value is Partial<UiPreferences> {
  return (
    isRecord(value) &&
    optional(isUiAppearance)(value.appearance) &&
    optional(isUiLayout)(value.layout) &&
    optional(isBoolean)(value.ideasVisible)
  )
}

function isUiPreferenceUpdate(value: unknown): value is UiPreferenceUpdate {
  if (!isRecord(value) || !optional(isCount)(value.revision)) return false
  if (value.key === 'appearance') return isUiAppearance(value.value)
  if (value.key === 'layout') return isUiLayout(value.value)
  return value.key === 'ideasVisible' && isBoolean(value.value)
}

function isShortcutOverrides(value: unknown): value is ShortcutOverrides {
  return isRecord(value) && Object.values(value).every(isString)
}

function isIdeaLink(value: unknown): value is IdeaLink {
  return (
    isRecord(value) &&
    isString(value.path) &&
    optional(isPositive)(value.line) &&
    optional(isPositive)(value.endLine) &&
    optional(isSide)(value.side) &&
    optional(isString)(value.excerpt) &&
    optional(isBoolean)(value.truncated)
  )
}

function isIdea(value: unknown): value is Idea {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isString(value.body) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    value.updatedAt >= value.createdAt &&
    arrayOf(isIdeaLink)(value.links)
  )
}

function isIdeaChange(value: unknown): value is IdeaChange {
  return (
    isRecord(value) &&
    ((value.type === 'upsert' && isIdea(value.idea)) || (value.type === 'delete' && isString(value.id)))
  )
}

function isReviewAnchor(value: unknown): value is ReviewAnchor {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isSide(value.side) &&
    (value.originalPath === undefined || (value.side === 'head' && isString(value.originalPath))) &&
    ((value.line === null && value.endLine === null) ||
      (isPositive(value.line) && isPositive(value.endLine) && value.endLine >= value.line)) &&
    isString(value.excerpt) &&
    isBoolean(value.truncated)
  )
}

function isReviewNote(value: unknown): value is ReviewNote {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.text) &&
    isBoolean(value.resolved) &&
    nullable(isReviewAnchor)(value.anchor)
  )
}

function isClaudeStatus(value: unknown): value is ClaudeStatus {
  return isRecord(value) && isBoolean(value.configured) && isBoolean(value.secureStorage)
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return value === 'claude' || value === 'cursor' || value === 'codex'
}

function isAgentThread(value: unknown): value is AgentThread {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isAgentProvider(value.provider) &&
    isString(value.title) &&
    isString(value.cwd) &&
    isTimestamp(value.updatedAt) &&
    optional(isBoolean)(value.active)
  )
}

function isAgentThreadList(value: unknown): value is AgentThreadList {
  return isRecord(value) && arrayOf(isAgentThread)(value.threads) && arrayOf(isAgentProvider)(value.unavailable)
}

function isAgentThreadFile(value: unknown): value is AgentThreadFile {
  return isRecord(value) && isString(value.path) && optional(isPositive)(value.line)
}

function isAgentThreadEvent(value: unknown): value is AgentThreadEvent {
  if (!isRecord(value) || !isString(value.text) || !optional(arrayOf(isAgentThreadFile))(value.files)) return false
  return (
    value.kind === 'user' ||
    value.kind === 'assistant' ||
    value.kind === 'tool' ||
    value.kind === 'edit' ||
    value.kind === 'status'
  )
}

function isAgentThreadUpdate(value: unknown): value is AgentThreadUpdate {
  return (
    isRecord(value) &&
    isString(value.subscription) &&
    arrayOf(isAgentThreadEvent)(value.events) &&
    optional(isString)(value.error)
  )
}

function isAgentFileView(value: unknown): value is AgentFileView {
  return (
    isRecord(value) &&
    ((value.kind === 'workspace' && isString(value.path)) ||
      (value.kind === 'preview' && isString(value.text) && isBoolean(value.limited)))
  )
}

function isClaudeFileEdit(value: unknown) {
  return isRecord(value) && isString(value.before) && isString(value.after) && isPositive(value.startLine)
}

function isClaudeProposal(value: unknown): value is ClaudeProposal {
  if (!isRecord(value) || !isString(value.id)) return false
  if (value.kind === 'files')
    return (
      Array.isArray(value.files) &&
      value.files.length > 0 &&
      value.files.every(
        (file: unknown) =>
          isRecord(file) &&
          isString(file.path) &&
          (file.action === 'edit' || file.action === 'create') &&
          Array.isArray(file.edits) &&
          (file.action === 'create' || file.edits.length > 0) &&
          file.edits.every(isClaudeFileEdit),
      )
    )
  return (
    value.kind === 'idea' &&
    isString(value.before) &&
    isString(value.after) &&
    (value.action === 'create' || value.action === 'update') &&
    isString(value.ideaId) &&
    isString(value.title) &&
    optional(isString)(value.beforeTitle)
  )
}

function isClaudeReply(value: unknown): value is ClaudeReply {
  return isRecord(value) && isString(value.text) && isCount(value.step) && optional(isClaudeProposal)(value.proposal)
}

function isClaudeApplied(value: unknown): value is ClaudeApplied {
  return (
    isRecord(value) &&
    ((Array.isArray(value.paths) && value.paths.length > 0 && value.paths.every(isString)) || isIdea(value.idea))
  )
}

function isClaudeActivity(value: unknown): value is ClaudeActivity {
  if (!isRecord(value) || !isString(value.requestId) || !isCount(value.step)) return false
  if (value.type === 'text') return isString(value.text)
  if (value.type === 'mode') return value.mode === 'edit'
  return (
    value.type === 'tool' &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.label) &&
    (value.status === 'running' || value.status === 'done' || value.status === 'error') &&
    optional(isString)(value.detail) &&
    optional(isString)(value.path) &&
    optional(isSide)(value.side) &&
    optional(isPositive)(value.startLine) &&
    optional(isPositive)(value.endLine)
  )
}

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

function isContentSearchResult(value: unknown): value is ContentSearchResult {
  return isRecord(value) && arrayOf(isContentMatch)(value.matches) && isBoolean(value.truncated)
}

function isRecentTarget(value: unknown): value is RecentTarget {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isString(value.name) &&
    isTimestamp(value.openedAt) &&
    (value.kind === 'folder' || value.kind === 'file')
  )
}

function isInventoryFile(value: unknown): value is InventoryFile {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isBoolean(value.submodule) &&
    optional(isBoolean)(value.ignored) &&
    optional(isBoolean)(value.directory)
  )
}

function isInventoryUpdate(value: unknown): value is InventoryUpdate {
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

function isSnapshot(value: unknown): value is WorkspaceSnapshot {
  return (
    isRecord(value) &&
    isString(value.root) &&
    isString(value.scope) &&
    nullable(isString)(value.initialPath) &&
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

function isWorkspaceDocument(value: unknown): value is WorkspaceDocument {
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

function isLineCounts(value: unknown): boolean {
  return (
    isRecord(value) &&
    isCount(value.total_lines) &&
    isCount(value.code_lines) &&
    isCount(value.doc_lines) &&
    isCount(value.comment_lines) &&
    isCount(value.blank_lines) &&
    isCount(value.total_size)
  )
}

function isHowManyReport(value: unknown): value is Report {
  if (!isRecord(value)) return false
  const { basic, source, breakdown } = value
  return (
    isRecord(basic) &&
    isCount(basic.total_files) &&
    isLineCounts(basic) &&
    (source === undefined || (isRecord(source) && isCount(source.file_count) && isLineCounts(source))) &&
    (breakdown === undefined ||
      (isRecord(breakdown) &&
        Array.isArray(breakdown.rows) &&
        breakdown.rows.every(
          row =>
            isRecord(row) &&
            isCount(row.file_count) &&
            isLineCounts(row) &&
            isString(row.language) &&
            (row.category === 'code' ||
              row.category === 'config' ||
              row.category === 'data' ||
              row.category === 'docs'),
        )))
  )
}

function isHowManyState(value: unknown): value is AnalysisState {
  return (
    isRecord(value) &&
    (value.status === 'idle' || value.status === 'analyzing' || value.status === 'ready' || value.status === 'error') &&
    nullable(isHowManyReport)(value.report) &&
    isString(value.message) &&
    nullable(isTimestamp)(value.updatedAt)
  )
}

function isHowManyFile(value: unknown): value is HowManyFile {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isString(value.title) &&
    optional(isBoolean)(value.live) &&
    optional(isString)(value.message)
  )
}

function isHowManyEvent(value: unknown): value is HowManyEvent {
  if (!isRecord(value)) return false
  if (value.type === 'analysis') return isHowManyState(value)
  if (value.type === 'file') return isString(value.path) && isString(value.request) && 'diagnostics' in value
  return value.type === 'process' && (value.status === 'started' || value.status === 'stopped') && isPositive(value.pid)
}

function isNull(value: unknown): value is null {
  return value === null
}

function isMedia(value: unknown): value is { type: string; url: string } {
  return isRecord(value) && isString(value.type) && isString(value.url)
}

function isBillyLane(value: unknown): value is BillyLane {
  return isRecord(value) && isString(value.slug) && isBoolean(value.current) && arrayOf(isString)(value.recorded)
}

function isBillyLanePage(value: unknown): value is BillyLanePage {
  return isRecord(value) && isBoolean(value.truncated) && arrayOf(isBillyLane)(value.rows)
}

function isBillyLaneRule(value: unknown): value is BillyLaneRule {
  return isRecord(value) && isString(value.id) && isString(value.path) && optional(isPositive)(value.line)
}

function isBillyLaneFinding(value: unknown): value is BillyLaneFinding {
  return (
    isRecord(value) &&
    isString(value.check) &&
    isString(value.message) &&
    optional(isString)(value.path) &&
    optional(isPositive)(value.line) &&
    arrayOf(isBillyLaneRule)(value.rules)
  )
}

function isBillyLaneLog(value: unknown): value is BillyLaneLog {
  return (
    isRecord(value) &&
    isString(value.text) &&
    isBoolean(value.complete) &&
    isCount(value.readBytes) &&
    optional(isCount)(value.totalBytes)
  )
}

function isBillyLaneChecks(value: unknown): value is BillyLaneChecks {
  if (!isRecord(value)) return false
  if (value.kind === 'missing') return true
  return (
    value.kind === 'saved' &&
    isString(value.capture) &&
    arrayOf(isString)(value.failedChecks) &&
    isRecord(value.counts) &&
    isCount(value.counts.passed) &&
    isCount(value.counts.failed) &&
    isCount(value.counts.advisory) &&
    isCount(value.counts.skipped) &&
    optional(isTimestamp)(value.capturedAt) &&
    isBoolean(value.conclusive) &&
    arrayOf(isBillyLaneFinding)(value.findings) &&
    isBoolean(value.findingsComplete) &&
    isCount(value.findingsTotal)
  )
}

function isBillyContractFile(value: unknown): value is BillyContractFile {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isBoolean(value.changed) &&
    isBoolean(value.shared) &&
    (value.sections === undefined ||
      (Array.isArray(value.sections) &&
        value.sections.every(
          (section: unknown) =>
            isRecord(section) && isString(section.name) && isPositive(section.start) && isPositive(section.end),
        ))) &&
    (value.confidence === 'declared' || value.confidence === 'header' || value.confidence === 'candidate')
  )
}

function isBillyContractGroup(value: unknown): value is BillyContractGroup {
  return (
    isRecord(value) &&
    isString(value.id) &&
    (value.sourceKind === 'generator' || value.sourceKind === 'protobuf') &&
    arrayOf(isBillyContractFile)(value.sources) &&
    arrayOf(isBillyContractFile)(value.outputs)
  )
}

function isBillyContractDiff(value: unknown): value is BillyContractDiff {
  return isRecord(value) && isBoolean(value.limited) && arrayOf(isBillyContractGroup)(value.groups)
}

function isBillyClaim(value: unknown): value is BillyClaim {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isPositive(value.line) &&
    isString(value.label) &&
    arrayOf(isString)(value.findings) &&
    (value.kind === 'sentinel' || value.kind === 'occurrence' || value.kind === 'path')
  )
}

function isBillyClaimsResult(value: unknown): value is BillyClaimsResult {
  return (
    isRecord(value) &&
    isBoolean(value.limited) &&
    arrayOf(isBillyClaim)(value.claims) &&
    (value.verification === 'scoped' || value.verification === 'unavailable')
  )
}

function isBillySiblingExcerpt(value: unknown): value is BillySiblingExcerpt {
  return isRecord(value) && isString(value.path) && isPositive(value.line) && nullable(isString)(value.text)
}

function isBillySiblingMatch(value: unknown): value is BillySiblingMatch {
  return (
    isRecord(value) &&
    (value.grade === 'identical' || value.grade === 'strong' || value.grade === 'moderate') &&
    isBillySiblingExcerpt(value)
  )
}

function isBillySiblingResult(value: unknown): value is BillySiblingResult {
  return (
    isRecord(value) &&
    (value.kind === 'no-function' ||
      (value.kind === 'ready' &&
        isString(value.scope) &&
        isBillySiblingExcerpt(value.source) &&
        arrayOf(isBillySiblingMatch)(value.candidates)))
  )
}

function isBillyPlaybook(value: unknown): value is BillyPlaybook {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isString(value.source) &&
    isString(value.registry) &&
    isString(value.trigger) &&
    nullable(isString)(value.owningEval) &&
    Array.isArray(value.routes) &&
    value.routes.every(
      (route: unknown) =>
        isRecord(route) &&
        arrayOf(isString)(route.values) &&
        (route.kind === 'Mission' ||
          route.kind === 'Surface' ||
          route.kind === 'Tool' ||
          route.kind === 'Connector' ||
          route.kind === 'Native format'),
    )
  )
}

function isBillyReplayRun(value: unknown): value is BillyReplayRun {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.build) &&
    isString(value.commit) &&
    nullable(isString)(value.mode) &&
    arrayOf(isString)(value.scenarios)
  )
}

function isBillyReplayText(value: unknown): value is BillyReplayText {
  return isRecord(value) && isString(value.preview) && isString(value.hash) && isBoolean(value.truncated)
}

function isBillyReplayCall(value: unknown): value is BillyReplayCall {
  return (
    isRecord(value) &&
    isString(value.name) &&
    nullable(isString)(value.agent) &&
    nullable(isBillyReplayText)(value.args) &&
    nullable(isBillyReplayText)(value.result) &&
    (value.status === 'error' ||
      value.status === 'finished' ||
      value.status === 'started' ||
      value.status === 'unknown')
  )
}

function isBillyReplayComposition(value: unknown): value is NonNullable<BillyReplayModel['composition']> {
  return (
    isRecord(value) &&
    nullable(isString)(value.variant) &&
    nullable(isString)(value.identityHash) &&
    nullable(isString)(value.toolSchemaHash) &&
    nullable(isCount)(value.identityTokens) &&
    nullable(isCount)(value.toolCount) &&
    nullable(isCount)(value.toolTokens) &&
    nullable(isCount)(value.historyTokens) &&
    nullable(isCount)(value.cacheReadTokens) &&
    nullable(isCount)(value.cacheWriteTokens) &&
    nullable(arrayOf(isString))(value.playbooks) &&
    (value.context === null ||
      (Array.isArray(value.context) &&
        value.context.every((block: unknown) => isRecord(block) && isString(block.id) && isCount(block.tokens))))
  )
}

function isBillyReplayModel(value: unknown): value is BillyReplayModel {
  return (
    isRecord(value) &&
    nullable(isString)(value.agent) &&
    nullable(isString)(value.provider) &&
    nullable(isString)(value.model) &&
    nullable(isBillyReplayComposition)(value.composition)
  )
}

function isBillyReplayCase(value: unknown): value is BillyReplayCase {
  if (
    !isRecord(value) ||
    !isString(value.scenario) ||
    !nullable(isString)(value.user) ||
    !nullable(isString)(value.verdict) ||
    !nullable(isBillyReplayText)(value.reason) ||
    !nullable(isBillyReplayText)(value.error) ||
    !Array.isArray(value.turns)
  )
    return false
  return value.turns.every(
    (turn: unknown) =>
      isRecord(turn) &&
      nullable(isBillyReplayText)(turn.user) &&
      nullable(isBillyReplayText)(turn.reply) &&
      nullable(arrayOf(isBillyReplayCall))(turn.calls) &&
      nullable(arrayOf(isBillyReplayModel))(turn.models),
  )
}

const API = {
  billy: {
    available: () => invoke('billy-available', isBoolean),
    listLanes: () => invoke('billy-lanes', isBillyLanePage),
    readLaneChecks: (slug: string) => invoke('billy-lane-checks', isBillyLaneChecks, slug),
    readLaneLog: (slug: string, check: string, capture: string) =>
      invoke('billy-lane-log', isBillyLaneLog, slug, check, capture),
    readContractDiff: (request: BillyContractRequest) => invoke('billy-contract', isBillyContractDiff, request),
    readClaims: (path: string) => invoke('billy-claims', isBillyClaimsResult, path),
    readSiblings: (path: string, line: number) => invoke('billy-siblings', isBillySiblingResult, path, line),
    replay: {
      playbook: (path: string) => invoke('billy-playbook', nullable(isBillyPlaybook), path),
      pickRun: () => invoke('billy-pick-replay', nullable(isBillyReplayRun)),
      readCase: (runId: string, scenario: string) => invoke('billy-replay-case', isBillyReplayCase, runId, scenario),
    },
  },
  preferences: {
    get: legacy => invoke('preferences-get', isUiPreferences, legacy),
    set: (key, value) => invoke('preferences-set', isUiPreferenceUpdate, key, value),
    onChange: callback => listen('preferences-updated', isUiPreferenceUpdate, callback),
  } satisfies UiPreferencesBridge,
  shortcuts: {
    platform: process.platform,
    get: () => invoke('shortcuts-get', isShortcutOverrides),
    set: (action: ShortcutAction, binding: ShortcutBinding) =>
      invoke('shortcuts-set', isShortcutOverrides, action, binding),
    reset: (action?: ShortcutAction) => invoke('shortcuts-reset', isShortcutOverrides, action),
    setCapturing: (active: boolean) => invoke('shortcuts-capture', isVoid, active),
    setModal: (active: boolean) => ipcRenderer.send('shortcuts-modal', active),
    onChange: (callback: (overrides: ShortcutOverrides) => void) =>
      listen('shortcuts-updated', isShortcutOverrides, callback),
    onOpenSettings: (callback: () => void) => listen('open-settings', isVoid, callback),
  },
  reviewNotes: {
    list: () => invoke('review-notes-list', arrayOf(isReviewNote)),
    change: (change: ReviewNoteChange) => invoke('review-notes-change', arrayOf(isReviewNote), change),
    copy: () => invoke('review-notes-copy', isCount),
    onChange: (callback: (notes: ReviewNote[]) => void) =>
      listen('review-notes-updated', arrayOf(isReviewNote), callback),
  },
  claude: {
    status: () => invoke('claude-status', isClaudeStatus),
    saveKey: (key: string) => invoke('claude-save-key', isClaudeStatus, key),
    removeKey: () => invoke('claude-remove-key', isClaudeStatus),
    send: (input: ClaudePrompt) => invoke('claude-send', isClaudeReply, input),
    apply: (id: string) => invoke('claude-apply', isClaudeApplied, id),
    discard: (id: string) => invoke('claude-discard', isVoid, id),
    reset: () => invoke('claude-reset', isVoid),
    cancel: () => invoke('claude-cancel', isVoid),
    onActivity: (callback: (activity: ClaudeActivity) => void) => listen('claude-activity', isClaudeActivity, callback),
    onReset: (callback: (status: ClaudeStatus) => void) => listen('claude-reset', isClaudeStatus, callback),
  },
  agentThreads: {
    list: () => invoke('agent-threads-list', isAgentThreadList),
    follow: (id: string, subscription: string) => invoke('agent-threads-follow', isVoid, id, subscription),
    stop: (subscription: string) => invoke('agent-threads-stop', isVoid, subscription),
    file: (subscription: string, path: string) => invoke('agent-threads-file', isAgentFileView, subscription, path),
    onUpdate: (callback: (update: AgentThreadUpdate) => void) =>
      listen('agent-threads-update', isAgentThreadUpdate, callback),
  },
  ideas: {
    list: () => invoke('ideas-list', arrayOf(isIdea)),
    upsert: (idea: Idea) => invoke('ideas-upsert', isIdea, idea),
    delete: (id: string) => invoke('ideas-delete', isVoid, id),
    onChange: (callback: (change: IdeaChange) => void) => listen('ideas-change', isIdeaChange, callback),
  },
  howmany: {
    export: () => invoke('howmany-export', isBoolean),
    analyze: (force?: boolean) => invoke('howmany-analyze', isHowManyState, force),
    file: (path: string, request: string) => invoke('howmany-file', nullable(isHowManyFile), path, request),
    close: (path: string) => invoke('howmany-close', isNull, path),
    onEvent: (callback: (value: HowManyEvent) => void) => listen('howmany-event', isHowManyEvent, callback),
  },
  language: {
    open: (input: unknown) => invoke('language-open', isRecord, input),
    request: (input: unknown) => invoke('language-request', isUnknown, input),
    cancel: (id: string | number) => invoke('language-cancel', isNull, id),
    close: (path: string) => invoke('language-close', isNull, path),
    status: () => invoke('language-status', arrayOf(isRecord)),
    onEvent: (callback: (value: unknown) => void) => listen('language-event', isRecord, callback),
  },
  snapshot: () => invoke('snapshot', nullable(isSnapshot)),
  restartWorkspace: () => invoke('restart-workspace', nullable(isSnapshot)),
  captureCheckpoint: () => invoke('capture-checkpoint', isSnapshot),
  files: () => invoke('files', arrayOf(isInventoryFile)),
  contentSearch: (request: ContentSearchRequest) => invoke('content-search', nullable(isContentSearchResult), request),
  cancelContentSearch: () => invoke('content-search-cancel', isVoid),
  filesDelta: (revision: number | null) => invoke('files-delta', isInventoryUpdate, revision),
  directoryExpanded: (path: string, expanded: boolean) => invoke('directory-expanded', isNull, path, expanded),
  document: (path: string, comparison: WorkspaceComparison = 'head') =>
    invoke('document', isWorkspaceDocument, path, comparison),
  save: (path: string, text: string, expected: string) => invoke('save', isNull, path, text, expected),
  rename: (path: string, name: string) => invoke('rename', isString, path, name),
  fileAction: (action: string, path: string) => invoke('file-action', isVoid, action, path),
  onFlushSaves: (callback: (id: number) => void) => listen('flush-saves', isPositive, callback),
  onResumeEditing: (callback: () => void) => listen('resume-editing', isVoid, callback),
  savesFlushed: (success: boolean, id: number) => ipcRenderer.send('saves-flushed', success, id),
  setSaveState: (dirty: boolean) => ipcRenderer.send('save-state', dirty),
  rendererReady: () => ipcRenderer.send('renderer-ready'),
  terminal: {
    toggle: () => invoke('terminal-toggle', isBoolean),
    layout: (height: number, bottom: number, theme?: 'light' | 'dark') =>
      ipcRenderer.send('terminal-layout', height, bottom, theme),
    onVisibility: (callback: (visible: boolean) => void) => listen('terminal-visibility', isBoolean, callback),
  },
  reportDiagnostic: (event: DiagnosticEvent) => reportDiagnostic(event),
  media: (path: string) => invoke('media', isMedia, path),
  refresh: () => invoke('refresh', isSnapshot),
  openFolder: () => invoke('open-folder', isBoolean),
  openFile: () => invoke('open-file', isBoolean),
  recentTargets: () => invoke('recent-targets', arrayOf(isRecentTarget)),
  openRecent: (path: string) => invoke('open-recent', isBoolean, path),
  openExternal: (url: string) => invoke('open-external', isVoid, url),
  onChange: (callback: (value: WorkspaceSnapshot) => void) => listen('change', isSnapshot, callback),
  onPaths: (callback: (paths: string[]) => void) => listen('paths', arrayOf(isString), callback),
  onError: (callback: (value: ErrorDetails) => void) => listen('backend-error', isErrorDetails, callback),
}

export type DiffpaneApi = typeof API

declare global {
  interface Window {
    diffpane?: DiffpaneApi
  }
}
contextBridge.exposeInMainWorld('diffpane', API)
