// The server-reported input-buffer depth is one byte on the wire in both directions: the encoder
// (src/netcode/SnapshotEncoder.js) clamps to 0..255, so a decoded depth is a byte too. "No depth
// reported" is NO_INPUT_DEPTH, never an unclamped number: a peer whose self block is absent has no
// depth to report, and a depth of 300 or -5 is not a depth at all.
//
// One parse means one place that decides what a wire byte means, so no consumer re-guesses the
// sentinel with its own ?? -1 and then re-validates the result.

export const NO_INPUT_DEPTH = -1

export function inputDepthFromWire(depth) {
  if (depth === null || depth === undefined) return NO_INPUT_DEPTH
  const n = depth | 0
  if (n < 0) return NO_INPUT_DEPTH
  return n > 255 ? 255 : n
}

// True only for a reported depth: an integer in 0..255. NO_INPUT_DEPTH, undefined and null are all
// "not reported", so a caller that narrows on this passes a byte and nothing else.
export function hasInputDepth(depth) {
  return typeof depth === 'number' && depth >= 0 && depth <= 255 && (depth | 0) === depth
}
