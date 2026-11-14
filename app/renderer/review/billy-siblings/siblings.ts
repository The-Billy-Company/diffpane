import type { BillySiblingExcerpt, BillySiblingMatch, BillySiblingResult } from '../../../shared/billy/siblings.ts'
import { serializeAppError } from '../../../shared/recovery/app-errors.ts'
import { runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import './siblings.css'

interface Selection {
  readonly path: string
  readonly line: number | null
  readonly changedPaths: readonly string[]
}

interface Options {
  load: (path: string, line: number) => Promise<BillySiblingResult>
  onOpen: (path: string, line: number) => unknown
}

type State = { kind: 'select' | 'reading' } | { kind: 'failed'; message: string } | BillySiblingResult

const grades: Record<BillySiblingMatch['grade'], string> = {
  identical: 'Near-identical',
  strong: 'Strong match',
  moderate: 'Moderate match',
}

function filename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function createBillySiblings(host: HTMLElement, { load, onOpen }: Options) {
  host.classList.add('billy-siblings')
  host.innerHTML = `
    <div class="billy-siblings-heading">
      <p class="billy-siblings-status" role="status"></p>
      <label class="billy-siblings-match" hidden>Suggestion
        <select aria-label="Sibling suggestion"></select>
      </label>
    </div>
    <div class="billy-siblings-pair" hidden></div>
    <button class="billy-siblings-retry" type="button" hidden>Try again</button>`
  const status = requireElement(host, '.billy-siblings-status', HTMLParagraphElement)
  const pickerLabel = requireElement(host, '.billy-siblings-match', HTMLLabelElement)
  const picker = requireElement(host, 'select', HTMLSelectElement)
  const pair = requireElement(host, '.billy-siblings-pair', HTMLDivElement)
  const retry = requireElement(host, '.billy-siblings-retry', HTMLButtonElement)

  let selection: Selection | null = null
  let selected = 0
  let generation = 0
  let state: State = { kind: 'select' }

  function panel(label: string, item: BillySiblingExcerpt, detail = '') {
    const section = document.createElement('section')
    section.className = 'billy-siblings-excerpt'
    section.setAttribute('aria-label', label)
    const meta = document.createElement('div')
    meta.className = 'billy-siblings-meta'
    const location = document.createElement('button')
    location.type = 'button'
    location.textContent = `${filename(item.path)}:${item.line}`
    location.setAttribute('aria-label', `Open ${item.path} at line ${item.line}`)
    location.title = item.path
    location.addEventListener('click', () => runTask('Open function source', () => onOpen(item.path, item.line)))
    const descriptor = document.createElement('span')
    descriptor.textContent = [
      label,
      detail,
      selection?.changedPaths.includes(item.path) ? 'File in diff' : 'File outside diff',
    ]
      .filter(Boolean)
      .join(' · ')
    meta.append(location, descriptor)
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = item.text ?? 'Excerpt unavailable'
    pre.append(code)
    section.append(meta, pre)
    return section
  }

  function renderPair() {
    if (state.kind !== 'ready') {
      pair.hidden = true
      pair.replaceChildren()
      return
    }
    pair.hidden = false
    const candidate = state.candidates[selected]
    pair.replaceChildren(
      panel('Selected function', state.source),
      ...(candidate ? [panel('Suggested sibling', candidate, grades[candidate.grade])] : []),
    )
  }

  function render() {
    pickerLabel.hidden = true
    retry.hidden = true
    switch (state.kind) {
      case 'select':
        status.textContent = 'Select a line inside a function to compare nearby implementations.'
        break
      case 'reading':
        status.textContent = 'Finding nearby functions…'
        break
      case 'failed':
        status.textContent = state.message
        retry.hidden = false
        break
      case 'no-function':
        status.textContent = 'Relate found no function at this line.'
        break
      case 'ready': {
        const count = state.candidates.length
        status.textContent = count
          ? `${count} possible ${count === 1 ? 'sibling' : 'siblings'} in ${state.scope}`
          : `No close matches in ${state.scope}`
        if (count > 1) {
          picker.replaceChildren(
            ...state.candidates.map(({ path, line }, index) => {
              const option = new Option(`${filename(path)}:${line}`, String(index))
              option.title = path
              return option
            }),
          )
          picker.value = String(selected)
          pickerLabel.hidden = false
        }
        break
      }
    }
    renderPair()
  }

  async function compare() {
    const request = ++generation
    if (!selection || selection.line === null) {
      state = { kind: 'select' }
      render()
      return
    }
    state = { kind: 'reading' }
    render()
    const { path, line } = selection
    try {
      const result = await load(path, line)
      if (request !== generation) return
      state = result
      selected = 0
    } catch (error) {
      if (request !== generation) return
      state = { kind: 'failed', message: serializeAppError(error).message }
    }
    render()
  }

  picker.addEventListener('change', () => {
    selected = Number(picker.value)
    renderPair()
  })
  function startComparison() {
    runTask('Compare sibling functions', compare)
  }

  retry.addEventListener('click', startComparison)

  return {
    update(next: Selection | null) {
      const sameFunction = selection?.path === next?.path && selection?.line === next?.line
      if (sameFunction && selection?.changedPaths === next?.changedPaths) return
      selection = next
      if (sameFunction) renderPair()
      else startComparison()
    },
    dispose() {
      generation++
      host.replaceChildren()
    },
  }
}
