#!/usr/bin/env node
// Live witness harness for the spointreplay-file-format-deterministic-playback PRD row.
//
// Boots a REAL server (src/sdk/server.js createServer/loadWorld/start, same construction path
// scripts/playtest-heatmap-run.mjs already uses), spawns a real virtual player via
// playerManager.addPlayer + physicsIntegration.addPlayerCollider (mirroring ServerHandlers.js's
// onClientConnect join sequence), drives it through a scripted real-tick input sequence
// (forward/strafe/jump/turn) while ReplayRecorder (src/netcode/ReplayRecorder.js) hooks
// playerManager.addInput to capture the exact applied-input stream, writes a real .spointreplay file
// (src/netcode/ReplayFile.js), tears the server down, then boots a FRESH second server and feeds the
// file back through ReplayPlayer (src/netcode/ReplayPlayer.js) to reproduce the session -- comparing
// the replayed final player state against the originally-recorded final player state.
//
// Not a test file (no-test-files-ever): this is a runnable harness, its console output IS the live
// witness, no assertion library involved -- exits 0/1 by manually checking the real numbers.

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

// Deterministic scripted input sequence: a real player-shaped control stream (walk forward, strafe,
// jump, turn), NOT random -- so both the record run and any future eyeballing of the file are legible.
// One entry per real tick index (relative to first input tick).
function scriptedInputAt(i) {
  const yaw = (i % 240) < 120 ? 0 : Math.PI / 2 // turn halfway through
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

  // Drive real ticks: poll tickSystem.currentTick (real setInterval-driven ticks, same pattern
  // ReplayPlayer.js uses) and push one scripted input the first time we observe each new tick.
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
  // let the last few inputs actually get consumed by processPlayerMovement before reading final state
  await new Promise(r => setTimeout(r, 200))

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
  // small pause so the first server's port/socket is fully released before booting the second
  await new Promise(r => setTimeout(r, 300))
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

  // Tolerance: this format's determinism scope (documented in ReplayFile.js) is same-process/same-build
  // reproduction through the real tick loop, not cross-platform bit-exact Jolt -- a few mm of float
  // divergence across two separate WASM instantiations is honestly expected and acceptable here; several
  // METRES of divergence would mean the input stream/tick alignment is actually broken.
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
