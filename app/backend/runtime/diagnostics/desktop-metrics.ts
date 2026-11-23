// Copyright (c) 2026 The Billy Company
import { execFile } from 'node:child_process'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import type { createDiagnostics } from '../../../shared/diagnostics/diagnostics.ts'
import { attempt } from '../../../shared/recovery/app-errors.ts'

const sampleIntervalMs = 30_000
function sampleProcesses(diagnostics: ReturnType<typeof createDiagnostics>) {
  if (process.platform !== 'darwin') return
  execFile(
    '/bin/ps',
    ['-p', `${process.ppid},${process.pid}`, '-o', 'pid=,rss=,%cpu='],
    { timeout: 2_000 },
    (error, stdout) => {
      if (error) {
        diagnostics.error('desktop.process.sample', error)
        return
      }
      for (const row of stdout.trim().split('\n')) {
        const [pid, workingSet, cpu] = row.trim().split(/\s+/).map(Number)
        const group = pid === process.pid ? 'workspace-service' : pid === process.ppid ? 'host' : undefined
        if (
          !group ||
          workingSet === undefined ||
          cpu === undefined ||
          !Number.isFinite(workingSet) ||
          !Number.isFinite(cpu)
        )
          continue
        diagnostics.metric(`desktop.process.${group}.working-set`, workingSet * 1_024, 'bytes')
        diagnostics.metric(`desktop.process.${group}.cpu`, cpu, 'percent')
      }
    },
  )
}

export function startDesktopMetrics(diagnostics: ReturnType<typeof createDiagnostics>): () => void {
  const eventLoop = attempt(() => {
    const utilization = performance.eventLoopUtilization()
    const delay = monitorEventLoopDelay({ resolution: 50 })
    delay.enable()
    return { delay, utilization }
  })
  if (!eventLoop.ok) diagnostics.error('desktop.main.event-loop.sample', eventLoop.error)

  const timer = setInterval(() => {
    if (eventLoop.ok) {
      const { delay, utilization } = eventLoop.value
      const sampled = attempt(() => {
        const next = performance.eventLoopUtilization()
        const { utilization: fraction } = performance.eventLoopUtilization(next, utilization)
        eventLoop.value.utilization = next
        const delayP95Ms = delay.count ? delay.percentile(95) / 1_000_000 : undefined
        const delayMaxMs = delay.max / 1_000_000
        delay.reset()
        diagnostics.metric('desktop.main.event-loop.utilization', fraction * 100, 'percent')
        if (delayP95Ms !== undefined) {
          diagnostics.metric('desktop.main.event-loop.delay-p95', delayP95Ms, 'ms')
          diagnostics.metric('desktop.main.event-loop.delay-max', delayMaxMs, 'ms')
        }
      })
      if (!sampled.ok) diagnostics.error('desktop.main.event-loop.sample', sampled.error)
    }

    sampleProcesses(diagnostics)
  }, sampleIntervalMs).unref()

  return () => {
    clearInterval(timer)
    if (eventLoop.ok) eventLoop.value.delay.disable()
  }
}
