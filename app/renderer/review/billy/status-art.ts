import { createSketch } from '../../illustrations/sketch.ts'
import './status-art.css'

type Sketch = ReturnType<typeof createSketch>
type Kind = keyof typeof drawings

const ink = { stroke: 'currentColor', strokeWidth: 1.25, roughness: 0.65 }
const paper = { stroke: 'var(--billy-art-paper)', roughness: 0.65 }

const drawings = {
  contract: (sketch: Sketch) => [
    sketch.path('M3 4h7v16H3Z M5.5 8h2 M5.5 12h2 M5.5 16h2', paper),
    sketch.path('M10 12h5m0 0q3 0 3-3V7h3m-6 5q3 0 3 3v2h3 M22 5h5v4h-5Z M22 15h5v4h-5Z', ink),
  ],
  claims: (sketch: Sketch) => [
    sketch.circle(14, 12, 17, paper),
    sketch.circle(14, 12, 9, paper),
    sketch.path('M14 12l7-6 M11 14h1 M18 13h1', ink),
  ],
  siblings: (sketch: Sketch) => [
    sketch.path('M9 5H7q-2 0-2 3v2l-2 2 2 2v2q0 3 2 3h2 M21 5h2q2 0 2 3v2l2 2-2 2v2q0 3-2 3h-2', ink),
    sketch.path('M11 10h8 M11 14h8', paper),
  ],
  lanes: (sketch: Sketch) => [
    sketch.path('M6 12h9q5 0 6-5m-6 5q5 0 6 5', ink),
    sketch.circle(5, 12, 4, ink),
    sketch.circle(22, 5.5, 4, paper),
    sketch.circle(22, 18.5, 4, paper),
  ],
  run: (sketch: Sketch) => [sketch.path('M7 2h11l5 5v15H7Z M18 2v6h5', paper), sketch.path('M12 10l6 4-6 4Z', ink)],
}

export function createBillyStatusArt(kind: Kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('billy-status-art')
  svg.setAttribute('viewBox', '0 0 30 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.append(...drawings[kind](createSketch(svg)))
  return svg
}
