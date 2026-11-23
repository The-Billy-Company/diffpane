// Copyright (c) 2026 The Billy Company
import { initializeDesktop } from './desktop.ts'
import { hostEvent, hostRequest, readHost } from './transport.ts'

const started = new Promise<void>((resolve, reject) => {
  const remove = hostEvent('app.start', options => {
    remove()
    try {
      initializeDesktop(options)
      resolve()
    } catch (error) {
      reject(error)
    }
  })
})
readHost()

try {
  await started
  await import('../../backend/runtime/window/main.mjs')
} catch (error) {
  console.error('Diffpane could not start its workspace service.', error)
  await hostRequest('app.exit', 1).catch(() => {})
  process.exit(1)
}
