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
  events?: readonly AgentThreadEvent[]
  loading?: boolean
  error?: string
  onRetry?: () => void
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
  details.append(node('summary', '', 'Thinking'))
  details.addEventListener('toggle', () => {
    if (details.open && details.childElementCount === 1) details.append(assistantMarkdown(text))
  })
  return details
}

function describeTool(event: AgentThreadEvent) {
  const name = event.toolName ?? (event.kind === 'edit' ? 'File change' : 'Tool call')
  const text = event.text.trimEnd()
  const raw = text && text !== name ? event.text : ''
  const description = event.toolDescription?.trim()
  const preview =
    description && description !== name ? description : (raw.trimStart().split('\n', 1)[0]?.slice(0, 180) ?? '')
  return { name, preview, raw, files: event.files ?? [] }
}

type ToolCall = ReturnType<typeof describeTool>

function toolHeading(tag: 'summary' | 'div', className: string, name: string, preview: string, showIcon = false) {
  const heading = node(tag, className)
  if (showIcon) {
    const icon = node('span', 'agent-thread-tool-icon', '›_')
    icon.setAttribute('aria-hidden', 'true')
    heading.append(icon)
  }
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

function toolGroup(
  firstEvent: AgentThreadEvent,
  followingEvents: readonly AgentThreadEvent[],
  onOpenFile: ConversationOptions['onOpenFile'],
) {
  if (!followingEvents.length) {
    const group = node('div', 'agent-thread-tool-group')
    const item = node('div', 'agent-thread-tool-entry')
    appendToolEntry(item, describeTool(firstEvent), onOpenFile, true)
    group.append(item)
    return group
  }

  const tools = [firstEvent, ...followingEvents].map(describeTool)
  const names = [...new Set(tools.map(tool => tool.name))]
  const summary = toolHeading(
    'summary',
    'agent-thread-tool-summary',
    `${tools.length} tool calls`,
    names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : ''),
    true,
  )
  const group = node('details', 'agent-thread-tool-group')
  group.append(summary)

  function renderEntries() {
    if (group.childElementCount > 1) return
    const list = node('ul', 'agent-thread-tool-list')
    for (const tool of tools) {
      const item = node('li', 'agent-thread-tool-entry')
      appendToolEntry(item, tool, onOpenFile)
      list.append(item)
    }
    group.append(list)
  }

  summary.addEventListener('click', renderEntries, { once: true })
  group.addEventListener('toggle', () => {
    if (group.open) renderEntries()
  })
  return group
}

function renderTurns(events: readonly AgentThreadEvent[], { provider, providerMark, onOpenFile }: ConversationOptions) {
  const list = node('div', 'agent-thread-turns')
  let reply: HTMLElement | undefined
  let tools: AgentThreadEvent[] = []

  function replyBody() {
    if (!reply) {
      const assistant = turn('assistant', agentProviderNames[provider], providerMark)
      list.append(assistant.article)
      reply = assistant.body
    }
    return reply
  }

  function flushTools() {
    const [first, ...rest] = tools
    if (!first) return
    replyBody().append(toolGroup(first, rest, onOpenFile))
    tools = []
  }

  for (const event of events) {
    if (event.kind === 'status') continue
    if (event.kind === 'notice') {
      flushTools()
      list.append(node('p', 'agent-thread-conversation-notice', event.text))
      reply = undefined
      continue
    }
    if (event.kind === 'tool' || event.kind === 'edit') {
      tools.push(event)
      continue
    }
    const hasText = Boolean(event.text.trim())
    const files = event.files ?? []
    const images = event.images ?? []
    if (!hasText && !files.length && !images.length) continue
    flushTools()
    if (event.kind === 'thinking') {
      if (hasText) replyBody().append(thinkingDisclosure(event.text))
      continue
    }
    let body: HTMLElement
    if (event.kind === 'user') {
      const message = turn('user', 'You')
      if (hasText) message.body.append(node('div', 'agent-thread-prompt', event.text))
      list.append(message.article)
      body = message.body
      reply = undefined
    } else {
      body = replyBody()
      if (hasText) body.append(assistantMarkdown(event.text))
    }
    if (images.length) body.append(imageAttachments(images))
    if (files.length) body.append(fileReferences(files, onOpenFile))
  }
  flushTools()
  if (
    events.some(event => event.kind === 'tool' || event.kind === 'edit') &&
    !events.some(
      event =>
        (event.kind === 'assistant' || event.kind === 'user' || event.kind === 'thinking') &&
        (event.text.trim() || event.images?.length),
    )
  ) {
    list.prepend(
      node('p', 'agent-thread-conversation-notice', 'This session saved tool activity without chat messages.'),
    )
  }
  return list
}

export function renderAgentThreadConversation(host: HTMLElement, options: ConversationOptions) {
  const { provider, events = [], loading, error, onRetry } = options
  host.classList.add('agent-thread-conversation')
  host.dataset.provider = provider
  host.setAttribute('role', 'region')
  host.setAttribute('aria-label', 'Conversation')
  host.setAttribute('aria-busy', String(Boolean(loading)))
  host.tabIndex = 0
  const list = !loading && error === undefined ? renderTurns(events, options) : undefined
  const transcript = list?.childElementCount ? list : undefined
  if (transcript) {
    host.replaceChildren(transcript)
  } else {
    const state = node('div', 'agent-thread-conversation-state')
    state.setAttribute('role', 'status')
    if (loading) {
      state.append(node('p', '', 'Loading conversation…'))
    } else if (error !== undefined) {
      state.append(node('strong', '', error))
      if (onRetry) state.append(button('agent-thread-conversation-retry', 'Try again', onRetry))
    } else {
      state.append(node('strong', '', 'No messages yet'), node('p', '', 'This session has no saved conversation.'))
    }
    host.replaceChildren(state)
  }
  host.scrollTop = 0
  return transcript
}
