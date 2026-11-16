import type { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
import { createAgentThreadTranscript } from '../../../renderer/panels/assistant/agent-thread-conversation.ts'
import { createAgentThreadPanel } from '../../../renderer/panels/assistant/agent-threads.ts'
import { requireElement } from '../../../renderer/shell/workspace/dom.js'
import '../../../renderer/panels/assistant/assistant.css'
import type { AgentThread, AgentThreadEvent, AgentThreadFile } from '../../../shared/agent-threads.ts'
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

function checkLiveEdits() {
  const host = document.createElement('div')
  const turnId = 'live-turn'
  const transcript = createAgentThreadTranscript(host, { provider: 'codex' })
  const initial: AgentThreadEvent[] = [
    { kind: 'user', turnId, text: 'Update the parser.' },
    { kind: 'assistant', turnId, text: 'Updated the parser.' },
    { kind: 'edit', turnId, text: '', changes: [{ path: 'parser.ts', operation: 'update' }] },
  ]
  transcript.update(0, initial)
  const card = requireElement(host, '.agent-thread-edit-summary', HTMLElement)
  const originalEdit = requireElement(host, '.agent-thread-tool-group', HTMLElement)
  transcript.update(initial.length, [
    { kind: 'user', turnId, text: 'Update the test, too.' },
    { kind: 'edit', turnId, text: '', changes: [{ path: 'parser.test.ts', operation: 'update' }] },
    { kind: 'assistant', turnId, text: 'Updated the test.' },
  ])
  assert(
    host.querySelector('.agent-thread-edit-summary') === card &&
      card.textContent.includes('Edited 2 files') &&
      card.previousElementSibling?.textContent.includes('Updated the test.') &&
      host.querySelectorAll('.agent-thread-tool-group').length === 2 &&
      host.querySelector('.agent-thread-tool-group') === originalEdit,
    'A live steer did not move and update the native turn’s file edits.',
  )
  transcript.update(initial.length, [])
  assert(
    host.querySelector('.agent-thread-edit-summary') === card &&
      card.textContent.includes('Edited 1 file') &&
      card.previousElementSibling === originalEdit &&
      host.querySelectorAll('.agent-thread-tool-group').length === 1,
    'Removing the steer did not restore the edit card to its earlier reply.',
  )
}

export async function run(longCommand: string, transcriptRoute: string) {
  checkLiveEdits()
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
  let memoryReads = 0
  let openedFile: AgentThreadFile | undefined
  const api: DiffpaneApi['agentThreads'] = {
    list: async () => {
      lists++
      return { threads: threads.map(thread => ({ ...thread })), unavailable: [] }
    },
    memory: () => {
      memoryReads++
      return bridge.memory()
    },
    children: (selection, parentId) => bridge.children(selection, parentId),
    read: async (id, selection, childId) => {
      assert(id === 'codex:1', 'The selected thread ID was sent to the source.')
      assert(!selectionId || selection === selectionId, 'Refreshing the conversation changed its selection.')
      if (childId) return bridge.read(id, selection, childId)
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
    update: async (id, selection, childId) => {
      assert(id === 'codex:1' && selection === selectionId, 'The live update lost its thread or selection.')
      if (childId) return bridge.update(id, selection, childId)
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
    clear: selection => {
      if (selectionId === selection) selectionId = ''
      return bridge.clear(selection)
    },
    file: (selection, path, childId, line) => bridge.file(selection, path, childId, line),
  }
  const panel = createAgentThreadPanel(host, {
    api,
    openWorkspaceFile: file => {
      openedFile = file
    },
    onVisibilityChange: open => {
      workspace.hidden = open
    },
  })

  try {
    panel.open()
    const rosterRows = requireElement(host, '[data-list-content]', HTMLDivElement)
    const memory = requireElement(host, '.agent-thread-memory', HTMLElement)
    await eventually(() => rosterRows.textContent.includes('Inspect the parser'), 'The thread roster did not load.')
    await eventually(() => memory.textContent.includes('Elevated'), 'The first memory pressure sample did not load.')
    assert(memory.textContent.includes('Windows app'), 'The memory pressure sample source is missing.')
    assert(memory.textContent.includes('8 GiB / 16 GiB used'), 'The system memory usage is missing.')
    const measurements = [...memory.querySelectorAll('.agent-thread-memory-resident')].map(row => row.textContent)
    assert(
      measurements.join('|') === '512 MiB resident · shared PID 1234|Shared PID 1234',
      'Shared process memory was not labeled and shown once per PID.',
    )
    assert(memory.textContent.includes('Check the parser fixture'), 'The latest recorded action is missing.')
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
    assert(
      !rosterRows.textContent.includes('Compare release notes'),
      'The project filter did not narrow the thread list.',
    )
    button(projects, 'marigold').click()
    assert(!rosterRows.textContent.includes('Inspect the parser'), 'Switching projects did not update the thread list.')
    button(projects, 'All projects').click()
    assert(rosterRows.textContent.includes('Inspect the parser'), 'All projects did not restore the thread list.')
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
    button(memory, 'Inspect the parser').click()
    await eventually(
      () => host.querySelector('.agent-thread-turn[data-role="assistant"]'),
      'The conversation did not load.',
    )
    await eventually(
      () => host.querySelector('[role="tablist"]')?.checkVisibility(),
      'The conversation did not discover its delegate tab.',
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
    const conversation = requireElement(host, '.agent-thread-conversation', HTMLElement)
    await eventually(
      () =>
        Boolean(host.querySelector('.agent-thread-minimap')?.checkVisibility()) ===
        conversation.scrollHeight > conversation.clientHeight + 1,
      'The thread map did not match the conversation’s scrollability.',
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
      'The tool activity was out of order relative to the surrounding thinking.',
    )
    const edits = requireElement(host, '.agent-thread-edit-summary', HTMLElement)
    assert(
      host.textContent.includes('Include the legacy fixture cleanup.') &&
        host.querySelectorAll('.agent-thread-edit-summary').length === 1 &&
        edits.textContent.includes('Edited 2 files') &&
        edits.textContent.includes('+3') &&
        edits.textContent.includes('−2') &&
        edits.textContent.includes('fixtures/legacy.txt') &&
        edits.previousElementSibling?.classList.contains('agent-thread-markdown'),
      'Edits across a steering message were not summarized together after the final reply.',
    )
    const editToggle = button(edits, 'Diff for docs/parser.md')
    assert(editToggle.getAttribute('aria-expanded') === 'false', 'The per-file diff was initially open.')
    editToggle.focus({ preventScroll: true })
    editToggle.click()
    const editDiff = requireElement(edits, '.agent-thread-edit-diff', HTMLElement)
    assert(
      editDiff.textContent.includes('-Old example') &&
        editDiff.textContent.includes('+Greeting example') &&
        editDiff.textContent.includes('+See the parser fixture.'),
      'The per-file diff did not show each recorded hunk.',
    )
    assert(
      editDiff.querySelector('[data-change="addition"]') && editDiff.querySelector('[data-change="deletion"]'),
      'The per-file diff did not distinguish added and deleted lines.',
    )
    assert(document.activeElement === editToggle, 'Opening the diff moved focus away from its control.')
    editToggle.click()
    assert(editDiff.hidden, 'The expanded diff could not be closed.')
    const deletedPath = button(edits, 'Diff for fixtures/legacy.txt')
    deletedPath.click()
    assert(
      edits.querySelector('.agent-thread-edit-diff:not([hidden])')?.textContent.includes('-Old fixture'),
      'The deleted file did not open its recorded diff.',
    )
    deletedPath.click()
    thinkingSummary.click()
    await eventually(
      () => firstThought.open && firstThought.querySelector('strong')?.textContent === 'greeting fixture',
      'Expanding thinking did not render its Markdown.',
    )
    const summary = requireElement(tools, '.agent-thread-tool-summary', HTMLElement)
    const activity = summary.textContent.toLowerCase()
    assert(
      !tools.open &&
        activity.includes('edited a file') &&
        activity.includes('read a file') &&
        activity.includes('ran a command'),
      'The collapsed tool group did not summarize its activity.',
    )
    summary.click()
    assert(tools.open, 'The tool call group could not be expanded.')
    await eventually(() => tools.querySelector('.agent-thread-tool-entry'), 'The open group did not display its calls.')
    const entries = [...tools.querySelectorAll('.agent-thread-tool-entry')]
    assert(
      entries.length === 4 &&
        entries[0]?.querySelector('.agent-thread-tool-name')?.textContent === 'Ran' &&
        entries[0]?.querySelector('.agent-thread-tool-preview')?.textContent.startsWith('cat fixtures/') &&
        entries[1]?.querySelector('.agent-thread-tool-name')?.textContent === 'Read' &&
        entries[1]?.textContent.includes('greeting.txt') &&
        entries[2]?.textContent.includes('WebSearch') &&
        entries[2]?.textContent.includes('Look up the parser contract') &&
        entries[3]?.querySelector('.agent-thread-tool-name')?.textContent === 'Edited' &&
        entries[3]?.querySelector('.agent-thread-edit-path')?.textContent === 'parser.md' &&
        entries[3]?.textContent.includes('+2') &&
        entries[3]?.textContent.includes('−1'),
      'The expanded activity did not show each action in transcript order.',
    )
    const timelinePath = button(tools, 'Diff for parser.md')
    assert(timelinePath.getAttribute('aria-expanded') === 'false', 'The timeline diff was initially open.')
    timelinePath.click()
    const timelineDiff = requireElement(tools, '.agent-thread-edit-diff', HTMLElement)
    assert(
      timelineDiff.textContent.includes('-Old example') &&
        timelineDiff.textContent.includes('+Greeting example') &&
        !timelineDiff.textContent.includes('See the parser fixture.'),
      'Clicking the timeline filename did not display the diff for that edit.',
    )
    timelinePath.click()
    assert(timelineDiff.hidden && tools.open, 'Closing the diff did not preserve the expanded activity list.')
    const raw = requireElement(tools, '.agent-thread-tool-detail', HTMLDetailsElement)
    assert(!raw.open, 'Opening the tool group exposed raw command details.')
    const rowSummary = requireElement(raw, ':scope > summary', HTMLElement)
    assert(
      rowSummary.querySelector('.agent-thread-tool-preview')?.textContent.startsWith('cat fixtures/'),
      'The command was missing from its disclosure.',
    )
    rowSummary.scrollIntoView({ block: 'center' })
    await new Promise<void>(resolve => {
      window.requestAnimationFrame(() => resolve())
    })
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
      `Opening the command moved its tool row or focus (top ${top} → ${openedBounds.top}, width ${width} → ${openedBounds.width}).`,
    )
    rowSummary.click()
    assert(!raw.open && tools.open, 'Closing a tool row also closed the tool group.')
    assert(
      button(tools, 'greeting.txt').title === '/projects/juniper/fixtures/greeting.txt',
      'The tool file reference lost its path.',
    )

    await eventually(
      () => memoryReads >= 2 && memory.textContent.includes('Add a parser example'),
      'Agent activity did not update.',
    )
    assert(memory.querySelectorAll('.agent-thread-memory-tick').length >= 2, 'Pressure history is missing samples.')
    const conversationPressure = requireElement(host, '[data-memory-detail]', HTMLElement)
    assert(conversationPressure.checkVisibility(), 'Memory pressure went away when opening the conversation.')
    assert(conversationPressure.textContent.includes('Normal'), 'The conversation memory indicator did not update.')
    assert(
      lists === 1 && reads === 1 && updates >= 1 && firstPrompt.isConnected,
      'Live checks should leave the roster and unchanged transcript in place.',
    )

    timelinePath.focus({ preventScroll: true })
    timelinePath.click()
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
      document.activeElement === timelinePath && !timelineDiff.hidden,
      'The live update interrupted the focused filename or open diff.',
    )
    timelinePath.click()

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
    const inline = requireElement(host, 'img[alt="Inline diagram"]', HTMLImageElement)
    const generated = requireElement(host, 'img[alt="Generated diagram"]', HTMLImageElement)
    await eventually(
      () => inline.naturalWidth === 2 && generated.naturalWidth === 2,
      'The reply images did not decode.',
    )
    assert(
      inline.previousElementSibling?.textContent === 'Before' && inline.nextElementSibling?.textContent === 'after',
      'The Markdown image left its original position in the reply.',
    )
    assert(
      generated.parentElement?.previousElementSibling === inline.closest('.agent-thread-markdown'),
      'The generated image was not placed after its reply.',
    )
    const diagramLink = button(host, 'Open diagram')
    assert(diagramLink.title.endsWith('/Example diagram.png'), 'The linked image lost its file path.')

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

    const delegate = button(conversation, 'Message from Euler')
    assert(
      delegate.closest('.agent-thread-delegate')?.textContent.includes('I checked the parser example.'),
      'Saved subagent communication was missing from the parent timeline.',
    )
    const parentScroll = conversation.scrollTop
    delegate.click()
    const tabs = requireElement(host, '[role="tablist"][aria-label="Conversation and subagents"]', HTMLElement)
    await eventually(
      () => host.textContent.includes('The delegate finished checking the example.'),
      'The delegate transcript did not open.',
    )
    assert(
      tabs.querySelector('[role="tab"][aria-selected="true"]')?.textContent.includes('Euler'),
      'The delegate tab was not selected.',
    )
    const childConversation = [...host.querySelectorAll<HTMLElement>('.agent-thread-conversation')].find(element =>
      element.checkVisibility(),
    )
    assert(childConversation, 'The delegate conversation was not visible.')
    const childTools = requireElement(childConversation, '.agent-thread-tool-group', HTMLDetailsElement)
    requireElement(childTools, '.agent-thread-tool-summary', HTMLElement).click()
    await eventually(
      () => childTools.querySelector('.agent-thread-edit-path'),
      'The delegate’s native file change was missing.',
    )
    button(childTools, 'Diff for delegate-edit.txt').click()
    assert(
      childTools.querySelector('.agent-thread-edit-diff')?.textContent.includes('+Delegate edit contents.'),
      'The delegate’s edit did not open its diff.',
    )
    const parent = tabs.querySelector('[role="tab"]')
    assert(
      parent instanceof HTMLElement && parent.textContent.includes('Main thread'),
      'The main-thread tab was missing.',
    )
    parent.click()
    await eventually(
      () => conversation.checkVisibility() && firstPrompt.isConnected,
      'Returning from the subagent replaced the main transcript.',
    )
    assert(
      Math.abs(conversation.scrollTop - parentScroll) <= 1 && firstThought.open,
      'Switching tabs lost the parent scroll or disclosure state.',
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

    assert(
      updates === updatesBeforeLeaving && !conversation.textContent.trim(),
      'The conversation updated after returning to the thread list.',
    )
    requireElement(host, '[data-source="codex"]', HTMLElement).click()
    button(host, 'Recheck the parser').click()
    await eventually(() => host.querySelector('[role="tablist"]')?.checkVisibility(), 'Delegate tabs did not return.')
    button(host, 'Euler').click()
    await eventually(
      () => conversation.textContent.includes('The delegate finished checking the example.'),
      'The delegate transcript did not reopen.',
    )
    const reopenedTools = requireElement(conversation, '.agent-thread-tool-group', HTMLDetailsElement)
    requireElement(reopenedTools, '.agent-thread-tool-summary', HTMLElement).click()
    await eventually(() => reopenedTools.querySelector('.agent-thread-tool-entry'), 'The delegate tools did not open.')
    button(reopenedTools, 'delegate.txt:4').click()
    await eventually(
      () => openedFile?.path === 'delegate.txt' && openedFile.line === 4,
      'The delegate’s read link did not open the workspace at its recorded location.',
    )
    assert(host.hidden && !workspace.hidden, 'File navigation did not restore the workspace.')
    assert(!host.querySelector('[data-preview], dialog[open]'), 'File navigation opened a thread preview.')
    const readsAtClose = memoryReads
    await delay(2_150)
    assert(memoryReads === readsAtClose, 'Memory polling continued after Agent Threads closed.')
  } finally {
    lateUpdate.resolve()
    panel.dispose()
  }
}
