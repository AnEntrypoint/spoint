const _isNode = typeof process !== 'undefined' && !!process.versions?.node
const _nodeTimingSafeEqual = _isNode ? (await import('node:crypto')).timingSafeEqual : null

function _manualTimingSafeEqual(a, b) {
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function timingSafeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (_nodeTimingSafeEqual) {
    const bufA = Buffer.from(a, 'utf8')
    const bufB = Buffer.from(b, 'utf8')
    if (bufA.length !== bufB.length) { _nodeTimingSafeEqual(bufA, bufA); return false }
    return _nodeTimingSafeEqual(bufA, bufB)
  }
  if (a.length !== b.length) { _manualTimingSafeEqual(a, a); return false }
  return _manualTimingSafeEqual(a, b)
}
