import { agentProviderNames, isAgentThreadImageDataUrl } from '../../../shared/agent-threads.ts'
import type {
  AgentProvider,
  AgentThreadEvent,
  AgentThreadFile,
  AgentThreadImage,
} from '../../../shared/agent-threads.ts'
import { renderAssistantMarkdown } from './assistant-content.js'
import './agent-thread-conversation.css'

interface ConversationOptions {
  provider: AgentProvider
  providerMark?: HTMLElement
  onOpenFile?: (file: AgentThreadFile, trigger: HTMLButtonElement) => void
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

function fileReferences(files: readonly AgentThreadFile[], onOpenFile: ConversationOptions['onOpenFile']) {
  const references = node('div', 'agent-thread-references')
  for (const file of files) {
    const name = file.path.match(/[^\\/]+$/u)?.[0] ?? file.path
    const label = file.line ? `${name}:${file.line}` : name
    const reference = onOpenFile
      ? button('agent-thread-reference', label, trigger => onOpenFile(file, trigger))
      : node('span', 'agent-thread-reference', label)
    reference.title = file.path
    references.append(reference)
  }
  return references
}

function imageAttachments(images: readonly AgentThreadImage[]) {
  const attachments = node('div', 'agent-thread-images')
  for (const { name, dataUrl } of images) {
    const unavailable = () => node('span', 'agent-thread-image-unavailable', `${name} · Preview unavailable`)
    if (!isAgentThreadImageDataUrl(dataUrl)) {
      attachments.append(unavailable())
      continue
    }
    const image = node('img', 'agent-thread-image')
    image.alt = name
    image.decoding = 'async'
    image.addEventListener('error', () => image.replaceWith(unavailable()), { once: true })
    image.src = dataUrl
    attachments.append(image)
  }
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

function toolName(event: AgentThreadEvent) {
  return event.toolName ?? (event.kind === 'edit' ? 'File change' : 'Tool call')
}

function describeTool(event: AgentThreadEvent) {
  const name = toolName(event)
  const text = event.text.trimEnd()
  const raw = text && text !== name ? event.text : ''
  const description = event.toolDescription?.trim()
  const preview =
    description && description !== name ? description : (raw.trimStart().split('\n', 1)[0]?.slice(0, 180) ?? '')
  return { name, preview, raw, files: event.files ?? [] }
}

type ToolCall = ReturnType<typeof describeTool>

function toolIcon() {
  const icon = node('span', 'agent-thread-tool-icon', '›_')
  icon.setAttribute('aria-hidden', 'true')
  return icon
}

function toolHeading(tag: 'summary' | 'div', className: string, name: string, preview: string, showIcon = false) {
  const heading = node(tag, className)
  if (showIcon) heading.append(toolIcon())
  const copy = node('span', 'agent-thread-tool-copy')
  copy.append(node('span', 'agent-thread-tool-name', name))
  if (preview) {
    const label = node('span', 'agent-thread-tool-preview', preview)
    label.title = preview
    copy.append(label)
  }
  heading.append(copy)
  return heading
}

function appendToolEntry(
  item: HTMLElement,
  tool: ToolCall,
  onOpenFile: ConversationOptions['onOpenFile'],
  showIcon = false,
) {
  const row = toolHeading(tool.raw ? 'summary' : 'div', 'agent-thread-tool-row', tool.name, tool.preview, showIcon)
  if (tool.raw) {
    const disclosure = node('details', 'agent-thread-tool-detail')
    const pre = node('pre', 'agent-thread-tool-raw', tool.raw)
    pre.tabIndex = 0
    pre.setAttribute('aria-label', `${tool.name} details`)
    disclosure.append(row, pre)
    item.append(disclosure)
  } else {
    item.append(row)
  }
  if (tool.files.length) item.append(fileReferences(tool.files, onOpenFile))
}

function createToolGroup(onOpenFile: ConversationOptions['onOpenFile']) {
  let group: HTMLDetailsElement | HTMLDivElement | undefined
  let list: HTMLUListElement | HTMLDivElement | undefined
  let events: readonly AgentThreadEvent[] = []
  let entries: { event: AgentThreadEvent; item: HTMLElement }[] = []

  function renderEntries() {
    if (!group) return
    const grouped = group instanceof HTMLDetailsElement
    const parent = (list ??= group instanceof HTMLDetailsElement ? node('ul', 'agent-thread-tool-list') : group)
    const oldNodes = entries.map(entry => entry.item).filter(item => item.parentElement === parent)
    const tag = grouped ? 'li' : 'div'
    const next = events.map((event, index) => {
      const old = entries[index]
      if (old?.event === event && old.item.localName === tag) return old
      const item = node(tag, 'agent-thread-tool-entry')
      if (old?.event === event) {
        item.append(...old.item.childNodes)
        if (grouped) item.querySelector('.agent-thread-tool-icon')?.remove()
        else item.querySelector('.agent-thread-tool-row')?.prepend(toolIcon())
      } else {
        appendToolEntry(item, describeTool(event), onOpenFile, !grouped)
        const details = item.querySelector('details')
        if (details && old?.event.toolName === event.toolName && old?.item.querySelector('details[open]'))
          details.open = true
      }
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
      const names = [...new Set(events.map(toolName))]
      const heading = toolHeading(
        'summary',
        'agent-thread-tool-summary',
        `${events.length} tool calls`,
        names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : ''),
        true,
      )
      if (group instanceof HTMLDetailsElement) {
        group.querySelector('summary')?.replaceChildren(...heading.childNodes)
      } else {
        const details = node('details', 'agent-thread-tool-group')
        details.open = !!group?.querySelector('details[open]') || !!group?.contains(document.activeElement)
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

interface Block {
  start: number
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'notice'
  events: [AgentThreadEvent, ...AgentThreadEvent[]]
}

interface Turn {
  start: number
  kind: 'user' | 'assistant' | 'notice'
  blocks: [Block, ...Block[]]
}

interface RenderedBlock extends Block {
  nodes: HTMLElement[]
  updateText?: (text: string) => void
  updateTools?: ReturnType<typeof createToolGroup>
}

interface RenderedTurn extends Omit<Turn, 'blocks'> {
  element: HTMLElement
  body: HTMLElement
  blocks: RenderedBlock[]
}

function groupTurns(events: readonly AgentThreadEvent[], start: number) {
  const turns: Turn[] = []
  let reply: Turn | undefined
  for (let index = start; index < events.length; index++) {
    const event = events[index]
    if (!event || event.kind === 'status') continue
    const kind = event.kind === 'edit' ? 'tool' : event.kind
    if (kind === 'thinking' && !event.text.trim()) continue
    if (
      (kind === 'user' || kind === 'assistant') &&
      !event.text.trim() &&
      !event.files?.length &&
      !event.images?.length
    )
      continue

    if (kind === 'notice' || kind === 'user') {
      turns.push({ start: index, kind, blocks: [{ start: index, kind, events: [event] }] })
      reply = undefined
      continue
    }
    if (!reply) {
      reply = { start: index, kind: 'assistant', blocks: [{ start: index, kind, events: [event] }] }
      turns.push(reply)
      continue
    }
    const tail = reply.blocks.at(-1)
    if (kind === 'tool' && tail?.kind === 'tool') tail.events.push(event)
    else reply.blocks.push({ start: index, kind, events: [event] })
  }
  return turns
}

function sameEvent(first: AgentThreadEvent, second?: AgentThreadEvent) {
  return (
    first.kind === second?.kind &&
    first.text === second.text &&
    first.toolName === second.toolName &&
    first.toolDescription === second.toolDescription &&
    sameAttachments(first, second)
  )
}

function sameAttachments(first: AgentThreadEvent, second: AgentThreadEvent) {
  return (
    first.files?.length === second.files?.length &&
    first.images?.length === second.images?.length &&
    (first.files?.every(
      (file, index) => file.path === second.files?.[index]?.path && file.line === second.files?.[index]?.line,
    ) ??
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

function renderBlock(
  block: Block,
  onOpenFile: ConversationOptions['onOpenFile'],
  previous?: RenderedBlock,
): RenderedBlock {
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
  const nodes: HTMLElement[] = []
  let updateText: RenderedBlock['updateText']
  if (first.text.trim()) {
    if (block.kind === 'user') {
      const prompt = node('div', 'agent-thread-prompt', first.text)
      nodes.push(prompt)
    } else {
      const markdown = assistantMarkdown(first.text)
      nodes.push(markdown)
      updateText = text => renderAssistantMarkdown(markdown, text)
    }
  }
  if (first.images?.length) nodes.push(imageAttachments(first.images))
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

export function createAgentThreadTranscript(
  host: HTMLElement,
  { provider, providerMark, onOpenFile }: ConversationOptions,
) {
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

  function renderTurn(current: Turn, previous: RenderedTurn | undefined): RenderedTurn {
    if (current.kind === 'notice') {
      const text = current.blocks[0].events[0].text
      const element = previous?.element ?? node('p', 'agent-thread-conversation-notice')
      if (element.textContent !== text) element.textContent = text
      return { ...current, element, body: element, blocks: [] }
    }
    const rendered =
      previous ??
      (() => {
        const { article, body } = turn(
          current.kind,
          current.kind === 'user' ? 'You' : agentProviderNames[provider],
          providerMark,
        )
        return { ...current, element: article, body, blocks: [] }
      })()
    const byStart = new Map(rendered.blocks.map(block => [block.start, block]))
    const blocks = current.blocks.map(block => renderBlock(block, onOpenFile, byStart.get(block.start)))
    syncChildren(
      rendered.body,
      rendered.blocks.flatMap(block => block.nodes),
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
      const boundary = Math.max(
        0,
        turns.findLastIndex(item => item.start < from),
      )
      const previous = turns.slice(boundary)
      const byStart = new Map(previous.map(item => [item.start, item]))
      const next = groupTurns(events, Math.min(from, previous[0]?.start ?? 0)).map(item => {
        const old = byStart.get(item.start)
        return renderTurn(item, item.kind === old?.kind ? old : undefined)
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
            ['user', 'assistant', 'thinking'].includes(event.kind) && (event.text.trim() || event.images?.length),
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
