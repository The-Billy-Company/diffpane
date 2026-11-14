export interface BillyContractRequest {
  path: string
  changedPaths: readonly string[]
}

export const MAX_BILLY_CONTRACT_PATHS = 4000

export type BillyContractConfidence = 'declared' | 'header' | 'candidate'

export interface BillyContractSection {
  name: string
  start: number
  end: number
}

export interface BillyContractFile {
  path: string
  changed: boolean
  confidence: BillyContractConfidence
  shared: boolean
  sections?: readonly BillyContractSection[]
}

export interface BillyContractGroup {
  id: string
  sourceKind: 'generator' | 'protobuf'
  sources: readonly BillyContractFile[]
  outputs: readonly BillyContractFile[]
}

export interface BillyContractDiff {
  groups: readonly BillyContractGroup[]
  limited: boolean
}

function isBillyContractPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    value.isWellFormed() &&
    !/[\\\0\r\n]/u.test(value) &&
    !/^[a-z]:/iu.test(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isContractSection(value: unknown): value is BillyContractSection {
  return (
    record(value) &&
    typeof value['name'] === 'string' &&
    typeof value['start'] === 'number' &&
    Number.isSafeInteger(value['start']) &&
    value['start'] > 0 &&
    typeof value['end'] === 'number' &&
    Number.isSafeInteger(value['end']) &&
    value['end'] > value['start']
  )
}

function isContractFile(value: unknown): value is BillyContractFile {
  return (
    record(value) &&
    isBillyContractPath(value['path']) &&
    typeof value['changed'] === 'boolean' &&
    typeof value['shared'] === 'boolean' &&
    (value['sections'] === undefined ||
      (Array.isArray(value['sections']) && value['sections'].every(isContractSection))) &&
    (value['confidence'] === 'declared' || value['confidence'] === 'header' || value['confidence'] === 'candidate')
  )
}

function isContractGroup(value: unknown): value is BillyContractGroup {
  return (
    record(value) &&
    typeof value['id'] === 'string' &&
    (value['sourceKind'] === 'generator' || value['sourceKind'] === 'protobuf') &&
    Array.isArray(value['sources']) &&
    value['sources'].every(isContractFile) &&
    Array.isArray(value['outputs']) &&
    value['outputs'].every(isContractFile)
  )
}

export function isBillyContractDiff(value: unknown): value is BillyContractDiff {
  return (
    record(value) &&
    typeof value['limited'] === 'boolean' &&
    Array.isArray(value['groups']) &&
    value['groups'].every(isContractGroup)
  )
}
