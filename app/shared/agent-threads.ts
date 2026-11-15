export type AgentProvider = 'claude' | 'cursor' | 'codex' | 'antigravity'

export type AgentThreadStatus = 'running' | 'idle' | 'recent' | 'unknown'

export const agentProviderNames: Record<AgentProvider, string> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  antigravity: 'Antigravity',
}

export interface AgentThread {
  id: string
  provider: AgentProvider
  title: string
  cwd: string
  projectRoot?: string
  updatedAt: number
  active?: boolean
  status?: AgentThreadStatus
  activity?: string
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
  kind: 'user' | 'assistant' | 'tool' | 'edit' | 'status' | 'notice'
  text: string
  files?: AgentThreadFile[]
  toolName?: string
  toolDescription?: string
}

export type AgentFileView = { kind: 'workspace'; path: string } | { kind: 'preview'; text: string; limited: boolean }
