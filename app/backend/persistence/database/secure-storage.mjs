import { unwrapSecret, wrapSecret } from '../../../desktop/services/keychain.ts'

export const localStateKeys = {
  /** @param {string} key */
  wrap: key => wrapSecret('Local state', key),
  /** @param {Buffer} wrapped */
  async unwrap(wrapped) {
    try {
      return await unwrapSecret('Local state', wrapped)
    } catch (cause) {
      throw new Error('Diffpane could not unlock its local storage. Check access to the operating system key store.', {
        cause,
      })
    }
  },
}
