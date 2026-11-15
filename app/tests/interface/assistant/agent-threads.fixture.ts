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

export async function run(longCommand: string, transcriptRoute: string) {
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
  async function publish(stage: 'append' | 'grow' | 'reply' | 'late') {
    const response = await window.fetch(`${transcriptRoute}/${stage}`, { method: 'POST' })
    assert(response.ok, `The fixture failed to publish the ${stage} update.`)
  }

  let lists = 0
  let reads = 0
  let readInFlight = false
  let selectionId = ''
  let updates = 0
  let updateInFlight = false
  let lateUpdateReceived = false
  const lateUpdate = Promise.withResolvers<void>()
  const api: DiffpaneApi['agentThreads'] = {
    list: async () => {
      lists++
      return { threads: threads.map(thread => ({ ...thread })), unavailable: [] }
    },
    read: async (id, selection) => {
      assert(id === 'codex:1', 'The selected thread ID was sent to the source.')
      assert(!selectionId || selection === selectionId, 'Refreshing the conversation changed its selection.')
      assert(!readInFlight && !updateInFlight, 'The conversation requested a simultaneous snapshot.')
      selectionId = selection
      reads++
      readInFlight = true
      try {
        return await bridge.read(id, selection)
      } finally {
        readInFlight = false
      }
    },
    update: async (id, selection) => {
      assert(id === 'codex:1' && selection === selectionId, 'The live update lost its thread or selection.')
      assert(!readInFlight && !updateInFlight, 'The open conversation requested simultaneous updates.')
      updates++
      updateInFlight = true
      try {
        const update = await bridge.update(id, selection)
        if (update.change?.events.some(event => event.text === 'This update arrived after leaving.')) {
          lateUpdateReceived = true
          await lateUpdate.promise
        }
        return update
      } finally {
        updateInFlight = false
      }
    },
    clear: selection => bridge.clear(selection),
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
    const firstPrompt = requireElement(host, '.agent-thread-prompt', HTMLElement)

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

    await eventually(() => updates >= 1 && !updateInFlight, 'The open conversation did not check for live changes.')
    assert(
      lists === 1 && reads === 1 && firstPrompt.isConnected,
      'Live checks should leave the roster and unchanged transcript in place.',
    )

    reference.click()
    const preview = requireElement(host, '.agent-thread-preview pre', HTMLElement)
    await eventually(() => document.activeElement === preview, 'The file preview did not regain focus.')
    conversation.scrollTop = conversation.scrollHeight
    const atEnd = () => Math.abs(conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop) <= 1
    await publish('append')
    await eventually(
      () => conversation.textContent.includes('This arrived after the snapshot.'),
      'Output written after opening the conversation did not arrive automatically.',
    )
    await eventually(atEnd, 'The conversation did not follow new output from the end.')
    assert(
      firstPrompt.isConnected && firstThought.isConnected && firstThought.open && tools.isConnected && tools.open,
      'The live update replaced earlier messages or closed their disclosures.',
    )
    assert(
      document.activeElement === preview && preview.textContent === 'Hello from the parser fixture.',
      'The live update interrupted the focused file preview.',
    )
    button(host, 'Close file preview').click()
    assert(document.activeElement === reference, 'The preview lost its original link after a live update.')

    const liveThought = [...conversation.querySelectorAll<HTMLDetailsElement>('.agent-thread-thinking')].at(-1)
    assert(liveThought && liveThought !== nextThought, 'The live thinking block did not arrive.')
    const liveSummary = requireElement(liveThought, 'summary', HTMLElement)
    liveSummary.focus({ preventScroll: true })
    liveSummary.click()
    await eventually(() => liveThought.textContent.includes('Checking the final example.'), 'Thinking did not open.')
    conversation.scrollTop = conversation.scrollHeight
    await publish('grow')
    await eventually(
      () => liveThought.textContent.includes('The final check passed.'),
      'A partial thinking block did not continue updating in place.',
    )
    assert(
      liveThought.open && document.activeElement === liveSummary,
      'The growing block lost its open state or focus.',
    )
    await eventually(atEnd, 'The conversation did not follow growth within the current block.')

    conversation.scrollTop = 120
    const readingTop = conversation.scrollTop
    await publish('reply')
    await eventually(() => conversation.textContent.includes('All examples pass.'), 'The live reply did not arrive.')
    assert(Math.abs(conversation.scrollTop - readingTop) <= 1, 'New output jumped away from earlier messages.')
    await eventually(() => !updateInFlight, 'The live update did not finish.')
    button(host, 'Refresh conversation').click()
    await eventually(() => reads === 2 && !readInFlight, 'Manual refresh did not reread the conversation.')
    assert(firstPrompt.isConnected, 'Manual refresh replaced the existing conversation.')

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

    await publish('late')
    await eventually(() => lateUpdateReceived, 'The pending live update did not reach the renderer.')
    const updatesBeforeLeaving = updates
    button(host, 'Back to threads').click()
    lateUpdate.resolve()
    await eventually(() => !updateInFlight, 'The pending live update did not settle after leaving.')
    assert(search.checkVisibility() && search.value === 'parser', 'Back did not restore the thread list and filters.')
    assert(
      !map.checkVisibility() && !host.querySelector('.agent-thread-minimap-marks [data-role]'),
      'Back did not hide and clear the thread map.',
    )
    await delay(1_150)
    assert(
      updates === updatesBeforeLeaving && !conversation.textContent.trim(),
      'The conversation updated after returning to the thread list.',
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
    lateUpdate.resolve()
    panel.dispose()
  }
}
