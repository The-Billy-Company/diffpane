// Copyright (c) 2026 The Billy Company
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked } from 'marked'
import type { AgentThreadLink } from '../../../../shared/agent-threads.ts'
import { mediaType } from '../../../../shared/documents/media-types.ts'

const markdown = new Marked({ gfm: true })
const MAX_LOCAL_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_MESSAGE_LINKS = 100

export function rasterImageType(filename: string): string | undefined {
  const type = mediaType(filename)
  return type?.startsWith('image/') && type !== 'image/svg+xml' ? type : undefined
}

export async function localImageUrl(filename: string, remaining = Infinity): Promise<string | undefined> {
  const type = rasterImageType(filename)
  if (!type || !path.isAbsolute(filename)) return undefined
  const prefix = `data:${type};base64,`
  if (remaining <= prefix.length) return undefined
  try {
    const absolute = await realpath(filename)
    if (absolute.split(path.sep).includes('.git')) return undefined
    const file = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      const encodedSize = Math.ceil(info.size / 3) * 4 + prefix.length
      if (!info.isFile() || !info.size || info.size > MAX_LOCAL_IMAGE_BYTES || encodedSize > remaining) return undefined
      const buffer = Buffer.allocUnsafe(info.size)
      const { bytesRead } = await file.read(buffer)
      return bytesRead === info.size ? prefix + buffer.toString('base64') : undefined
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
}

function localLink(href: string): AgentThreadLink | undefined {
  const [location = '', fragment] = href.split('#', 2)
  const target = location.split('?', 1)[0] ?? ''
  if (!target || target.startsWith('//')) return undefined
  let filename: string
  try {
    if (/^file:/i.test(target)) filename = fileURLToPath(target)
    else {
      filename = decodeURIComponent(target)
      if (/^[a-z][a-z\d+.-]*:/i.test(filename) && !path.isAbsolute(filename)) return undefined
    }
  } catch {
    return undefined
  }
  // oxlint-disable-next-line no-control-regex -- Reject control characters in file links.
  if (!filename || /[\u0000-\u001f]/.test(filename)) return undefined
  const position = Number(/^L([1-9]\d*)(?:-L?[1-9]\d*)?$/i.exec(fragment ?? '')?.[1])
  return {
    href,
    path: filename,
    ...(Number.isSafeInteger(position) ? { line: position } : {}),
    ...(rasterImageType(filename) ? { image: true } : {}),
  }
}

export function localMarkdownLinks(text: string) {
  const links = new Map<string, { link: AgentThreadLink; inline: boolean }>()
  if (!text.includes('[')) return links.values()
  const tokens = markdown.lexer(text)
  // oxlint-disable-next-line typescript/no-floating-promises -- This token visitor runs synchronously and returns no promises.
  markdown.walkTokens(tokens, token => {
    if (token.type !== 'link' && token.type !== 'image') return
    const href: unknown = token.href
    if (typeof href !== 'string') return
    const found = links.get(href)
    const inline = token.type === 'image'
    if (found) {
      if (inline) found.inline = true
    } else if (links.size < MAX_MESSAGE_LINKS) {
      const link = localLink(href)
      if (link) links.set(href, { link, inline })
    }
  })
  return links.values()
}
