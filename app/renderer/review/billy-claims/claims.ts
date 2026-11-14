import type { BillyClaim, BillyClaimsResult } from '../../../shared/billy/claims.ts'
import { runTask } from '../../shell/recovery/errors.ts'
import { createBillyStatusArt } from '../billy/status-art.ts'

import './claims.css'

interface Options {
  load: (pathname: string) => Promise<BillyClaimsResult>
  onOpen: (pathname: string, line: number) => unknown
}

const labels = {
  sentinel: 'Source marker',
  occurrence: 'Occurrence count',
  path: 'Required path',
} satisfies Record<BillyClaim['kind'], string>

function message(text: string) {
  const node = document.createElement('p')
  node.className = 'billy-claims-status'
  node.textContent = text
  node.setAttribute('role', 'status')
  return node
}

function claimRow(claim: BillyClaim, open: Options['onOpen']) {
  const item = document.createElement('li')
  const label = document.createElement('span')
  label.className = 'billy-claims-kind'
  label.textContent = claim.findings.length ? 'Drift found' : labels[claim.kind]
  if (claim.findings.length) label.dataset.drift = ''
  const link = document.createElement('button')
  link.type = 'button'
  link.textContent = `${claim.path}:${claim.line}`
  link.addEventListener('click', () => runTask('Open Doc Radar assertion', () => open(claim.path, claim.line)))
  const detail = document.createElement('p')
  detail.textContent = claim.label
  item.append(label, link, detail)
  for (const finding of claim.findings) {
    const evidence = document.createElement('p')
    evidence.className = 'billy-claims-finding'
    evidence.textContent = finding
    item.append(evidence)
  }
  return item
}

export function createBillyClaims(host: HTMLElement, { load, onOpen }: Options) {
  host.classList.add('billy-claims')
  let pathname: string | null = null
  let revision = 0

  function render(result: BillyClaimsResult) {
    const nodes: HTMLElement[] = []
    if (result.claims.length) {
      const list = document.createElement('ul')
      list.append(...result.claims.map(claim => claimRow(claim, onOpen)))
      nodes.push(list)
      if (result.verification === 'unavailable')
        nodes.push(message('Doc Radar verification unavailable. Showing declarations.'))
      else nodes.push(message('Checked the linked documents against the working tree.'))
    } else {
      const empty = message('No matching Doc Radar assertions found.')
      empty.prepend(createBillyStatusArt('claims'))
      nodes.push(empty)
    }
    if (result.limited) nodes.push(message('Some candidate documents or findings could not be linked.'))
    host.replaceChildren(...nodes)
  }

  function update(next: string | null) {
    if (pathname === next) return
    pathname = next
    const request = ++revision
    if (!next) {
      host.replaceChildren()
      return
    }
    host.replaceChildren(message('Finding Doc Radar assertions…'))
    runTask('Find Doc Radar assertions', async () => {
      let result
      try {
        result = await load(next)
      } catch {
        if (request === revision) host.replaceChildren(message('Doc Radar assertions are unavailable.'))
        return
      }
      if (request === revision) render(result)
    })
  }
  return { update, dispose: () => update(null) }
}
