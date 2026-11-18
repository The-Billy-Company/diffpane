import { hostEvent, hostRequest, reportHostError } from '../host/desktop.ts'

export interface MenuItemOptions {
  id?: string
  label?: string
  role?: string
  type?: 'separator'
  accelerator?: string
  enabled?: boolean
  visible?: boolean
  submenu?: MenuItemOptions[]
  click?: () => void
}

interface MenuState {
  id: string
  enabled: boolean
  visible: boolean
}

let actions = new Map<string, () => void>()
let pending = Promise.resolve<unknown>(undefined)

function sendMenu(method: string, args: unknown) {
  pending = pending.then(() => hostRequest(method, args)).catch(reportHostError)
}

export function setNativeMenu(items: MenuItemOptions[]) {
  const nextActions = new Map<string, () => void>()
  function serialize(entries: MenuItemOptions[], parent = 'menu'): unknown[] {
    return entries.map(({ click, submenu, ...item }, index) => {
      const id = item.id ?? `${parent}-${index}`
      if (click) nextActions.set(id, click)
      return { ...item, id, submenu: submenu ? serialize(submenu, id) : undefined }
    })
  }
  const template = serialize(items)
  actions = nextActions
  sendMenu('menu.set', template)
}

export function updateNativeMenu(states: MenuState[]) {
  sendMenu('menu.state', states)
}

hostEvent('menu.click', id => {
  if (typeof id === 'string') actions.get(id)?.()
})
