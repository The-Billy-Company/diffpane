// Copyright (c) 2026 The Billy Company
import type {
  BillyLane,
  BillyLaneChecks,
  BillyLaneFinding,
  BillyLaneLog,
  BillyLanePage,
  BillyLaneRule,
} from '../../../../backend/tools/billy-lanes/lanes.ts'
import type { BillyClaim, BillyClaimsResult } from '../../../billy/claims.ts'
import type { BillyContractDiff, BillyContractFile, BillyContractGroup } from '../../../billy/contracts.ts'
import type { BillySiblingExcerpt, BillySiblingMatch, BillySiblingResult } from '../../../billy/siblings.ts'
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
} from '../values.ts'

function isBillyLane(value: unknown): value is BillyLane {
  return isRecord(value) && isString(value.slug) && isBoolean(value.current) && arrayOf(isString)(value.recorded)
}

export function isBillyLanePage(value: unknown): value is BillyLanePage {
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

export function isBillyLaneLog(value: unknown): value is BillyLaneLog {
  return (
    isRecord(value) &&
    isString(value.text) &&
    isBoolean(value.complete) &&
    isCount(value.readBytes) &&
    optional(isCount)(value.totalBytes)
  )
}

export function isBillyLaneChecks(value: unknown): value is BillyLaneChecks {
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

export function isBillyContractDiff(value: unknown): value is BillyContractDiff {
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

export function isBillyClaimsResult(value: unknown): value is BillyClaimsResult {
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

export function isBillySiblingResult(value: unknown): value is BillySiblingResult {
  return (
    isRecord(value) &&
    (value.kind === 'no-function' ||
      (value.kind === 'ready' &&
        isString(value.scope) &&
        isBillySiblingExcerpt(value.source) &&
        arrayOf(isBillySiblingMatch)(value.candidates)))
  )
}
