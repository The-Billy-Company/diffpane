export interface BillySiblingExcerpt {
  readonly path: string
  readonly line: number
  readonly text: string | null
}

export interface BillySiblingMatch extends BillySiblingExcerpt {
  readonly grade: 'identical' | 'strong' | 'moderate'
}

export type BillySiblingResult =
  | { readonly kind: 'no-function' }
  | {
      readonly kind: 'ready'
      readonly scope: string
      readonly source: BillySiblingExcerpt
      readonly candidates: readonly BillySiblingMatch[]
    }
