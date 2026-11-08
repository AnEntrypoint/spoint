import { writeFileSync } from 'node:fs'
import { installSpecifierHooks } from './install-specifier-hooks.mjs'

await installSpecifierHooks()
const { PredictionEngine } = await import('../../src/client/PredictionEngine.js')

const RECORD_PATH = process.env.GROUNDY_RECORD || ''
const INJECT_M = Number(process.env.GROUNDY_INJECT_M || 0)
const records = []
const proto = PredictionEngine.prototype
const realOnServerSnapshot = proto.onServerSnapshot
const realRebaseAndReplay = proto._rebaseAndReplay

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

const entryWithSequence = (engine, sequence) => {
  for (const e of engine.inputHistory) if (e.sequence === sequence) return e
  return null
}

proto.onServerSnapshot = function (snapshot, tick) {
  if (INJECT_M && Array.isArray(snapshot.players)) {
    const players = snapshot.players.map(p => (p && p.id === this.localPlayerId && Array.isArray(p.position)
      ? { ...p, position: [p.position[0], p.position[1] + INJECT_M, p.position[2]] }
      : p))
    return realOnServerSnapshot.call(this, { ...snapshot, players }, tick)
  }
  return realOnServerSnapshot.call(this, snapshot, tick)
}

proto._rebaseAndReplay = function (server, predictedAtAck, recordCorrection = true) {
  let last = null
  for (const e of this.inputHistory) last = e
  const before = last ? [last.position[0], last.position[1], last.position[2]] : null
  realRebaseAndReplay.call(this, server, predictedAtAck, recordCorrection)
  if (!recordCorrection || !last) return
  const after = entryWithSequence(this, last.sequence)
  if (!after) return
  const reference = predictedAtAck ?? server
  const errM = distance(server.position, reference.position)
  const offsetM = distance(before, after.position)
  records.push({
    seq: last.sequence,
    errM,
    offsetM,
    growthM: offsetM - errM,
    serverGroundY: server.onGround || this.verticallyBlocked ? server.position[1] : null,
    predictedGroundY: predictedAtAck && Number.isFinite(predictedAtAck.groundY) ? predictedAtAck.groundY : null,
    serverOnGround: !!server.onGround,
    verticallyBlocked: !!this.verticallyBlocked,
    injectedM: INJECT_M,
    t: Date.now()
  })
}

process.on('exit', () => {
  if (RECORD_PATH) writeFileSync(RECORD_PATH, JSON.stringify(records))
})
