// Copyright (c) 2026 The Billy Company
import type { LiveEditCounts } from '../live-edit-highlight.ts'
import './edit-activity.css'

const HISTORY_SIZE = 12

function extent(lines: number) {
  return Math.min(8, 2 + Math.log2(lines) * 1.25)
}

export function createEditActivity() {
  const element = document.createElement('span')
  element.className = 'edit-activity'
  element.hidden = true
  element.role = 'img'

  const label = document.createElement('span')
  label.className = 'edit-activity-label'
  label.textContent = 'Live edits'

  const chart = document.createElement('span')
  chart.className = 'edit-activity-chart'

  const counts = document.createElement('span')
  counts.className = 'edit-activity-counts'
  const added = document.createElement('span')
  const removed = document.createElement('span')
  counts.append(added, removed)

  for (const part of [label, chart, counts]) part.setAttribute('aria-hidden', 'true')
  element.append(label, chart, counts)

  return {
    element,
    record(edit: LiveEditCounts | null) {
      const sample = document.createElement('span')
      sample.className = 'edit-activity-sample'
      if (edit?.added) sample.style.setProperty('--edit-rise', `${extent(edit.added)}px`)
      if (edit?.removed) sample.style.setProperty('--edit-fall', `${extent(edit.removed)}px`)
      sample.toggleAttribute('data-uncounted', !edit?.added && !edit?.removed)
      const summary = edit
        ? `${edit.added.toLocaleString()} added, ${edit.removed.toLocaleString()} removed`
        : 'Line counts unavailable'
      sample.title = summary
      chart.append(sample)
      if (chart.childElementCount > HISTORY_SIZE) chart.firstElementChild?.remove()

      counts.hidden = !edit
      if (edit) {
        added.textContent = `+${edit.added.toLocaleString()}`
        removed.textContent = `−${edit.removed.toLocaleString()}`
      }
      const description = `Live edits. Latest external update. ${summary}.`
      element.setAttribute('aria-label', description)
      element.title = description
      element.hidden = false
    },
  }
}
