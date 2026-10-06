import WebSocket from 'ws'
import { createServer as createNetServer } from 'node:net'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer as createSpointServer } from '../src/sdk/server.js'
import { loadWorldModule } from '../src/sdk/WorldLocator.js'
import { MSG } from '../src/protocol/MessageTypes.js'
import { pack, unpack, ensurePacked } from '../src/protocol/msgpack.js'

const SDK_ROOT = resolve(process.argv[2] || process.cwd())
const WORK_DIR = resolve(SDK_ROOT, 'data', 'terrain-reseed-witness')
const EDITOR_TOKEN = 'reseed-witness-token'
const WAIT_MS = 240000

const PASS = []
const FAIL = []
function check(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}

const COALESCE_SENTINEL = 0xff
const LEN_PREFIX_BYTES = 4
function decodeFrame(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
  if (!(bytes.length > 0 && bytes[0] === COALESCE_SENTINEL)) return [unpack(bytes)]
  const out = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 1
  while (off + LEN_PREFIX_BYTES <= bytes.length) {
    const len = view.getUint32(off, true); off += LEN_PREFIX_BYTES
    if (off + len > bytes.length) break
    out.push(unpack(bytes.subarray(off, off + len))); off += len
  }
  return out
}

async function openClient(port, label) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  ws.binaryType = 'arraybuffer'
  const client = { label, ws, messages: [], worldDef: null }
  ws.on('message', data => {
    let msgs
    try { msgs = decodeFrame(data) } catch { return }
    for (const m of msgs) {
      client.messages.push(m)
      if (m.type === MSG.WORLD_DEF) client.worldDef = m.payload
    }
  })
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${label}: ws open timeout`)), 15000)
    ws.once('open', () => { clearTimeout(t); res() })
    ws.once('error', e => { clearTimeout(t); rej(e) })
  })
  const started = Date.now()
  while (Date.now() - started < 15000 && !client.messages.some(m => m.type === MSG.HANDSHAKE_ACK)) await new Promise(r => setTimeout(r, 50))
  return client
}

async function send(client, type, payload) {
  client.ws.send(pack({ type, payload }))
}

async function waitFor(client, predicate, label) {
  const started = Date.now()
  while (Date.now() - started < WAIT_MS) {
    const hit = client.messages.find(predicate)
    if (hit) return hit
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`${client.label}: timed out waiting for ${label}`)
}

async function main() {
  await ensurePacked
  process.env.EDITOR_TOKEN = EDITOR_TOKEN
  await mkdir(resolve(WORK_DIR, 'data'), { recursive: true })
  process.chdir(WORK_DIR)

  const freePort = () => new Promise((res, rej) => { const s = createNetServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
  const loaded = await loadWorldModule(resolve(SDK_ROOT, 'apps/world/tps-game.js'))
  const baseSeed = loaded.terrain?.seed
  const worldDef = { ...loaded, entities: loaded.entities.filter(e => e.id !== 'env-sillos') }
  const tickRate = worldDef.tickRate || 64
  const port = await freePort()
  const server = await createSpointServer({
    port, tickRate,
    appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src/stdlib-apps')],
    sdkRoot: SDK_ROOT, gravity: worldDef.gravity, staticDirs: [],
    storageDir: resolve(WORK_DIR, 'data'),
  })
  await server.loadWorld({ ...worldDef, tickRate })
  const info = await server.start()
  console.log(`[reseed-witness] server up on ${info.port}, base terrain seed ${baseSeed}`)

  const liveFields = new Set()
  const realAdd = server.physics.addHeightField.bind(server.physics)
  const realRemove = server.physics.removeBody.bind(server.physics)
  server.physics.addHeightField = (...args) => { const id = realAdd(...args); if (id != null) liveFields.add(id); return id }
  server.physics.removeBody = (id) => { liveFields.delete(id); return realRemove(id) }

  const realSetSource = server.physics.setTerrainHeightSource.bind(server.physics)
  let armedThrows = 0
  server.physics.setTerrainHeightSource = (...args) => {
    if (armedThrows > 0) { armedThrows--; throw new Error('[witness] injected failure: terrain height source rejected') }
    return realSetSource(...args)
  }
  let armedBuildThrows = 0
  server.physics.addHeightField = (...args) => {
    if (armedBuildThrows > 0) { armedBuildThrows--; throw new Error('[witness] injected failure: heightfield body rejected') }
    const id = realAdd(...args)
    if (id != null) liveFields.add(id)
    return id
  }

  const clientA = await openClient(port, 'A')
  const clientB = await openClient(port, 'B')
  await send(clientA, MSG.AUTH_EDITOR, { token: EDITOR_TOKEN })
  const authAck = await waitFor(clientA, m => m.type === MSG.AUTH_EDITOR_ACK, 'AUTH_EDITOR_ACK')
  check('editor client authenticates', authAck.payload?.ok === true, JSON.stringify(authAck.payload))

  const seedOf = async () => {
    const probe = await openClient(port, 'probe')
    const started = Date.now()
    while (Date.now() - started < 15000 && !probe.worldDef) await new Promise(r => setTimeout(r, 50))
    const seed = probe.worldDef?.terrain?.seed
    probe.ws.close()
    return seed
  }

  const SEED1 = (baseSeed | 0) + 101
  const SEED2 = (baseSeed | 0) + 202
  const SEED3 = (baseSeed | 0) + 303

  console.log('[reseed-witness] live edit: a sculpt the reseed must carry')
  await send(clientA, MSG.TERRAIN_SCULPT, { brush: 'raise', x: 40, z: 40, radius: 6, strength: 1 })
  const preSculpt = await waitFor(clientA, m => m.type === MSG.TERRAIN_SCULPT_ACK, 'TERRAIN_SCULPT_ACK')
  const strokesBefore = server.physics._terrainStreamer?.heightDelta?.cellCount ?? 0
  check('a sculpt lands on the terrain that is about to be reseeded', preSculpt.payload?.ok === true && strokesBefore > 0, `${JSON.stringify(preSculpt.payload).slice(0, 200)} cells=${strokesBefore}`)

  console.log('[reseed-witness] control: successful reseed')
  clientA.messages.length = 0
  clientB.messages.length = 0
  await send(clientA, MSG.TERRAIN_RESEED, { seed: SEED1 })
  const okA = await waitFor(clientA, m => m.type === MSG.TERRAIN_CONFIG, 'TERRAIN_CONFIG on A')
  const okB = await waitFor(clientB, m => m.type === MSG.TERRAIN_CONFIG, 'TERRAIN_CONFIG on B')
  check('successful reseed broadcasts ok to the requester', okA.payload?.ok === true, JSON.stringify(okA.payload).slice(0, 200))
  check('successful reseed broadcasts ok to every other client', okB.payload?.ok === true, JSON.stringify(okB.payload).slice(0, 200))
  check('successful reseed publishes the new seed', okA.payload?.config?.seed === SEED1, `config.seed=${okA.payload?.config?.seed}`)
  check('successful reseed leaves a registered terrain streamer', !!server.physics._terrainStreamer)
  check('successful reseed mutates the live world def', (await seedOf()) === SEED1, `worldDef.terrain.seed=${await seedOf()}`)
  const strokesAfter = server.physics._terrainStreamer?.heightDelta?.cellCount ?? 0
  check('a successful reseed carries live sculpts into the new terrain', strokesBefore > 0 && strokesAfter >= strokesBefore, `heightDelta cells ${strokesBefore} -> ${strokesAfter}`)
  const baselineFields = liveFields.size
  console.log(`[reseed-witness] baseline resident heightfield bodies: ${baselineFields}`)

  console.log('[reseed-witness] reentrant reseed while one is in flight')
  clientA.messages.length = 0
  clientB.messages.length = 0
  await send(clientA, MSG.TERRAIN_RESEED, { seed: SEED1 })
  await send(clientA, MSG.TERRAIN_RESEED, { seed: SEED3 })
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline && clientA.messages.filter(m => m.type === MSG.TERRAIN_CONFIG).length < 2) {
    await new Promise(r => setTimeout(r, 50))
  }
  const reentrantReplies = clientA.messages.filter(m => m.type === MSG.TERRAIN_CONFIG)
  const refused = reentrantReplies.find(m => /already running/.test(String(m.payload?.error || '')))
  const succeeded = reentrantReplies.filter(m => m.payload?.ok === true)
  check('a reseed started while another is in flight is refused, not run twice', !!refused, JSON.stringify(reentrantReplies.map(m => m.payload)).slice(0, 300))
  check('exactly one of two overlapping reseeds succeeds', succeeded.length === 1, `ok:true count=${succeeded.length}`)
  check('overlapping reseeds leave one terrain, not two', liveFields.size <= baselineFields, `liveFields=${liveFields.size} baseline=${baselineFields}`)
  check('overlapping reseeds leave a registered terrain streamer', !!server.physics._terrainStreamer)

  console.log('[reseed-witness] injected failure with a working rollback')
  clientA.messages.length = 0
  clientB.messages.length = 0
  armedThrows = 1
  await send(clientA, MSG.TERRAIN_RESEED, { seed: SEED2 })
  const failA = await waitFor(clientA, m => m.type === MSG.TERRAIN_CONFIG, 'TERRAIN_CONFIG on A')
  const failB = await waitFor(clientB, m => m.type === MSG.TERRAIN_CONFIG, 'TERRAIN_CONFIG on B')
  check('failed reseed reports ok:false to the requester', failA.payload?.ok === false, JSON.stringify(failA.payload).slice(0, 300))
  check('failed reseed reports ok:false to every other client', failB.payload?.ok === false, JSON.stringify(failB.payload).slice(0, 300))
  check('failed reseed names the cause', String(failA.payload?.error || '').includes('injected failure'), `error=${failA.payload?.error}`)
  check('failed reseed rolls the previous terrain back', failA.payload?.restored === true, JSON.stringify(failA.payload).slice(0, 300))
  check('failed reseed ships no config, so no client rebuilds its terrain', failA.payload?.config == null && failB.payload?.config == null, `config=${JSON.stringify(failA.payload?.config)}`)
  check('rolled-back world keeps the pre-reseed seed', (await seedOf()) === SEED1, `worldDef.terrain.seed=${await seedOf()}`)
  check('rolled-back world has a live terrain streamer', !!server.physics._terrainStreamer)
  check('rolled-back world keeps its heightfield colliders', liveFields.size > 0, `liveFields=${liveFields.size}`)

  console.log('[reseed-witness] injected failure where the rollback also fails')
  clientA.messages.length = 0
  clientB.messages.length = 0
  armedThrows = 2
  await send(clientA, MSG.TERRAIN_RESEED, { seed: SEED3 })
  const deadA = await waitFor(clientA, m => m.type === MSG.TERRAIN_CONFIG, 'TERRAIN_CONFIG on A')
  const deadB = await waitFor(clientB, m => m.type === MSG.TERRAIN_CONFIG, 'TERRAIN_CONFIG on B')
  check('double failure reports ok:false to every client', deadA.payload?.ok === false && deadB.payload?.ok === false, `${JSON.stringify(deadA.payload).slice(0, 200)} / ${JSON.stringify(deadB.payload).slice(0, 200)}`)
  check('double failure reports restored:false', deadA.payload?.restored === false, JSON.stringify(deadA.payload).slice(0, 300))
  check('double failure publishes no terrain config', deadA.payload?.config == null, `config=${JSON.stringify(deadA.payload?.config)}`)
  check('double failure leaves no terrain streamer registered', server.physics._terrainStreamer == null, `physics._terrainStreamer=${server.physics._terrainStreamer && 'set'}`)
  check('double failure hands out no stale terrain body id', server.physics.getTerrainBodyId() == null, `terrainBodyId=${server.physics.getTerrainBodyId()}`)
  check('double failure leaves no abandoned heightfield body', liveFields.size === 0, `liveFields=${liveFields.size}`)
  check('double failure keeps the world def unmutated', (await seedOf()) === SEED1, `worldDef.terrain.seed=${await seedOf()}`)
  await send(clientA, MSG.TERRAIN_SCULPT, { brush: 'raise', x: 0, z: 0, radius: 5, strength: 1 })
  const sculpt = await waitFor(clientA, m => m.type === MSG.TERRAIN_SCULPT_ACK, 'TERRAIN_SCULPT_ACK')
  check('no stale stopped streamer answers a sculpt after a failed reseed', sculpt.payload?.ok === false && sculpt.payload?.error === 'no active terrain streamer', JSON.stringify(sculpt.payload))

  console.log('[reseed-witness] injected heightfield build failure')
  clientA.messages.length = 0
  clientB.messages.length = 0
  armedBuildThrows = 1
  await send(clientA, MSG.TERRAIN_RESEED, { seed: SEED2 })
  const buildFailA = await waitFor(clientA, m => m.type === MSG.TERRAIN_CONFIG, 'TERRAIN_CONFIG on A')
  check('a heightfield build failure is reported instead of swallowed', buildFailA.payload?.ok === false && /heightfield body rejected/.test(String(buildFailA.payload?.error || '')), JSON.stringify(buildFailA.payload).slice(0, 300))
  check('a heightfield build failure leaves the world with its previous terrain', buildFailA.payload?.restored === true && !!server.physics._terrainStreamer, JSON.stringify(buildFailA.payload).slice(0, 300))
  check('a heightfield build failure leaves no second terrain behind', liveFields.size <= baselineFields, `liveFields=${liveFields.size} baseline=${baselineFields}`)
  check('a failed build keeps the pre-reseed seed', (await seedOf()) === SEED1, `worldDef.terrain.seed=${await seedOf()}`)

  console.log('[reseed-witness] recovery: the world takes a reseed again')
  clientA.messages.length = 0
  await send(clientA, MSG.TERRAIN_RESEED, { seed: SEED1 })
  const again = await waitFor(clientA, m => m.type === MSG.TERRAIN_CONFIG, 'TERRAIN_CONFIG on A')
  check('a later reseed succeeds after a failed one', again.payload?.ok === true, JSON.stringify(again.payload).slice(0, 200))
  check('recovered world has a terrain streamer again', !!server.physics._terrainStreamer)
  check('recovered world has heightfield colliders again', liveFields.size > 0, `liveFields=${liveFields.size}`)

  console.log('[reseed-witness] seed 0: the in-flight guard is not disarmed by a falsy seed')
  clientA.messages.length = 0
  await send(clientA, MSG.TERRAIN_RESEED, { seed: 0 })
  await send(clientA, MSG.TERRAIN_RESEED, { seed: 0 })
  const zeroDeadline = Date.now() + WAIT_MS
  while (Date.now() < zeroDeadline && clientA.messages.filter(m => m.type === MSG.TERRAIN_CONFIG).length < 2) {
    await new Promise(r => setTimeout(r, 50))
  }
  const zeroReplies = clientA.messages.filter(m => m.type === MSG.TERRAIN_CONFIG)
  check('a reseed to seed 0 still refuses a second one in flight', zeroReplies.some(m => /already running/.test(String(m.payload?.error || ''))), JSON.stringify(zeroReplies.map(m => m.payload)).slice(0, 300))

  clientA.ws.close()
  clientB.ws.close()
  server.stop()
  console.log(`\n[reseed-witness] ${PASS.length} passed, ${FAIL.length} failed`)
  console.log(`[reseed-witness] RESULT: ${FAIL.length ? 'FAIL' : 'PASS'}`)
  process.exitCode = FAIL.length ? 1 : 0
}

main().catch(e => {
  console.error('[reseed-witness] RESULT: FAIL (uncaught)')
  console.error(e?.stack || e)
  process.exitCode = 1
})
