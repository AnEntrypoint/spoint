
export const NO_INPUT_DEPTH = -1

export function hasInputDepth(depth) {
  return typeof depth === 'number' && depth >= 0 && depth <= 255 && (depth | 0) === depth
}

export function inputDepthFromWire(depth) {
  return hasInputDepth(depth) ? depth : NO_INPUT_DEPTH
}
