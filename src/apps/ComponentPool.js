const GROWTH_FACTOR = 2
const INITIAL_CAPACITY = 16

function _typedArrayCtor(kind) {
  if (kind === 'f64') return Float64Array
  if (kind === 'f32' || kind == null) return Float32Array
  throw new TypeError(`[ComponentPool] unknown field kind: ${kind} (use 'f32' or 'f64')`)
}

export function createComponentPool(spec) {
  const fieldNames = Object.keys(spec.fields)
  const fieldCtors = {}
  for (const name of fieldNames) fieldCtors[name] = _typedArrayCtor(spec.fields[name])
  let capacity = INITIAL_CAPACITY
  const columns = {}
  for (const name of fieldNames) columns[name] = new fieldCtors[name](capacity)

  let nextFreshSlot = 0
  const freeList = []
  let epoch = 0

  function grow(minCapacity) {
    let newCapacity = capacity
    while (newCapacity < minCapacity) newCapacity *= GROWTH_FACTOR
    for (const name of fieldNames) {
      const old = columns[name]
      const next = new fieldCtors[name](newCapacity)
      next.set(old)
      columns[name] = next
    }
    capacity = newCapacity
    epoch++
  }

  return {
    fieldNames,
    alloc() {
      let slot
      if (freeList.length > 0) slot = freeList.pop()
      else {
        if (nextFreshSlot >= capacity) grow(nextFreshSlot + 1)
        slot = nextFreshSlot++
      }
      for (const name of fieldNames) columns[name][slot] = 0
      return slot
    },
    free(slot) { freeList.push(slot) },
    get(field, slot) { return columns[field][slot] },
    set(field, slot, value) { columns[field][slot] = value },
    column(field) { return columns[field] },
    get epoch() { return epoch },
    get capacity() { return capacity },
    get liveCount() { return nextFreshSlot - freeList.length },
  }
}

export default { createComponentPool }
