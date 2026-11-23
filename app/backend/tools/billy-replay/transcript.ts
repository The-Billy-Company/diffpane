// Copyright (c) 2026 The Billy Company
import { createHash } from 'node:crypto'
import type {
  BillyReplayCall,
  BillyReplayCase,
  BillyReplayModel,
  BillyReplayText,
  BillyReplayTurn,
} from '../../../shared/billy/replay.ts'

const previewLength = 1200
const maxTurns = 200
const maxRowsPerTurn = 500

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function texts(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string') ? value : null
}

export function scenarioId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9_][a-z0-9_.-]{0,179}$/iu.test(value) && value !== 'run'
}

function count(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function boundedRows(value: unknown, limit: number): unknown[] | null {
  if (!Array.isArray(value)) return null
  if (value.length > limit) throw new Error('The saved scenario exceeds the supported evidence size.')
  const rows: unknown[] = value
  return rows
}

function evidenceText(value: unknown): BillyReplayText | null {
  if (typeof value !== 'string') return null
  return {
    preview: value.slice(0, previewLength),
    truncated: value.length > previewLength,
    hash: createHash('sha256').update(value).digest('hex'),
  }
}

function contextBlocks(value: unknown) {
  const entries = boundedRows(value, maxRowsPerTurn)
  if (!entries) return null
  const blocks = entries.map(entry => {
    const row = record(entry)
    const id = text(row?.id)
    const tokens = count(row?.tokens)
    return id && tokens !== null ? { id, tokens } : null
  })
  return blocks.every(block => block !== null) ? blocks : null
}

function modelInputs(value: unknown): BillyReplayModel[] | null {
  const rows = boundedRows(value, maxRowsPerTurn)
  if (!rows?.length) return null
  return rows.map(entry => {
    const model = record(entry)
    const composition = record(model?.prompt_composition)
    return {
      agent: text(model?.agent),
      provider: text(composition?.provider) ?? text(model?.provider),
      model: text(composition?.model) ?? text(model?.model),
      composition: composition
        ? {
            variant: text(composition.variant),
            identityHash: text(composition.identity_hash),
            identityTokens: count(composition.identity_tokens),
            toolSchemaHash: text(composition.bound_tool_schema_hash),
            toolCount: count(composition.bound_tool_count),
            toolTokens: count(composition.bound_tool_tokens),
            historyTokens: count(composition.history_tokens),
            cacheReadTokens: count(composition.cache_read_tokens),
            cacheWriteTokens: count(composition.cache_write_tokens),
            playbooks: texts(composition.loaded_playbook_ids),
            context: contextBlocks(composition.context_blocks),
          }
        : null,
    }
  })
}

// TraceSink stores args as a JSON string. Normalize key order for side-by-side comparison.
function argumentText(value: unknown) {
  let decoded = value
  if (typeof value === 'string' && value) {
    try {
      decoded = JSON.parse(value)
    } catch {
      return evidenceText(value)
    }
  }
  if (value === '' || value === undefined || value === null) return null
  return evidenceText(
    JSON.stringify(
      decoded,
      (_key, item: unknown) => {
        const object = record(item)
        return object
          ? Object.fromEntries(
              Object.entries(object).toSorted(([left], [right]) => (left < right ? -1 : Number(left > right))),
            )
          : item
      },
      2,
    ),
  )
}

function toolCalls(value: unknown): BillyReplayCall[] | null {
  const rows = boundedRows(value, maxRowsPerTurn)
  if (!rows) return null
  const calls = rows.map(entry => {
    const call = record(entry)
    const fn = record(call?.function)
    const name = text(call?.name) ?? text(call?.tool) ?? text(fn?.name)
    if (!call || !name) return null
    const status: BillyReplayCall['status'] =
      call.is_error === true
        ? 'error'
        : call.finished === true || (call.is_error === false && call.finished === undefined)
          ? 'finished'
          : call.finished === false
            ? 'started'
            : 'unknown'
    return {
      name,
      agent: text(call.agent),
      args: argumentText(call.args ?? fn?.arguments),
      result: status === 'started' ? null : evidenceText(call.content),
      status,
    }
  })
  return calls.every(call => call !== null) ? calls : null
}

export function projectReplayCase(value: unknown, scenario: string): BillyReplayCase {
  const saved = record(value)
  const messages = boundedRows(saved?.messages, 2 * maxTurns + 1)
  if (saved?.scenario_id !== scenario || !messages) {
    throw new Error('The selected file does not match the Replay scenario.')
  }
  const evidence = boundedRows(saved.evidence, maxTurns)
  const turns: BillyReplayTurn[] = []
  let current: BillyReplayTurn | undefined
  let completed = 0
  for (const raw of messages) {
    const message = record(raw)
    if (message?.role === 'system') continue
    if (message?.role === 'user' && typeof message.content === 'string') {
      current = { user: evidenceText(message.content), reply: null, calls: null, models: null }
      turns.push(current)
      continue
    }
    if (message?.role !== 'assistant' || !current || typeof message.content !== 'string') {
      throw new Error('The Replay scenario has an unsupported transcript structure.')
    }
    current.reply = evidenceText(message.content)
    const capture = record(evidence?.[completed++])
    current.calls = toolCalls(message.tool_calls ?? capture?.tools ?? [])
    current.models = modelInputs(capture?.model_inputs)
    current = undefined
  }
  if (turns.length > maxTurns) throw new Error('The saved scenario exceeds the supported evidence size.')
  return {
    scenario,
    user: text(saved.user_id),
    turns,
    verdict: text(saved.delta),
    reason: evidenceText(saved.delta_reason),
    error: evidenceText(saved.error),
  }
}
