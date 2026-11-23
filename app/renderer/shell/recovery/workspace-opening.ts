// Copyright (c) 2026 The Billy Company
import { creatureGlyph } from '../../panels/assistant/creature-glyph.ts'
import { rendererDiagnostics } from '../diagnostics/diagnostics.ts'

export function startWorkspaceOpeningPeeks(opening: HTMLElement | null) {
  if (!opening) return
  const pieces = Array.from(opening.querySelectorAll('.workspace-opening__piece'))
  for (const [earliest, latest] of [
    [140, 360],
    [1700, 1950],
  ] as const) {
    const [piece] = pieces.splice(Math.floor(Math.random() * pieces.length), 1)
    if (!piece) break
    const peek = document.createElement('span')
    peek.className = 'workspace-opening__peek'
    peek.style.setProperty('--peek-delay', `${earliest + Math.floor(Math.random() * (latest - earliest))}ms`)
    peek.innerHTML = creatureGlyph
    piece.prepend(peek)
  }
  import('./art/window-art.ts')
    .then(({ drawWindowMascot, drawOpeningPage }) => {
      if (opening.hidden) return undefined
      const mascot = opening.querySelector<HTMLElement>('.window-mascot')
      if (mascot) drawWindowMascot(mascot, true)
      for (const page of opening.querySelectorAll<HTMLElement>('.workspace-opening__page')) {
        drawOpeningPage(page, page.closest('.workspace-opening__page--left') ? 'removed' : 'added')
      }
      return undefined
    })
    .catch((cause: unknown) => rendererDiagnostics.error('renderer.workspace-opening-art', cause))
}
