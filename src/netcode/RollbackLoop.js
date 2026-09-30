const DEFAULT_WINDOW = 32

export function createRollbackLoop({ capture, apply, windowSize = DEFAULT_WINDOW } = {}) {
  if (typeof capture !== 'function' || typeof apply !== 'function') throw new Error('[RollbackLoop] capture() and apply(snapshot) are required')
  const ring = new Map()
  let newestTick = -1

  function save(tick) {
    ring.delete(tick)
    ring.set(tick, capture(tick))
    if (tick > newestTick) newestTick = tick
    while (ring.size > windowSize) ring.delete(ring.keys().next().value)
  }

  function has(tick) { return ring.has(tick) }
  function get(tick) { return ring.get(tick) }
  function oldestTick() { const k = ring.keys().next(); return k.done ? -1 : k.value }

  function restore(tick) {
    const snap = ring.get(tick)
    if (!snap) throw new Error(`[RollbackLoop] restore(${tick}): not in ring (oldest=${oldestTick()}, newest=${newestTick}, window=${windowSize})`)
    apply(snap)
    for (const t of [...ring.keys()]) if (t > tick) ring.delete(t)
    newestTick = tick
  }

  return { save, has, get, restore, oldestTick, get newestTick() { return newestTick }, get windowSize() { return windowSize } }
}
