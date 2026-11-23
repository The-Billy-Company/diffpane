// Copyright (c) 2026 The Billy Company
import './reading-rail.css'

export interface ReadingSection {
  heading: HTMLHeadingElement
  title: string
}

export function createReadingRail(
  root: HTMLElement,
  article: HTMLElement,
  sections: ReadingSection[],
  jump: (anchor: string) => void,
  readAnchor: (scrollTop: number) => HTMLHeadingElement | undefined,
  signal: AbortSignal,
) {
  if (sections.length < 2) return null

  const layout = document.createElement('div')
  layout.className = 'md-reading-layout'
  const rail = document.createElement('nav')
  rail.className = 'md-reading-rail'
  rail.setAttribute('aria-label', 'On this page')
  const header = document.createElement('div')
  header.className = 'md-reading-header'
  header.textContent = 'On this page'
  const percent = document.createElement('span')
  percent.setAttribute('aria-hidden', 'true')
  const percentText = document.createTextNode('0%')
  percent.append(percentText)
  header.append(percent)
  const progress = document.createElement('div')
  progress.className = 'md-reading-progress'
  progress.setAttribute('role', 'progressbar')
  progress.setAttribute('aria-label', 'Reading progress')
  progress.setAttribute('aria-valuenow', '0')
  const list = document.createElement('ol')
  list.className = 'md-reading-sections'

  const links = sections.map(({ heading, title }) => {
    const item = document.createElement('li')
    const link = document.createElement('a')
    link.href = `#${encodeURIComponent(heading.id)}`
    link.textContent = title
    link.dataset.level = heading.tagName.slice(1)
    link.addEventListener(
      'click',
      event => {
        event.preventDefault()
        jump(heading.id)
      },
      { signal },
    )
    item.append(link)
    list.append(item)
    return link
  })
  rail.append(header, progress, list)
  layout.append(article, rail)

  let active: HTMLAnchorElement | undefined
  let frame = 0
  function update() {
    frame = 0
    const scrollTop = root.scrollTop
    const anchor = readAnchor(scrollTop)
    if (!rail.clientWidth) return

    const max = root.scrollHeight - root.clientHeight
    const atEnd = max > 0 && max - scrollTop <= 1
    const fraction = max > 0 && !atEnd ? Math.max(0, scrollTop / max) : 1
    const readingEdge = root.getBoundingClientRect().top + 32
    // Probe only a few headings per scroll frame, even in a long document.
    let low = 0
    let high = sections.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const heading = sections[middle]?.heading
      if (heading && heading.getBoundingClientRect().top <= readingEdge) low = middle + 1
      else high = middle
    }
    const picked = anchor ? sections.findIndex(section => section.heading === anchor) : -1
    const index = atEnd ? sections.length - 1 : Math.max(0, low - 1)
    const current = links[picked >= 0 ? picked : index]

    // Read geometry and reveal the active link before changing text or styles.
    if (current && !list.contains(document.activeElement)) {
      const top = current.offsetTop
      const bottom = top + current.offsetHeight
      const listTop = list.scrollTop
      const listHeight = list.clientHeight
      if (top < listTop) list.scrollTop = top
      else if (bottom > listTop + listHeight) list.scrollTop = bottom - listHeight
    }

    progress.style.setProperty('--reading-progress', String(fraction))
    const value = String(Math.round(fraction * 100))
    const label = `${value}%`
    if (percentText.data !== label) {
      // Replacing the text node invalidates styles across the workspace.
      percentText.data = label
      progress.setAttribute('aria-valuenow', value)
    }
    if (current && current !== active) {
      active?.removeAttribute('aria-current')
      current.setAttribute('aria-current', 'location')
      active = current
    }
  }

  function refresh() {
    if (!frame) frame = requestAnimationFrame(update)
  }

  const observer = new ResizeObserver(refresh)
  observer.observe(root)
  observer.observe(article)
  root.addEventListener('scroll', refresh, { passive: true, signal })
  signal.addEventListener(
    'abort',
    () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    },
    { once: true },
  )
  refresh()
  return { layout, refresh }
}
