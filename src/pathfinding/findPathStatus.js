function refusal(code, message) {
  const err = new TypeError(`[find-path-status] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function readPoint(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw refusal('path-point-invalid', `${name} must be an array of three finite numbers`)
  return value
}

export async function findPathWithStatus({ query, from, to, nearest = null, options = {} } = {}) {
  if (typeof query !== 'function') throw refusal('path-query-invalid', 'query must be a function')
  readPoint(from, 'from')
  readPoint(to, 'to')
  if (nearest !== null && typeof nearest !== 'function') throw refusal('path-nearest-invalid', 'nearest must be a function or null')
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw refusal('path-options-invalid', 'options must be an object')
  let points
  try {
    points = await query(from, to, options)
  } catch (err) {
    return { ok: false, points: [], partial: false, reasonCode: 'path-query-failed', message: String(err?.message ?? err) }
  }
  if (Array.isArray(points) && points.length >= 2) {
    for (let i = 0; i < points.length; i++) readPoint(points[i], `points[${i}]`)
    return { ok: true, points, partial: false, reasonCode: null }
  }
  if (points !== null && points !== undefined) throw refusal('path-result-invalid', 'query must return null or an array of at least two points')
  if (nearest === null) return { ok: false, points: [], partial: false, reasonCode: 'path-unreachable' }
  let fallback
  try {
    fallback = await nearest(from, to, options)
  } catch (err) {
    return { ok: false, points: [], partial: false, reasonCode: 'path-nearest-failed', message: String(err?.message ?? err) }
  }
  if (fallback === null || fallback === undefined) return { ok: false, points: [], partial: false, reasonCode: 'path-unreachable' }
  readPoint(fallback, 'nearest')
  return { ok: false, points: [from, fallback], partial: true, reasonCode: 'path-partial' }
}
