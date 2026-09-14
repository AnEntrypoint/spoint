#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from '../src/sdk/server.js'
import { ReplayRecorder } from '../src/netcode/ReplayRecorder.js'
import { ReplayPlayer } from '../src/netcode/ReplayPlayer.js'
import { decodeReplay } from '../src/netcode/ReplayFile.js'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(SDK_ROOT, 'data', 'replay-record-and-play')
const REPLAY_PATH = resolve(OUT_DIR, 'witness-session.spointreplay')

function scriptedInputAt(i) {
  const yaw = (i % 240) < 120 ? 0 : Math.PI / 2
  if (i < 40) return { forward: true, yaw, pitch: 0 }
  if (i < 60) return { forward: true, right: true, yaw, pitch: 0 }
  if (i === 60) return { forward: true, jump: true, yaw, pitch: 0 }
  if (i < 100) return { forward: true, yaw, pitch: 0 }
  if (i < 140) return { left: true, yaw, pitch: 0 }
  return { forward: false, yaw, pitch: 0 }
}
const SCRIPT_LENGTH = 160

async function runRecordSession() {
  const worldPath = resolve(SDK_ROOT, 'apps/world/replay-witness-arena.js')
  const worldDef = (await import(pathToFileURL(worldPath).href)).default
  const PORT = 20000 + Math.floor(Math.random() * 20000)
  const config = {
    port: PORT,
    tickRate: 60,
    appsDirs: [resolve(SDK_ROOT, 'apps')],
    sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity,
    staticDirs: [],
    storageDir: resolve(SDK_ROOT, 'data'),
  }
  console.log(`[replay-record] booting real server on port ${PORT} for world: replay-witness-arena`)
  const server = await createServer(config)
  await server.loadWorld(worldDef)
  await server.start()

  const recorder = new ReplayRecorder({ playerManager: server.playerManager, tickSystem: server.tickSystem, eventLog: server.eventLog, worldName: 'replay-witness-arena', tickRate: 60 })

  const spawn = { position: [0, 5, 0], rotation: [0, 0, 0, 1], health: 100 }
  const fakeSocket = { send() {}, close() {} }
  const playerId = server.playerManager.addPlayer(fakeSocket, spawn)
  server.networkState.addPlayer(playerId, { position: spawn.position })
  server.physicsIntegration.addPlayerCollider(playerId, 0.4)
  server.physicsIntegration.setPlayerPosition(playerId, spawn.position)
  recorder.registerPlayer(playerId, 'ReplayWitness', spawn)
  recorder.start()

  console.log(`[replay-record] real player ${playerId} spawned, driving ${SCRIPT_LENGTH} real ticks of scripted input`)

  let lastTick = server.tickSystem.currentTick
  let i = 0
  await new Promise((doneResolve) => {
    const step = () => {
      const tick = server.tickSystem.currentTick
      if (tick > lastTick) {
        for (let t = lastTick + 1; t <= tick && i < SCRIPT_LENGTH; t++) {
          server.playerManager.addInput(playerId, scriptedInputAt(i), i + 1)
          i++
        }
        lastTick = tick
      }
      if (i >= SCRIPT_LENGTH) { doneResolve(); return }
      setTimeout(step, 4)
    }
    step()
  })
  const INPUT_DRAIN_MS = 200
  await new Promise(r => setTimeout(r, INPUT_DRAIN_MS))

  const finalPlayer = server.playerManager.getPlayer(playerId)
  const recordedFinal = { position: [...finalPlayer.state.position], rotation: [...finalPlayer.state.rotation], velocity: [...finalPlayer.state.velocity] }
  console.log(`[replay-record] recording session done: ${recorder.inputCount} inputs captured, ticksRun=${server.tickSystem.currentTick}`)
  console.log(`[replay-record] real recorded-session final state: pos=${JSON.stringify(recordedFinal.position)} rot=${JSON.stringify(recordedFinal.rotation)}`)

  const buf = recorder.stop()
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true })
  await writeFile(REPLAY_PATH, buf)
  console.log(`[replay-record] wrote real .spointreplay file -> ${REPLAY_PATH} (${buf.length} bytes)`)

  server.stop()
  return { recordedFinal, worldDef }
}

async function runPlaybackSession(worldDef, replayBuf) {
  console.log('[replay-play] decoding .spointreplay file header')
  const env = decodeReplay(replayBuf)
  console.log(`[replay-play] header: worldName=${env.header.worldName} tickRate=${env.header.tickRate} startTick=${env.header.startTick} endTick=${env.header.endTick} players=${env.header.players.length} inputs=${env.inputs.length} events=${env.events.length}`)

  const player = new ReplayPlayer({
    createServer,
    worldDef,
    replayBuf,
    sdkConfig: { appsDirs: [resolve(SDK_ROOT, 'apps')], sdkRoot: SDK_ROOT, gravity: worldDef.gravity, staticDirs: [], storageDir: resolve(SDK_ROOT, 'data'), port: 20000 + Math.floor(Math.random() * 20000) },
  })
  console.log('[replay-play] booting a FRESH real server and replaying the recorded input stream')
  const result = await player.play({ extraTicks: 20 })
  await player.stop()
  console.log(`[replay-play] playback done: ticksRun=${result.ticksRun}`)
  return result
}

async function main() {
  const { recordedFinal, worldDef } = await runRecordSession()
  const PORT_RELEASE_MS = 300
  await new Promise(r => setTimeout(r, PORT_RELEASE_MS))
  const { finalStates } = await runPlaybackSession(worldDef, await (await import('node:fs/promises')).readFile(REPLAY_PATH))

  const replayedFinal = [...finalStates.values()][0]
  console.log(`[replay-play] real replayed-session final state: pos=${JSON.stringify(replayedFinal.position)} rot=${JSON.stringify(replayedFinal.rotation)}`)

  const posDelta = Math.hypot(
    recordedFinal.position[0] - replayedFinal.position[0],
    recordedFinal.position[1] - replayedFinal.position[1],
    recordedFinal.position[2] - replayedFinal.position[2],
  )
  const rotDelta = Math.hypot(
    recordedFinal.rotation[0] - replayedFinal.rotation[0],
    recordedFinal.rotation[1] - replayedFinal.rotation[1],
    recordedFinal.rotation[2] - replayedFinal.rotation[2],
    recordedFinal.rotation[3] - replayedFinal.rotation[3],
  )
  console.log(`[replay-play] === COMPARISON ===`)
  console.log(`  position delta (metres): ${posDelta.toFixed(6)}`)
  console.log(`  rotation delta (quat L2): ${rotDelta.toFixed(6)}`)

  const POS_TOLERANCE_M = 0.5
  const ROT_TOLERANCE = 0.05
  const ok = posDelta < POS_TOLERANCE_M && rotDelta < ROT_TOLERANCE
  console.log(ok ? '[replay-play] PASS: playback reproduced the recorded session within tolerance' : '[replay-play] FAIL: playback diverged beyond tolerance')
  process.exit(ok ? 0 : 1)
}

main().catch(err => {
  console.error('[replay-record-and-play] FATAL:', err.stack || err.message)
  process.exit(1)
})
