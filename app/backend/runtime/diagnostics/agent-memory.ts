import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import { hostRequest } from '../../../desktop/host/transport.ts'
import type { AgentMemorySnapshot, MemoryPressure } from '../../../shared/agent-memory.ts'

type MachineMemory = Omit<AgentMemorySnapshot, 'activities'>

interface ProcessMemory {
  residentBytes: number
  startedAt: number
  executable: string
}

const run = promisify(execFile)
const maxFeedBytes = 1024
const maxFeedAgeMs = 5_000
const platform = process.platform

function isPressure(value: unknown): value is MemoryPressure {
  return value === 'normal' || value === 'warning' || value === 'critical' || value === 'unknown'
}

export function parseWindowsPressure(line: string, now = Date.now()): MachineMemory | undefined {
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return undefined
    if (!('pressure' in value) || !isPressure(value.pressure) || !('sampledAt' in value)) return undefined
    const { pressure, sampledAt } = value
    if (
      typeof sampledAt !== 'number' ||
      !Number.isSafeInteger(sampledAt) ||
      sampledAt < now - maxFeedAgeMs ||
      sampledAt > now + 1_000
    )
      return undefined
    const sample: MachineMemory = { source: 'windows', pressure, sampledAt }
    if ('usedBytes' in value && 'totalBytes' in value) {
      const { usedBytes, totalBytes } = value
      if (
        typeof usedBytes === 'number' &&
        Number.isSafeInteger(usedBytes) &&
        usedBytes >= 0 &&
        typeof totalBytes === 'number' &&
        Number.isSafeInteger(totalBytes) &&
        totalBytes > 0 &&
        usedBytes <= totalBytes
      ) {
        sample.usedBytes = usedBytes
        sample.totalBytes = totalBytes
      }
    }
    return sample
  } catch {
    return undefined
  }
}

async function windowsPressure(uid: number): Promise<MachineMemory | undefined> {
  const directory = `/tmp/com.griffinstrier.windows-${uid}`
  const endpoint = `${directory}/pressure.sock`
  try {
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o7777) !== 0o700) return undefined
    const socketInfo = await lstat(endpoint)
    if (!socketInfo.isSocket() || socketInfo.uid !== uid || (socketInfo.mode & 0o7777) !== 0o600) return undefined
  } catch {
    return undefined
  }

  return new Promise(resolve => {
    const socket = createConnection(endpoint)
    let reply = Buffer.alloc(0)
    const timeout = setTimeout(() => finish(), 300)

    function finish(sample?: MachineMemory) {
      clearTimeout(timeout)
      socket.destroy()
      resolve(sample)
    }

    socket.on('data', (chunk: Buffer) => {
      if (reply.length + chunk.length > maxFeedBytes) return finish()
      reply = Buffer.concat([reply, chunk])
      const newline = reply.indexOf(10)
      if (newline !== -1) finish(parseWindowsPressure(reply.toString('utf8', 0, newline)))
    })
    socket.on('error', () => finish())
    socket.on('close', () => finish())
  })
}

async function machineMemory(uid: number | undefined): Promise<MachineMemory> {
  if (platform === 'darwin' && uid !== undefined) {
    const windows = await windowsPressure(uid)
    if (windows) return windows
    const pressure = await hostRequest('diagnostics.memory-pressure').catch(() => undefined)
    if (isPressure(pressure)) return { source: 'system', pressure, sampledAt: Date.now() }
  }
  return { source: 'system', pressure: 'unknown', sampledAt: Date.now() }
}

export function parseProcessMemory(stdout: string): Map<number, ProcessMemory> {
  const processes = new Map<number, ProcessMemory>()
  for (const line of stdout.split('\n')) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d{1,2} \d\d:\d\d:\d\d \d{4})\s+(.+)$/.exec(line)
    if (!fields) continue
    const pid = Number(fields[1])
    const residentBytes = Number(fields[2]) * 1024
    const startedAt = Date.parse(`${fields[3]} UTC`)
    const executable = fields[4]?.trim()
    if (
      pid > 0 &&
      Number.isSafeInteger(pid) &&
      Number.isSafeInteger(residentBytes) &&
      Number.isFinite(startedAt) &&
      executable
    ) {
      processes.set(pid, { residentBytes, startedAt, executable })
    }
  }
  return processes
}

async function processMemory(uid: number | undefined): Promise<Map<number, ProcessMemory>> {
  if ((platform !== 'darwin' && platform !== 'linux') || uid === undefined) return new Map()
  try {
    const { stdout } = await run('/bin/ps', ['-U', String(uid), '-ww', '-o', 'pid=,rss=,lstart=,comm='], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      timeout: 1_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return parseProcessMemory(stdout)
  } catch {
    return new Map()
  }
}

async function collect() {
  const uid = process.getuid?.()
  const [memory, processes] = await Promise.all([machineMemory(uid), processMemory(uid)])
  return { memory, processes }
}

let pending: ReturnType<typeof collect> | undefined
let cached: Awaited<ReturnType<typeof collect>> | undefined
let lastSampled = -Infinity

export function sampleAgentMemory() {
  if (pending) return pending
  if (cached && performance.now() - lastSampled < 750) return Promise.resolve(cached)
  pending = collect()
    .then(result => {
      cached = result
      lastSampled = performance.now()
      return result
    })
    .finally(() => {
      pending = undefined
    })
  return pending
}
