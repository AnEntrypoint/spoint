// A path-scoped publish writes the WHOLE blob for a path, so publishing a copy of that path that
// remote main has already moved past silently reverts every edit main took on it since. That is how
// a fix gets clobbered: the commit applies cleanly, the content is an old revision, and CI goes red
// on a change nobody removed. This gate walks the revisions main has taken on each path this publish
// actually changes and refuses when the blob being written is one main has already moved past.

export const REFUSAL_STALE = 'stale-base-publish'
export const STALE_HISTORY_DEPTH = 20

export function planStaleCheck({ entries, atTip, history }) {
  const stale = []
  const current = []
  for (const { rel, blob } of entries ?? []) {
    if (!atTip || !atTip.has(rel)) { current.push(rel); continue }
    if (atTip.get(rel) === blob) { current.push(rel); continue }
    const revs = (history && history[rel]) || []
    let at = -1
    for (let i = 0; i < revs.length; i++) {
      if (revs[i] === null || revs[i] === undefined) continue
      if (revs[i] === blob) { at = i; break }
    }
    if (at > 0) stale.push({ rel, blob, behind: at, at: revs[at] })
    else current.push(rel)
  }
  return { stale, current }
}

export function staleRefusal({ stale, tip }) {
  return [
    `${REFUSAL_STALE}: REFUSING PUBLISH -- ${(stale ?? []).length} path(s) this publish writes carry a revision remote main has already moved past (main is at ${String(tip).slice(0, 12)}):`,
    ...(stale ?? []).map((s) => `  ${s.rel}: this publish carries ${short(s.blob)}, which is exactly what main had ${s.behind} commit(s) ago (${short(s.at)})`),
    'a path-scoped publish writes the whole blob, so publishing an older revision reverts every edit main has taken on that path since, and nothing on either side reports it.',
    'fix: re-read these path(s) from remote main, re-apply your edit on top of the current tip, and publish again',
  ]
}

const short = (sha) => (sha === null || sha === undefined ? '(absent)' : String(sha).slice(0, 12))
