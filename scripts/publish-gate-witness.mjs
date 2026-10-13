import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CHECK_REL, WITNESS_ROOT, REFUSAL_ABSENT, REFUSAL_EMPTY_PARSE, parseCheckPins, missingCheckPins, checkPinRefusal, emptyParseRefusal } from './lib/check-pin-gate.mjs'
import { REFUSAL_CONTESTED, planRebaseOnTip, contestedRefusal } from './lib/tip-rebase.mjs'
import { REFUSAL_STALE, planStaleCheck, staleRefusal } from './lib/stale-base.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkPath = join(root, CHECK_REL)
const publisherPath = join(root, 'scripts', 'lib', 'git-api-publish.mjs')

const ABSENT = 'scripts/absent-witness-1013.mjs'
const ABSENT_TWO = 'scripts/second-absent-witness-1013.mjs'
const CARRIED = 'scripts/carried-witness-1013.mjs'
const ON_REMOTE = 'scripts/already-on-remote-1013.mjs'

const V1 = 'a'.repeat(40)
const V2 = 'b'.repeat(40)
const V3 = 'c'.repeat(40)
const V4 = 'd'.repeat(40)
const P = 'scripts/check.mjs'
const Q = 'scripts/lib/tip-rebase.mjs'

const synth = (rows) => 'const NO_GPU_WITNESSES = [\n' + rows.map((f) => `  { file: '${f}', must: /RESULT: PASS/ },`).join('\n') + '\n]\n'

let total = 0
let failures = 0
const check = (name, ok, detail) => {
  total += 1
  if (!ok) failures += 1
  console.log(`CHECK ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`)
}

const realText = readFileSync(checkPath, 'utf8')
const realPins = parseCheckPins(realText)
const realMatches = (realText.match(/file: '[^']+'/g) || []).length
check('real-check-parses', realPins.length >= 20 && realPins.length <= realMatches,
  `${realPins.length} pin(s) parsed out of ${CHECK_REL} over ${realMatches} quoted file: literal(s)`)
check('real-check-pins-are-scripts-relative', realPins.every((p) => p.startsWith(WITNESS_ROOT + '/')),
  realPins.every((p) => p.startsWith(WITNESS_ROOT + '/')) ? `all ${realPins.length} under ${WITNESS_ROOT}/` : realPins.filter((p) => !p.startsWith(WITNESS_ROOT + '/')).join(','))
check('both-pin-tables-covered', realPins.includes('scripts/msgpack-negative-zero-witness.mjs') && realPins.includes('scripts/planet-multiplayer-harness.mjs'),
  `NO_GPU table ${realPins.includes('scripts/msgpack-negative-zero-witness.mjs')}, SLOW table ${realPins.includes('scripts/planet-multiplayer-harness.mjs')}`)

const onePin = parseCheckPins(synth([ABSENT]))
check('absent-witness-is-missing', onePin.length === 1 && onePin[0] === ABSENT, `${onePin.length} pin(s): ${onePin.join(',') || 'none'}`)

const refused = missingCheckPins({ pins: onePin, publishing: new Set([CHECK_REL]), remoteHas: () => false })
check('absent-witness-refused', refused.length === 1 && refused[0] === ABSENT, `missing ${refused.length}: ${refused.join(',') || 'none'}`)

const refusalText = checkPinRefusal({ missing: refused, publishingPaths: [CHECK_REL] }).join('\n')
check('refusal-names-the-witness', refusalText.includes(ABSENT), `${REFUSAL_ABSENT} message carries ${ABSENT}`)
check('refusal-carries-its-code', refusalText.includes(REFUSAL_ABSENT), `code ${REFUSAL_ABSENT}`)
check('refusal-names-the-publish-together', refusalText.includes(CHECK_REL) && refusalText.includes('--message-file='), 'the fix line publishes both path(s) in one commit')

const twoMissing = missingCheckPins({ pins: [ABSENT, ABSENT_TWO], publishing: new Set([CHECK_REL]), remoteHas: () => false })
check('every-missing-pin-is-named', twoMissing.length === 2 && checkPinRefusal({ missing: twoMissing, publishingPaths: [CHECK_REL] }).join('\n').includes(ABSENT_TWO),
  `${twoMissing.length} missing, second named in the refusal`)

const acceptedSameCommit = missingCheckPins({ pins: [CARRIED], publishing: new Set([CHECK_REL, CARRIED]), remoteHas: () => false })
check('same-commit-accepted', acceptedSameCommit.length === 0, `missing ${acceptedSameCommit.length} when the commit carries ${CARRIED}`)

const acceptedOnRemote = missingCheckPins({ pins: [ON_REMOTE], publishing: new Set([CHECK_REL]), remoteHas: (rel) => rel === ON_REMOTE })
check('already-on-remote-accepted', acceptedOnRemote.length === 0, `missing ${acceptedOnRemote.length} when remote already has ${ON_REMOTE}`)

const mixed = missingCheckPins({ pins: [ON_REMOTE, ABSENT], publishing: new Set([CHECK_REL]), remoteHas: (rel) => rel === ON_REMOTE })
check('mixed-case-names-only-the-absent-one', mixed.length === 1 && mixed[0] === ABSENT, `missing ${mixed.join(',') || 'none'}`)

const emptyPins = parseCheckPins('const NO_GPU_WITNESSES = []\nconst SLOW_NO_GPU_WITNESSES = []\n')
check('empty-parse-refuses', emptyPins.length === 0 && emptyParseRefusal().join('\n').includes(REFUSAL_EMPTY_PARSE),
  `0 pin(s) parsed, refusal code ${REFUSAL_EMPTY_PARSE}`)

const carriedUnchanged = planRebaseOnTip({
  entries: [{ rel: P, blob: V1, binary: false }, { rel: Q, blob: V3, binary: false }],
  prevAtTip: new Map([[P, V1], [Q, V1]]),
  atTip: new Map([[P, V2], [Q, V1]]),
})
check('race-adopts-the-new-tip-for-an-unchanged-path', carriedUnchanged.adopt.length === 1 && carriedUnchanged.adopt[0].rel === P && carriedUnchanged.adopt[0].sha === V2,
  `adopted ${carriedUnchanged.adopt.map((a) => a.rel + '@' + a.sha.slice(0, 7)).join(',') || 'none'}, kept ${carriedUnchanged.keep.join(',') || 'none'}`)
check('race-keeps-the-path-remote-did-not-move', carriedUnchanged.keep.length === 1 && carriedUnchanged.keep[0] === Q, `kept ${carriedUnchanged.keep.join(',') || 'none'}`)
check('race-adopt-is-not-contested', carriedUnchanged.contested.length === 0, `contested ${carriedUnchanged.contested.length}`)

const bothMoved = planRebaseOnTip({
  entries: [{ rel: P, blob: V3, binary: false }],
  prevAtTip: new Map([[P, V1]]),
  atTip: new Map([[P, V2]]),
})
const bothMovedText = contestedRefusal({ contested: bothMoved.contested, tip: V2 }).join('\n')
check('race-refuses-a-path-both-sides-moved', bothMoved.contested.length === 1 && bothMoved.contested[0].rel === P && bothMoved.adopt.length === 0,
  `contested ${bothMoved.contested.map((c) => c.rel).join(',') || 'none'}, adopt ${bothMoved.adopt.length}`)
check('contested-refusal-names-the-path-and-its-code', bothMovedText.includes(P) && bothMovedText.includes(REFUSAL_CONTESTED),
  `${REFUSAL_CONTESTED} message carries ${P}`)

const createdRemotely = planRebaseOnTip({
  entries: [{ rel: P, blob: V4, binary: false }],
  prevAtTip: new Map(),
  atTip: new Map([[P, V2]]),
})
check('race-refuses-a-path-remote-created-under-it', createdRemotely.contested.length === 1 && createdRemotely.adopt.length === 0,
  `contested ${createdRemotely.contested.length}, adopt ${createdRemotely.adopt.length}`)

const deletedRemotely = planRebaseOnTip({
  entries: [{ rel: P, blob: V1, binary: false }],
  prevAtTip: new Map([[P, V1]]),
  atTip: new Map(),
})
check('race-refuses-a-path-remote-deleted-under-it', deletedRemotely.contested.length === 1 && deletedRemotely.adopt.length === 0,
  `contested ${deletedRemotely.contested.length}, adopt ${deletedRemotely.adopt.length}`)

const noRace = planRebaseOnTip({
  entries: [{ rel: P, blob: V3, binary: false }],
  prevAtTip: new Map([[P, V1]]),
  atTip: new Map([[P, V1]]),
})
check('an-unmoved-tip-changes-nothing', noRace.keep.length === 1 && noRace.adopt.length === 0 && noRace.contested.length === 0,
  `kept ${noRace.keep.join(',') || 'none'}`)

const binaryMoved = planRebaseOnTip({
  entries: [{ rel: 'apps/tps-game/x.glb', blob: V1, binary: true }],
  prevAtTip: new Map([['apps/tps-game/x.glb', V1]]),
  atTip: new Map([['apps/tps-game/x.glb', V2]]),
})
check('a-moved-binary-is-refused-not-rebuilt', binaryMoved.contested.length === 1 && binaryMoved.adopt.length === 0,
  `contested ${binaryMoved.contested.length}, adopt ${binaryMoved.adopt.length}`)

const staleBehind = planStaleCheck({
  entries: [{ rel: P, blob: V1 }],
  atTip: new Map([[P, V3]]),
  history: { [P]: [V3, V2, V1] },
})
const staleText = staleRefusal({ stale: staleBehind.stale, tip: V3 }).join('\n')
check('stale-base-is-refused', staleBehind.stale.length === 1 && staleBehind.stale[0].rel === P && staleBehind.stale[0].behind === 2,
  `stale ${staleBehind.stale.map((s) => s.rel + ' behind ' + s.behind).join(',') || 'none'}`)
check('stale-refusal-names-the-path-and-its-code', staleText.includes(P) && staleText.includes(REFUSAL_STALE),
  `${REFUSAL_STALE} message carries ${P}`)

const freshEdit = planStaleCheck({
  entries: [{ rel: P, blob: V3 }],
  atTip: new Map([[P, V1]]),
  history: { [P]: [V1, V2] },
})
check('an-edit-that-matches-no-past-revision-is-accepted', freshEdit.stale.length === 0 && freshEdit.current.length === 1,
  `stale ${freshEdit.stale.length}, current ${freshEdit.current.join(',') || 'none'}`)

const matchesTip = planStaleCheck({
  entries: [{ rel: P, blob: V1 }],
  atTip: new Map([[P, V1]]),
  history: { [P]: [V1, V2] },
})
check('a-path-identical-to-the-tip-is-skipped', matchesTip.stale.length === 0, `stale ${matchesTip.stale.length}`)

const newPath = planStaleCheck({
  entries: [{ rel: P, blob: V3 }],
  atTip: new Map(),
  history: { [P]: [] },
})
check('a-path-absent-from-the-tip-is-skipped', newPath.stale.length === 0, `stale ${newPath.stale.length}`)

const publisher = readFileSync(publisherPath, 'utf8')
const gateCall = publisher.indexOf('enforceCheckPinGate(atTip)')
const atTipBuilt = publisher.indexOf('const atTip = new Map()')
const firstPost = publisher.indexOf("method: 'POST'")
const tipFetch = publisher.indexOf("/git/ref/heads/main'").valueOf()
const rereread = publisher.indexOf('    prepared = readPrepared()')
const rebaseCall = publisher.indexOf('planRebaseOnTip(')
const PIN_MODULE = ['check-pin-gate', '.mjs'].join('')
const REBASE_MODULE = ['tip-rebase', '.mjs'].join('')
const importOf = (name) => new RegExp("from '[^']*" + name + "'")
const STALE_MODULE = ['stale-base', '.mjs'].join('')
check('gate-is-wired-into-the-publisher', gateCall > 0 && importOf(PIN_MODULE).test(publisher) && importOf(REBASE_MODULE).test(publisher) && importOf(STALE_MODULE).test(publisher),
  `gate call at ${gateCall}, pin import ${importOf(PIN_MODULE).test(publisher)}, rebase import ${importOf(REBASE_MODULE).test(publisher)}, stale import ${importOf(STALE_MODULE).test(publisher)}`)
check('gate-runs-after-the-tip-tree-is-known', gateCall > atTipBuilt && atTipBuilt > 0, `atTip at ${atTipBuilt}, gate at ${gateCall}`)
check('gate-runs-before-the-first-write', gateCall > 0 && firstPost > 0 && gateCall < firstPost, `gate at ${gateCall}, first POST at ${firstPost}`)
check('gate-refuses-not-warns', publisher.includes('refuse(checkPinRefusal(') && publisher.includes('refuse(emptyParseRefusal()'),
  'both refusal paths call refuse()')
check('blobs-are-read-per-attempt-not-once-before-the-loop', rereread > tipFetch && rereread < firstPost,
  `tip fetch at ${tipFetch}, prepared read at ${rereread}, first POST at ${firstPost}`)
check('rebase-runs-per-attempt-before-the-pin-gate', rebaseCall > rereread && rebaseCall < gateCall && publisher.includes('prevAtTip = atTip'),
  `rebase at ${rebaseCall}, prepared read at ${rereread}, gate at ${gateCall}, prevAtTip carried ${publisher.includes('prevAtTip = atTip')}`)
check('an-adopted-blob-is-written-by-sha-not-by-stale-text', publisher.includes('if (p.sha !== null)') && publisher.indexOf('if (p.sha !== null)') < firstPost,
  'the tree build reuses the new tip blob sha')
const staleCall = publisher.indexOf('enforceStaleBaseGate(tip, atTip)')
check('stale-base-gate-runs-before-the-first-write', staleCall > gateCall && staleCall < firstPost,
  `pin gate at ${gateCall}, stale gate at ${staleCall}, first POST at ${firstPost}`)
check('stale-base-gate-refuses-not-warns', publisher.includes('refuse(staleRefusal('),
  'the stale refusal calls refuse()')

const absentHere = realPins.filter((p) => {
  try { readFileSync(join(root, p)); return false } catch { return true }
})
console.log(`MEASURED publish-gate: ${realPins.length} pin(s) in the work tree copy of ${CHECK_REL}, ${absentHere.length} of them absent from this work tree right now${absentHere.length ? ': ' + absentHere.join(', ') : ''}`)

console.log(`[publish-gate] RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} -- ${total - failures} of ${total} check(s) passed`)
process.exit(failures === 0 ? 0 : 1)
