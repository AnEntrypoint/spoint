import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { buildWorldSnapshot, restoreWorldSnapshot, worldDefFingerprint, definitionFingerprintOf } = await import('../src/sdk/WorldPersistence.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const DEF_A = { name: 'arena', entities: [{ id: 'box', app: 'box-static', position: [0, 0, 0] }], spawnPoints: [[0, 1, 0]] }
const DEF_B = { name: 'arena', entities: [{ id: 'box', app: 'box-static', position: [0, 0, 4] }], spawnPoints: [[0, 1, 0]] }
const SAME_A_REORDERED = { spawnPoints: [[0, 1, 0]], entities: [{ position: [0, 0, 0], app: 'box-static', id: 'box' }], name: 'arena' }

const appRuntimeStub = () => ({
  snapshotGameState: () => ({ entities: new Map(), tick: 7, elapsed: 1, respawnTimers: new Map(), timers: new Map(), interactCooldowns: new Map() }),
  entities: new Map(),
  restoreGameState(state) { this.restored = state }
})

const storageWith = snap => ({ get: async () => snap, set: async () => {} })

const ctxFor = (def, snap) => ({ appRuntime: appRuntimeStub(), physics: null, storage: storageWith(snap), currentWorldDef: def, worldName: def?.name })

const savedUnder = def => buildWorldSnapshot(appRuntimeStub(), null, def.name, worldDefFingerprint(def))

check('the fingerprint is stable under key order', worldDefFingerprint(DEF_A) === worldDefFingerprint(SAME_A_REORDERED))
check('the fingerprint changes when the definition changes', worldDefFingerprint(DEF_A) !== worldDefFingerprint(DEF_B))
check('a saved snapshot carries the fingerprint of its definition', savedUnder(DEF_A).definition === worldDefFingerprint(DEF_A))
check('definitionFingerprintOf is null without a world definition', definitionFingerprintOf({}) === null)

const sameDefinition = await restoreWorldSnapshot(ctxFor(DEF_A, savedUnder(DEF_A)))
check('a snapshot of the same name and definition restores', sameDefinition.restored === true, `reason ${sameDefinition.reason ?? '-'}`)

const edited = await restoreWorldSnapshot(ctxFor(DEF_B, savedUnder(DEF_A)))
check('a snapshot of the same name but an edited definition is refused', edited.restored === false && edited.reason === 'definition-mismatch', `restored ${edited.restored} reason ${edited.reason}`)

const reorderedOnly = await restoreWorldSnapshot(ctxFor(SAME_A_REORDERED, savedUnder(DEF_A)))
check('a reordered but identical definition still restores', reorderedOnly.restored === true, `reason ${reorderedOnly.reason ?? '-'}`)

const legacy = { ...savedUnder(DEF_A), definition: undefined }
const unfingerprinted = await restoreWorldSnapshot(ctxFor(DEF_A, legacy))
check('a snapshot without a fingerprint is refused, never restored by name alone', unfingerprinted.restored === false && unfingerprinted.reason === 'definition-mismatch', `reason ${unfingerprinted.reason}`)

const renamed = await restoreWorldSnapshot(ctxFor({ ...DEF_A, name: 'tutorial' }, savedUnder(DEF_A)))
check('a different world name is still refused as world-mismatch', renamed.restored === false && renamed.reason === 'world-mismatch', `reason ${renamed.reason}`)

const undefinedCtx = { appRuntime: appRuntimeStub(), physics: null, storage: storageWith(savedUnder(DEF_A)), worldName: 'arena' }
const noDefinition = await restoreWorldSnapshot(undefinedCtx)
check('a restore with no world definition is refused, not compared by name alone', noDefinition.restored === false && noDefinition.reason === 'no-world-definition', `reason ${noDefinition.reason}`)

const failed = checks.filter(c => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map(c => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log(`RESULT: PASS spoint's world restore compares the world definition fingerprint as well as the name: an edited definition under the same name is refused, a reordered identical definition restores, and a snapshot with no fingerprint or no current definition is refused (${checks.length} checks)`)
  await exitAfterQuiesce(0)
}
