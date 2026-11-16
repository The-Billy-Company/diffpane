import type { AgentProvider } from './agent-threads.ts'

export type MemoryPressure = 'normal' | 'warning' | 'critical' | 'unknown'

export interface AgentMemoryActivity {
  id: string
  provider: AgentProvider
  title: string
  action?: string
  updatedAt: number
  process?: { pid: number; residentBytes: number; shared: boolean }
}

export interface AgentMemorySnapshot {
  sampledAt: number
  pressure: MemoryPressure
  source: 'windows' | 'system'
  usedBytes?: number
  totalBytes?: number
  activities: AgentMemoryActivity[]
}
