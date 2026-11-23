// Copyright (c) 2026 The Billy Company
export interface GitRef {
  name: string
  kind: 'branch' | 'remote' | 'tag'
}

export interface GitCommit {
  id: string
  parents: string[]
  subject: string
  committedAt: number
  refs: GitRef[]
}

export interface GitOverview {
  head: string | null
  branch: string
  commits: GitCommit[]
  today: GitCommit[]
  dayBase: string | null
  historyHasMore: boolean
}

export type GitComparison =
  | { kind: 'working'; mode: 'head' | 'staged' | 'unstaged' }
  | { kind: 'revision'; base: string | null; target: string }

export interface GitFile {
  path: string
  originalPath: string | null
  status: string
  additions: number | null
  deletions: number | null
}

export interface GitChanges {
  files: GitFile[]
  additions: number
  deletions: number
}

export interface GitFileContents {
  before: string
  after: string
  note?: string | null
  available?: boolean
}
