import { agentThreadChangeCounts } from '../../../shared/agent-thread-change-counts.ts'
import { agentProviderNames, isAgentThreadImageDataUrl } from '../../../shared/agent-threads.ts'
import type {
  AgentProvider,
  AgentThreadChange,
  AgentThreadDelegation,
  AgentThreadEvent,
  AgentThreadFile,
  AgentThreadImage,
  AgentThreadLink,
} from '../../../shared/agent-threads.ts'
import { renderAssistantMarkdown } from './assistant-content.js'
import './agent-thread-conversation.css'

interface ConversationOptions {
  provider: AgentProvider
  providerMark?: HTMLElement
  assistantName?: string
  userName?: string
  projectRoot?: string
  onOpenFile?: (file: AgentThreadFile, trigger: HTMLButtonElement) => void
  onOpenDelegate?: (threadId: string) => void
  openExternal?: (href: string) => unknown
}

function node<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, text?: string) {
  const element = document.createElement(tag)
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function button(className: string, label: string, onClick: (trigger: HTMLButtonElement) => void) {
  const element = node('button', className, label)
  element.type = 'button'
  element.addEventListener('click', () => onClick(element))
  return element
}

function basename(path: string) {
  return path.match(/[^\\/]+$/u)?.[0] ?? path
}

function fileReferences(files: readonly AgentThreadFile[], onOpenFile: ConversationOptions['onOpenFile']) {
  const references = node('div', 'agent-thread-references')
  for (const file of files) {
    const name = basename(file.path)
    const label = file.line ? `${name}:${file.line}` : name
    const reference = onOpenFile
      ? button('agent-thread-reference', label, trigger => onOpenFile(file, trigger))
      : node('span', 'agent-thread-reference', label)
    reference.title = file.path
    references.append(reference)
  }
  return references
}

function threadImage({ name, dataUrl }: AgentThreadImage) {
  const unavailable = () => node('span', 'agent-thread-image-unavailable', `${name} · Preview unavailable`)
  if (!isAgentThreadImageDataUrl(dataUrl)) return unavailable()
  const image = node('img', 'agent-thread-image')
  image.alt = name
  image.decoding = 'async'
  image.addEventListener('error', () => image.replaceWith(unavailable()), { once: true })
  image.src = dataUrl
  return image
}

function imageAttachments(images: readonly AgentThreadImage[]) {
  const attachments = node('div', 'agent-thread-images')
  attachments.append(...images.map(threadImage))
  return attachments
}

function turn(role: 'user' | 'assistant', author: string, providerMark?: HTMLElement) {
  const article = node('article', 'agent-thread-turn')
  article.dataset.role = role
  article.setAttribute('aria-label', author)
  const heading = node('header', 'agent-thread-author')
  if (role === 'assistant') {
    const avatar = providerMark?.cloneNode(true) ?? node('span', 'agent-thread-avatar', author.slice(0, 1))
    if (avatar instanceof HTMLElement) {
      avatar.removeAttribute('title')
      avatar.removeAttribute('role')
      avatar.removeAttribute('aria-label')
      avatar.setAttribute('aria-hidden', 'true')
    }
    heading.append(avatar)
  }
  heading.append(node('span', '', author))
  const body = node('div', 'agent-thread-turn-body')
  article.append(heading, body)
  return { article, body }
}

function assistantMarkdown(text: string) {
  const markdown = node('div', 'claude-turn-content agent-thread-markdown')
  renderAssistantMarkdown(markdown, text)
  return markdown
}

function markdownFileLink(
  link: AgentThreadLink,
  anchor: HTMLAnchorElement,
  onOpenFile: NonNullable<ConversationOptions['onOpenFile']>,
) {
  const reference = button('agent-thread-inline-link', '', trigger => onOpenFile(link, trigger))
  reference.title = link.path
  const glyph = node('span', 'agent-thread-link-icon')
  glyph.setAttribute('aria-hidden', 'true')
  glyph.innerHTML = link.image
    ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="10.25" cy="5.5" r="1"/><path d="m2.5 11 3.2-3.2 4.2 4.2"/></svg>'
    : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1.5h-5A2 2 0 0 0 2.5 3.5v9a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-7zm0 0v4h4"/></svg>'
  reference.append(glyph, ...anchor.childNodes)
  return reference
}

function messageMarkdown(event: AgentThreadEvent, { onOpenFile, openExternal }: ConversationOptions) {
  const user = event.kind === 'user'
  const markdown = node('div', `claude-turn-content agent-thread-markdown${user ? ' agent-thread-prompt' : ''}`)
  const links = new Map(event.links?.map(link => [link.href, link]))
  const updateText = (text: string) =>
    renderAssistantMarkdown(markdown, text, {
      breaks: user,
      openExternal,
      renderLocalLink: (href, anchor) => {
        const link = links.get(href)
        return link && onOpenFile ? markdownFileLink(link, anchor, onOpenFile) : undefined
      },
      renderImage: (href, alt) => {
        const link = links.get(href)
        const dataUrl = isAgentThreadImageDataUrl(href) ? href : link?.dataUrl
        return link?.image || dataUrl ? threadImage({ name: alt || 'Image', dataUrl }) : undefined
      },
    })
  updateText(event.text)
  return { markdown, updateText }
}

function thinkingDisclosure(text: string) {
  const details = node('details', 'agent-thread-thinking')
  let markdown: HTMLElement | undefined
  details.append(node('summary', '', 'Thinking'))
  details.addEventListener('toggle', () => {
    if (details.open && !markdown) {
      markdown = assistantMarkdown(text)
      details.append(markdown)
    }
  })
  return {
    details,
    updateText: (next: string) => {
      text = next
      if (markdown) renderAssistantMarkdown(markdown, text)
    },
  }
}

const toolGlyphs = {
  shell: '<rect x="1.5" y="2" width="13" height="12" rx="2.5"/><path d="m4.25 6 1.75 2-1.75 2m3.5 0h3.75"/>',
  read: '<path d="M8 4.5c-1.5-1.75-3.75-2.25-6-1.75V13c2.25-.5 4.5 0 6 1.5 1.5-1.5 3.75-2 6-1.5V2.75c-2.25-.5-4.5 0-6 1.75Zm0 0v10"/>',
  edit: '<path d="m2 14 1-4 7.8-7.8a2 2 0 0 1 2.8 2.8L5.8 13 2 14Zm7.5-10.5 3 3"/>',
  tool: '<path d="M3 4h10M3 8h10M3 12h10"/>',
}

type ToolAction = keyof typeof toolGlyphs

function toolIcon(action: ToolAction) {
  const icon = node('span', 'agent-thread-tool-icon')
  icon.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${toolGlyphs[action]}</svg>`
  return icon
}

function toolAction(event: AgentThreadEvent): ToolAction {
  if (event.kind === 'edit') return 'edit'
  const name = event.toolName?.toLowerCase()
  if (name === 'read' || name === 'read_file' || name === 'view_file') return 'read'
  if (name === 'shell' || name === 'bash' || name === 'exec_command' || name === 'run_command') {
    if (event.files?.length && event.toolDescription?.startsWith('Read ')) return 'read'
    return 'shell'
  }
  return 'tool'
}

function toolGroupHeading(events: readonly AgentThreadEvent[]) {
  const counts = { edit: 0, read: 0, shell: 0, tool: 0 }
  for (const event of events) {
    const action = toolAction(event)
    counts[action] +=
      action === 'edit' || action === 'read' ? Math.max(1, event.changes?.length ?? 0, event.files?.length ?? 0) : 1
  }
  const summary = node('summary', 'agent-thread-tool-summary')
  const labels = [
    counts.edit ? (counts.edit === 1 ? 'edited a file' : 'edited files') : '',
    counts.read ? (counts.read === 1 ? 'read a file' : 'read files') : '',
    counts.shell ? (counts.shell === 1 ? 'ran a command' : 'ran commands') : '',
    counts.tool ? (counts.tool === 1 ? 'used a tool' : 'used tools') : '',
  ]
    .filter(Boolean)
    .join(', ')
  const label =
    counts.tool === events.length ? `${events.length} tool calls` : labels.charAt(0).toUpperCase() + labels.slice(1)
  const action = counts.edit ? 'edit' : counts.read ? 'read' : counts.shell ? 'shell' : 'tool'
  summary.append(toolIcon(action), node('span', '', label))
  return summary
}

function inlineDisclosure(
  container: HTMLElement,
  className: string,
  label: string,
  render: () => HTMLElement,
  initiallyOpen = false,
) {
  let details: HTMLElement | undefined
  function setOpen(open: boolean) {
    trigger.setAttribute('aria-expanded', String(open))
    if (open && !details) {
      details = render()
      container.append(details)
    }
    if (details) details.hidden = !open
  }
  const trigger = button(className, label, () => setOpen(details?.hidden !== false))
  setOpen(initiallyOpen)
  return trigger
}

function appendToolEntry(
  item: HTMLElement,
  event: AgentThreadEvent,
  onOpenFile: ConversationOptions['onOpenFile'],
  previous?: HTMLElement,
) {
  if (event.kind === 'edit' && event.changes?.length) {
    const open = expandedEditPaths(previous)
    for (const [path, history] of editsByPath(event.changes)) {
      item.append(editFileRow('div', path, history, agentThreadChangeCounts(history), basename, onOpenFile, open, true))
    }
    return
  }

  const action = toolAction(event)
  const name = event.toolName ?? 'Tool call'
  const files = event.files ?? []
  const text = event.text.trim()
  const raw = text && text !== name ? event.text : ''
  const firstLine = raw.trimStart().split('\n', 1)[0] ?? ''
  const label = action === 'read' ? 'Read' : action === 'edit' ? 'Edited' : action === 'shell' ? 'Ran' : name
  const description = event.toolDescription?.trim()
  let preview = description ?? firstLine
  if (action === 'shell') preview = firstLine || preview || name
  else if (files.length && (action === 'read' || action === 'edit')) preview = ''
  const row = node(raw && !files.length ? 'summary' : 'div', 'agent-thread-tool-row')
  row.append(toolIcon(action), node('span', 'agent-thread-tool-name', label))
  row.title = description ?? name
  if (preview && preview !== label) {
    const excerpt = node('span', 'agent-thread-tool-preview', preview)
    excerpt.title = preview
    row.append(excerpt)
  }
  if (files.length) row.append(fileReferences(files, onOpenFile))

  function rawDetails() {
    const pre = node('pre', 'agent-thread-tool-raw', raw)
    pre.tabIndex = 0
    pre.setAttribute('aria-label', `${name} details`)
    return pre
  }

  if (row.localName === 'summary') {
    const details = node('details', 'agent-thread-tool-detail')
    details.open = !!previous?.querySelector('.agent-thread-tool-detail[open]')
    details.append(row, rawDetails())
    item.append(details)
  } else {
    item.append(row)
    if (raw) {
      const toggle = inlineDisclosure(
        item,
        'agent-thread-tool-toggle',
        '',
        rawDetails,
        !!previous?.querySelector('.agent-thread-tool-toggle[aria-expanded="true"]'),
      )
      toggle.setAttribute('aria-label', `${name} details`)
      row.append(toggle)
    }
  }
}

function createToolGroup(onOpenFile: ConversationOptions['onOpenFile']) {
  let group: HTMLDetailsElement | HTMLDivElement | undefined
  let list: HTMLUListElement | undefined
  let events: readonly AgentThreadEvent[] = []
  let entries: { event: AgentThreadEvent; item: HTMLElement }[] = []

  function renderEntries() {
    if (!group) return
    const grouped = group instanceof HTMLDetailsElement
    const parent = grouped ? (list ??= node('ul', 'agent-thread-tool-list')) : group
    const oldNodes = entries.map(entry => entry.item).filter(item => item.parentElement === parent)
    const tag = grouped ? 'li' : 'div'
    const next = events.map((event, index) => {
      const old = entries[index]
      if (old?.event === event && old.item.localName === tag) return old
      const item = node(tag, 'agent-thread-tool-entry')
      if (old?.event === event) item.append(...old.item.childNodes)
      else appendToolEntry(item, event, onOpenFile, old?.event.kind === event.kind ? old.item : undefined)
      return { event, item }
    })
    syncChildren(
      parent,
      oldNodes,
      next.map(entry => entry.item),
    )
    if (grouped && parent.parentElement !== group) group.append(parent)
    entries = next
  }

  return (next: readonly AgentThreadEvent[]) => {
    events = next
    if (events.length === 1) {
      if (!group || group instanceof HTMLDetailsElement) {
        group = node('div', 'agent-thread-tool-group')
        list = undefined
      }
    } else {
      const heading = toolGroupHeading(events)
      if (group instanceof HTMLDetailsElement) {
        group.firstElementChild?.replaceChildren(...heading.childNodes)
      } else {
        const details = node('details', 'agent-thread-tool-group')
        details.open =
          !!group?.querySelector('details[open], button[aria-expanded="true"]') ||
          !!group?.contains(document.activeElement)
        details.append(heading)
        heading.addEventListener('click', renderEntries, { once: true })
        details.addEventListener('toggle', () => {
          if (details === group && details.open && !list) renderEntries()
        })
        group = details
        list = undefined
      }
    }
    if (!(group instanceof HTMLDetailsElement) || group.open || list) renderEntries()
    return group
  }
}

const editLabels = { add: 'Added', update: 'Edited', delete: 'Deleted', move: 'Moved' } as const

function sameChanges(first?: readonly AgentThreadChange[], second?: readonly AgentThreadChange[]) {
  return (
    first?.length === second?.length &&
    (first?.every((change, index) => {
      const other = second?.[index]
      return (
        change.path === other?.path &&
        change.operation === other.operation &&
        change.destinationPath === other.destinationPath &&
        change.diff === other.diff &&
        change.line === other.line &&
        change.additions === other.additions &&
        change.deletions === other.deletions
      )
    }) ??
      true)
  )
}

type EditCounts = ReturnType<typeof agentThreadChangeCounts>
interface RenderedEditFile {
  changes: AgentThreadChange[]
  row: HTMLElement
  counts: EditCounts
}

function editStats(changes: readonly EditCounts[]) {
  const stats = node('span', 'agent-thread-edit-stats')
  stats.title = 'Line changes recorded in the transcript'
  for (const [field, sign, label] of [
    ['additions', '+', 'added'],
    ['deletions', '−', 'removed'],
  ] as const) {
    let count = 0
    for (const change of changes) {
      const lines = change[field]
      if (lines === undefined) {
        count = 0
        break
      }
      count += lines
    }
    if (!count) continue
    const number = node('span', `agent-thread-edit-${label}`, `${sign}${count}`)
    number.setAttribute('aria-label', `${count} ${count === 1 ? 'line' : 'lines'} ${label}`)
    stats.append(number)
  }
  return stats.childElementCount ? stats : undefined
}

function editsByPath(changes: readonly AgentThreadChange[]) {
  const files = new Map<string, AgentThreadChange[]>()
  for (const change of changes) {
    const path = change.destinationPath ?? change.path
    const previous = files.get(path) ?? []
    if (path !== change.path) {
      const source = files.get(change.path)
      if (source) previous.push(...source)
      files.delete(change.path)
    }
    previous.push(change)
    files.set(path, previous)
  }
  // A move can combine histories from both paths.
  const order = new Map(changes.map((change, index) => [change, index]))
  for (const history of files.values()) history.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return files
}

function appendEditDiff(code: HTMLElement, diff: string) {
  let inHunk = false
  let row: HTMLSpanElement | undefined
  const lines = diff.replace(/\r?\n$/u, '').split(/\r?\n/u)
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('@@')) inHunk = true
    let change = 'context'
    if (line.startsWith('@@') || (!inHunk && /^(?:---|\+\+\+) /u.test(line))) change = 'header'
    else if (line.startsWith('+')) change = 'addition'
    else if (line.startsWith('-')) change = 'deletion'
    if (row?.dataset.change === change) {
      row.append(`\n${line}`)
    } else {
      if (index) code.append('\n')
      row = node('span', 'agent-thread-edit-line', line)
      row.dataset.change = change
      code.append(row)
    }
  }
}

function editDiff(path: string, changes: readonly AgentThreadChange[]) {
  const pre = node('pre', 'agent-thread-edit-diff')
  pre.tabIndex = 0
  pre.setAttribute('aria-label', `Changes to ${path}`)
  const code = node('code', '')
  for (const [index, change] of changes.entries()) {
    if (index) code.append('\n\n')
    appendEditDiff(code, change.diff ?? 'Diff unavailable for this edit')
  }
  pre.append(code)
  return pre
}

function expandedEditPaths(element?: HTMLElement) {
  return new Set(
    Array.from(
      element?.querySelectorAll<HTMLButtonElement>('.agent-thread-edit-toggle[aria-expanded="true"]') ?? [],
      trigger => trigger.title,
    ),
  )
}

function editFileRow(
  tag: 'li' | 'div',
  path: string,
  changes: readonly AgentThreadChange[],
  counts: EditCounts,
  displayPath: (path: string) => string,
  onOpenFile: ConversationOptions['onOpenFile'],
  open: ReadonlySet<string>,
  inTimeline: boolean,
) {
  const last = changes.at(-1)
  const operation = last?.operation ?? 'update'
  const originalPath = changes.find(change => change.destinationPath)?.path
  const label = displayPath(path)
  const name = originalPath && originalPath !== path ? `${displayPath(originalPath)} → ${label}` : label
  const title = originalPath && originalPath !== path ? `${originalPath} → ${path}` : path
  const element = node(tag, 'agent-thread-edit-file')
  const row = node('div', 'agent-thread-edit-row')
  element.append(row)
  if (inTimeline) row.append(toolIcon('edit'), node('span', 'agent-thread-tool-name', editLabels[operation]))

  const file =
    onOpenFile && operation !== 'delete'
      ? button('agent-thread-edit-path', name, trigger => onOpenFile({ path, line: last?.line }, trigger))
      : node('span', 'agent-thread-edit-path', name)
  file.title = title
  row.append(file)

  const stats = editStats([counts])
  if (!inTimeline && (operation !== 'update' || !stats))
    row.append(node('span', 'agent-thread-edit-operation', editLabels[operation]))
  if (stats) row.append(stats)
  if (changes.some(change => change.diff)) {
    const toggle = inlineDisclosure(
      element,
      'agent-thread-tool-toggle agent-thread-edit-toggle',
      'Diff',
      () => editDiff(label, changes),
      open.has(title),
    )
    toggle.setAttribute('aria-label', `Diff for ${label}`)
    toggle.title = title
    row.append(toggle)
  }
  return element
}

function createEditSummary({ onOpenFile, projectRoot }: ConversationOptions) {
  const card = node('section', 'agent-thread-edit-summary')
  card.setAttribute('aria-label', 'Edited files')
  const header = node('div', 'agent-thread-edit-header')
  const icon = toolIcon('edit')
  const heading = node('strong', 'agent-thread-edit-title')
  header.append(icon, heading)
  const list = node('ul', 'agent-thread-edit-list')
  card.append(header, list)
  const prefix = projectRoot ? `${projectRoot.replaceAll('\\', '/').replace(/\/+$/u, '')}/` : undefined
  const displayPath = (file: string) => {
    const path = file.replaceAll('\\', '/')
    return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : file
  }
  let rendered = new Map<string, RenderedEditFile>()
  return (events: readonly AgentThreadEvent[]) => {
    const changes = events.flatMap(event => event.changes ?? [])
    const files = editsByPath(changes)
    heading.textContent = `Edited ${files.size} ${files.size === 1 ? 'file' : 'files'}`
    const next = new Map<string, RenderedEditFile>()
    for (const [path, history] of files) {
      const previous = rendered.get(path)
      if (previous && sameChanges(previous.changes, history)) {
        next.set(path, previous)
        continue
      }
      const counts = agentThreadChangeCounts(history)
      const row = editFileRow(
        'li',
        path,
        history,
        counts,
        displayPath,
        onOpenFile,
        expandedEditPaths(previous?.row),
        false,
      )
      next.set(path, { changes: history, row, counts })
    }
    const total = editStats([...next.values()].map(file => file.counts))
    header.replaceChildren(icon, heading, ...(total ? [total] : []))
    syncChildren(
      list,
      [...rendered.values()].map(file => file.row),
      [...next.values()].map(file => file.row),
    )
    rendered = next
    return card
  }
}

const delegationLabels = {
  spawn: 'Delegated to',
  resume: 'Resumed',
  close: 'Closed',
  result: 'Result from',
  wait: 'Waited for',
}

function delegationLabel(delegation: AgentThreadDelegation) {
  const prefix =
    delegation.action === 'message'
      ? delegation.direction === 'received'
        ? 'Message from'
        : 'Message to'
      : delegationLabels[delegation.action]
  return `${prefix} ${delegation.name ?? 'subagent'}`
}

function delegationBlock(event: AgentThreadEvent, onOpenDelegate: ConversationOptions['onOpenDelegate']) {
  const card = node('section', 'agent-thread-delegate')
  const delegation = event.delegation
  const title = delegation ? delegationLabel(delegation) : 'Subagent activity'
  if (delegation && onOpenDelegate) {
    card.append(button('agent-thread-delegate-open', title, () => onOpenDelegate(delegation.threadId)))
  } else {
    card.append(node('span', 'agent-thread-delegate-title', title))
  }
  const text = event.text.trim()
  if (!text) return card
  if (text.length <= 210 && !text.includes('\n')) {
    card.append(node('p', 'agent-thread-delegate-message', text))
    return card
  }
  const disclosure = node('details', 'agent-thread-delegate-details')
  const [firstLine = text] = text.split('\n', 1)
  const excerpt = firstLine.length > 205 ? `${firstLine.slice(0, 204).trimEnd()}…` : firstLine
  disclosure.append(node('summary', 'agent-thread-delegate-message', excerpt))
  disclosure.addEventListener('toggle', () => {
    if (disclosure.open && disclosure.children.length === 1) disclosure.append(assistantMarkdown(text))
  })
  card.append(disclosure)
  return card
}

interface Block {
  start: number
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'edit-summary' | 'delegate' | 'notice'
  events: [AgentThreadEvent, ...AgentThreadEvent[]]
}

interface Turn {
  start: number
  turnId?: string
  kind: 'user' | 'assistant' | 'notice'
  blocks: Block[]
}

interface RenderedBlock extends Block {
  nodes: HTMLElement[]
  updateText?: (text: string) => void
  updateTools?: ReturnType<typeof createToolGroup>
  updateEdits?: ReturnType<typeof createEditSummary>
}

interface RenderedTurn extends Omit<Turn, 'blocks'> {
  element: HTMLElement
  body: HTMLElement
  blocks: RenderedBlock[]
}

function groupTurns(events: readonly AgentThreadEvent[], start: number) {
  const turns: Turn[] = []
  const nativeTurns = new Map<string, { reply: Turn; edits?: Block }>()
  let reply: Turn | undefined
  let edits: Block | undefined
  function finishReply() {
    if (reply && edits) reply.blocks.push(edits)
    reply = undefined
    edits = undefined
  }
  for (let index = start; index < events.length; index++) {
    const event = events[index]
    if (!event || event.kind === 'status') continue
    const kind = event.kind
    if (kind === 'thinking' && !event.text.trim()) continue
    if (
      (kind === 'user' || kind === 'assistant') &&
      !event.text.trim() &&
      !event.files?.length &&
      !event.images?.length
    )
      continue

    if (kind === 'notice' || kind === 'user') {
      finishReply()
      turns.push({ start: index, turnId: event.turnId, kind, blocks: [{ start: index, kind, events: [event] }] })
      continue
    }
    if (reply?.turnId && event.turnId && reply.turnId !== event.turnId) finishReply()
    if (!reply) {
      reply = { start: index, turnId: event.turnId, kind: 'assistant', blocks: [] }
      turns.push(reply)
    }
    reply.turnId ??= event.turnId
    let nativeTurn = reply.turnId ? nativeTurns.get(reply.turnId) : undefined
    if (nativeTurn) {
      nativeTurn.reply = reply
    } else if (reply.turnId) {
      nativeTurn = { reply }
      nativeTurns.set(reply.turnId, nativeTurn)
    }
    if (kind === 'edit' && event.changes?.length) {
      const block = nativeTurn ? nativeTurn.edits : edits
      if (block) block.events.push(event)
      else if (nativeTurn) nativeTurn.edits = { start: index, kind: 'edit-summary', events: [event] }
      else edits = { start: index, kind: 'edit-summary', events: [event] }
    }
    const tail = reply.blocks.at(-1)
    const blockKind = kind === 'edit' ? 'tool' : kind
    if (blockKind === 'tool' && tail?.kind === 'tool') tail.events.push(event)
    else reply.blocks.push({ start: index, kind: blockKind, events: [event] })
  }
  finishReply()
  for (const nativeTurn of nativeTurns.values()) {
    if (nativeTurn.edits) nativeTurn.reply.blocks.push(nativeTurn.edits)
  }
  return turns.filter(item => item.blocks.length)
}

function sameEvent(first: AgentThreadEvent, second?: AgentThreadEvent) {
  return (
    first.kind === second?.kind &&
    first.turnId === second.turnId &&
    first.text === second.text &&
    first.toolName === second.toolName &&
    first.toolDescription === second.toolDescription &&
    first.delegation?.threadId === second.delegation?.threadId &&
    first.delegation?.action === second.delegation?.action &&
    first.delegation?.name === second.delegation?.name &&
    first.delegation?.direction === second.delegation?.direction &&
    sameChanges(first.changes, second.changes) &&
    sameAttachments(first, second)
  )
}

function sameAttachments(first: AgentThreadEvent, second: AgentThreadEvent) {
  return (
    first.files?.length === second.files?.length &&
    first.links?.length === second.links?.length &&
    first.images?.length === second.images?.length &&
    (first.files?.every(
      (file, index) => file.path === second.files?.[index]?.path && file.line === second.files?.[index]?.line,
    ) ??
      true) &&
    (first.links?.every((link, index) => {
      const other = second.links?.[index]
      return (
        link.href === other?.href &&
        link.path === other.path &&
        link.line === other.line &&
        link.image === other.image &&
        link.dataUrl === other.dataUrl
      )
    }) ??
      true) &&
    (first.images?.every(
      (image, index) =>
        image.name === second.images?.[index]?.name && image.dataUrl === second.images?.[index]?.dataUrl,
    ) ??
      true)
  )
}

function syncChildren(parent: HTMLElement, oldNodes: readonly HTMLElement[], nodes: readonly HTMLElement[]) {
  if (oldNodes.length === nodes.length && oldNodes.every((element, index) => element === nodes[index])) return
  const retained = new Set(nodes)
  const start = oldNodes[0]?.previousSibling
  const end = oldNodes.at(-1)?.nextSibling ?? null
  for (const element of oldNodes) if (!retained.has(element)) element.remove()
  let cursor = start ? start.nextSibling : oldNodes.length ? parent.firstChild : end
  for (const element of nodes) {
    if (element === cursor) cursor = cursor.nextSibling
    else parent.insertBefore(element, cursor)
  }
}

function renderBlock(block: Block, options: ConversationOptions, previous?: RenderedBlock): RenderedBlock {
  const { onOpenFile } = options
  const [first] = block.events
  if (block.kind === previous?.kind) {
    if (
      block.events.length === previous.events.length &&
      block.events.every((event, index) => event === previous.events[index])
    )
      return previous
    if (previous.updateText && first.text.trim() && sameAttachments(first, previous.events[0])) {
      previous.updateText(first.text)
      return { ...previous, ...block }
    }
  }

  if (block.kind === 'thinking') {
    const { details, updateText } = thinkingDisclosure(first.text)
    return { ...block, nodes: [details], updateText }
  }
  if (block.kind === 'tool') {
    const updateTools = previous?.updateTools ?? createToolGroup(onOpenFile)
    return { ...block, nodes: [updateTools(block.events)], updateTools }
  }
  if (block.kind === 'delegate') {
    return { ...block, nodes: [delegationBlock(first, options.onOpenDelegate)] }
  }
  if (block.kind === 'edit-summary') {
    const updateEdits = previous?.updateEdits ?? createEditSummary(options)
    return { ...block, nodes: [updateEdits(block.events)], updateEdits }
  }
  const nodes: HTMLElement[] = []
  let updateText: RenderedBlock['updateText']
  const images = first.images?.length ? imageAttachments(first.images) : undefined
  if (images && block.kind === 'user') nodes.push(images)
  if (first.text.trim()) {
    const message = messageMarkdown(first, options)
    nodes.push(message.markdown)
    updateText = message.updateText
  }
  if (images && block.kind !== 'user') nodes.push(images)
  if (first.files?.length) nodes.push(fileReferences(first.files, onOpenFile))
  return { ...block, nodes, updateText }
}

export function showAgentThreadConversationState(
  host: HTMLElement,
  provider: AgentProvider,
  error?: string,
  onRetry?: () => void,
) {
  const loading = error === undefined
  host.classList.add('agent-thread-conversation')
  host.dataset.provider = provider
  host.setAttribute('role', 'region')
  host.setAttribute('aria-label', 'Conversation')
  host.setAttribute('aria-busy', String(loading))
  host.tabIndex = 0
  const state = node('div', 'agent-thread-conversation-state')
  state.setAttribute('role', 'status')
  if (loading) {
    state.append(node('p', '', 'Loading conversation…'))
  } else {
    state.append(node('strong', '', error))
    if (onRetry) state.append(button('agent-thread-conversation-retry', 'Try again', onRetry))
  }
  host.replaceChildren(state)
}

export function createAgentThreadTranscript(host: HTMLElement, options: ConversationOptions) {
  const { provider, providerMark, assistantName = agentProviderNames[provider], userName = 'You' } = options
  const list = node('div', 'agent-thread-turns')
  const empty = node('div', 'agent-thread-conversation-state')
  empty.setAttribute('role', 'status')
  empty.append(node('strong', '', 'No messages yet'), node('p', '', 'This session has no saved conversation.'))
  const toolOnly = node(
    'p',
    'agent-thread-conversation-notice',
    'This session saved tool activity without chat messages.',
  )
  const events: AgentThreadEvent[] = []
  const turns: RenderedTurn[] = []

  function renderTurn(
    current: Turn,
    previous: RenderedTurn | undefined,
    previousEdits: ReadonlyMap<number, RenderedBlock>,
  ): RenderedTurn {
    if (current.kind === 'notice') {
      const text = current.blocks[0]?.events[0].text ?? ''
      const element = previous?.element ?? node('p', 'agent-thread-conversation-notice')
      if (element.textContent !== text) element.textContent = text
      return { ...current, element, body: element, blocks: [] }
    }
    const rendered =
      previous ??
      (() => {
        const { article, body } = turn(current.kind, current.kind === 'user' ? userName : assistantName, providerMark)
        return { ...current, element: article, body, blocks: [] }
      })()
    const byStart = new Map(
      rendered.blocks.filter(block => block.kind !== 'edit-summary').map(block => [block.start, block]),
    )
    const blocks = current.blocks.map(block =>
      renderBlock(block, options, (block.kind === 'edit-summary' ? previousEdits : byStart).get(block.start)),
    )
    syncChildren(
      rendered.body,
      rendered.blocks.flatMap(block => block.nodes).filter(element => element.parentElement === rendered.body),
      blocks.flatMap(block => block.nodes),
    )
    return { ...current, element: rendered.element, body: rendered.body, blocks }
  }

  return {
    get eventCount() {
      return events.length
    },
    update(from: number, patch: readonly AgentThreadEvent[]) {
      const focused = document.activeElement
      for (const [index, next] of patch.entries()) {
        const offset = from + index
        if (!sameEvent(next, events[offset])) events[offset] = next
      }
      events.length = from + patch.length
      // The last preexisting turn can acquire more text or tools at the patch boundary.
      let boundary = Math.max(
        0,
        turns.findLastIndex(item => item.start < from),
      )
      // Codex steering messages can start new visual replies inside a single native turn.
      const turnId = turns[boundary]?.turnId
      if (turnId) while (boundary > 0 && turns[boundary - 1]?.turnId === turnId) boundary--
      const previous = turns.slice(boundary)
      const byStart = new Map(previous.map(item => [item.start, item]))
      const previousEdits = new Map(
        previous.flatMap(item =>
          item.blocks.filter(block => block.kind === 'edit-summary').map(block => [block.start, block]),
        ),
      )
      const next = groupTurns(events, Math.min(from, previous[0]?.start ?? 0)).map(item => {
        const old = byStart.get(item.start)
        return renderTurn(item, item.kind === old?.kind ? old : undefined, previousEdits)
      })
      syncChildren(
        list,
        previous.map(item => item.element),
        next.map(item => item.element),
      )
      turns.length = boundary
      for (const item of next) turns.push(item)
      if (
        !events.some(
          event =>
            ['user', 'assistant', 'thinking', 'delegate'].includes(event.kind) &&
            (event.text.trim() || event.images?.length),
        ) &&
        events.some(event => event.kind === 'tool' || event.kind === 'edit')
      ) {
        if (toolOnly.parentElement !== list) list.prepend(toolOnly)
      } else {
        toolOnly.remove()
      }
      host.setAttribute('aria-busy', 'false')
      const content = turns.length ? list : empty
      if (host.firstElementChild !== content) host.replaceChildren(content)
      if (
        focused instanceof HTMLElement &&
        focused.isConnected &&
        host.contains(focused) &&
        document.activeElement !== focused
      )
        focused.focus({ preventScroll: true })
      return content === list ? list : undefined
    },
  }
}
