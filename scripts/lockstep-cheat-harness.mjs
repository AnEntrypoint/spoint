import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { DesyncDetector } from '../src/netcode/DesyncDetector.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const peerScript = path.join(__dirname, 'lockstep-cheat-peer.mjs')

const peerIds = ['honest-A', 'honest-B', 'cheater-C']
const totalTicks = 90
const checksumIntervalTicks = 10

const desyncEvents = []
const verifiedTicks = []

const detector = new DesyncDetector({
  checksumIntervalTicks,
  expectedPeerIds: peerIds,
  onDesync: (tick, result) => desyncEvents.push({ tick, offenders: result.offenders, majorityChecksum: result.majorityChecksum }),
  onVerified: (tick, checksum) => verifiedTicks.push(tick),
})

function runPeer(peerId, cheat) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [peerScript, peerId, cheat ? 'cheat' : 'honest', String(totalTicks), String(checksumIntervalTicks)])
    let buf = ''
    const reports = []
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (line.trim()) reports.push(JSON.parse(line))
      }
    })
    let stderrBuf = ''
    child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString() })
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`peer ${peerId} exited ${code}: ${stderrBuf}`))
      else resolve(reports)
    })
  })
}

async function main() {
  const [reportsA, reportsB, reportsC] = await Promise.all([
    runPeer('honest-A', false),
    runPeer('honest-B', false),
    runPeer('cheater-C', true),
  ])

  const byTick = new Map()
  for (const [peerId, reports] of [['honest-A', reportsA], ['honest-B', reportsB], ['cheater-C', reportsC]]) {
    for (const r of reports) {
      if (!byTick.has(r.tick)) byTick.set(r.tick, [])
      byTick.get(r.tick).push({ peerId, checksum: r.checksum })
    }
  }

  const ticks = [...byTick.keys()].sort((a, b) => a - b)
  for (const tick of ticks) {
    for (const { peerId, checksum } of byTick.get(tick)) {
      detector.reportChecksum(tick, peerId, checksum)
    }
  }

  const cheaterCaughtEvents = desyncEvents.filter(e => e.offenders.includes('cheater-C'))
  const cheaterFalselyAccusedHonest = desyncEvents.some(e => e.offenders.includes('honest-A') || e.offenders.includes('honest-B'))
  const preCheatTicksVerified = verifiedTicks.filter(t => t < 45)
  const postCheatTicksDesynced = desyncEvents.filter(e => e.tick >= 50)

  const summary = {
    totalTicksRun: totalTicks,
    checksumTicksExchanged: ticks.length,
    verifiedTickCount: verifiedTicks.length,
    desyncEventCount: desyncEvents.length,
    desyncEvents,
    cheaterCaughtEventCount: cheaterCaughtEvents.length,
    cheaterAlwaysTheOffenderWhenCaught: cheaterCaughtEvents.every(e => e.offenders.length === 1 && e.offenders[0] === 'cheater-C'),
    cheaterFalselyAccusedHonestPeer: cheaterFalselyAccusedHonest,
    preCheatTicksAllVerified: preCheatTicksVerified.length > 0 && preCheatTicksVerified.length === ticks.filter(t => t < 45).length,
    postCheatTicksAllDesynced: postCheatTicksDesynced.length === ticks.filter(t => t >= 50).length,
  }

  console.log(JSON.stringify(summary, null, 1))

  const pass = summary.cheaterCaughtEventCount > 0
    && summary.cheaterAlwaysTheOffenderWhenCaught
    && !summary.cheaterFalselyAccusedHonestPeer
    && summary.preCheatTicksAllVerified
    && summary.postCheatTicksAllDesynced

  process.exit(pass ? 0 : 1)
}

main().catch(err => {
  console.error('harness error:', err)
  process.exit(1)
})
