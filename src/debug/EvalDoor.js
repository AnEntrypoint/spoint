const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const MAX_DEPTH = 8

function toPlain(value, depth, seen) {
  if (value === undefined) return null
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`
  if (depth >= MAX_DEPTH) return '[depth]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[${value.constructor.name} ${value.byteLength}]`
  if (Array.isArray(value)) return value.map((item) => toPlain(item, depth + 1, seen))
  const out = {}
  for (const key of Object.keys(value)) out[key] = toPlain(value[key], depth + 1, seen)
  seen.delete(value)
  return out
}

export async function evalInRealm(body, realm) {
  try {
    const value = await new AsyncFunction('realm', body)(realm)
    return { ok: true, value: toPlain(value, 0, new Set()) }
  } catch (error) {
    return { ok: false, error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) } }
  }
}
