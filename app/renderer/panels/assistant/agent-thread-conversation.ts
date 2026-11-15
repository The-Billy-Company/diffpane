import { agentProviderNames } from '../../../shared/agent-threads.ts'
import type { AgentProvider, AgentThreadEvent, AgentThreadFile } from '../../../shared/agent-threads.ts'
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
  const description = event.toolDescription?.trim() ?? ''
  const text = event.text.trimEnd()
  return { name, description, raw: text === description || text === name ? '' : text, files: event.files ?? [] }
}

type ToolCall = ReturnType<typeof describeTool>

function toolContents(tool: ToolCall, onOpenFile: ConversationOptions['onOpenFile']) {
  const contents = node('div', 'agent-thread-tool-contents')
  if (tool.raw) {
    const pre = node('pre', 'agent-thread-tool-raw', tool.raw)
    pre.tabIndex = 0
    pre.setAttribute('aria-label', `${tool.name} details`)
    contents.append(pre)
  }
  if (tool.files.length) contents.append(fileReferences(tool.files, onOpenFile))
  return contents
}

function toolGroup(
  firstEvent: AgentThreadEvent,
  followingEvents: readonly AgentThreadEvent[],
  onOpenFile: ConversationOptions['onOpenFile'],
) {
  const first = describeTool(firstEvent)
  const tools = [first, ...followingEvents.map(describeTool)]
  const isSingle = tools.length === 1
  const hasDetails = !isSingle || Boolean(first.raw || first.files.length)
  const summary = node(hasDetails ? 'summary' : 'div', 'agent-thread-tool-summary')
  const icon = node('span', 'agent-thread-tool-icon', '›_')
  icon.setAttribute('aria-hidden', 'true')
  const copy = node('span', 'agent-thread-tool-copy')
  copy.append(node('span', 'agent-thread-tool-name', isSingle ? first.name : `${tools.length} tool calls`))
  const names = [...new Set(tools.map(tool => tool.name))]
  const preview = isSingle ? first.description : names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '')
  if (preview) copy.append(node('span', 'agent-thread-tool-preview', preview))
  summary.append(icon, copy)
  if (!hasDetails) {
    const group = node('div', 'agent-thread-tool-group')
    group.append(summary)
    return group
  }

  const group = node('details', 'agent-thread-tool-group')
  group.append(summary)
  group.addEventListener('toggle', () => {
    if (!group.open || group.childElementCount > 1) return
    if (isSingle) {
      group.append(toolContents(first, onOpenFile))
      return
    }
    const list = node('ul', 'agent-thread-tool-list')
    for (const tool of tools) {
      const item = node('li', 'agent-thread-tool-entry')
      item.append(node('span', 'agent-thread-tool-name', tool.name))
      if (tool.description) item.append(node('p', 'agent-thread-tool-description', tool.description))
      if (tool.raw) {
        const details = node('details', 'agent-thread-tool-detail')
        details.append(node('summary', '', 'Details'), toolContents(tool, onOpenFile))
        item.append(details)
      } else if (tool.files.length) {
        item.append(fileReferences(tool.files, onOpenFile))
      }
      list.append(item)
    }
    group.append(list)
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
    if (!hasText && !files.length) continue
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
    if (files.length) body.append(fileReferences(files, onOpenFile))
  }
  flushTools()
  if (
    events.some(event => event.kind === 'tool' || event.kind === 'edit') &&
    !events.some(
      event => (event.kind === 'assistant' || event.kind === 'user' || event.kind === 'thinking') && event.text.trim(),
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
