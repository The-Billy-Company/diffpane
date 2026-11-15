import type { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
import { createAgentThreadPanel } from '../../../renderer/panels/assistant/agent-threads.ts'
import { requireElement } from '../../../renderer/shell/workspace/dom.js'
import '../../../renderer/panels/assistant/assistant.css'
import type { AgentThread, AgentThreadEvent } from '../../../shared/agent-threads.ts'
import '../../../renderer/shell/workspace/style.css'
import '../../../renderer/shell/workspace/theme-tokens.css'
import '../../../renderer/shell/workspace/theme.css'

const { document, window, HTMLElement, HTMLDivElement, HTMLInputElement, HTMLDetailsElement, Event } = globalThis

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function button(host: ParentNode, label: string): HTMLButtonElement {
  const control = [...host.querySelectorAll('button')].find(candidate => {
    const accessibleLabel = candidate.getAttribute('aria-label')
    const threadTitle = candidate.querySelector('strong')?.textContent
    return (
      candidate.checkVisibility() &&
      (accessibleLabel === label || candidate.textContent.trim().startsWith(label) || threadTitle === label)
    )
  })
  assert(control, `Missing visible control: ${label}`)
  return control
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, milliseconds)
  })
}

async function eventually(condition: () => unknown, message: string): Promise<void> {
  const deadline = performance.now() + 2_000
  while (!condition()) {
    assert(performance.now() < deadline, message)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for asynchronous rendering before checking the view.
    await delay(20)
  }
}

export async function run() {
  const app = requireElement(document, '#app', HTMLDivElement)
  const workspace = document.createElement('section')
  const host = document.createElement('main')
  host.id = 'agent-threads'
  host.hidden = true
  app.append(workspace, host)

  const updatedAt = Date.now()
  const threads: AgentThread[] = [
    { id: 'codex:1', provider: 'codex', title: 'Inspect the parser', cwd: '/projects/juniper', updatedAt },
    { id: 'cursor:2', provider: 'cursor', title: 'Compare release notes', cwd: '/projects/marigold', updatedAt },
  ]
  const snapshot: AgentThreadEvent[] = [
    { kind: 'user', text: 'How does the parser handle a greeting?' },
    {
      kind: 'tool',
      toolName: 'exec_command',
      toolDescription: 'Check the parser fixture',
      text: 'cat fixtures/greeting.txt',
    },
    { kind: 'tool', toolName: 'apply_patch', toolDescription: 'Add a parser example', text: 'Update docs/parser.md' },
    {
      kind: 'assistant',
      text: '## Parsed greeting\n\nThe parser returns **a value**.\n\n```js\nreturn "hello"\n```',
    },
    { kind: 'status', text: 'Turn finished' },
  ]
  let lists = 0
  let reads = 0
  const api: DiffpaneApi['agentThreads'] = {
    list: async () => {
      lists++
      return { threads: threads.map(thread => ({ ...thread })), unavailable: [] }
    },
    read: async id => {
      assert(id === 'codex:1', 'The selected thread ID was sent to the source.')
      reads++
      return [...snapshot]
    },
    clear: async () => {},
    file: async () => {
      throw new Error('The fixture does not expose files.')
    },
  }
  const panel = createAgentThreadPanel(host, {
    api,
    openWorkspaceFile: () => {},
    onVisibilityChange: open => {
      workspace.hidden = open
    },
  })

  try {
    panel.open()
    await eventually(() => host.textContent.includes('Inspect the parser'), 'The thread roster did not load.')
    assert(host.tagName === 'MAIN' && !document.querySelector('dialog[open]'), 'Agent Threads opened in a modal.')
    assert(workspace.hidden, 'Agent Threads did not replace the workspace.')
    const bounds = host.getBoundingClientRect()
    assert(
      bounds.left === 0 &&
        bounds.top === 0 &&
        bounds.width === window.innerWidth &&
        bounds.height === window.innerHeight,
      `Agent Threads did not fill the ${window.innerWidth}×${window.innerHeight} viewport: ${JSON.stringify(bounds.toJSON())}.`,
    )

    const projects = requireElement(host, 'nav[aria-label="Projects"]', HTMLElement)
    button(projects, 'juniper').click()
    assert(
      button(host, 'Show projects').getAttribute('aria-expanded') === 'false',
      'The project picker stayed expanded.',
    )
    assert(projects.inert, 'The collapsed project picker stayed interactive.')
    await eventually(
      () => !projects.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || projects.clientWidth === 0,
      'The project picker stayed visible after selection.',
    )
    assert(!host.textContent.includes('Compare release notes'), 'The project filter did not narrow the thread list.')
    button(host, 'Show projects').click()
    assert(button(host, 'Hide projects').getAttribute('aria-expanded') === 'true', 'The project picker did not reopen.')
    assert(!projects.inert, 'The reopened project picker is not interactive.')

    const search = requireElement(host, 'input[aria-label="Search threads"]', HTMLInputElement)
    search.value = 'parser'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    button(host, 'Inspect the parser').click()
    await eventually(
      () => host.querySelector('.agent-thread-turn[data-role="assistant"]'),
      'The conversation did not load.',
    )
    assert(!search.checkVisibility(), 'The roster is still visible next to the conversation.')
    assert(
      host.querySelector('.agent-thread-turn[data-role="user"]')?.textContent.includes('How does the parser'),
      'The user message is missing.',
    )
    assert(
      host.querySelector('.agent-thread-turn strong')?.textContent === 'a value',
      'Markdown emphasis was not rendered.',
    )
    assert(
      host.querySelector('.agent-thread-turn pre code')?.textContent.includes('return "hello"'),
      'The code fence was not rendered.',
    )
    assert(!host.textContent.includes('Turn finished'), 'Internal status was included in the conversation.')

    const tools = requireElement(host, '.agent-thread-tool-group', HTMLDetailsElement)
    const summary = requireElement(tools, 'summary', HTMLElement)
    assert(
      !tools.open && summary.textContent.includes('2 tool calls'),
      'The tool calls were not grouped and collapsed.',
    )
    summary.click()
    assert(tools.open, 'The tool call group could not be expanded.')
    await eventually(() => tools.querySelector('.agent-thread-tool-entry'), 'The open group did not display its calls.')
    assert(
      tools.textContent.includes('exec_command') &&
        tools.textContent.includes('Check the parser fixture') &&
        tools.textContent.includes('apply_patch') &&
        tools.textContent.includes('Add a parser example'),
      'The expanded tool calls are missing source names or descriptions.',
    )
    const raw = requireElement(tools, '.agent-thread-tool-detail', HTMLDetailsElement)
    assert(!raw.open, 'Opening the tool group exposed raw command details.')

    snapshot.push({ kind: 'assistant', text: 'This arrived after the snapshot.' })
    await delay(3_200)
    assert(lists === 1 && reads === 1, 'Agent Threads polled for updates.')
    assert(
      !host.textContent.includes('This arrived after the snapshot.'),
      'The conversation changed without a refresh.',
    )
    button(host, 'Refresh conversation').click()
    await eventually(
      () => host.textContent.includes('This arrived after the snapshot.'),
      'Manual refresh did not reload the conversation.',
    )

    button(host, 'Back to threads').click()
    assert(search.checkVisibility() && search.value === 'parser', 'Back did not restore the thread list and filters.')
    const first = threads[0]
    assert(first, 'Missing fixture thread.')
    first.title = 'Recheck the parser'
    button(host, 'Refresh threads').click()
    await eventually(
      () => host.textContent.includes('Recheck the parser'),
      'Manual refresh did not reload the thread list.',
    )
    button(host, 'Back to workspace').click()
    assert(host.hidden && !workspace.hidden, 'Back did not restore the workspace.')
  } finally {
    panel.dispose()
  }
}
