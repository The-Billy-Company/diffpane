import { createSketch } from '../../../illustrations/sketch.ts'

function makeSvg(host: HTMLElement, viewBox: string) {
  const svg = host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  return svg
}

export function drawWindowMascot(host: HTMLElement, opening: boolean) {
  const svg = makeSvg(host, opening ? '0 0 48 36' : '0 0 58 42')
  const sketch = createSketch(svg)
  const ink = { stroke: 'var(--window-mascot-ink)', roughness: 0.42, disableMultiStroke: true }
  const outline = sketch.path('M7 2h34q5 0 5 5v22q0 5-5 5H7q-5 0-5-5V7q0-5 5-5Z', {
    ...ink,
    stroke: 'currentColor',
    strokeWidth: 1.55,
    fill: 'var(--mascot-fill, var(--warning-surface))',
    fillStyle: 'solid',
  })
  const sidebar = sketch.path('M3 12h10v21H7q-4 0-4-4Z', {
    ...ink,
    stroke: 'none',
    fill: 'var(--window-mascot-ink)',
    hachureGap: 3.5,
    fillWeight: 0.68,
  })
  const chrome = sketch.path('M3 12h42 M13 12v21 M7 7h1 M11 7h1 M15 7h1', ink)
  const eyes = sketch.path('M24 19v3 M36 19v3', {
    ...ink,
    stroke: 'currentColor',
    strokeWidth: 2,
    roughness: 0.35,
  })
  eyes.classList.add('window-mascot__eyes')
  const mouth = sketch.path(opening ? 'M27 25q3 4.5 6 0' : 'M27 27q3-4 6 0', {
    ...ink,
    stroke: 'currentColor',
    strokeWidth: 1.35,
  })
  svg.append(outline, sidebar, chrome, eyes, mouth)
  if (!opening) {
    const flag = { ...ink, stroke: 'currentColor', strokeWidth: 1.35 }
    svg.append(
      sketch.circle(46, 31, 16, { ...flag, fill: 'var(--surface)', fillStyle: 'solid' }),
      sketch.path('M46 27v4.5 M46 34.5v.5', flag),
    )
  }
  host.append(svg)
  host.classList.add('window-mascot--sketched')
}

export function drawOpeningPage(host: HTMLElement, change: 'added' | 'removed') {
  const svg = makeSvg(host, '0 0 28 36')
  const sketch = createSketch(svg)
  const ink = { stroke: `var(--${change})`, roughness: 0.45, disableMultiStroke: true }
  svg.append(
    sketch.path('M3 2h15l7 7v24H3Z', {
      ...ink,
      fill: `var(--${change}-surface)`,
      fillStyle: 'solid',
      strokeWidth: 1.35,
    }),
    sketch.path('M18 2v7h7 M8 14h9 M8 19h12', ink),
    sketch.path(change === 'added' ? 'M9 26h7 M12.5 22.5v7' : 'M9 26h7', { ...ink, strokeWidth: 1.4 }),
  )
  host.append(svg)
  host.classList.add('workspace-opening__page--sketched')
}
