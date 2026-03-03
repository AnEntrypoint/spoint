import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cwd = __dirname

let serverProcess = null
let botProcess = null
const logs = { server: [], bots: [] }

console.log('[TEST-RUNNER] Starting 150-player stress test...')

// Launch server
console.log('[TEST-RUNNER] Starting server...')
serverProcess = spawn('node', ['server.js'], {
  cwd,
  env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=2048' },
  stdio: ['ignore', 'pipe', 'pipe']
})

let serverReady = false
const serverStartTimeout = setTimeout(() => {
  if (!serverReady) {
    console.error('[TEST-RUNNER] Server startup timeout (45s)')
    cleanup()
    process.exit(1)
  }
}, 45000)

serverProcess.stdout.on('data', (data) => {
  const text = data.toString()
  logs.server.push(text)
  process.stdout.write(text)

  if (text.includes('http://localhost:')) {
    serverReady = true
    clearTimeout(serverStartTimeout)
    setTimeout(launchBots, 500)
  }
})

serverProcess.stderr.on('data', (data) => {
  logs.server.push('ERR: ' + data.toString())
  process.stderr.write(data)
})

function launchBots() {
  console.log('[TEST-RUNNER] Starting BotHarness with 150 bots for 120s...')

  botProcess = spawn('node', ['src/sdk/BotHarness.js'], {
    cwd,
    env: {
      ...process.env,
      BOT_COUNT: '150',
      BOT_DURATION: '120000',
      BOT_BATCH: '30',
      BOT_DELAY: '50'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let captureMetrics = false
  const metrics = { snapshots: 0, duration: 0, connected: 0, errors: 0 }

  botProcess.stdout.on('data', (data) => {
    const text = data.toString()
    logs.bots.push(text)
    process.stdout.write(text)

    // Parse metrics from output
    if (text.includes('[BotHarness]')) {
      captureMetrics = true
      const match = text.match(/snaps=(\d+)/)
      if (match) metrics.snapshots = parseInt(match[1])
      const match2 = text.match(/conn=(\d+)/)
      if (match2) metrics.connected = parseInt(match2[1])
      const match3 = text.match(/err=(\d+)/)
      if (match3) metrics.errors = parseInt(match3[1])
    }
  })

  botProcess.stderr.on('data', (data) => {
    logs.bots.push('ERR: ' + data.toString())
    process.stderr.write(data)
  })

  botProcess.on('close', (code) => {
    console.log('[TEST-RUNNER] BotHarness exited with code', code)
    console.log('[TEST-RUNNER] Final metrics:', metrics)
    cleanup(code)
  })
}

function cleanup(exitCode = 0) {
  console.log('[TEST-RUNNER] Cleaning up...')
  if (botProcess && !botProcess.killed) botProcess.kill()
  if (serverProcess && !serverProcess.killed) serverProcess.kill()

  setTimeout(() => {
    process.exit(exitCode)
  }, 500)
}

process.on('SIGINT', () => {
  console.log('[TEST-RUNNER] Interrupted')
  cleanup()
})

process.on('SIGTERM', () => {
  console.log('[TEST-RUNNER] Terminated')
  cleanup()
})

// Safety timeout: kill everything after 200 seconds
setTimeout(() => {
  console.log('[TEST-RUNNER] Test timeout (200s)')
  cleanup()
}, 200000)
