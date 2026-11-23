// Copyright (c) 2026 The Billy Company
import { parse } from 'smol-toml'

import type {
  BillyContractDiff,
  BillyContractGroup,
  BillyContractRequest,
  BillyContractSection,
} from '../../../shared/billy/contracts.ts'
import { MAX_BILLY_CONTRACT_PATHS } from '../../../shared/billy/contracts.ts'
import type { BillyContext } from '../billy/native.ts'
import { isBillyPath, readBillyText } from '../billy/native.ts'
import { PROTO_ROOT, protobufGroups } from './protobuf.ts'

const REGISTRY = 'contracts/operate/codegen/generators.toml'
const REGISTRY_BYTES = 512 * 1024
const MAX_SHARED_HEADERS = 16
const MARKER_HEADER_BYTES = 32 * 1024
const BLOCK_MARKER = /^\s*\/\/\s+([\w-]+):([\w-]+)-(start|end)(?:[\t ]|$)/u

interface Generator {
  id: string
  sources: string[]
  outputs: string[]
}

function declarationPaths(raw: unknown, allowRoot = false): string[] {
  const values: unknown[] = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
  if (
    !values.every(
      (value): value is string =>
        typeof value === 'string' && ((allowRoot && value === '.') || isBillyPath(value.replace(/\/$/u, ''))),
    )
  ) {
    throw new Error('Billy’s codegen registry contains an invalid path.')
  }
  return values
}

function registry(text: string): Generator[] {
  const table: unknown = parse(text)['generator']
  if (!Array.isArray(table)) throw new Error('Billy’s codegen registry has no generator declarations.')
  const ids = new Set<string>()
  return table.map((value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !value.id ||
      ids.has(value.id) ||
      !('source' in value) ||
      !('outputs' in value) ||
      !(typeof value.source === 'string' || Array.isArray(value.source)) ||
      !Array.isArray(value.outputs)
    ) {
      throw new Error('Billy’s codegen registry contains an invalid generator declaration.')
    }
    ids.add(value.id)
    return { id: value.id, sources: declarationPaths(value.source, true), outputs: declarationPaths(value.outputs) }
  })
}

function generatorGroups(
  generators: readonly Generator[],
  selected: string,
  changed: ReadonlySet<string>,
): BillyContractGroup[] {
  const owners = new Map<string, number>()
  for (const { outputs } of generators) {
    for (const path of new Set(outputs)) owners.set(path, (owners.get(path) ?? 0) + 1)
  }

  const groups: BillyContractGroup[] = []
  for (const generator of generators) {
    const { id, sources, outputs } = generator
    // A declared output directory identifies a generator's scope, not individual generated files.
    const changedOutputs = outputs.filter(path => changed.has(path) || path === selected)
    const inSourceScope =
      !sources.includes(selected) && sources.some(path => path.endsWith('/') && selected.startsWith(path))
    if (!sources.includes(selected) && !outputs.includes(selected) && !(inSourceScope && changedOutputs.length)) {
      continue
    }
    const sourcePaths = sources.filter(path => path !== '.' && !path.endsWith('/'))
    groups.push({
      id,
      sourceKind: 'generator',
      sources: sourcePaths.map(path => ({ path, changed: changed.has(path), confidence: 'declared', shared: false })),
      outputs: changedOutputs.map(path => ({
        path,
        changed: changed.has(path),
        confidence: 'declared',
        shared: (owners.get(path) ?? 0) > 1 || path.endsWith('.proto'),
      })),
    })
  }
  return groups
}

async function sectionsByWriter(context: BillyContext, path: string) {
  const sections = new Map<string, BillyContractSection[]>()
  try {
    const starts = new Map<string, number>()
    const completed = new Set<string>()
    const invalid = new Set<string>()
    const prefix = await readBillyText(context.root, path, MARKER_HEADER_BYTES, context.signal, true)
    const text = prefix.slice(0, prefix.lastIndexOf('\n') + 1)
    for (const [offset, line] of text.split('\n').entries()) {
      const [, writer, name, side] = BLOCK_MARKER.exec(line) ?? []
      if (!writer || !name) continue
      const key = `${writer}:${name}`
      if (side === 'start') {
        if (starts.has(key) || completed.has(key)) invalid.add(key)
        else starts.set(key, offset + 1)
        continue
      }
      const start = starts.get(key)
      if (!start || completed.has(key)) {
        invalid.add(key)
        continue
      }
      completed.add(key)
      starts.delete(key)
      const rows = sections.get(writer)
      const section = { name, start, end: offset + 1 }
      if (rows) rows.push(section)
      else sections.set(writer, [section])
    }
    for (const [writer, rows] of sections) {
      sections.set(
        writer,
        rows.filter(row => !invalid.has(`${writer}:${row.name}`)),
      )
    }
  } catch {
    context.signal.throwIfAborted()
  }
  return sections
}

async function annotateSharedOutputs(context: BillyContext, groups: BillyContractGroup[]) {
  const paths = [...new Set(groups.flatMap(group => group.outputs.filter(file => file.shared).map(file => file.path)))]
  const observed = new Map(
    await Promise.all(
      paths.slice(0, MAX_SHARED_HEADERS).map(async path => [path, await sectionsByWriter(context, path)] as const),
    ),
  )
  const annotated = groups.map(group => ({
    ...group,
    outputs: group.outputs.map(file => {
      const sections = observed.get(file.path)?.get(group.id)
      return sections?.length ? { ...file, sections } : file
    }),
  }))
  return { groups: annotated, limited: paths.length > MAX_SHARED_HEADERS }
}

export async function readBillyContractDiff(
  context: BillyContext,
  input: BillyContractRequest,
): Promise<BillyContractDiff> {
  if (!input || !isBillyPath(input.path) || !Array.isArray(input.changedPaths)) {
    throw new Error('Choose a file in the Billy workspace.')
  }
  const changed = new Set(input.changedPaths.slice(0, MAX_BILLY_CONTRACT_PATHS).filter(isBillyPath))
  const limited = input.changedPaths.length > MAX_BILLY_CONTRACT_PATHS
  if (limited) changed.add(input.path)
  const generators = registry(await readBillyText(context.root, REGISTRY, REGISTRY_BYTES, context.signal))
  const proto = generators.find(row => row.id === 'proto' && row.sources.includes(PROTO_ROOT))
  const [bindings, declared] = await Promise.all([
    proto ? protobufGroups(context, proto.outputs, input.path, changed) : null,
    annotateSharedOutputs(context, generatorGroups(generators, input.path, changed)),
  ])
  return {
    groups: [...(bindings?.groups ?? []), ...declared.groups],
    limited: limited || declared.limited || (bindings?.limited ?? false),
  }
}
