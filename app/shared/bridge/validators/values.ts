// Copyright (c) 2026 The Billy Company
import type { ErrorDetails } from '../../recovery/app-errors.ts'

export type Validator<T> = (value: unknown) => value is T

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isErrorDetails(value: unknown): value is ErrorDetails {
  return (
    isRecord(value) &&
    typeof value.message === 'string' &&
    typeof value.code === 'string' &&
    typeof value.recoverable === 'boolean' &&
    (value.operation === undefined || typeof value.operation === 'string')
  )
}

export function arrayOf<T>(validate: Validator<T>): Validator<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every(validate)
}

export function optional<T>(validate: Validator<T>): Validator<T | undefined> {
  return (value): value is T | undefined => value === undefined || validate(value)
}

export function nullable<T>(validate: Validator<T>): Validator<T | null> {
  return (value): value is T | null => value === null || validate(value)
}

export function isUnknown(_value: unknown): _value is unknown {
  return true
}

export function isVoid(value: unknown): value is void {
  return value === undefined
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isPositive(value: unknown): value is number {
  return isCount(value) && value > 0
}

export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isSide(value: unknown): value is 'working' | 'head' {
  return value === 'working' || value === 'head'
}

export function isNull(value: unknown): value is null {
  return value === null
}
