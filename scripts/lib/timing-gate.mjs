import { contentionMark, contentionWatch, contentionVerdict, formatContention } from './host-contention.mjs'

const DEFAULT_RETRIES = 3

export function cpuDeltaMs(since) {
  const d = process.cpuUsage(since)
  return (d.user + d.system) / 1000
}

export async function measureUncontested(label, measure, options = {}) {
  const retries = options.retries ?? DEFAULT_RETRIES
  const canRetry = options.canRetry ?? (() => true)
  const samples = []
  let row = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    const watch = contentionWatch()
    row = await measure(() => contentionMark(watch))
    const contention = contentionVerdict(watch)
    row.spinMsBefore = contention.beforeMs
    row.spinMsMid = contention.midMs
    row.spinMsAfter = contention.afterMs
    row.spinMsBest = contention.bestMs
    row.contentionSlowdown = contention.slowdown
    row.contested = contention.contested
    samples.push(contention.slowdown)
    if (!contention.contested) break
    if (attempt >= retries || !canRetry()) {
      const why = attempt >= retries ? `out of attempts` : `this run has no budget left to re-measure it`
      console.log(`${label} shared the box (x${contention.slowdown} of its cleanest ${contention.bestMs} ms per fixed spin) and is ${why}, so its figures are quoted as inconclusive, not as a measurement`)
      break
    }
    console.log(`${label} shared the box (x${contention.slowdown} of its cleanest ${contention.bestMs} ms per fixed spin); re-measuring it (attempt ${attempt + 1} of ${retries})`)
  }
  row.label = label
  row.attempts = samples.length
  row.contentionSamples = samples
  return row
}

export function rowContention(row) {
  return {
    beforeMs: row.spinMsBefore,
    midMs: row.spinMsMid,
    afterMs: row.spinMsAfter,
    bestMs: row.spinMsBest,
    slowdown: row.contentionSlowdown,
    contested: row.contested,
  }
}

export function formatRowContention(row) {
  return formatContention(rowContention(row))
}

export function contestedRows(rows) {
  return rows.filter(r => r.contested === true)
}

export function describeContested(rows, retries = DEFAULT_RETRIES) {
  return contestedRows(rows)
    .map(r => `${r.label} contested on all ${r.attempts} of the ${retries} attempt(s) it was allowed (${(r.contentionSamples || []).map(s => 'x' + s).join(', ')}), so its wall figures measure the box: re-run alone`)
    .join('; ')
}

export function fingerprintFields(row) {
  return {
    label: row.label,
    spinMsBefore: row.spinMsBefore,
    spinMsMid: row.spinMsMid,
    spinMsAfter: row.spinMsAfter,
    spinMsBest: row.spinMsBest,
    contentionSlowdown: row.contentionSlowdown,
    contested: row.contested,
    attempts: row.attempts,
    contentionSamples: row.contentionSamples,
  }
}
