// Copyright (c) 2026 The Billy Company
import { requireElement } from '../../shell/workspace/dom.js'

export function createAgentThreadMinimap(conversation: HTMLElement) {
  const element = document.createElement('label')
  element.className = 'agent-thread-minimap'
  element.hidden = true
  element.innerHTML = `
    <span class="agent-thread-minimap-label">Thread map</span>
    <span class="agent-thread-minimap-track">
      <span class="agent-thread-minimap-marks" aria-hidden="true"></span>
      <input class="agent-thread-minimap-position" type="range" min="0" max="100" value="0">
    </span>`
  const marks = requireElement(element, '.agent-thread-minimap-marks', HTMLSpanElement)
  const position = requireElement(element, 'input', HTMLInputElement)
  let transcript: HTMLElement | undefined
  let scrollRange = 0
  let frame = 0

  function syncPosition() {
    if (!scrollRange || element.hidden) return
    const percent = Math.round((100 * conversation.scrollTop) / scrollRange)
    position.value = String(percent)
    position.setAttribute('aria-valuetext', `${position.value}% through conversation`)
  }

  function draw() {
    frame = 0
    const { clientHeight, scrollHeight, scrollTop } = conversation
    scrollRange = scrollHeight - clientHeight
    element.hidden = !transcript || scrollRange <= 1
    if (!transcript || !position.clientHeight) return

    const viewport = Math.max(16, (position.clientHeight * clientHeight) / scrollHeight)
    const origin = conversation.getBoundingClientRect().top - scrollTop
    const preview = document.createDocumentFragment()
    for (const block of transcript.querySelectorAll<HTMLElement>(
      '.agent-thread-turn, .agent-thread-tool-group, .agent-thread-edit-summary',
    )) {
      const { top, height } = block.getBoundingClientRect()
      const mark = document.createElement('span')
      mark.dataset.role = block.dataset.role ?? (block.matches('.agent-thread-tool-group') ? 'tool' : 'edit')
      mark.style.insetBlockStart = `${(100 * (top - origin)) / scrollHeight}%`
      mark.style.blockSize = `${(100 * height) / scrollHeight}%`
      preview.append(mark)
    }
    marks.replaceChildren(preview)
    position.style.setProperty('--minimap-viewport', `${viewport}px`)
    syncPosition()
  }

  function scheduleDraw() {
    if (!frame) frame = requestAnimationFrame(draw)
  }

  const size = new ResizeObserver(scheduleDraw)
  size.observe(conversation)
  size.observe(position)
  conversation.addEventListener('scroll', syncPosition, { passive: true })
  position.addEventListener('input', () => {
    conversation.scrollTop = (scrollRange * position.valueAsNumber) / 100
  })

  return {
    element,
    setTranscript(next?: HTMLElement) {
      if (transcript === next) {
        if (next) scheduleDraw()
        return
      }
      if (transcript) size.unobserve(transcript)
      transcript = next
      if (transcript) {
        size.observe(transcript)
        scheduleDraw()
      } else {
        element.hidden = true
        marks.replaceChildren()
      }
    },
    dispose() {
      size.disconnect()
      cancelAnimationFrame(frame)
      conversation.removeEventListener('scroll', syncPosition)
    },
  }
}
