// Copyright (c) 2026 The Billy Company
import { spawn } from 'node:child_process'

export async function runDesktop(command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv }) {
  const processGroup = process.platform !== 'win32'
  const child = spawn(command, args, { ...options, stdio: 'inherit', detached: processGroup })
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
  const stop = () => {
    if (!child.pid) return
    if (!processGroup) {
      child.kill('SIGTERM')
      return
    }
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    return await exited
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    stop()
  }
}
