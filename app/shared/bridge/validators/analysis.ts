import type { AnalysisState, HowManyEvent, HowManyFile, Report } from '../../../backend/tools/analysis/howmany.mjs'
import { isRecord, optional, nullable, isBoolean, isString, isCount, isPositive, isTimestamp } from './values.ts'

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

export function isHowManyState(value: unknown): value is AnalysisState {
  return (
    isRecord(value) &&
    (value.status === 'idle' || value.status === 'analyzing' || value.status === 'ready' || value.status === 'error') &&
    nullable(isHowManyReport)(value.report) &&
    isString(value.message) &&
    nullable(isTimestamp)(value.updatedAt)
  )
}

export function isHowManyFile(value: unknown): value is HowManyFile {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isString(value.title) &&
    optional(isBoolean)(value.live) &&
    optional(isString)(value.message)
  )
}

export function isHowManyEvent(value: unknown): value is HowManyEvent {
  if (!isRecord(value)) return false
  if (value.type === 'analysis') return isHowManyState(value)
  if (value.type === 'file') return isString(value.path) && isString(value.request) && 'diagnostics' in value
  return value.type === 'process' && (value.status === 'started' || value.status === 'stopped') && isPositive(value.pid)
}
