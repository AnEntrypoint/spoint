import { pack, unpack } from '../protocol/msgpack.js'

export const SPOINTREPLAY_MAGIC = 'spointreplay'
export const SPOINTREPLAY_VERSION = 2

export function encodeReplay({ header, inputs, ticks, events }) {
  if (!header || typeof header !== 'object') throw new Error('encodeReplay requires a header object')
  if (!Array.isArray(inputs)) throw new Error('encodeReplay requires an inputs array')
  return pack({
    magic: SPOINTREPLAY_MAGIC,
    version: SPOINTREPLAY_VERSION,
    header,
    inputs,
    ticks: Array.isArray(ticks) ? ticks : [],
    events: Array.isArray(events) ? events : [],
  })
}

export function decodeReplay(buf) {
  let env
  try { env = unpack(buf) } catch (e) { throw new Error(`decodeReplay: not a valid .spointreplay file (msgpack decode failed: ${e.message})`) }
  if (!env || env.magic !== SPOINTREPLAY_MAGIC) throw new Error('decodeReplay: not a .spointreplay file (bad magic)')
  if (env.version !== 1 && env.version !== SPOINTREPLAY_VERSION) throw new Error(`decodeReplay: unsupported version ${env.version} (expected 1 or ${SPOINTREPLAY_VERSION})`)
  if (!env.header || !Array.isArray(env.inputs)) throw new Error('decodeReplay: malformed envelope (missing header/inputs)')
  if (!Array.isArray(env.ticks)) env.ticks = []
  return env
}
