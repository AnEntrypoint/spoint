const INVALID_INPUT = 'invalid-input'
const UNREACHABLE = 'unreachable'
const BUDGET_EXHAUSTED = 'budget-exhausted'
const NUMERIC_KEY = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

const identityKeys = new WeakMap()
let nextIdentityKey = 0

function identityKey(value) {
  let key = identityKeys.get(value)
  if (key === undefined) {
    key = nextIdentityKey++
    identityKeys.set(value, key)
  }
  return key
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function encodeNode(value, active) {
  if (value === null) return ['null']
  const type = typeof value
  if (type === 'string') return ['string', value]
  if (type === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)]
  if (type === 'boolean') return ['boolean', value]
  if (type === 'bigint') return ['bigint', String(value)]
  if (type === 'symbol') return ['symbol', String(value)]
  if (type === 'undefined') return ['undefined']
  if (active.has(value)) return ['identity', identityKey(value)]
  active.add(value)
  let encoded
  if (Array.isArray(value)) encoded = ['array', value.map((item) => encodeNode(item, active))]
  else if (isPlainObject(value)) encoded = ['object', Object.keys(value).sort().map((key) => [key, encodeNode(value[key], active)])]
  else encoded = ['identity', identityKey(value)]
  active.delete(value)
  return encoded
}

function nodeKey(value) {
  return JSON.stringify(encodeNode(value, new Set()))
}

function refusal(reasonCode, expanded = 0, truncated = false) {
  return { ok: false, reasonCode, points: [], cost: Infinity, expanded, truncated }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function primitiveKey(node) {
  return typeof node === 'string' || typeof node === 'number' || typeof node === 'symbol'
}

function isIterable(value) {
  return value !== null && value !== undefined && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function'
}

function adjacencyFor(neighbors, node, key) {
  if (typeof neighbors === 'function') return neighbors(node)
  if (neighbors instanceof Map) {
    if (neighbors.has(node)) return neighbors.get(node)
    if (neighbors.has(key)) return neighbors.get(key)
    return undefined
  }
  if (neighbors && typeof neighbors === 'object') {
    if (primitiveKey(node) && hasOwn(neighbors, node)) return neighbors[node]
    if (hasOwn(neighbors, key)) return neighbors[key]
    return undefined
  }
  return undefined
}

function neighborRecords(adjacency, preferNumbers) {
  if (adjacency === null || adjacency === undefined) return []
  if (typeof adjacency === 'string') return null
  if (adjacency instanceof Map) return Array.from(adjacency.entries(), ([node, cost]) => ({ node, explicitCost: cost }))
  if (isIterable(adjacency)) {
    return Array.from(adjacency, (entry) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && isPlainObject(entry)) {
        const node = entry.node !== undefined ? entry.node : entry.to
        if (node !== undefined) return { node, explicitCost: entry.cost }
      }
      return { node: entry, explicitCost: undefined }
    })
  }
  if (typeof adjacency === 'object') {
    return Object.keys(adjacency).map((key) => ({ node: preferNumbers && NUMERIC_KEY.test(key) ? Number(key) : key, explicitCost: adjacency[key] }))
  }
  return null
}

function nestedCost(outer, to, toKey, explicitCost) {
  if (outer === null || outer === undefined) return explicitCost === undefined ? NaN : explicitCost
  if (typeof outer === 'number') return outer
  if (typeof outer === 'function') return outer(to)
  if (outer instanceof Map) {
    if (outer.has(to)) return outer.get(to)
    if (outer.has(toKey)) return outer.get(toKey)
    return explicitCost === undefined ? NaN : explicitCost
  }
  if (outer && typeof outer === 'object') {
    if (primitiveKey(to) && hasOwn(outer, to)) return outer[to]
    if (hasOwn(outer, toKey)) return outer[toKey]
    return explicitCost === undefined ? NaN : explicitCost
  }
  return explicitCost === undefined ? NaN : explicitCost
}

function edgeCostFor(edgeCost, from, to, fromKey, toKey, explicitCost) {
  if (typeof edgeCost === 'function') return edgeCost(from, to)
  if (edgeCost === null || edgeCost === undefined) return explicitCost === undefined ? NaN : explicitCost
  if (edgeCost instanceof Map) {
    const outer = edgeCost.has(from) ? edgeCost.get(from) : edgeCost.get(fromKey)
    return nestedCost(outer, to, toKey, explicitCost)
  }
  if (edgeCost && typeof edgeCost === 'object') {
    const outer = primitiveKey(from) && hasOwn(edgeCost, from) ? edgeCost[from] : edgeCost[fromKey]
    return nestedCost(outer, to, toKey, explicitCost)
  }
  return NaN
}

function heapBefore(a, b) {
  return a.cost < b.cost || (a.cost === b.cost && a.seq < b.seq)
}

function heapPush(heap, item) {
  heap.push(item)
  let i = heap.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (!heapBefore(item, heap[p])) break
    heap[i] = heap[p]
    i = p
  }
  heap[i] = item
}

function heapPop(heap) {
  const top = heap[0]
  const last = heap.pop()
  if (heap.length) {
    heap[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < heap.length && heapBefore(heap[l], heap[m])) m = l
      if (r < heap.length && heapBefore(heap[r], heap[m])) m = r
      if (m === i) break
      const swap = heap[m]
      heap[m] = heap[i]
      heap[i] = swap
      i = m
    }
  }
  return top
}

export function findCostCorridor(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return refusal(INVALID_INPUT)
  const { start, goal, neighbors, edgeCost, costAt = null, budget = Infinity, ignore = [] } = options
  if (start === undefined || start === null || goal === undefined || goal === null) return refusal(INVALID_INPUT)
  if (typeof neighbors !== 'function' && (!neighbors || typeof neighbors !== 'object')) return refusal(INVALID_INPUT)
  if (edgeCost !== null && edgeCost !== undefined && typeof edgeCost !== 'function' && typeof edgeCost !== 'object') return refusal(INVALID_INPUT)
  if (costAt !== null && typeof costAt !== 'function') return refusal(INVALID_INPUT)
  if (budget !== Infinity && (!Number.isFinite(budget) || budget < 0)) return refusal(INVALID_INPUT)
  if (!ignore || typeof ignore === 'string' || typeof ignore[Symbol.iterator] !== 'function') return refusal(INVALID_INPUT)

  let startKey
  let goalKey
  let ignored
  try {
    startKey = nodeKey(start)
    goalKey = nodeKey(goal)
    ignored = new Set(Array.from(ignore, nodeKey))
  } catch {
    return refusal(INVALID_INPUT)
  }

  const nodeByKey = new Map()
  const register = (node) => {
    const key = nodeKey(node)
    if (!nodeByKey.has(key)) nodeByKey.set(key, node)
    return key
  }
  register(start)
  register(goal)
  if (ignored.has(startKey) || ignored.has(goalKey)) return refusal(UNREACHABLE)

  const preferNumbers = typeof start === 'number' || typeof goal === 'number'
  const best = new Map([[startKey, 0]])
  const previous = new Map()
  const settled = new Set()
  const heap = []
  let sequence = 0
  let expanded = 0
  let budgetCut = false
  heapPush(heap, { cost: 0, key: startKey, seq: sequence++ })

  while (heap.length) {
    const current = heapPop(heap)
    if (settled.has(current.key) || current.cost > (best.get(current.key) ?? Infinity)) continue
    settled.add(current.key)
    expanded += 1
    if (current.key === goalKey) {
      const points = []
      const maxPoints = nodeByKey.size + 1
      let cursor = goalKey
      while (cursor !== undefined) {
        points.push(nodeByKey.get(cursor))
        if (cursor === startKey) break
        cursor = previous.get(cursor)
        if (points.length > maxPoints) return refusal(INVALID_INPUT, expanded)
      }
      points.reverse()
      return { ok: true, points, cost: current.cost, expanded, truncated: false }
    }

    const fromNode = nodeByKey.get(current.key)
    let adjacency
    let records
    try {
      adjacency = adjacencyFor(neighbors, fromNode, current.key)
      records = neighborRecords(adjacency, preferNumbers)
    } catch {
      return refusal(INVALID_INPUT, expanded)
    }
    if (records === null) return refusal(INVALID_INPUT, expanded)

    for (const record of records) {
      if (record.node === undefined || record.node === null) return refusal(INVALID_INPUT, expanded)
      let toKey
      let toNode
      try {
        toKey = register(record.node)
        toNode = nodeByKey.get(toKey)
      } catch {
        return refusal(INVALID_INPUT, expanded)
      }
      if (ignored.has(toKey) || settled.has(toKey)) continue
      let edge
      let multiplier
      try {
        edge = edgeCostFor(edgeCost, fromNode, toNode, current.key, toKey, record.explicitCost)
        multiplier = costAt === null ? 1 : costAt(toNode)
      } catch {
        return refusal(INVALID_INPUT, expanded)
      }
      if (typeof edge !== 'number' || !Number.isFinite(edge) || edge < 0) return refusal(INVALID_INPUT, expanded)
      if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 0) return refusal(INVALID_INPUT, expanded)
      const stepCost = edge * multiplier
      if (!Number.isFinite(stepCost) || stepCost < 0) return refusal(INVALID_INPUT, expanded)
      const tentative = current.cost + stepCost
      if (!Number.isFinite(tentative)) return refusal(INVALID_INPUT, expanded)
      if (tentative > budget) {
        budgetCut = true
        continue
      }
      const known = best.get(toKey)
      if (known === undefined || tentative < known) {
        best.set(toKey, tentative)
        previous.set(toKey, current.key)
        heapPush(heap, { cost: tentative, key: toKey, seq: sequence++ })
      }
    }
  }

  if (budgetCut) return refusal(BUDGET_EXHAUSTED, expanded, true)
  return refusal(UNREACHABLE, expanded, false)
}

export default findCostCorridor
