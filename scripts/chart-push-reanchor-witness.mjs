import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { materializeBase, treeUrl } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const PRE_REV = '20e9389'
const MIGRATE = 'src/sdk/chartState/migratePlayers.js'
const REEXPRESS = 'src/shared/chartReexpress.js'
const TRANSFER = 'src/shared/chartTransfer.js'
const TILT_DEG = 2
const TOLERANCE_M = 1e-6
const QUEUE_INDEX = 15

function childRun(which) {
  const out = spawnSync(process.execPath, [SELF, '--child', `--push=${which}`], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
  if (out.error) throw new Error(`[chart-push] ${which} child: ${out.error.message}`)
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) throw new Error(`[chart-push] ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

function charts() {
  const t = TILT_DEG * Math.PI / 180
  const from = { east: [1, 0, 0], up: [0, 1, 0], north: [0, 0, 1], radius: 6371000, anchorHeight: 0, offsetY: 0 }
  const to = { east: [1, 0, 0], up: [0, Math.cos(t), Math.sin(t)], north: [0, -Math.sin(t), Math.cos(t)], radius: 6371000, anchorHeight: 0, offsetY: 0 }
  return { from, to }
}

function makePlayer(id, position, pendingPush, queuedPush) {
  const pushQueue = new Array(16).fill(null)
  pushQueue[QUEUE_INDEX] = queuedPush
  return {
    id,
    state: { position: position.slice(), velocity: [1, 0, -2], onGround: false, wallNormals: [], lookYaw: 0.3, lookPitch: 0.1, rotation: [0, 0, 0, 1] },
    lastInput: {},
    pendingPush,
    pushQueue,
  }
}

async function runChild(which) {
  const migrateUrl = which === 'base' ? materializeBase(PRE_REV, [MIGRATE, REEXPRESS])[MIGRATE] : treeUrl(MIGRATE)
  const reexpressUrl = which === 'base' ? materializeBase(PRE_REV, [MIGRATE, REEXPRESS])[REEXPRESS] : treeUrl(REEXPRESS)
  const { createPlayerMigrator } = await import(migrateUrl)
  const { createReexpressPass } = await import(reexpressUrl)
  const { createChartTransfer } = await import(treeUrl(TRANSFER))
  const { from, to } = charts()
  const transfer = createChartTransfer(from, to)
  const a = makePlayer(1, [10, 0.5, 20], [0.3, -0.2, 1.2, -0.8], [0.1, 0.1, 0.4, 0.4])
  const b = makePlayer(2, [-4, 0.5, 7], null, null)
  const players = new Map([[a.id, a], [b.id, b]])
  const playerManager = { players, getInputs: () => [] }
  const networkState = { players: new Map() }
  const lagCompensator = { applyChartTransfer: () => 0 }
  const physicsIntegration = { physicsWorld: null, playerBodies: new Map() }
  const migrate = createPlayerMigrator({ playerManager, networkState, lagCompensator, physicsIntegration })
  const oldPositions = [a.state.position.slice(), b.state.position.slice()]
  const oldPending = a.pendingPush.slice()
  const oldQueued = a.pushQueue[QUEUE_INDEX].slice()
  migrate({ transfer }, createReexpressPass(transfer))
  const pointOf = p => transfer.point(p)
  const expectedPush = (p, d) => {
    const before = pointOf(p)
    const after = pointOf([p[0] + d[0], p[1], p[2] + d[1]])
    return [after[0] - before[0], after[2] - before[2]]
  }
  const expectedPending = expectedPush(oldPositions[0], [oldPending[0], oldPending[1]])
  const expectedQueued = expectedPush(oldPositions[0], [oldQueued[0], oldQueued[1]])
  const expectedPendingVel = (() => { const v = transfer.vec([oldPending[2], 0, oldPending[3]]); return [v[0], v[2]] })()
  const got = a.pendingPush, gotQ = a.pushQueue[QUEUE_INDEX]
  const errors = [
    Math.abs(got[0] - expectedPending[0]), Math.abs(got[1] - expectedPending[1]),
    Math.abs(gotQ[0] - expectedQueued[0]), Math.abs(gotQ[1] - expectedQueued[1]),
    Math.abs(got[2] - expectedPendingVel[0]), Math.abs(got[3] - expectedPendingVel[1]),
  ]
  const positionErrors = [a, b].map((p, i) => {
    const want = pointOf(oldPositions[i])
    return Math.max(Math.abs(p.state.position[0] - want[0]), Math.abs(p.state.position[1] - want[1]), Math.abs(p.state.position[2] - want[2]))
  })
  return { pushErrorM: Math.max(...errors), positionErrorM: Math.max(...positionErrors), pendingM: [got[0], got[1]], expectedM: expectedPending }
}

async function main() {
  const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
  if (process.argv.includes('--child')) {
    console.log('WITNESS_JSON ' + JSON.stringify(await runChild(arg('push', 'tree'))))
    return
  }
  const which = arg('push', 'tree')
  const runs = which === 'base' ? { base: childRun('base') } : { tree: childRun('tree'), base: childRun('base') }
  const target = runs[which === 'base' ? 'base' : 'tree']
  const name = which === 'base' ? 'base' : 'tree'
  const rows = []
  const add = (label, ok, detail) => { rows.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`) }
  add(`a push planned before the re-anchor is applied in the new chart (error at most ${TOLERANCE_M} m)`, target.pushErrorM <= TOLERANCE_M, `${name}: largest push error ${target.pushErrorM.toExponential(3)} m (${TILT_DEG} degree chart tilt)`)
  add('positions are re-expressed as before (sanity)', target.positionErrorM <= TOLERANCE_M, `${name}: largest position error ${target.positionErrorM.toExponential(3)} m`)
  const ok = rows.every(Boolean)
  console.log(ok
    ? `RESULT: PASS ${name} queued and pending pushes re-expressed at a ${TILT_DEG} degree re-anchor: largest push error ${target.pushErrorM.toExponential(3)} m`
    : `RESULT: FAIL ${name} queued and pending pushes at a ${TILT_DEG} degree re-anchor: largest push error ${target.pushErrorM.toExponential(3)} m`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL chart push witness threw'); process.exitCode = 1 })
