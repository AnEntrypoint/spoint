#!/usr/bin/env node
import { fork } from 'node:child_process'
import { watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'server.js')
const CRASH_WATCH_ROOTS = ['src', 'apps']
const IPC_DRAIN_MS = 50
const SHUTDOWN_GRACE_MS = 8000

let child = null, restartRequested = false, stopping = false, watchGapStart = 0

function spawnServer() {
  restartRequested = false
  const env = { ...process.env, SPOINT_DEV: '1', SPOINT_SUPERVISED: '1', SPOINT_HMR_SINCE: String(watchGapStart || '') }
  child = fork(SERVER, process.argv.slice(2), { env, stdio: 'inherit' })
  let restartAt = 0
  child.on('message', msg => { if (msg?.type === 'spoint-restart') { restartRequested = true; restartAt = msg.at || Date.now() } })
  child.on('exit', code => { watchGapStart = restartAt || Date.now(); setTimeout(() => onExit(code), IPC_DRAIN_MS) })
  child.on('error', e => console.error('[dev] server process error:', e.message))
}

function waitForEditThenSpawn() {
  console.log('[dev] server exited with an error; waiting for the next edit under src/ or apps/ to retry')
  const watchers = []
  const retry = () => { for (const w of watchers) w.close(); spawnServer() }
  for (const r of CRASH_WATCH_ROOTS) watchers.push(watch(join(ROOT, r), { recursive: true }, retry))
}

function onExit(code) {
  child = null
  if (stopping) { process.exit(code ?? 0); return }
  if (restartRequested) { console.log('[dev] restarting server'); spawnServer(); return }
  if (code === 0) { process.exit(0); return }
  waitForEditThenSpawn()
}

function stop() {
  if (stopping) return
  stopping = true
  if (!child) process.exit(0)
  if (child.connected) child.send({ type: 'spoint-shutdown' }, () => {})
  setTimeout(() => child?.kill(), SHUTDOWN_GRACE_MS).unref()
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
spawnServer()
