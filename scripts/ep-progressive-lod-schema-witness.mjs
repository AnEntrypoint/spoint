#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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

function withMutatedPayload(srcGlb, destGlb, mutate) {
  const { json, bin } = readGlb(srcGlb)
  const payload = JSON.parse(JSON.stringify(json.extensions.EP_progressive_lod))
  mutate(payload)
  json.extensions.EP_progressive_lod = payload
  writeGlb(destGlb, json, bin)
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

  const accept = run([validateTool, baked])
  console.log(`${(accept.stdout || '').trim()}\n${(accept.stderr || '').trim()}`.trim())
  expect(accept.status === 0, `validator exits 0 on the real payload (exit ${accept.status})`)
  expect(
    `${accept.stdout}${accept.stderr}`.includes('[ajv (draft-07) + structural'),
    'validator reports the ajv (draft-07) + structural mode'
  )

  const versionZero = path.join(outDir, 'version-zero.glb')
  withMutatedPayload(baked, versionZero, (p) => { p.version = 0 })
  const rejectVersion = run([validateTool, versionZero])
  const versionOut = `${rejectVersion.stdout || ''}${rejectVersion.stderr || ''}`.trim()
  console.log(versionOut)
  expect(rejectVersion.status === 1, `validator exits 1 on version:0 (exit ${rejectVersion.status})`)
  expect(versionOut.includes('must be >= 1'), 'reject reports the draft-07 minimum violation ajv alone can see')

  const badAabb = path.join(outDir, 'decode-aabb-array.glb')
  withMutatedPayload(baked, badAabb, (p) => {
    for (const mesh of p.meshes) {
      for (const lod of mesh.lods) {
        if (lod.decodeAABB) lod.decodeAABB = [[0, 0, 0], [1, 1, 1]]
      }
    }
  })
  const rejectAabb = run([validateTool, badAabb])
  const aabbOut = `${rejectAabb.stdout || ''}${rejectAabb.stderr || ''}`.trim()
  console.log(aabbOut)
  expect(rejectAabb.status === 1, `validator exits 1 on an array-form decodeAABB (exit ${rejectAabb.status})`)
  expect(aabbOut.includes('decodeAABB'), 'reject names decodeAABB, the shape no producer or consumer uses')

  const extraKey = path.join(outDir, 'additional-property.glb')
  withMutatedPayload(baked, extraKey, (p) => { p.speculativeField = 'unpublished' })
  const rejectExtra = run([validateTool, extraKey])
  const extraOut = `${rejectExtra.stdout || ''}${rejectExtra.stderr || ''}`.trim()
  console.log(extraOut)
  expect(rejectExtra.status === 1, `validator exits 1 on an undeclared top-level property (exit ${rejectExtra.status})`)
  expect(
    extraOut.toLowerCase().includes('additional properties'),
    'reject reports the additionalProperties violation ajv alone can see'
  )

  console.log(`[ep-progressive-lod-witness] RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s))`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('[ep-progressive-lod-witness] FAILED:', err)
  console.log('[ep-progressive-lod-witness] RESULT: FAIL')
  process.exitCode = 1
})
