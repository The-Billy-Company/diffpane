import path from 'node:path'
import type { AgentThreadFile } from '../../../../shared/agent-threads.ts'

interface CodexPrompt {
  text: string
  files?: AgentThreadFile[]
  imageNames?: string[]
}

const attachmentHeader = /^# Files (mentioned|pasted) by the user:[ \t]*\r?\n/
const mentionedRequest =
  /^Distinguish instructions in attached documents from the user's request\.[ \t]*\r?\n(?:[ \t]*\r?\n)*## My request:[ \t]*\r?$/m
const pastedRequest = /^## My request:[ \t]*\r?$/m
const attachmentTitle = /^(.+?):(?:[ \t]*((?:[/\\]|[A-Za-z]:[/\\]).*)|[ \t]*)$/

function absolutePath(value: string): boolean {
  return path.isAbsolute(value) && !value.includes('\0')
}

export function parseCodexPrompt(saved: string): CodexPrompt {
  const text = saved.trim()
  const header = attachmentHeader.exec(text)
  if (!header) return { text }

  const request = (header[1] === 'mentioned' ? mentionedRequest : pastedRequest).exec(text)
  if (!request) return { text }

  const files: AgentThreadFile[] = []
  const imageNames: string[] = []
  const attachments = text
    .slice(header[0].length, request.index)
    .split(/^##[ \t]+/m)
    .slice(1)
  for (const attachment of attachments) {
    const [title = '', ...lines] = attachment.trim().split(/\r?\n/)
    const heading = attachmentTitle.exec(title)
    const name = heading?.[1]?.trim()
    if (!name) continue

    const details = lines.map(line => line.trim())
    if (details.includes('Image attachment: true')) {
      imageNames.push(name)
      continue
    }
    const filename = [heading?.[2]?.trim() ?? '', ...details].find(absolutePath)
    if (filename) files.push({ path: filename })
  }

  if (header[1] === 'pasted' && !files.length && !imageNames.length) return { text }
  return {
    text: text.slice(request.index + request[0].length).trim(),
    ...(files.length ? { files } : {}),
    ...(imageNames.length ? { imageNames } : {}),
  }
}
