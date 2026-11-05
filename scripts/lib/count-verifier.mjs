function refusal(code, message) {
  const err = new Error(`[count-verifier] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function countRows(paths, read, matches = line => /\[[ x]\]/.test(line)) {
  if (!Array.isArray(paths) || typeof read !== 'function' || typeof matches !== 'function') throw refusal('count-input-invalid', 'paths must be an array and read/matches must be functions')
  const perFile = paths.map(path => {
    const text = read(path)
    if (typeof text !== 'string') throw refusal('count-read-invalid', `${path} did not read as text`)
    return { path, rows: text.split('\n').filter(matches).length }
  })
  return { total: perFile.reduce((sum, item) => sum + item.rows, 0), perFile }
}

export function assertClaimedCount({ claimed, computed, label = 'report' }) {
  if (!Number.isInteger(claimed) || claimed < 0) throw refusal('count-claim-invalid', `${label} claimed count must be a non-negative integer`)
  if (claimed !== computed) throw refusal('count-mismatch', `${label} claims ${claimed} rows but the files contain ${computed}`)
  return { ok: true, claimed, computed }
}

export function coverageVerdict({ expected, found, gaps = [], openItems = [] }) {
  if (!Number.isInteger(expected) || !Number.isInteger(found) || expected < 0 || found < 0) throw refusal('count-input-invalid', 'expected and found must be non-negative integers')
  if (!Array.isArray(gaps) || !Array.isArray(openItems)) throw refusal('count-input-invalid', 'gaps and openItems must be arrays')
  return {
    complete: found >= expected && gaps.length === 0 && openItems.length === 0,
    short: Math.max(0, expected - found),
    gaps: gaps.length,
    openItems: openItems.length,
  }
}
