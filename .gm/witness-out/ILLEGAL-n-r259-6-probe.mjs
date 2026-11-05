const M = await import('/workspace/spoint/src/protocol/MessageTypes.js')
const out = {}
out.MSG_frozen = Object.isFrozen(M.MSG)
out.DISCONNECT_REASONS_frozen = Object.isFrozen(M.DISCONNECT_REASONS)
out.unknownId_isUnreliable = M.isUnreliable(0xfe)
out.knownUnreliable_isUnreliable = M.isUnreliable(M.MSG.SNAPSHOT)
out.unknown_msgName = M.msgName(0xfe)
out.UNRELIABLE_MSGS_frozen = Object.isFrozen(M.UNRELIABLE_MSGS)
console.log(JSON.stringify(out))
