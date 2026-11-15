import type { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
import { createAgentThreadPanel } from '../../../renderer/panels/assistant/agent-threads.ts'
import { requireElement } from '../../../renderer/shell/workspace/dom.js'
import '../../../renderer/panels/assistant/assistant.css'
import type { AgentThread } from '../../../shared/agent-threads.ts'
import '../../../renderer/shell/workspace/style.css'
import '../../../renderer/shell/workspace/theme-tokens.css'
import '../../../renderer/shell/workspace/theme.css'

const { document, window, HTMLElement, HTMLDivElement, HTMLImageElement, HTMLInputElement, HTMLDetailsElement, Event } =
  globalThis

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

export async function run(longCommand: string) {
  const app = requireElement(document, '#app', HTMLDivElement)
  const workspace = document.createElement('section')
  const host = document.createElement('main')
  host.id = 'agent-threads'
  host.hidden = true
  app.append(workspace, host)

  const updatedAt = Date.now()
  const threads: AgentThread[] = [
    {
      id: 'codex:1',
      provider: 'codex',
      title: 'Inspect the parser',
      cwd: '/projects/juniper',
      status: 'running',
      updatedAt,
    },
    { id: 'codex:2', provider: 'codex', title: 'Review tests', cwd: '/projects/juniper', status: 'idle', updatedAt },
    {
      id: 'cursor:1',
      provider: 'cursor',
      title: 'Compare release notes',
      cwd: '/projects/marigold',
      status: 'running',
      updatedAt,
    },
    { id: 'cursor:2', provider: 'cursor', title: 'Update release notes', cwd: '/projects/marigold', updatedAt },
  ]
  const bridge = window.diffpane?.agentThreads
  assert(bridge, 'The Agent Threads preload bridge did not load.')
  let lists = 0
  let reads = 0
  const api: DiffpaneApi['agentThreads'] = {
    list: async () => {
      lists++
      return { threads: threads.map(thread => ({ ...thread })), unavailable: [] }
    },
    read: (id, selection) => {
      assert(id === 'codex:1', 'The selected thread ID was sent to the source.')
      reads++
      return bridge.read(id, selection)
    },
    clear: async () => {},
    file: async (_selection, path) => {
      assert(path === '/projects/juniper/fixtures/greeting.txt', 'The tool file reference sent the wrong path.')
      return { kind: 'preview', text: 'Hello from the parser fixture.', limited: false }
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
    const juniper = button(projects, 'juniper')
    juniper.focus()
    juniper.click()
    assert(
      button(host, 'Hide projects').getAttribute('aria-expanded') === 'true' && !projects.inert,
      'Selecting a project closed the project sidebar.',
    )
    assert(
      document.activeElement === button(projects, 'juniper'),
      'Selecting a project moved focus out of the sidebar.',
    )
    assert(!host.textContent.includes('Compare release notes'), 'The project filter did not narrow the thread list.')
    button(projects, 'marigold').click()
    assert(!host.textContent.includes('Inspect the parser'), 'Switching projects did not update the thread list.')
    button(projects, 'All projects').click()
    assert(host.textContent.includes('Inspect the parser'), 'All projects did not restore the thread list.')
    button(projects, 'juniper').click()

    button(host, 'Hide projects').click()
    assert(button(host, 'Show projects').getAttribute('aria-expanded') === 'false', 'The sidebar did not collapse.')
    assert(projects.inert, 'The collapsed project picker stayed interactive.')
    await eventually(
      () => !projects.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || projects.clientWidth === 0,
      'The project picker stayed visible after toggling it closed.',
    )
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
    assert(
      !host.querySelector('.agent-thread-minimap')?.checkVisibility(),
      'The thread map appeared alongside a short conversation.',
    )

    const tools = requireElement(host, '.agent-thread-tool-group', HTMLDetailsElement)
    const thinking = [...host.querySelectorAll<HTMLDetailsElement>('.agent-thread-thinking')]
    assert(thinking.length === 2, 'The conversation did not render both thinking blocks.')
    const firstThought = thinking[0]
    const nextThought = thinking[1]
    assert(firstThought && nextThought, 'The thinking blocks are missing.')
    const thinkingSummary = requireElement(firstThought, 'summary', HTMLElement)
    assert(
      !firstThought.open && !nextThought.open && thinkingSummary.textContent === 'Thinking',
      'Thinking should appear as a collapsed disclosure.',
    )
    assert(
      firstThought.nextElementSibling === tools && tools.nextElementSibling === nextThought,
      'Thinking and tool calls were reordered in the conversation.',
    )
    thinkingSummary.click()
    await eventually(
      () => firstThought.open && firstThought.querySelector('strong')?.textContent === 'greeting fixture',
      'Expanding thinking did not render its Markdown.',
    )
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
    const conversation = requireElement(host, '.agent-thread-conversation', HTMLElement)
    const raw = requireElement(tools, '.agent-thread-tool-detail', HTMLDetailsElement)
    assert(!raw.open, 'Opening the tool group exposed raw command details.')
    const rowSummary = requireElement(raw, ':scope > summary', HTMLElement)
    assert(
      rowSummary.textContent.includes('exec_command') && rowSummary.textContent.includes('Check the parser fixture'),
      'The tool row description was missing from its disclosure.',
    )
    const { top, width } = rowSummary.getBoundingClientRect()
    rowSummary.focus({ preventScroll: true })
    rowSummary.click()
    await eventually(
      () => raw.open && raw.querySelector('.agent-thread-tool-raw'),
      'Opening a tool row did not expose its command.',
    )
    const command = requireElement(raw, '.agent-thread-tool-raw', HTMLElement)
    assert(command.textContent === longCommand, 'Opening the tool row changed the saved command.')
    assert(command.scrollWidth <= command.clientWidth + 1, 'The long command did not wrap within its code block.')
    const groupBounds = tools.getBoundingClientRect()
    const commandBounds = command.getBoundingClientRect()
    assert(
      commandBounds.left >= groupBounds.left && commandBounds.right <= groupBounds.right,
      'The expanded command overflowed the tool group.',
    )
    assert(
      conversation.scrollLeft === 0 && conversation.scrollWidth === conversation.clientWidth,
      'Opening the command made the conversation scroll horizontally.',
    )
    const openedBounds = rowSummary.getBoundingClientRect()
    assert(
      Math.abs(openedBounds.top - top) <= 1 &&
        Math.abs(openedBounds.width - width) <= 1 &&
        document.activeElement === rowSummary,
      'Opening the command moved its tool row or focus.',
    )
    rowSummary.click()
    assert(!raw.open && tools.open, 'Closing a tool row also closed the tool group.')
    const reference = button(tools, 'greeting.txt')
    reference.click()
    await eventually(
      () => host.textContent.includes('Hello from the parser fixture.'),
      'The tool file reference did not open a preview.',
    )
    button(host, 'Close file preview').click()
    assert(
      document.activeElement === reference,
      'Closing the preview did not restore focus to the tool file reference.',
    )

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

    const screenshot = requireElement(host, 'img[alt="Parser screenshot.png"]', HTMLImageElement)
    await eventually(
      () => screenshot.naturalWidth === 2 && screenshot.naturalHeight === 1,
      'The screenshot did not decode.',
    )
    const imageTurn = screenshot.closest('.agent-thread-turn[data-role="user"]')
    assert(
      imageTurn && !imageTurn.querySelector('.agent-thread-prompt'),
      'An image-only turn should have no empty prompt bubble.',
    )
    assert(imageTurn.textContent.includes('Unavailable screenshot.png'), 'The missing screenshot was not labeled.')

    const map = requireElement(host, '.agent-thread-minimap', HTMLElement)
    await eventually(() => map.checkVisibility(), 'The thread map did not appear for the long conversation.')
    const position = requireElement(map, 'input[type="range"].agent-thread-minimap-position', HTMLInputElement)
    assert(
      [...(position.labels ?? [])].some(label => label.textContent.trim() === 'Thread map'),
      'The thread map range was missing its label.',
    )
    const marks = requireElement(map, '.agent-thread-minimap-marks', HTMLElement)
    assert(
      ['user', 'tool', 'assistant'].every(role => marks.querySelector(`[data-role="${role}"]`)),
      'The thread map did not show each kind of activity in the conversation.',
    )

    const maxScroll = conversation.scrollHeight - conversation.clientHeight
    const minPosition = Number(position.min || 0)
    const maxPosition = Number(position.max || 100)
    const middlePosition = (minPosition + maxPosition) / 2
    conversation.scrollTop = 0
    await eventually(
      () => position.valueAsNumber === minPosition,
      'The thread map did not return to the start when the conversation did.',
    )
    conversation.scrollTop = maxScroll / 2
    await eventually(
      () => Math.abs(position.valueAsNumber - middlePosition) <= Math.max(1, (maxPosition - minPosition) * 0.01),
      'Scrolling the conversation did not move the thread map position.',
    )
    position.valueAsNumber = maxPosition
    position.dispatchEvent(new Event('input', { bubbles: true }))
    await eventually(
      () => Math.abs(conversation.scrollTop - maxScroll) <= 1,
      'Moving the thread map position did not seek to the end of the conversation.',
    )

    button(host, 'Back to threads').click()
    assert(search.checkVisibility() && search.value === 'parser', 'Back did not restore the thread list and filters.')
    assert(
      !map.checkVisibility() && !host.querySelector('.agent-thread-minimap-marks [data-role]'),
      'Back did not hide and clear the thread map.',
    )
    const first = threads[0]
    assert(first, 'Missing fixture thread.')
    first.title = 'Recheck the parser'
    button(host, 'Refresh threads').click()
    await eventually(
      () => host.textContent.includes('Recheck the parser'),
      'Manual refresh did not reload the thread list.',
    )

    button(projects, 'All projects').click()
    search.value = ''
    search.dispatchEvent(new Event('input', { bubbles: true }))
    const sourceCount = (provider: string) => host.querySelector(`[data-source="${provider}"] [data-source-count]`)
    assert(sourceCount('codex')?.textContent === '2', 'The Codex count did not include all threads.')
    const updatedThread = threads.find(thread => thread.id === 'cursor:2')
    assert(updatedThread, 'Missing Cursor fixture thread.')
    updatedThread.status = 'running'
    button(host, 'Running').click()
    await eventually(() => lists === 3 && sourceCount('cursor')?.textContent === '2', 'Running did not refresh Cursor.')
    assert(sourceCount('codex')?.textContent === '1', 'The Codex count included an idle thread.')
    assert(host.querySelectorAll('.agent-thread-row').length === 3, 'Running did not show three active threads.')
    button(host, 'Cursor').click()
    assert(host.querySelectorAll('.agent-thread-row').length === 2, 'The Cursor filter hid a running Cursor thread.')
    assert(sourceCount('codex')?.textContent === '1', 'Selecting Cursor hid the Codex count.')

    button(host, 'Back to workspace').click()
    assert(host.hidden && !workspace.hidden, 'Back did not restore the workspace.')
  } finally {
    panel.dispose()
  }
}
