// Copyright (c) 2026 The Billy Company
export interface BillyPlaybookRoute {
  kind: 'Mission' | 'Surface' | 'Tool' | 'Connector' | 'Native format'
  values: string[]
}

export interface BillyPlaybook {
  id: string
  title: string
  source: string
  registry: string
  trigger: string
  owningEval: string | null
  routes: BillyPlaybookRoute[]
}

export interface BillyReplayRun {
  id: string
  build: string
  commit: string
  mode: string | null
  scenarios: string[]
}

export interface BillyReplayText {
  preview: string
  hash: string
  truncated: boolean
}

export interface BillyReplayCall {
  name: string
  agent: string | null
  args: BillyReplayText | null
  result: BillyReplayText | null
  status: 'error' | 'finished' | 'started' | 'unknown'
}

export interface BillyReplayModel {
  agent: string | null
  provider: string | null
  model: string | null
  composition: {
    variant: string | null
    identityHash: string | null
    identityTokens: number | null
    toolSchemaHash: string | null
    toolCount: number | null
    toolTokens: number | null
    historyTokens: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
    playbooks: string[] | null
    context: { id: string; tokens: number }[] | null
  } | null
}

export interface BillyReplayTurn {
  user: BillyReplayText | null
  reply: BillyReplayText | null
  calls: BillyReplayCall[] | null
  models: BillyReplayModel[] | null
}

export interface BillyReplayCase {
  scenario: string
  user: string | null
  turns: BillyReplayTurn[]
  verdict: string | null
  reason: BillyReplayText | null
  error: BillyReplayText | null
}

export interface BillyReplayApi {
  playbook(path: string): Promise<BillyPlaybook | null>
  pickRun(): Promise<BillyReplayRun | null>
  readCase(runId: string, scenario: string): Promise<BillyReplayCase>
}
