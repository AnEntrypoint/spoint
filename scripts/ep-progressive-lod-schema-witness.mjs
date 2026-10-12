#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const pkgDir = path.join(repoRoot, 'packages/streaming-gltf')
const bakeTool = path.join(pkgDir, 'tools/bake-cluster.mjs')
const validateTool = path.join(pkgDir, 'tools/validate-extension.mjs')
const outDir = path.join(tmpdir(), 'ep-progressive-lod-schema-witness')

let failures = 0
function expect(cond, msg) {
  if (cond) {
    console.log(`[ep-progressive-lod-witness] ok   ${msg}`)
    return
  }
  failures += 1
  console.log(`[ep-progressive-lod-witness] FAIL ${msg}`)
}

function run(args, cwd) {
  return spawnSync(process.execPath, args, { cwd: cwd || repoRoot, encoding: 'utf8' })
}

function readGlb(fp) {
  const buf = readFileSync(fp)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error(`not a GLB: ${fp}`)
  const jsonLen = dv.getUint32(12, true)
  const json = JSON.parse(Buffer.from(buf.subarray(20, 20 + jsonLen)).toString('utf8'))
  const binStart = 20 + jsonLen + 8
  const binLen = dv.getUint32(20 + jsonLen, true)
  return { json, bin: buf.subarray(binStart, binStart + binLen) }
}

function writeGlb(fp, json, bin) {
  const jsonStr = JSON.stringify(json)
  const jsonPad = (4 - (jsonStr.length % 4)) % 4
  const jsonBuf = Buffer.alloc(jsonStr.length + jsonPad, 0x20)
  Buffer.from(jsonStr).copy(jsonBuf)
  const binPad = (4 - (bin.length % 4)) % 4
  const binBuf = Buffer.concat([Buffer.from(bin), Buffer.alloc(binPad, 0)])
  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length
  const out = Buffer.alloc(total)
  let p = 0
  out.writeUInt32LE(0x46546c67, p); p += 4
  out.writeUInt32LE(2, p); p += 4
  out.writeUInt32LE(total, p); p += 4
  out.writeUInt32LE(jsonBuf.length, p); p += 4
  out.writeUInt32LE(0x4e4f534a, p); p += 4
  jsonBuf.copy(out, p); p += jsonBuf.length
  out.writeUInt32LE(binBuf.length, p); p += 4
  out.writeUInt32LE(0x004e4942, p); p += 4
  binBuf.copy(out, p)
  writeFileSync(fp, out)
}

// A mutation that silently touches nothing would sail through a "the validator rejects it" check,
// so every mutation reports how many sites it rewrote and the witness refuses a zero.
function withMutatedPayload(srcGlb, destGlb, mutate) {
  const { json, bin } = readGlb(srcGlb)
  const payload = JSON.parse(JSON.stringify(json.extensions.EP_progressive_lod))
  const touched = mutate(payload)
  json.extensions.EP_progressive_lod = payload
  writeGlb(destGlb, json, bin)
  return Number.isInteger(touched) ? touched : -1
}

function bakeReport(stdout) {
  const m = /clustered (\d+) prim\(s\), (\d+) clusters, skinned-lodded (\d+) prim\(s\), skipped (\d+)/.exec(stdout || '')
  if (!m) return null
  return { clustered: Number(m[1]), clusters: Number(m[2]), skinnedLodded: Number(m[3]), skipped: Number(m[4]) }
}

// EP_cluster_lod has no published schema, so the bake's cluster output is the only place its
// content can be checked; these are the rules a consumer relies on and nothing else verifies.
function clusterFindings(json) {
  const errs = []
  let prims = 0
  let clusters = 0
  let lods = 0
  let indexSum = 0
  for (let mi = 0; mi < (json.meshes || []).length; mi++) {
    const list = json.meshes[mi].primitives || []
    for (let pi = 0; pi < list.length; pi++) {
      const prim = list[pi]
      const e = prim.extras && prim.extras.EP_cluster_lod
      if (!e) continue
      prims++
      const where = `meshes[${mi}].primitives[${pi}].extras.EP_cluster_lod`
      if (!Number.isInteger(e.version) || e.version < 1) errs.push(`${where}.version: ${JSON.stringify(e.version ?? null)}`)
      if (!Array.isArray(e.clusters) || e.clusters.length === 0) { errs.push(`${where}.clusters: empty, so this primitive carries no cluster content`); continue }
      if (e.clusterCount !== e.clusters.length) errs.push(`${where}.clusterCount ${e.clusterCount} != clusters.length ${e.clusters.length}`)
      if (!Number.isInteger(e.lodCount) || e.lodCount < 1) errs.push(`${where}.lodCount: ${JSON.stringify(e.lodCount ?? null)}`)
      const coarse = json.accessors[e.coarseIndexAccessor]
      if (!coarse) errs.push(`${where}.coarseIndexAccessor ${JSON.stringify(e.coarseIndexAccessor)}: no such accessor`)
      else if (coarse.type !== 'SCALAR') errs.push(`${where}.coarseIndexAccessor ${e.coarseIndexAccessor}: type ${coarse.type}, expected SCALAR`)
      const idxAcc = json.accessors[prim.indices]
      let lod0Sum = 0
      let coarseSum = 0
      for (let ci = 0; ci < e.clusters.length; ci++) {
        const c = e.clusters[ci]
        clusters++
        const cw = `${where}.clusters[${ci}]`
        if (!Array.isArray(c.aabb) || c.aabb.length !== 6 || !c.aabb.every((v) => Number.isFinite(v))) errs.push(`${cw}.aabb: ${JSON.stringify(c.aabb ?? null)}`)
        else for (let a = 0; a < 3; a++) if (c.aabb[a] > c.aabb[a + 3]) errs.push(`${cw}.aabb: min ${c.aabb[a]} > max ${c.aabb[a + 3]} on axis ${a}`)
        if (!Array.isArray(c.sphere) || c.sphere.length !== 4 || !c.sphere.every((v) => Number.isFinite(v)) || !(c.sphere[3] > 0)) errs.push(`${cw}.sphere: ${JSON.stringify(c.sphere ?? null)}`)
        if (!Array.isArray(c.lods) || c.lods.length === 0) { errs.push(`${cw}.lods: empty`); continue }
        for (let li = 0; li < c.lods.length; li++) {
          const l = c.lods[li]
          lods++
          if (!Array.isArray(l) || l.length !== 3 || !l.every((v) => Number.isInteger(v) && v >= 0)) { errs.push(`${cw}.lods[${li}]: ${JSON.stringify(l ?? null)}`); continue }
          if (l[1] <= 0) errs.push(`${cw}.lods[${li}]: count ${l[1]}`)
          if (l[2] > 1) errs.push(`${cw}.lods[${li}]: stream ${l[2]}`)
          if (li === 0) lod0Sum += l[1]
          if (l[2] === 1) coarseSum += l[1]
        }
      }
      if (idxAcc && lod0Sum !== idxAcc.count) errs.push(`${where}: LOD0 index sum ${lod0Sum} != primitive indices count ${idxAcc.count}, so the cluster set does not tile the mesh it replaces`)
      if (coarse && e.coarseIndexCount !== coarseSum) errs.push(`${where}: coarseIndexCount ${e.coarseIndexCount} != coarse-stream index sum ${coarseSum}`)
      indexSum += lod0Sum
    }
  }
  return { errs, prims, clusters, lods, indexSum }
}

function mutatedClusterFindings(srcGlb, mutate) {
  const { json, bin } = readGlb(srcGlb)
  const touched = mutate(json)
  const destGlb = `${srcGlb}.mutated.glb`
  writeGlb(destGlb, json, bin)
  return { ...clusterFindings(json), touched, destGlb }
}

async function main() {
  const resolveProbe = run(['-e', "process.stdout.write(require.resolve('ajv'))"], pkgDir)
  expect(resolveProbe.status === 0, `require.resolve('ajv') succeeds from packages/streaming-gltf`)
  console.log(`[ep-progressive-lod-witness] ajv path: ${resolveProbe.stdout}`)

  const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  expect(
    Boolean(pkgJson.devDependencies && pkgJson.devDependencies.ajv),
    `packages/streaming-gltf devDependencies declares ajv (${pkgJson.devDependencies && pkgJson.devDependencies.ajv})`
  )
  const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'))
  expect(
    Boolean(lock.packages && lock.packages['node_modules/ajv']),
    `package-lock.json carries node_modules/ajv (${lock.packages && lock.packages['node_modules/ajv'] && lock.packages['node_modules/ajv'].version})`
  )

  const input = process.argv[2] || path.join('apps', 'tps-game', 'cleetus.glb')
  const clusterInput = process.argv[3] || path.join('apps', 'tps-game', 'schwust.glb')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const baked = path.join(outDir, 'baked.glb')

  const bake = run([bakeTool, input, baked])
  expect(bake.status === 0, `bake-cluster produces a real GLB (exit ${bake.status})`)
  console.log((bake.stdout || '').trim().split('\n').filter((l) => l.includes('[bake-cluster]')).join('\n'))
  const bakedJson = readGlb(baked).json
  expect(
    Boolean(bakedJson.extensions && bakedJson.extensions.EP_progressive_lod),
    'baked GLB carries extensions.EP_progressive_lod'
  )
  const payload = bakedJson.extensions.EP_progressive_lod
  const lodPayloads = payload.meshes.reduce((n, m) => n + m.lods.length, 0)
  console.log(`[ep-progressive-lod-witness] payload: version=${payload.version} storage=${payload.storage} meshes=${payload.meshes.length} lods=${lodPayloads}`)

  expect(payload.meshes.length > 0, `the payload declares at least one LOD chain, so the schema is checked against real content (${payload.meshes.length} mesh(es))`)
  expect(lodPayloads > 0, `the payload declares at least one LOD, so every per-LOD rule below has something to check (${lodPayloads} LOD(s))`)
  const badRatio = []
  const badField = []
  let siblingFiles = 0
  let siblingBytes = 0
  for (const [mi, m] of payload.meshes.entries()) {
    if (!Number.isInteger(m.meshIndex)) badField.push(`meshes[${mi}].meshIndex`)
    if (!Number.isInteger(m.primIndex)) badField.push(`meshes[${mi}].primIndex`)
    for (const [li, l] of m.lods.entries()) {
      if (!(typeof l.ratio === 'number' && l.ratio > 0 && l.ratio <= 1)) badRatio.push(`meshes[${mi}].lods[${li}].ratio=${JSON.stringify(l.ratio ?? null)}`)
      if (l.inline === false) {
        if (!(Number.isInteger(l.indexCount) && l.indexCount > 0)) badField.push(`meshes[${mi}].lods[${li}].indexCount`)
        if (!(Number.isInteger(l.vertexCount) && l.vertexCount > 0)) badField.push(`meshes[${mi}].lods[${li}].vertexCount`)
        const sib = path.join(outDir, l.path)
        if (!existsSync(sib)) { badField.push(`meshes[${mi}].lods[${li}].path ${l.path} absent on disk`); continue }
        const size = statSync(sib).size
        siblingFiles++
        siblingBytes += size
        if (size !== l.bytes) badField.push(`meshes[${mi}].lods[${li}].bytes ${l.bytes} != ${size} on disk`)
        if (size === 0) badField.push(`meshes[${mi}].lods[${li}].path ${l.path} is empty`)
      }
    }
  }
  expect(badRatio.length === 0, `every LOD ratio is in (0,1] and was read, not defaulted (${badRatio.length} of ${lodPayloads} bad${badRatio.length ? `: ${badRatio.slice(0, 4).join(', ')}` : ''})`)
  expect(badField.length === 0, `every LOD carries a positive index/vertex count and its non-inline sibling file exists on disk at the declared size (${badField.length} bad${badField.length ? `: ${badField.slice(0, 4).join(', ')}` : ''})`)
  expect(siblingFiles > 0, `storage=sibling-file was exercised: ${siblingFiles} sibling LOD file(s) totalling ${siblingBytes} byte(s) were read back from disk`)
  expect(Array.isArray(payload.textures), `payload.textures is an array, which model-pool.js iterates (${JSON.stringify(payload.textures)})`)

  const accept = run([validateTool, baked])
  console.log(`${(accept.stdout || '').trim()}\n${(accept.stderr || '').trim()}`.trim())
  expect(accept.status === 0, `validator exits 0 on the real payload (exit ${accept.status})`)
  expect(
    `${accept.stdout}${accept.stderr}`.includes('[ajv (draft-07) + structural'),
    'validator reports the ajv (draft-07) + structural mode'
  )

  const versionZero = path.join(outDir, 'version-zero.glb')
  const versionTouched = withMutatedPayload(baked, versionZero, (p) => { p.version = 0; return 1 })
  expect(versionTouched > 0, `the version mutation rewrote a real site (${versionTouched} site(s))`)
  const rejectVersion = run([validateTool, versionZero])
  const versionOut = `${rejectVersion.stdout || ''}${rejectVersion.stderr || ''}`.trim()
  console.log(versionOut)
  expect(rejectVersion.status === 1, `validator exits 1 on version:0 (exit ${rejectVersion.status})`)
  expect(versionOut.includes('must be >= 1'), 'reject reports the draft-07 minimum violation ajv alone can see')

  const badAabb = path.join(outDir, 'decode-aabb-array.glb')
  const aabbTouched = withMutatedPayload(baked, badAabb, (p) => {
    let n = 0
    for (const mesh of p.meshes) {
      for (const lod of mesh.lods) {
        if (lod.decodeAABB) { lod.decodeAABB = [[0, 0, 0], [1, 1, 1]]; n++ }
      }
    }
    return n
  })
  expect(aabbTouched > 0, `the decodeAABB mutation rewrote a real site (${aabbTouched} site(s))`)
  const rejectAabb = run([validateTool, badAabb])
  const aabbOut = `${rejectAabb.stdout || ''}${rejectAabb.stderr || ''}`.trim()
  console.log(aabbOut)
  expect(rejectAabb.status === 1, `validator exits 1 on an array-form decodeAABB (exit ${rejectAabb.status})`)
  expect(aabbOut.includes('decodeAABB'), 'reject names decodeAABB, the shape no producer or consumer uses')

  const extraKey = path.join(outDir, 'additional-property.glb')
  const extraTouched = withMutatedPayload(baked, extraKey, (p) => { p.speculativeField = 'unpublished'; return 1 })
  expect(extraTouched > 0, `the additional-property mutation rewrote a real site (${extraTouched} site(s))`)
  const rejectExtra = run([validateTool, extraKey])
  const extraOut = `${rejectExtra.stdout || ''}${rejectExtra.stderr || ''}`.trim()
  console.log(extraOut)
  expect(rejectExtra.status === 1, `validator exits 1 on an undeclared top-level property (exit ${rejectExtra.status})`)
  expect(
    extraOut.toLowerCase().includes('additional properties'),
    'reject reports the additionalProperties violation ajv alone can see'
  )

  // The skinned input clusters nothing, so a witness that stopped here would print
  // "clustered 0 prim(s), 0 clusters" and never exercise the cluster half of the same baker.
  const clusterBaked = path.join(outDir, 'cluster-baked.glb')
  const clusterBake = run([bakeTool, clusterInput, clusterBaked])
  expect(clusterBake.status === 0, `bake-cluster produces a real GLB for the cluster arm (exit ${clusterBake.status})`)
  console.log((clusterBake.stdout || '').trim().split('\n').filter((l) => l.includes('clustered')).join('\n'))
  const clusterReport = bakeReport(clusterBake.stdout)
  expect(clusterReport !== null, `the cluster bake prints a parseable report, so its counts are measured and not assumed`)
  expect(clusterReport !== null && clusterReport.clustered > 0, `the cluster arm clusters at least one primitive, so cluster content is non-empty (${clusterReport === null ? 'unparsed' : `${clusterReport.clustered} prim(s)`})`)
  expect(clusterReport !== null && clusterReport.clusters > 0, `the cluster arm produces at least one cluster, so every cluster rule below has something to check (${clusterReport === null ? 'unparsed' : `${clusterReport.clusters} cluster(s)`})`)

  const clusterJson = readGlb(clusterBaked).json
  const cf = clusterFindings(clusterJson)
  console.log(`[ep-progressive-lod-witness] cluster content: ${cf.prims} clustered prim(s), ${cf.clusters} cluster(s), ${cf.lods} cluster LOD record(s), ${cf.indexSum} LOD0 index(es)`)
  expect(cf.prims === (clusterReport === null ? -1 : clusterReport.clustered), `every clustered primitive carries extras.EP_cluster_lod (${cf.prims} of ${clusterReport === null ? '?' : clusterReport.clustered})`)
  expect(cf.clusters === (clusterReport === null ? -1 : clusterReport.clusters), `every cluster the report counted was parsed and checked (${cf.clusters} of ${clusterReport === null ? '?' : clusterReport.clusters})`)
  expect(cf.errs.length === 0, `every parsed cluster satisfies the content rules a consumer relies on (${cf.errs.length} finding(s) over ${cf.clusters} cluster(s)${cf.errs.length ? `: ${cf.errs.slice(0, 4).join('; ')}` : ''})`)

  const nullSphere = mutatedClusterFindings(clusterBaked, (json) => {
    let n = 0
    for (const m of json.meshes) {
      for (const p of m.primitives) {
        const e = p.extras && p.extras.EP_cluster_lod
        if (e && e.clusters.length > 0) { e.clusters[0].sphere = null; n++; break }
      }
      if (n > 0) break
    }
    return n
  })
  expect(nullSphere.touched > 0, `the null-sphere mutation rewrote a real cluster (${nullSphere.touched} site(s))`)
  expect(nullSphere.errs.length > 0, `a cluster with no bounding sphere is reported instead of being skipped (${nullSphere.errs.length} finding(s)${nullSphere.errs.length ? `: ${nullSphere.errs[0]}` : ''})`)

  const wrongCount = mutatedClusterFindings(clusterBaked, (json) => {
    let n = 0
    for (const m of json.meshes) {
      for (const p of m.primitives) {
        const e = p.extras && p.extras.EP_cluster_lod
        if (e) { e.clusterCount = e.clusters.length + 1; n++; break }
      }
      if (n > 0) break
    }
    return n
  })
  expect(wrongCount.touched > 0, `the clusterCount mutation rewrote a real prim (${wrongCount.touched} site(s))`)
  expect(wrongCount.errs.length > 0, `a clusterCount that disagrees with the cluster array is reported instead of being trusted (${wrongCount.errs.length} finding(s)${wrongCount.errs.length ? `: ${wrongCount.errs[0]}` : ''})`)

  const brokenTile = mutatedClusterFindings(clusterBaked, (json) => {
    let n = 0
    for (const m of json.meshes) {
      for (const p of m.primitives) {
        const e = p.extras && p.extras.EP_cluster_lod
        if (e && e.clusters.length > 0) { e.clusters[0].lods[0][1] += 1; n++; break }
      }
      if (n > 0) break
    }
    return n
  })
  expect(brokenTile.touched > 0, `the LOD0 tiling mutation rewrote a real cluster (${brokenTile.touched} site(s))`)
  expect(brokenTile.errs.length > 0, `a cluster set that no longer tiles the primitive's indices is reported instead of passing (${brokenTile.errs.length} finding(s)${brokenTile.errs.length ? `: ${brokenTile.errs[0]}` : ''})`)

  console.log(`[ep-progressive-lod-witness] MEASURED ep-progressive-lod-schema: ${payload.meshes.length} mesh(es) / ${lodPayloads} LOD(s) / ${siblingFiles} sibling file(s) of ${siblingBytes} byte(s) validated against the EP_progressive_lod schema, ${cf.prims} clustered prim(s) / ${cf.clusters} cluster(s) / ${cf.lods} cluster LOD record(s) / ${cf.indexSum} LOD0 index(es) checked against the EP_cluster_lod content rules, 3 schema mutation(s) and 3 cluster mutation(s) each rejected`)
  console.log(`[ep-progressive-lod-witness] RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s))`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('[ep-progressive-lod-witness] FAILED:', err)
  console.log('[ep-progressive-lod-witness] RESULT: FAIL')
  process.exitCode = 1
})
