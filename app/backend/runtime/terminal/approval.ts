import { hostRequest, reportHostError } from '../../../desktop/host/desktop.ts'

interface Prompt {
  title: string
  message: string
  detail: string
  approve: string
}

let nextPrompt = 0

export async function confirmTerminal(owner: string, prompt: Prompt, signal: AbortSignal) {
  if (signal.aborted) return false
  const id = ++nextPrompt
  const aborted = Promise.withResolvers<false>()
  const cancel = () => {
    aborted.resolve(false)
    void hostRequest('terminal.cancel-confirmation', owner, id).catch(reportHostError)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const approved = await Promise.race([hostRequest('terminal.confirm', owner, id, prompt), aborted.promise])
    return approved === true && !signal.aborted
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
