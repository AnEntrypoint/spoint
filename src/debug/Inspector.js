import { MSG } from '../protocol/MessageTypes.js'

// The "debug message" range below was ORIGINALLY a hardcoded 100-199 guess with a manually
// carved-out exception list for known editor-protocol ids -- and it kept silently rotting: first
// a 128-159 exception missed SAVE_PREFAB/PREFAB_SAVED/PLACE_PREFAB/GROUP_ENTITIES/LIST_FS_TREE/
// FS_TREE/FS_TREE_CHANGED/MKDIR/DELETE_FILE/RENAME_FILE/FS_OP_RESULT (0xa0-0xaa), fixed by
// deriving a min/max RANGE from an explicit _editorMsgIds array instead -- but a min/max range
// has the exact same rot mode as a hardcoded range: it silently re-broke a second time when
// EDITOR_PRESENCE (0xab=171) and TERRAIN_SCULPT/TERRAIN_SCULPT_ACK (0xae/0xaf=174/175) were added
// past the array's max (170), landing back in the swallowed range with zero error anywhere
// (Inspector.handleMessage returns true, so ServerHandlers.js's dispatcher never even sees the
// message -- live-reproduced this session: TERRAIN_SCULPT sent, zero ack, zero error, zero warning).
// STRUCTURAL fix (can't rot again): swallow-as-debug only applies to a numeric type that is NOT
// any currently-defined MSG.* value at all. Every real, wired protocol message -- present or any
// future addition -- is automatically excluded by construction, with zero list to keep in sync.
const _knownMsgTypes = new Set(Object.values(MSG))

export class Inspector {
  constructor() {
    this.clients = new Map()
  }

  handleMessage(clientId, msg) {
    if (!msg || msg.type < 100) return false
    const msgType = msg.type
    if (_knownMsgTypes.has(msgType)) return false
    if (msgType >= 100 && msgType <= 199) {
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
