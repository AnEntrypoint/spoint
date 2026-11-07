export const REFUSAL_CONTESTED = 'contested-path-on-new-tip'

export function planRebaseOnTip({ entries, prevAtTip, atTip }) {
  const keep = []
  const adopt = []
  const contested = []
  for (const { rel, blob, binary } of entries ?? []) {
    const prev = prevAtTip && prevAtTip.has(rel) ? prevAtTip.get(rel) : null
    const now = atTip && atTip.has(rel) ? atTip.get(rel) : null
    if (prev === now) { keep.push(rel); continue }
    if (blob === now) { keep.push(rel); continue }
    if (blob === prev && !binary && now !== null) { adopt.push({ rel, sha: now }); continue }
    contested.push({ rel, prev, now, mine: blob })
  }
  return { keep, adopt, contested }
}

export function contestedRefusal({ contested, tip }) {
  return [
    `${REFUSAL_CONTESTED}: REFUSING PUBLISH -- ${(contested ?? []).length} path(s) this publish writes also moved on remote main between the tip it first read and the tip it must now parent on (${String(tip).slice(0, 12)}):`,
    ...(contested ?? []).map((c) => `  ${c.rel}: this publish carries ${short(c.mine)}, remote moved ${short(c.prev)} -> ${short(c.now)}`),
    'a path both this publish and a sibling lane moved cannot be resolved by either side winning, and a retry that re-parents the old blob is exactly how a fix gets silently reverted.',
    'fix: re-read these path(s) from remote main, re-apply your edit on top of the new tip, and publish again',
  ]
}

const short = (sha) => (sha === null || sha === undefined ? '(absent)' : String(sha).slice(0, 12))
