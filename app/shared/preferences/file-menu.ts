export const fileMenuLabels = {
  searchFiles: 'Quick Open…',
  saveFile: 'Save File',
  findInFile: 'Find in File…',
  showDiff: 'Compare with Git HEAD',
  showWorkingFile: 'Show Working File',
  closeComparison: 'Close Comparison',
  revealActiveFile: 'Reveal in File Explorer',
  copyRelativePath: 'Copy Relative Path',
  previousEditor: 'Switch to Previous File',
  closeOtherEditors: 'Close Other Editors',
  closeAllEditors: 'Close All Editors',
} as const

export type FileMenuAction = keyof typeof fileMenuLabels

export function isFileMenuAction(value: unknown): value is FileMenuAction {
  return typeof value === 'string' && Object.hasOwn(fileMenuLabels, value)
}
