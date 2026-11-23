// Copyright (c) 2026 The Billy Company
let decode: ((encoded: string) => Uint8Array<ArrayBuffer>) | undefined

function selectDecoder() {
  const { fromBase64 } = Uint8Array as Uint8ArrayConstructor & {
    fromBase64?: (encoded: string) => Uint8Array<ArrayBuffer>
  }
  if (typeof fromBase64 === 'function') {
    try {
      // Early WebKit implementations accepted malformed final chunks.
      fromBase64('A==')
    } catch {
      return fromBase64
    }
  }
  return (encoded: string) => {
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < bytes.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
}

export function decodeBase64(encoded: string) {
  decode ??= selectDecoder()
  return decode(encoded)
}
