import { persisted } from './AppGameplay.js'

const DEFAULT_ACCOUNT_DEBOUNCE_MS = 500
const MAX_ACCOUNT_ID_LENGTH = 128

export class AccountStateError extends Error {
  constructor(reason, detail) {
    super(`[account-state] ${reason}${detail === undefined ? '' : `: ${detail}`}`)
    this.name = 'AccountStateError'
    this.reason = reason
  }
}

export function accountIdOf(socket) {
  const id = socket?._nostrPubkey
  if (typeof id !== 'string' || id === '' || id.length > MAX_ACCOUNT_ID_LENGTH) return null
  return id
}

function watched(target, onWrite) {
  if (target === null || typeof target !== 'object') return target
  return new Proxy(target, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r)
      return v !== null && typeof v === 'object' ? watched(v, onWrite) : v
    },
    set(t, k, v, r) {
      const ok = Reflect.set(t, k, v, r)
      onWrite()
      return ok
    },
    deleteProperty(t, k) {
      const ok = Reflect.deleteProperty(t, k)
      onWrite()
      return ok
    }
  })
}

export function createAccountState({ storage, accountOf, debounceMs = DEFAULT_ACCOUNT_DEBOUNCE_MS }) {
  if (!storage) throw new AccountStateError('no-storage')
  const handles = new Map()

  function accountFor(playerId) {
    const account = accountOf(playerId)
    if (account === null) throw new AccountStateError('no-account', String(playerId))
    return account
  }

  function scopedStorage(account) {
    const prefix = `accounts/${account}/`
    return {
      get: k => storage.get(prefix + k),
      set: (k, v) => storage.set(prefix + k, v)
    }
  }

  return {
    open(playerId, key, initial) {
      if (typeof key !== 'string' || key === '') throw new AccountStateError('bad-key', String(key))
      const account = accountFor(playerId)
      const handleId = `${account}\u0000${key}`
      let handle = handles.get(handleId)
      if (!handle) {
        const store = persisted({ storage: scopedStorage(account) }, key, structuredClone(initial), { debounceMs })
        handle = {
          account,
          store,
          ready: store.ready,
          get state() { return watched(store.value, () => store.save()) },
          flush: () => store.flush()
        }
        handles.set(handleId, handle)
      }
      return handle
    },
    release(playerId) {
      const account = accountOf(playerId)
      if (account === null) return Promise.resolve()
      const flushes = []
      for (const [id, handle] of handles) {
        if (handle.account !== account) continue
        handles.delete(id)
        flushes.push(handle.flush())
      }
      return Promise.all(flushes).then(() => undefined)
    }
  }
}
