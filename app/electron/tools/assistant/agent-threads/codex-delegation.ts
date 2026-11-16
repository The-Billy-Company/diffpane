import type { AgentThreadEvent } from '../../../../shared/agent-threads.ts'

type Delegation = NonNullable<AgentThreadEvent['delegation']>
type Action = Delegation['action']

interface Intent {
  action: Action
  target: string
  text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function messageBody(value: unknown) {
  const text = string(value).trim()
  // Codex persists recent inter-agent tool arguments as Fernet tokens.
  return /^gAAAAA[a-z0-9_-]{90,}={0,2}$/i.test(text) ? '' : text.slice(0, 48 * 1024)
}

function actionForTool(value: unknown): Action | undefined {
  switch (string(value).toLowerCase().replaceAll('_', '')) {
    case 'spawnagent':
      return 'spawn'
    case 'sendinput':
    case 'sendmessage':
    case 'followuptask':
      return 'message'
    case 'resumeagent':
      return 'resume'
    case 'closeagent':
      return 'close'
    case 'wait':
    case 'waitagent':
      return 'wait'
    default:
      return undefined
  }
}

function event(
  id: string,
  action: Action,
  text: string,
  name?: string,
  direction?: Delegation['direction'],
): AgentThreadEvent {
  return {
    kind: 'delegate',
    text,
    delegation: {
      threadId: `codex:${id}`,
      action,
      ...(name ? { name } : {}),
      ...(direction ? { direction } : {}),
    },
  }
}

function agentName(agentPath: string): string | undefined {
  return agentPath === '/root' ? 'Parent conversation' : agentPath.split('/').at(-1)
}

export function codexSpawnMetadata(value: unknown) {
  return record(record(record(value)?.subagent)?.thread_spawn)
}

export function codexDelegation(threadId: string) {
  const paths = new Map<string, string>()
  const intents = new Map<string, Intent>()
  let localPath = '/root'
  let historyStart = 0

  function initialize(metadata: Record<string, unknown>) {
    const spawn = codexSpawnMetadata(metadata.source)
    const parent = string(metadata.parent_thread_id) || string(spawn?.parent_thread_id)
    if (!parent) return
    localPath = string(metadata.agent_path) || string(spawn?.agent_path) || localPath
    const parentPath = localPath.slice(0, localPath.lastIndexOf('/'))
    if (parentPath) paths.set(parentPath, parent)
    const start = metadata.subagent_history_start_ordinal
    if (typeof start === 'number' && Number.isSafeInteger(start) && start > 0) historyStart = start
  }

  function matchesIntent(intent: Intent, id: string, peer: string, action: Action) {
    return (
      (intent.target === id || intent.target === peer || `${localPath}/${intent.target}` === peer) &&
      (action !== 'spawn' || intent.action === 'spawn')
    )
  }

  function nativeActivity(item: Record<string, unknown>): AgentThreadEvent[] {
    const id = string(item.agent_thread_id)
    const peer = string(item.agent_path)
    if (!id || id === threadId) return []
    if (peer) paths.set(peer, id)
    switch (item.kind) {
      case 'started': {
        const intent = [...intents.values()].findLast(value => matchesIntent(value, id, peer, 'spawn'))
        return [event(id, 'spawn', intent?.text ?? '', agentName(peer))]
      }
      case 'interacted': {
        const intent = [...intents.values()].findLast(value => matchesIntent(value, id, peer, 'message'))
        return [
          event(id, intent?.action ?? 'message', intent?.text ?? '', agentName(peer), intent ? 'sent' : undefined),
        ]
      }
      case 'completed':
        return [event(id, 'result', '', agentName(peer))]
      default:
        return []
    }
  }

  function legacyActivity(item: Record<string, unknown>): AgentThreadEvent[] {
    if (item.status !== 'completed') return []
    const action = actionForTool(item.tool)
    if (!action) return []
    const receivers = Array.isArray(item.receiver_agents) ? item.receiver_agents.map(record) : []
    const ids = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.map(string) : []
    const names = new Map<string, string>()
    for (const receiver of receivers) {
      const id = string(receiver?.thread_id) || string(receiver?.threadId)
      const name = string(receiver?.agent_nickname) || string(receiver?.agentNickname)
      if (id) {
        ids.push(id)
        if (name) names.set(id, name)
      }
    }
    return [...new Set(ids)].flatMap(id => {
      if (!id || id === threadId) return []
      return [event(id, action, messageBody(item.prompt), names.get(id), action === 'message' ? 'sent' : undefined)]
    })
  }

  function message(payload: Record<string, unknown>): AgentThreadEvent[] {
    const author = string(payload.author)
    const recipient = string(payload.recipient)
    const direction = author === localPath ? 'sent' : recipient === localPath ? 'received' : undefined
    if (!direction) return []
    const peer = direction === 'sent' ? recipient : author
    const id = paths.get(peer)
    if (!id || id === threadId) return []
    const parts = Array.isArray(payload.content) ? payload.content.map(record) : []
    const stored = parts
      .flatMap(part => (part?.type === 'input_text' || part?.type === 'output_text' ? [string(part.text)] : []))
      .join('\n')
      .trim()
    const envelope = /^Message Type: ([A-Z_]+)\r?\nTask name: [^\r\n]+\r?\nSender: [^\r\n]+\r?\nPayload:\s*/.exec(
      stored,
    )
    const text = parts.some(part => part?.type === 'encrypted_content')
      ? ''
      : messageBody(stored.slice(envelope?.[0].length ?? 0))
    return [event(id, envelope?.[1] === 'FINAL_ANSWER' ? 'result' : 'message', text, agentName(peer), direction)]
  }

  return {
    ignore(entry: Record<string, unknown> | undefined, ordinal: number) {
      if (ordinal === 0 && entry?.type === 'session_meta') {
        const metadata = record(entry.payload)
        if (metadata) initialize(metadata)
      }
      return ordinal < historyStart
    },
    parse(entry: Record<string, unknown> | undefined, payload: Record<string, unknown>): AgentThreadEvent[] {
      if (entry?.type === 'event_msg' && payload.type === 'item_completed') {
        const item = record(payload.item)
        if (item?.type === 'SubAgentActivity') return nativeActivity(item)
        if (item?.type === 'CollabAgentToolCall') return legacyActivity(item)
      }
      if (entry?.type !== 'response_item') return []
      if (payload.type === 'agent_message') return message(payload)
      const id = string(payload.call_id)
      if (!id) return []
      if (payload.type === 'function_call_output') intents.delete(id)
      if (payload.type === 'function_call') {
        const action = actionForTool(payload.name)
        if (!action) return []
        let args: Record<string, unknown> | undefined
        try {
          args = record(JSON.parse(string(payload.arguments)))
        } catch {
          return []
        }
        const target = string(args?.target) || string(args?.task_name) || string(args?.id)
        if (target && intents.size < 100) intents.set(id, { action, target, text: messageBody(args?.message) })
      }
      return []
    },
  }
}
