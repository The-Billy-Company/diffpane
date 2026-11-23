// Copyright (c) 2026 The Billy Company
import type { ClaudeCredentials } from '../../../backend/tools/assistant/claude-credentials.mjs'
import type { ClaudeActivity } from '../../../backend/tools/assistant/claude-session.mjs'
import type { ClaudeSession } from '../../../backend/tools/assistant/claude-session.mjs'
import type { AgentMemoryActivity, AgentMemorySnapshot } from '../../agent-memory.ts'
import type {
  AgentFileView,
  AgentProvider,
  AgentThread,
  AgentThreadChange,
  AgentThreadDelegation,
  AgentThreadEvent,
  AgentThreadFile,
  AgentThreadImage,
  AgentThreadLink,
  AgentThreadList,
  AgentThreadStatus,
  AgentThreadUpdate,
} from '../../agent-threads.ts'
import { isIdea } from './persistence.ts'
import { isRecord, arrayOf, optional, isBoolean, isString, isCount, isPositive, isTimestamp, isSide } from './values.ts'

export type ClaudeStatus = Awaited<ReturnType<ClaudeCredentials['status']>>
type ClaudeReply = Awaited<ReturnType<ClaudeSession['send']>>
type ClaudeApplied = Awaited<ReturnType<ClaudeSession['apply']>>
type ClaudeProposal = NonNullable<ClaudeReply['proposal']>

export function isClaudeStatus(value: unknown): value is ClaudeStatus {
  return isRecord(value) && isBoolean(value.configured) && isBoolean(value.secureStorage)
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return value === 'claude' || value === 'cursor' || value === 'codex' || value === 'antigravity'
}

function isAgentThreadStatus(value: unknown): value is AgentThreadStatus {
  return value === 'running' || value === 'idle' || value === 'recent' || value === 'unknown'
}

export function isAgentThread(value: unknown): value is AgentThread {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isAgentProvider(value.provider) &&
    isString(value.title) &&
    isString(value.cwd) &&
    isTimestamp(value.updatedAt) &&
    optional(isString)(value.projectRoot) &&
    optional(isString)(value.agentName) &&
    optional(isBoolean)(value.active) &&
    optional(isAgentThreadStatus)(value.status) &&
    optional(isString)(value.activity)
  )
}

export function isAgentThreadList(value: unknown): value is AgentThreadList {
  return isRecord(value) && arrayOf(isAgentThread)(value.threads) && arrayOf(isAgentProvider)(value.unavailable)
}

function isAgentMemoryProcess(value: unknown): value is NonNullable<AgentMemoryActivity['process']> {
  return isRecord(value) && isPositive(value.pid) && isCount(value.residentBytes) && isBoolean(value.shared)
}

function isAgentMemoryActivity(value: unknown): value is AgentMemoryActivity {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isAgentProvider(value.provider) &&
    isString(value.title) &&
    isTimestamp(value.updatedAt) &&
    optional(isString)(value.action) &&
    optional(isAgentMemoryProcess)(value.process)
  )
}

export function isAgentMemorySnapshot(value: unknown): value is AgentMemorySnapshot {
  return (
    isRecord(value) &&
    isTimestamp(value.sampledAt) &&
    (value.pressure === 'normal' ||
      value.pressure === 'warning' ||
      value.pressure === 'critical' ||
      value.pressure === 'unknown') &&
    (value.source === 'system' || value.source === 'windows') &&
    optional(isCount)(value.usedBytes) &&
    optional(isPositive)(value.totalBytes) &&
    arrayOf(isAgentMemoryActivity)(value.activities)
  )
}

function isAgentThreadFile(value: unknown): value is AgentThreadFile {
  return isRecord(value) && isString(value.path) && optional(isPositive)(value.line)
}

function isAgentThreadChange(value: unknown): value is AgentThreadChange {
  return (
    isRecord(value) &&
    isAgentThreadFile(value) &&
    (value.operation === 'add' ||
      value.operation === 'update' ||
      value.operation === 'delete' ||
      value.operation === 'move') &&
    optional(isString)(value.destinationPath) &&
    optional(isString)(value.diff) &&
    optional(isCount)(value.additions) &&
    optional(isCount)(value.deletions)
  )
}

function isAgentThreadLink(value: unknown): value is AgentThreadLink {
  return (
    isRecord(value) &&
    isAgentThreadFile(value) &&
    isString(value.href) &&
    optional(isBoolean)(value.image) &&
    optional(isString)(value.dataUrl)
  )
}

function isAgentThreadImage(value: unknown): value is AgentThreadImage {
  return isRecord(value) && isString(value.name) && optional(isString)(value.dataUrl)
}

function isAgentThreadDelegation(value: unknown): value is AgentThreadDelegation {
  return (
    isRecord(value) &&
    isString(value.threadId) &&
    optional(isString)(value.name) &&
    (value.direction === undefined || value.direction === 'sent' || value.direction === 'received') &&
    (value.action === 'spawn' ||
      value.action === 'message' ||
      value.action === 'result' ||
      value.action === 'resume' ||
      value.action === 'close' ||
      value.action === 'wait')
  )
}

export function isAgentThreadEvent(value: unknown): value is AgentThreadEvent {
  if (
    !isRecord(value) ||
    !isString(value.text) ||
    !optional(isString)(value.turnId) ||
    !optional(isString)(value.toolName) ||
    !optional(isString)(value.toolDescription) ||
    !optional(arrayOf(isAgentThreadFile))(value.files) ||
    !optional(arrayOf(isAgentThreadChange))(value.changes) ||
    !optional(arrayOf(isAgentThreadLink))(value.links) ||
    !optional(arrayOf(isAgentThreadImage))(value.images)
  )
    return false
  return (
    value.kind === 'user' ||
    value.kind === 'assistant' ||
    value.kind === 'thinking' ||
    value.kind === 'tool' ||
    value.kind === 'edit' ||
    (value.kind === 'delegate' && isAgentThreadDelegation(value.delegation)) ||
    value.kind === 'notice' ||
    value.kind === 'status'
  )
}

export function isAgentThreadUpdate(value: unknown): value is AgentThreadUpdate {
  if (!isRecord(value) || !optional(isAgentThread)(value.thread)) return false
  const { change } = value
  return (
    change === undefined || (isRecord(change) && isCount(change.from) && arrayOf(isAgentThreadEvent)(change.events))
  )
}

export function isAgentFileView(value: unknown): value is AgentFileView {
  return isRecord(value) && (value.kind === 'opened' || (value.kind === 'workspace' && isString(value.path)))
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

export function isClaudeReply(value: unknown): value is ClaudeReply {
  return isRecord(value) && isString(value.text) && isCount(value.step) && optional(isClaudeProposal)(value.proposal)
}

export function isClaudeApplied(value: unknown): value is ClaudeApplied {
  return (
    isRecord(value) &&
    ((Array.isArray(value.paths) && value.paths.length > 0 && value.paths.every(isString)) || isIdea(value.idea))
  )
}

export function isClaudeActivity(value: unknown): value is ClaudeActivity {
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
