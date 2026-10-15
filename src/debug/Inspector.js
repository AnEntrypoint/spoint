import { MSG } from '../protocol/MessageTypes.js'

const _knownMsgTypes = new Set(Object.values(MSG))
const DEBUG_MSG_TYPE_MIN = 100
const DEBUG_MSG_TYPE_MAX = 199

export class Inspector {
  constructor() {
    this.clients = new Map()
  }

  handleMessage(clientId, msg) {
    if (!msg || msg.type < DEBUG_MSG_TYPE_MIN) return false
    const msgType = msg.type
    if (_knownMsgTypes.has(msgType)) return false
    if (msgType >= DEBUG_MSG_TYPE_MIN && msgType <= DEBUG_MSG_TYPE_MAX) {
      this._handleDebugMessage(clientId, msg)
      return true
    }
    return false
  }

  _handleDebugMessage(clientId, msg) {
    const client = this.clients.get(clientId) || {
      id: clientId,
      debugMessages: []
    }
    client.lastDebugMessage = Date.now()
    client.debugMessages = client.debugMessages || []
    client.debugMessages.push({
      type: msg.type,
      timestamp: Date.now(),
      payload: msg.payload
    })
    if (client.debugMessages.length > 1000) {
      client.debugMessages.shift()
    }
    this.clients.set(clientId, client)
  }

  removeClient(clientId) {
    this.clients.delete(clientId)
  }

  getAllClients(connections) {
    const result = []
    for (const [clientId, client] of this.clients.entries()) {
      const conn = connections.getClient(clientId)
      if (conn) {
        result.push({
          id: clientId,
          debugMessages: client.debugMessages.length,
          lastMessage: client.lastDebugMessage
        })
      }
    }
    return result
  }
}

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapInspector = (next) => {
  Inspector = next.Inspector
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapInspector)
