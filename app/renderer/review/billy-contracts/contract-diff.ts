// Copyright (c) 2026 The Billy Company
import type {
  BillyContractDiff,
  BillyContractFile,
  BillyContractGroup,
  BillyContractRequest,
} from '../../../shared/billy/contracts.ts'
import { createBillyStatusArt } from '../billy/status-art.ts'

import './contract-diff.css'

interface Options {
  load: (input: BillyContractRequest) => Promise<BillyContractDiff>
  onOpen: (path: string, line?: number) => void
}

function paragraph(text: string) {
  const element = document.createElement('p')
  element.className = 'billy-contract-summary'
  element.textContent = text
  return element
}

function fileList(label: string, files: readonly BillyContractFile[], selected: string, onOpen: Options['onOpen']) {
  const group = document.createElement('div')
  group.className = 'billy-contract-file-group'
  const title = paragraph(label)
  const list = document.createElement('ul')
  for (const file of files) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.className = 'billy-contract-file'
    button.type = 'button'
    button.title = file.path
    if (file.path === selected) button.setAttribute('aria-current', 'true')

    const name = document.createElement('span')
    name.className = 'billy-contract-path'
    name.textContent = file.path

    const flags = document.createElement('span')
    flags.className = 'billy-contract-flags'
    const values = [
      file.changed ? 'In diff' : 'Outside diff',
      ...(file.shared ? ['Shared file'] : []),
      ...(file.confidence === 'header' ? ['Source header'] : []),
      ...(file.confidence === 'candidate' ? ['Possible match'] : []),
    ]
    flags.textContent = values.join(' · ')
    if (file.confidence === 'candidate') flags.dataset.uncertain = ''

    button.append(name, flags)
    button.addEventListener('click', () => onOpen(file.path))
    item.append(button)
    for (const section of file.sections ?? []) {
      const jump = document.createElement('button')
      jump.type = 'button'
      jump.className = 'billy-contract-section'
      jump.textContent = `${section.name} · lines ${section.start}–${section.end}`
      jump.title = `${file.path}:${section.start}`
      jump.addEventListener('click', () => onOpen(file.path, section.start))
      item.append(jump)
    }
    list.append(item)
  }
  group.append(title, list)
  return group
}

function buildGroup(group: BillyContractGroup, selected: string, open: boolean, onOpen: Options['onOpen']) {
  const disclosure = document.createElement('details')
  disclosure.className = 'billy-contract-group'
  disclosure.open = open

  const summary = document.createElement('summary')
  const name = document.createElement('strong')
  name.textContent = group.sourceKind === 'protobuf' ? 'Protocol buffers' : group.id
  const scope = document.createElement('span')
  scope.className = 'billy-contract-group-count'
  const count = group.outputs.filter(output => output.changed).length
  scope.textContent = `${count} changed ${count === 1 ? 'projection' : 'projections'}`
  summary.append(name, scope)
  disclosure.append(summary)

  const sources = [...group.sources].toSorted((left, right) => {
    return (
      Number(right.path === selected) - Number(left.path === selected) || Number(right.changed) - Number(left.changed)
    )
  })
  if (sources.length)
    disclosure.append(
      fileList(group.sourceKind === 'protobuf' ? 'Source schema' : 'Declared inputs', sources, selected, onOpen),
    )
  if (group.outputs.length) disclosure.append(fileList('Related projections', group.outputs, selected, onOpen))
  else disclosure.append(paragraph('No related projections in this comparison.'))
  return disclosure
}

export function createBillyContractDiff(container: HTMLElement, { load, onOpen }: Options) {
  container.classList.add('billy-contract-diff')
  let version = 0
  let previous: BillyContractRequest | null = null

  function render(result: BillyContractDiff, path: string) {
    const groups = result.groups.map((group, index) => buildGroup(group, path, index === 0, onOpen))
    const content: HTMLElement[] = [...groups]
    if (!groups.length) {
      const empty = paragraph('No related contract was found for this file.')
      empty.prepend(createBillyStatusArt('contract'))
      content.push(empty)
    }
    if (result.limited)
      content.push(paragraph('Only part of this comparison could be checked for contract relationships.'))
    container.replaceChildren(
      ...content,
      ...(groups.length ? [paragraph('Relationships come from the current workspace.')] : []),
    )
  }

  function unavailable(request: number) {
    if (request !== version) return
    const message = paragraph('Contract relationships are unavailable in this workspace.')
    message.role = 'status'
    container.replaceChildren(message)
    previous = null
  }

  return {
    update(input: BillyContractRequest | null) {
      if (
        input?.path === previous?.path &&
        input?.changedPaths.length === previous?.changedPaths.length &&
        input?.changedPaths.every((path, index) => previous?.changedPaths[index] === path)
      ) {
        return
      }
      previous = input
      const request = ++version
      container.replaceChildren()
      if (!input) return
      const loading = paragraph('Reading contract relationships…')
      loading.role = 'status'
      container.append(loading)
      load(input)
        .then(result => {
          if (request === version) render(result, input.path)
          return undefined
        })
        .catch(() => unavailable(request))
    },
    dispose() {
      version++
      previous = null
      container.replaceChildren()
    },
  }
}
