// Copyright (c) 2026 The Billy Company
const historyLimit = 64

export class FileHistory {
  private entries: string[] = []
  private index = -1
  private recent: string[] = []

  record(path: string, historyIndex?: number) {
    if (historyIndex !== undefined && this.entries[historyIndex] === path) this.index = historyIndex
    else if (this.entries[this.index] !== path) {
      this.entries = [...this.entries.slice(0, this.index + 1), path].slice(-historyLimit)
      this.index = this.entries.length - 1
    }
    this.recent = [path, ...this.recent.filter(entry => entry !== path)].slice(0, historyLimit)
  }

  navigate(offset: -1 | 1, current: string | undefined) {
    const index = current === undefined && offset === -1 ? this.index : this.index + offset
    const path = this.entries[index]
    return path === undefined ? undefined : { path, index }
  }

  previous(current: string | undefined) {
    return this.recent.find(entry => entry !== current)
  }

  closeOthers(keep?: string) {
    this.recent = keep === undefined ? [] : [keep]
  }

  move(from: string, to?: string) {
    const remap = (path: string) =>
      path === from || path.startsWith(`${from}/`) ? (to === undefined ? [] : [to + path.slice(from.length)]) : [path]
    this.index = this.entries.slice(0, this.index + 1).flatMap(remap).length - 1
    this.entries = this.entries.flatMap(remap)
    this.recent = [...new Set(this.recent.flatMap(remap))]
  }
}
