// The server-reported input-buffer depth is one byte on the wire in both directions, and
// hasInputDepth is the one predicate that decides whether a value is one: the encoder
// (src/netcode/SnapshotEncoder.js inputBufferByte) reports null for anything else and this parse
// reports NO_INPUT_DEPTH for that same set, so 300, -5, 3.9 and 2^32+7 all mean "not reported"
// rather than a clamped, truncated or wrapped number.
//
// One parse means one place that decides what a wire byte means, so no consumer re-guesses the
// sentinel with its own ?? -1 and then re-validates the result.

export const NO_INPUT_DEPTH = -1

// True only for a reported depth: an integer in 0..255. NO_INPUT_DEPTH, undefined and null are all
// "not reported", so a caller that narrows on this passes a byte and nothing else.
export function hasInputDepth(depth) {
  return typeof depth === 'number' && depth >= 0 && depth <= 255 && (depth | 0) === depth
}

export function inputDepthFromWire(depth) {
  return hasInputDepth(depth) ? depth : NO_INPUT_DEPTH
}
