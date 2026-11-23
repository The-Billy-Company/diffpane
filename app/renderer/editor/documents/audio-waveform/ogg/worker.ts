// Copyright (c) 2026 The Billy Company
/// <reference lib="webworker" />

import { decodeOggPreview } from './decoder.ts'

declare const self: DedicatedWorkerGlobalScope

self.addEventListener(
  'message',
  ({ data }: MessageEvent<string>) => {
    decodeOggPreview(data).then(
      result => self.postMessage(result, { transfer: result.peaks.map(channel => channel.buffer) }),
      () => self.postMessage(null, []),
    )
  },
  { once: true },
)
