export function extractTrainingExamples(replay, opts = {}) {
  const { playerId, minTick = -Infinity, maxTick = Infinity } = opts

  const dtByTick = new Map()
  for (const { tick, dt } of replay.ticks || []) {
    dtByTick.set(tick, dt)
  }

  const examples = []
  for (const entry of replay.inputs) {
    if (entry.tick < minTick || entry.tick > maxTick) continue
    if (playerId && entry.playerId !== playerId) continue

    const dt = dtByTick.has(entry.tick)
      ? dtByTick.get(entry.tick)
      : (1 / (replay.header.tickRate || 60))

    examples.push({
      tick: entry.tick,
      dt,
      playerId: entry.playerId,
      input: entry.data || {},
    })
  }

  return examples
}

export function computeCorpusStats(examples) {
  if (examples.length === 0) {
    return { count: 0, playerIds: [], tickRange: [0, 0], dtStats: { min: 0, max: 0, avg: 0 }, inputKeys: [] }
  }
  const playerIds = [...new Set(examples.map(e => e.playerId))]
  const ticks = examples.map(e => e.tick)
  const dts = examples.map(e => e.dt)
  const keys = new Set()
  for (const e of examples) {
    for (const k of Object.keys(e.input)) keys.add(k)
  }
  return {
    count: examples.length,
    playerIds,
    tickRange: [Math.min(...ticks), Math.max(...ticks)],
    dtStats: {
      min: Math.min(...dts),
      max: Math.max(...dts),
      avg: dts.reduce((a, b) => a + b, 0) / dts.length,
    },
    inputKeys: [...keys].sort(),
  }
}