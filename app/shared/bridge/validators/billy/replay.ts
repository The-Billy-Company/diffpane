// Copyright (c) 2026 The Billy Company
import type {
  BillyPlaybook,
  BillyReplayCall,
  BillyReplayCase,
  BillyReplayModel,
  BillyReplayRun,
  BillyReplayText,
} from '../../../billy/replay.ts'
import type { BillySetupCheck, BillySetupStartResult, BillySetupStatus } from '../../../billy/setup.ts'
import { isRecord, arrayOf, nullable, isBoolean, isString, isCount } from '../values.ts'

export function isBillyPlaybook(value: unknown): value is BillyPlaybook {
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

export function isBillyReplayRun(value: unknown): value is BillyReplayRun {
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

export function isBillyReplayCase(value: unknown): value is BillyReplayCase {
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

function isBillySetupCheck(value: unknown): value is BillySetupCheck {
  return (
    isRecord(value) &&
    isString(value.label) &&
    isString(value.detail) &&
    (value.state === 'ready' || value.state === 'attention' || value.state === 'unavailable')
  )
}

export function isBillySetupStatus(value: unknown): value is BillySetupStatus {
  return isRecord(value) && arrayOf(isBillySetupCheck)(value.checks)
}

export function isBillySetupStartResult(value: unknown): value is BillySetupStartResult {
  return isRecord(value) && (value.ok === true || (value.ok === false && isString(value.message)))
}
