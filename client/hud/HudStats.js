const stats = new Map()

export function publishHudStat(key, value) {
  if (typeof key !== 'string' || key === '') return
  if (value === undefined || value === null) stats.delete(key)
  else stats.set(key, value)
}

export function clearHudStat(key) {
  stats.delete(key)
}

export function readHudStats() {
  return Object.fromEntries(stats)
}
