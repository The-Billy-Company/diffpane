import type {
  BillyReplayCall,
  BillyReplayCase,
  BillyReplayModel,
  BillyReplayText,
  BillyReplayTurn,
} from '../../../shared/billy/replay.ts'

export interface ReplayDifference {
  turn: number
  observations: string[]
}

function differs<T>(left: T | null, right: T | null) {
  return left !== null && right !== null && JSON.stringify(left) !== JSON.stringify(right)
}

function textChanged(left: BillyReplayText | null, right: BillyReplayText | null) {
  return differs(left?.hash ?? null, right?.hash ?? null)
}

function modelChanges(left: BillyReplayModel, right: BillyReplayModel) {
  const a = left.composition
  const b = right.composition
  return {
    model:
      differs(left.model, right.model) || differs(left.provider, right.provider) || differs(left.agent, right.agent),
    playbooks: differs(a?.playbooks?.toSorted() ?? null, b?.playbooks?.toSorted() ?? null),
    tools:
      differs(a?.toolSchemaHash ?? null, b?.toolSchemaHash ?? null) ||
      differs(a?.toolCount ?? null, b?.toolCount ?? null),
    prompt:
      differs(a?.identityHash ?? null, b?.identityHash ?? null) || differs(a?.variant ?? null, b?.variant ?? null),
    context: differs(
      a?.context?.toSorted((x, y) => x.id.localeCompare(y.id)) ?? null,
      b?.context?.toSorted((x, y) => x.id.localeCompare(y.id)) ?? null,
    ),
  }
}

function callChanged(left: BillyReplayCall, right: BillyReplayCall) {
  return (
    left.name !== right.name ||
    differs(left.agent, right.agent) ||
    textChanged(left.args, right.args) ||
    textChanged(left.result, right.result) ||
    (left.status !== 'unknown' && right.status !== 'unknown' && left.status !== right.status)
  )
}

function observeTurn(left: BillyReplayTurn, right: BillyReplayTurn) {
  if (textChanged(left.user, right.user)) return ['User input differs']
  const observations: string[] = []
  const calls = left.calls
  const pairedCalls = right.calls
  if (calls && pairedCalls) {
    if (calls.length !== pairedCalls.length) observations.push('Tool call count changed')
    else if (
      calls.some((call, index) => {
        const paired = pairedCalls[index]
        return paired !== undefined && callChanged(call, paired)
      })
    )
      observations.push('A tool, its input, or its recorded outcome changed')
  }
  const models = left.models
  const pairedModels = right.models
  if (models && pairedModels) {
    if (models.length !== pairedModels.length) observations.push('Model call count changed')
    const changes = models.flatMap((model, index) => {
      const paired = pairedModels[index]
      return paired ? [modelChanges(model, paired)] : []
    })
    if (changes.some(change => change.model)) observations.push('Model, provider, or agent changed')
    if (changes.some(change => change.playbooks)) observations.push('Loaded playbooks changed')
    if (changes.some(change => change.tools)) observations.push('Bound tool roster or schema changed')
    if (changes.some(change => change.prompt)) observations.push('Prompt fingerprint or variant changed')
    if (changes.some(change => change.context)) observations.push('Context block token counts changed')
  }
  if (textChanged(left.reply, right.reply)) observations.push('Assistant reply changed')
  return observations
}

export function compareReplayCases(left: BillyReplayCase, right: BillyReplayCase): ReplayDifference | null {
  const longest = Math.max(left.turns.length, right.turns.length)
  for (let index = 0; index < longest; index += 1) {
    const a = left.turns[index]
    const b = right.turns[index]
    if (!a || !b) return { turn: index + 1, observations: ['Turn retained on one side only'] }
    const observations = observeTurn(a, b)
    if (observations.length) return { turn: index + 1, observations }
  }
  return null
}
