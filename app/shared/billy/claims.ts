export interface BillyClaim {
  path: string
  line: number
  kind: 'sentinel' | 'occurrence' | 'path'
  label: string
  findings: readonly string[]
}

export interface BillyClaimsResult {
  claims: readonly BillyClaim[]
  limited: boolean
  verification: 'scoped' | 'unavailable'
}
