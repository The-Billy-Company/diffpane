export type AgentProvider = 'claude' | 'cursor' | 'codex'

export const agentProviderNames: Record<AgentProvider, string> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
}

export interface AgentThread {
  id: string
  provider: AgentProvider
  title: string
  cwd: string
  updatedAt: number
  active?: boolean
}

export interface AgentThreadList {
  threads: AgentThread[]
  unavailable: AgentProvider[]
}

export interface AgentThreadFile {
  path: string
  line?: number
}

export interface AgentThreadEvent {
  kind: 'user' | 'assistant' | 'tool' | 'edit' | 'status'
  text: string
  files?: AgentThreadFile[]
}

export interface AgentThreadUpdate {
  subscription: string
  events: AgentThreadEvent[]
  error?: string
}

export type AgentFileView = { kind: 'workspace'; path: string } | { kind: 'preview'; text: string; limited: boolean }
