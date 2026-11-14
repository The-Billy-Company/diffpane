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
  readAnchor: () => HTMLHeadingElement | undefined,
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
    const anchor = readAnchor()
    if (!rail.clientWidth) return

    const max = root.scrollHeight - root.clientHeight
    const scrollTop = root.scrollTop
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

    rail.style.setProperty('--reading-progress', String(fraction))
    const value = String(Math.round(fraction * 100))
    if (percent.textContent !== `${value}%`) {
      percent.textContent = `${value}%`
      progress.setAttribute('aria-valuenow', value)
    }
    if (!current) return
    if (current !== active) {
      active?.removeAttribute('aria-current')
      current.setAttribute('aria-current', 'location')
      active = current
    }
    if (list.contains(document.activeElement)) return

    const top = current.offsetTop
    const bottom = top + current.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
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
