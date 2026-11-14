import type {
  BillyReplayCall,
  BillyReplayModel,
  BillyReplayText,
  BillyReplayTurn,
} from '../../../shared/billy/replay.ts'

export function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, text?: string) {
  const result = document.createElement(tag)
  result.className = className
  if (text !== undefined) result.textContent = text
  return result
}

function preview(capture: BillyReplayText) {
  const value = !capture.preview ? 'Empty' : capture.preview + (capture.truncated ? '\n… Preview clipped' : '')
  return element('pre', 'billy-replay-preview', value)
}

function disclosure(label: string) {
  const folds = element('details', 'billy-replay-detail')
  folds.append(element('summary', '', label))
  return folds
}

function evidence(name: string, capture: BillyReplayText | null) {
  const value = disclosure(name)
  value.append(capture ? preview(capture) : element('p', 'billy-replay-muted', 'Unavailable'))
  return value
}

function row(list: HTMLDListElement, name: string, value: string | number | null) {
  list.append(element('dt', '', name), element('dd', '', value === null ? 'Unavailable' : String(value)))
}

function modelDetail(call: BillyReplayModel, index: number, playbook: string | null) {
  const detail = disclosure([call.agent, call.model].filter(Boolean).join(' · ') || `Model call ${index + 1}`)
  const data = element('dl', 'billy-replay-metadata')
  row(data, 'Provider', call.provider)
  row(data, 'Model', call.model)
  const c = call.composition
  if (!c) {
    detail.append(data, element('p', 'billy-replay-muted', 'Prompt composition unavailable'))
    return detail
  }
  row(data, 'Prompt', c.variant)
  row(data, 'Prompt fingerprint', c.identityHash)
  row(data, 'Prompt tokens', c.identityTokens)
  row(data, 'Bound tools', c.toolCount)
  row(data, 'Tool schema', c.toolSchemaHash)
  row(data, 'Tool tokens', c.toolTokens)
  row(data, 'History tokens', c.historyTokens)
  row(
    data,
    'Cache read / write',
    c.cacheReadTokens === null && c.cacheWriteTokens === null
      ? null
      : `${c.cacheReadTokens ?? 'Unknown'} / ${c.cacheWriteTokens ?? 'Unknown'}`,
  )
  row(data, 'Loaded playbooks', c.playbooks?.length ? c.playbooks.join(', ') : c.playbooks ? 'None' : null)
  if (playbook && c.playbooks?.includes(playbook)) row(data, 'Current playbook', `Recorded · ${playbook}`)
  const contexts = c.context?.map(block => `${block.id} ${block.tokens}`)
  row(data, 'Context block tokens', contexts?.length ? contexts.join(', ') : contexts ? 'None' : null)
  detail.append(data)
  return detail
}

function toolDetail(call: BillyReplayCall) {
  const label = `${call.name}${call.agent ? ` · ${call.agent}` : ''} · ${call.status === 'unknown' ? 'Status unavailable' : call.status}`
  const detail = disclosure(label)
  detail.append(evidence('Input', call.args), evidence('Recorded result', call.result))
  return detail
}

export function turnDetail(label: string, turn: BillyReplayTurn | undefined, playbook: string | null) {
  const side = element('section', 'billy-replay-side')
  side.append(element('h3', '', label))
  if (!turn) {
    side.append(element('p', 'billy-replay-muted', 'Turn unavailable'))
    return side
  }
  const user = evidence('User input', turn.user)
  const reply = evidence('Assistant reply', turn.reply)
  const tools = disclosure(turn.calls ? `Tool calls · ${turn.calls.length}` : 'Tool calls · unavailable')
  const models = disclosure(turn.models ? `Model inputs · ${turn.models.length}` : 'Model inputs · unavailable')
  if (turn.calls?.length) tools.append(...turn.calls.map(toolDetail))
  else
    tools.append(
      element('p', 'billy-replay-muted', turn.calls ? 'No tool calls recorded' : 'Tool evidence unavailable'),
    )
  if (turn.models?.length) models.append(...turn.models.map((model, index) => modelDetail(model, index, playbook)))
  else models.append(element('p', 'billy-replay-muted', 'Model evidence unavailable'))
  tools.open = Boolean(turn.calls?.length)
  models.open = Boolean(turn.models?.length)
  side.append(user, models, tools, reply)
  return side
}
