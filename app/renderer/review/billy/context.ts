import type { BillyContractDiff, BillyContractRequest } from '../../../shared/billy/contracts.ts'
import { MAX_BILLY_CONTRACT_PATHS } from '../../../shared/billy/contracts.ts'
import type { DiffpaneApi } from '../../../shared/bridge/workspace-bridge.ts'
import { runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { createBillyClaims } from '../billy-claims/claims.ts'
import { createBillyContractDiff } from '../billy-contracts/contract-diff.ts'
import { createBillyReplay } from '../billy-replay/billy-replay.ts'
import { createBillySiblings } from '../billy-siblings/siblings.ts'
import './context.css'

type Tool = 'contract' | 'replay' | 'claims' | 'siblings'
type Api = DiffpaneApi['billy']
type Source = (path: string, line?: number) => Promise<unknown>

interface FileContext {
  path: string
  line: () => number | null
  changed: boolean
  text: boolean
}

const labels: Readonly<Record<Tool, string>> = {
  contract: 'Contract',
  replay: 'What Billy Saw',
  claims: 'Doc claims',
  siblings: 'Sibling functions',
}

function likelyContract(path: string) {
  // These naming conventions only admit a quick lookup. The registry owns the result.
  return path.startsWith('contracts/') || /(?:[_.]gen\.|_pb2\.|_pb\.ts$|\.pb\.|_vtproto\.pb\.)/u.test(path)
}

export function createBillyReviewContext(api: Api, navigate: Source) {
  const disclosure = document.createElement('section')
  disclosure.className = 'billy-review-context'
  disclosure.setAttribute('aria-label', 'Billy review tools')
  disclosure.hidden = true
  disclosure.innerHTML = `
    <div class="billy-review-bar">
      <div class="billy-review-tools" role="group" aria-label="Review tools"></div>
      <button type="button" class="billy-review-close" aria-label="Close review tools" title="Close review tools">×</button>
    </div>
    <div class="billy-review-scroll"></div>`
  const toolbar = requireElement(disclosure, '.billy-review-tools', HTMLDivElement)
  const scroll = requireElement(disclosure, '.billy-review-scroll', HTMLDivElement)
  const close = requireElement(disclosure, '.billy-review-close', HTMLButtonElement)
  const hosts = new Map<Tool, HTMLDivElement>()
  const buttons = new Map<Tool, HTMLButtonElement>()
  const tools: Tool[] = ['contract', 'replay', 'claims', 'siblings']
  for (const tool of tools) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = labels[tool]
    button.setAttribute('aria-pressed', 'false')
    button.addEventListener('click', () => show(tool))
    buttons.set(tool, button)
    toolbar.append(button)
    const panel = document.createElement('div')
    panel.dataset.billyTool = tool
    panel.hidden = true
    scroll.append(panel)
    hosts.set(tool, panel)
  }
  function host(tool: Tool) {
    return requireElement(scroll, `[data-billy-tool="${tool}"]`, HTMLDivElement)
  }

  let file: FileContext | null = null
  let origin: FileContext | null = null
  let trigger: HTMLButtonElement | null = null
  let available = false
  let disposed = false
  let relatedNavigation = false
  let scope = ''
  let changedPaths: string[] = []
  let active: Tool | null = null
  let recommended: Tool | null = null
  let siblingLine: number | null = null
  let generation = 0
  let prepared = new Map<string, Promise<BillyContractDiff>>()

  function contractRead(input: BillyContractRequest) {
    const key = JSON.stringify([input.path, input.changedPaths])
    let result = prepared.get(key)
    if (!result) {
      result = api.readContractDiff(input)
      prepared.set(key, result)
      const clear = () => {
        if (prepared.get(key) === result) prepared.delete(key)
      }
      result.then(clear, clear)
    }
    return result
  }

  async function onSource(path: string, line?: number) {
    relatedNavigation = true
    try {
      await navigate(path, line)
    } finally {
      relatedNavigation = false
    }
  }

  function openSource(path: string, line?: number) {
    runTask('Open Billy review source', () => onSource(path, line))
  }

  const contract = createBillyContractDiff(host('contract'), { load: contractRead, onOpen: openSource })
  const replay = createBillyReplay(host('replay'), api.replay, { onSource })
  const claims = createBillyClaims(host('claims'), { load: api.readClaims, onOpen: openSource })
  const siblings = createBillySiblings(host('siblings'), { load: api.readSiblings, onOpen: openSource })

  function show(tool?: Tool) {
    if (!file || !available || disposed) return
    origin ??= file
    active = tool ?? null
    disclosure.hidden = false
    scroll.hidden = !tool
    for (const [id, button] of buttons) {
      button.setAttribute('aria-pressed', String(id === tool))
      button.hidden = id === 'siblings' && !origin.text
    }
    for (const [id, panel] of hosts) panel.hidden = id !== tool
    if (tool === 'contract') {
      contract.update({ path: origin.path, changedPaths })
    }
    if (tool === 'replay') replay.open(origin.path)
    if (tool === 'claims') claims.update(origin.path)
    if (tool === 'siblings') {
      siblingLine = origin.line()
      siblings.update({ path: origin.path, line: siblingLine, changedPaths })
    }
    syncTrigger()
  }

  function hide(restoreFocus = false) {
    active = null
    origin = null
    contract.update(null)
    claims.update(null)
    siblings.update(null)
    disclosure.hidden = true
    syncTrigger()
    if (restoreFocus) trigger?.focus()
  }

  function syncTrigger() {
    if (!trigger) return
    trigger.hidden = !available || (disclosure.hidden && (!file?.text || (!file.changed && !recommended)))
    trigger.setAttribute('aria-expanded', String(!disclosure.hidden))
    const label = recommended ? labels[recommended] : 'Review tools'
    if (trigger.textContent !== label) trigger.textContent = label
    trigger.title = disclosure.hidden ? 'Review this file with Billy’s workspace tools' : 'Close Billy review tools'
  }

  function suggest() {
    const current = file
    const request = ++generation
    recommended = null
    syncTrigger()
    if (!available || !current?.text) return
    if (current.path.endsWith('.j2')) {
      runTask(
        'Identify playbook',
        async () => {
          const playbook = await api.replay.playbook(current.path)
          if (request !== generation || !playbook) return
          recommended = 'replay'
          syncTrigger()
        },
        { silent: true },
      )
    }
    if (!likelyContract(current.path)) return
    runTask(
      'Identify contract',
      async () => {
        const result = await contractRead({ path: current.path, changedPaths })
        if (request !== generation || !result.groups.length || recommended === 'replay') return
        recommended = 'contract'
        syncTrigger()
      },
      { silent: true },
    )
  }

  close.addEventListener('click', () => hide(true))
  disclosure.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.target instanceof HTMLSelectElement) return
    event.stopPropagation()
    hide(true)
  })

  return {
    setAvailable(value: boolean) {
      if (available === value) return
      available = value
      if (!value) hide()
      suggest()
    },
    bind(container: HTMLElement, button: HTMLButtonElement, next: FileContext) {
      if (!relatedNavigation) hide()
      file = next
      trigger = button
      container.append(disclosure)
      button.addEventListener('click', () => {
        if (!disclosure.hidden) hide()
        else {
          show(recommended ?? undefined)
          if (!disclosure.hidden) buttons.get(active ?? 'contract')?.focus()
        }
      })
      suggest()
    },
    setChanges(paths: readonly string[], comparison: string, registryChanged: boolean) {
      const next = paths.slice(0, MAX_BILLY_CONTRACT_PATHS + 1)
      if (
        !registryChanged &&
        scope === comparison &&
        next.length === changedPaths.length &&
        next.every((path, index) => path === changedPaths[index])
      )
        return
      scope = comparison
      changedPaths = next
      prepared = new Map()
      if (active === 'contract' && origin) {
        contract.update(null)
        contract.update({ path: origin.path, changedPaths })
      }
      if (active === 'siblings' && origin) siblings.update({ path: origin.path, line: siblingLine, changedPaths })
      suggest()
    },
    setChanged(changed: boolean) {
      if (!file || file.changed === changed) return
      file.changed = changed
      syncTrigger()
    },
    open(tool: Tool) {
      origin = file
      show(tool)
      if (!disclosure.hidden) buttons.get(tool)?.focus()
    },
    clear() {
      hide()
      file = null
      trigger = null
      generation++
    },
    dispose() {
      disposed = true
      generation++
      contract.dispose()
      replay.dispose()
      claims.dispose()
      siblings.dispose()
      disclosure.remove()
    },
  }
}
