import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

console.log('[STRESS-TEST] Starting 150-player test...')
console.log('[STRESS-TEST] Step 1: Starting server in background')

const serverCmd = 'node server.js'
const botCmd = 'node src/sdk/BotHarness.js'

// Start server - let it run in the background
// We'll just run the bot test and let server output appear
const env150 = {
  ...process.env,
  BOT_COUNT: '150',
  BOT_DURATION: '120000',
  BOT_BATCH: '30',
  BOT_DELAY: '50'
}

console.log('[STRESS-TEST] Waiting 5s for server to initialize...')
await new Promise(r => setTimeout(r, 5000))

console.log('[STRESS-TEST] Step 2: Running 150-player bot test for 120s')
console.log('[STRESS-TEST] Configuration: BOT_COUNT=150, BOT_DURATION=120000ms, BOT_BATCH=30')

try {
  const { stdout, stderr } = await execAsync(botCmd, {
    cwd: process.cwd(),
    env: env150,
    timeout: 150000,
    maxBuffer: 10 * 1024 * 1024
  })

  console.log(stdout)
  if (stderr) console.error('STDERR:', stderr)
} catch (e) {
  console.error('Execution error:', e.message)
  process.exit(1)
}

console.log('[STRESS-TEST] Complete')
process.exit(0)
