import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import type { AgentThread, AgentThreadEvent } from '../../../../shared/agent-threads.ts'

export interface AgentThreadRecord extends AgentThread {
  locator: string
}

export interface AgentThreadReader {
  read(): Promise<AgentThreadEvent[]>
  close?(): void
}

export interface AgentThreadSource {
  list(): Promise<AgentThreadRecord[]>
  open(thread: AgentThreadRecord): AgentThreadReader
  summarize?(thread: AgentThreadRecord): Promise<string | undefined>
}

const HISTORY_BYTES = 512 * 1024
const MAX_RECORD_BYTES = 4 * 1024 * 1024

export async function recentJsonRecords(locator: string): Promise<unknown[]> {
  try {
    await using file = await open(locator, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile() || !info.size) return []
    const length = Math.min(info.size, 128 * 1024)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await file.read(buffer, 0, length, info.size - length)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    return lines.slice(info.size > length ? 1 : 0, -1).flatMap(line => {
      try {
        return [JSON.parse(line) as unknown]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export function activityText(text: string): string | undefined {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180) || undefined
}

export function latestActivity(events: AgentThreadEvent[]): string | undefined {
  const latest = events.findLast(event => event.kind !== 'status' && event.text.trim())
  if (!latest) return undefined
  const filename = latest.files?.[0]?.path
  if (filename) {
    const additional = (latest.files?.length ?? 1) - 1
    const action = latest.text.replace(/ (?:a file|\d+ files|file)$/, '')
    return activityText(`${action} ${path.basename(filename)}${additional ? ` +${additional}` : ''}`)
  }
  return activityText(latest.text)
}

export function readJsonLines(locator: string, parse: (record: unknown) => AgentThreadEvent[]): AgentThreadReader {
  let cursor = 0
  let inode: string | undefined
  let partial: Buffer = Buffer.alloc(0)
  let skip = false

  return {
    async read() {
      const file = await open(locator, 'r').catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) return null
        throw error
      })
      if (!file) return []
      try {
        const metadata = await file.stat()
        if (!metadata.isFile()) return []
        const identity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`
        if (identity !== inode || metadata.size < cursor) {
          cursor = Math.max(0, metadata.size - HISTORY_BYTES)
          skip = cursor > 0
          partial = Buffer.alloc(0)
          inode = identity
        }
        const length = Math.min(HISTORY_BYTES, metadata.size - cursor)
        if (!length) return []
        const chunk = Buffer.allocUnsafe(length)
        const { bytesRead } = await file.read(chunk, 0, length, cursor)
        cursor += bytesRead
        const bytes = partial.length
          ? Buffer.concat([partial, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead)
        const events: AgentThreadEvent[] = []
        let start = 0
        for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
          const line = bytes.subarray(start, end)
          start = end + 1
          if (skip || !line.length || line.length > MAX_RECORD_BYTES) {
            skip = false
            continue
          }
          let record: unknown
          try {
            record = JSON.parse(line.toString('utf8'))
          } catch {
            continue
          }
          for (const event of parse(record)) events.push(event)
        }
        partial = skip ? Buffer.alloc(0) : bytes.subarray(start)
        if (partial.length > MAX_RECORD_BYTES) {
          partial = Buffer.alloc(0)
          skip = true
        }
        return events
      } finally {
        await file.close()
      }
    },
  }
}
