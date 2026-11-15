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

export interface AgentThreadImage {
  name: string
  dataUrl?: string
}

export function isAgentThreadImageDataUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^data:image\/(?:png|apng|jpeg|gif|webp|avif|bmp|x-icon);base64,[a-z0-9+/]/i.test(value)
  )
}

export interface AgentThreadEvent {
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'edit' | 'status' | 'notice'
  text: string
  files?: AgentThreadFile[]
  images?: AgentThreadImage[]
  toolName?: string
  toolDescription?: string
}

export type AgentFileView = { kind: 'workspace'; path: string } | { kind: 'preview'; text: string; limited: boolean }
