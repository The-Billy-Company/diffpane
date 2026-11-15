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

const READ_BYTES = 512 * 1024
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024
const MAX_RECORD_BYTES = 4 * 1024 * 1024

export async function sampleJsonRecords(locator: string, edge: 'start' | 'end'): Promise<unknown[]> {
  try {
    await using file = await open(locator, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile() || !info.size) return []
    const length = Math.min(info.size, 128 * 1024)
    const buffer = Buffer.allocUnsafe(length)
    const offset = edge === 'start' ? 0 : info.size - length
    const { bytesRead } = await file.read(buffer, 0, length, offset)
    const lines = buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .split('\n')
      .slice(offset ? 1 : 0)
    return lines.flatMap(line => {
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

export function recentJsonRecords(locator: string): Promise<unknown[]> {
  return sampleJsonRecords(locator, 'end')
}

export function activityText(text: string): string | undefined {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180) || undefined
}

export function latestActivity(events: AgentThreadEvent[]): string | undefined {
  const latest = events.findLast(
    event => event.kind !== 'status' && event.kind !== 'notice' && (event.toolName ?? event.text.trim()),
  )
  if (!latest) return undefined
  if (latest.toolDescription) return activityText(latest.toolDescription)
  const label = latest.toolName ?? latest.text
  const filename = latest.files?.[0]?.path
  if (filename) {
    const additional = (latest.files?.length ?? 1) - 1
    return activityText(`${label} ${path.basename(filename)}${additional ? ` +${additional}` : ''}`)
  }
  return activityText(label)
}

export function toolCall(
  name: string,
  {
    kind = 'tool',
    text = '',
    description,
    files,
  }: {
    kind?: 'tool' | 'edit'
    text?: string
    description?: string
    files?: AgentThreadEvent['files']
  } = {},
): AgentThreadEvent {
  const label = activityText(description ?? '')
  return {
    kind,
    toolName: name.replace(/\s+/g, ' ').trim().slice(0, 180),
    ...(label ? { toolDescription: label } : {}),
    text: text.slice(0, 4096),
    ...(files?.length ? { files } : {}),
  }
}

type TranscriptParser = (record: unknown) => AgentThreadEvent[]

export function readJsonLines(locator: string, createParser: () => TranscriptParser): AgentThreadReader {
  return {
    async read() {
      const file = await open(locator, constants.O_RDONLY | constants.O_NONBLOCK).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) return null
        throw error
      })
      if (!file) return []
      try {
        const metadata = await file.stat()
        if (!metadata.isFile()) return []
        const parse = createParser()
        const limit = Math.min(metadata.size, MAX_TRANSCRIPT_BYTES)
        const events: AgentThreadEvent[] = []
        let offset = 0
        let partial: Buffer = Buffer.alloc(0)
        let skip = false

        function append(line: Buffer) {
          if (!line.length || line.length > MAX_RECORD_BYTES) return
          let record: unknown
          try {
            record = JSON.parse(line.toString('utf8'))
          } catch {
            return
          }
          for (const event of parse(record)) events.push(event)
        }

        while (offset < limit) {
          const length = Math.min(READ_BYTES, limit - offset)
          const chunk = Buffer.allocUnsafe(length)
          // oxlint-disable-next-line eslint/no-await-in-loop -- Consume the transcript in file order.
          const { bytesRead } = await file.read(chunk, 0, length, offset)
          if (!bytesRead) break
          offset += bytesRead
          const current = chunk.subarray(0, bytesRead)
          const bytes = partial.length ? Buffer.concat([partial, current]) : current
          let start = 0
          for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
            if (!skip) append(bytes.subarray(start, end))
            skip = false
            start = end + 1
          }
          partial = skip ? Buffer.alloc(0) : bytes.subarray(start)
          if (partial.length > MAX_RECORD_BYTES) {
            partial = Buffer.alloc(0)
            skip = true
          }
        }
        if (metadata.size > limit) {
          events.push({
            kind: 'notice',
            text: 'This transcript exceeds the reading limit. Only its beginning is shown.',
          })
        } else if (!skip) {
          append(partial)
        }
        return events
      } finally {
        await file.close()
      }
    },
  }
}
