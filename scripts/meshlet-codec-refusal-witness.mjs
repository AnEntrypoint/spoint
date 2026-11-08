import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const { parseClusterLod, CLUSTER_LOD_EXTRA_KEY } = await import(pathToFileURL(resolve(ROOT, 'packages/streaming-gltf/src/meshlet-codec.js')).href)

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`[meshlet-codec-refusal] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}
const outcomeOf = (extras) => {
  try {
    const r = parseClusterLod(extras)
    return r === null ? { kind: 'null' } : { kind: 'value', value: r }
  } catch (e) {
    return { kind: 'error', code: e.code }
  }
}
const record = (clusters) => ({ [CLUSTER_LOD_EXTRA_KEY]: { version: 2, lodCount: 1, clusters } })
const goodCluster = { aabb: [0, 0, 0, 1, 1, 1], sphere: [0.5, 0.5, 0.5, 0.866], lods: [[0, 3, 0]] }

const absentA = outcomeOf(undefined)
const absentB = outcomeOf({})
const absentC = outcomeOf({ [CLUSTER_LOD_EXTRA_KEY]: null })
check('absent record (no extras) returns null', absentA.kind === 'null', JSON.stringify(absentA))
check('extras without the key return null', absentB.kind === 'null', JSON.stringify(absentB))
check('null record returns null', absentC.kind === 'null', JSON.stringify(absentC))

const good = outcomeOf(record([goodCluster]))
check('well-formed record parses to one cluster', good.kind === 'value' && good.value.clusters.length === 1, JSON.stringify(good.kind))

const malformed = {
  shortAabb: record([{ ...goodCluster, aabb: [0, 0, 0, 1, 1] }]),
  badSphereLength: record([{ ...goodCluster, sphere: [0.5, 0.5] }]),
  missingLods: record([{ aabb: goodCluster.aabb, sphere: goodCluster.sphere }]),
  nonFiniteOffset: record([{ ...goodCluster, lods: [[Number.NaN, 3, 0]] }]),
  clustersNotArray: { [CLUSTER_LOD_EXTRA_KEY]: { version: 2, clusters: 'nope' } },
  recordWithoutClusters: { [CLUSTER_LOD_EXTRA_KEY]: { version: 2, lodCount: 1 } },
}
for (const [name, extras] of Object.entries(malformed)) {
  const o = outcomeOf(extras)
  check(`malformed record (${name}) refuses with a code`, o.kind === 'error' && typeof o.code === 'string' && o.code.length > 0, JSON.stringify(o))
}

const failed = results.filter((ok) => !ok).length
console.log(`[meshlet-codec-refusal] ${results.length - failed}/${results.length} checks passed`)
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(failed === 0 ? 0 : 1)
