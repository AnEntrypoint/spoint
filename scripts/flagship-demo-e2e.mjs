#!/usr/bin/env node
/**
 * flagship-demo-e2e.mjs -- E2E integration test harness for the flagship demo flow.
 *
 * Exercises the full cross-project integration:
 *   thebird window -> freddie chat -> spoint editor -> wireweave P2P room -> friend join
 *
 * This is a FIRST SLICE: the harness structure and checkpoint definitions.
 * Actual headless browser automation (Playwright) is deferred until the
 * dependent rows (freddie-spoint-bridge, wireweave-p2p-room, friend-join-link)
 * are fully implemented. This file defines the contract and can be run as a
 * smoke test for the pieces that are already in place.
 *
 * Usage: node scripts/flagship-demo-e2e.mjs
 */

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PASS = []
const FAIL = []
function check(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}

async function main() {
  console.log('=== Flagship Demo E2E Integration Test Harness ===')
  console.log('')

  // --- Phase 1: Source code presence (smoke test) ---
  console.log('--- Phase 1: Source file presence ---')

  const requiredFiles = [
    ['client/editor/P2PRoomPanel.js', 'P2P room panel'],
    ['client/editor/FreddieChatPanel.js', 'Freddie chat panel'],
    ['client/editor/thebird-host.html', 'thebird host page'],
    ['client/WireweaveBridge.js', 'Wireweave bridge'],
    ['client/WireweaveJoinClient.js', 'Wireweave join client'],
    ['src/sdk/FreddieBridge.js', 'Freddie bridge protocol'],
    ['src/protocol/MessageTypes.js', 'Message types (FREDDIE_MESSAGE)'],
    ['client/editor/EditorShell.js', 'Editor shell (P2P/Chat buttons)'],
  ]

  for (const [file, label] of requiredFiles) {
    const path = resolve(SDK_ROOT, file)
    try {
      await readFile(path)
      check(`Source: ${label}`, true)
    } catch {
      check(`Source: ${label}`, false, `file not found: ${file}`)
    }
  }

  // --- Phase 2: Message type registration ---
  console.log('')
  console.log('--- Phase 2: Protocol message types ---')

  try {
    const msgTypesPath = resolve(SDK_ROOT, 'src/protocol/MessageTypes.js')
    const content = await readFile(msgTypesPath, 'utf-8')
    check('FREDDIE_MESSAGE in MessageTypes', content.includes('FREDDIE_MESSAGE: 0xac'))
  } catch (e) {
    check('FREDDIE_MESSAGE in MessageTypes', false, e.message)
  }

  // --- Phase 3: EditorShell P2P/Chat button wiring ---
  console.log('')
  console.log('--- Phase 3: EditorShell integration ---')

  try {
    const shellPath = resolve(SDK_ROOT, 'client/editor/EditorShell.js')
    const content = await readFile(shellPath, 'utf-8')
    check('onOpenP2PRoom in createEditPanel params', content.includes('onOpenP2PRoom'))
    check('onOpenFreddieChat in createEditPanel params', content.includes('onOpenFreddieChat'))
    check('P2P Room button in status bar', content.includes("'P2P Room'"))
    check('Freddie button in status bar', content.includes("'Freddie'"))
    check('openP2PRoomWindow function', content.includes('function openP2PRoomWindow'))
    check('openFreddieChatWindow function', content.includes('function openFreddieChatWindow'))
    check('_ensureP2PRoomPanel function', content.includes('function _ensureP2PRoomPanel'))
    check('_ensureFreddieChatPanel function', content.includes('function _ensureFreddieChatPanel'))
  } catch (e) {
    check('EditorShell integration', false, e.message)
  }

  // --- Phase 4: App.js callback wiring ---
  console.log('')
  console.log('--- Phase 4: App.js callback wiring ---')

  try {
    const appPath = resolve(SDK_ROOT, 'client/app.js')
    const content = await readFile(appPath, 'utf-8')
    check('onOpenP2PRoom in app.js', content.includes('onOpenP2PRoom'))
    check('onOpenFreddieChat in app.js', content.includes('onOpenFreddieChat'))
  } catch (e) {
    check('App.js wiring', false, e.message)
  }

  // --- Phase 5: P2PRoomPanel exports ---
  console.log('')
  console.log('--- Phase 5: P2PRoomPanel exports ---')

  try {
    const p2pPath = resolve(SDK_ROOT, 'client/editor/P2PRoomPanel.js')
    const content = await readFile(p2pPath, 'utf-8')
    check('createP2PRoomPanel exports', content.includes('export function createP2PRoomPanel'))
    check('hostRoom function', content.includes('hostRoom'))
    check('joinRoom function', content.includes('joinRoom'))
    check('destroy function', content.includes('destroy'))
    check('getRoomState function', content.includes('getRoomState'))
    check('_generateRoomId helper', content.includes('_generateRoomId'))
    check('copy link to clipboard', content.includes('navigator.clipboard.writeText'))
  } catch (e) {
    check('P2PRoomPanel', false, e.message)
  }

  // --- Phase 6: FreddieChatPanel exports ---
  console.log('')
  console.log('--- Phase 6: FreddieChatPanel exports ---')

  try {
    const chatPath = resolve(SDK_ROOT, 'client/editor/FreddieChatPanel.js')
    const content = await readFile(chatPath, 'utf-8')
    check('createFreddieChatPanel exports', content.includes('export function createFreddieChatPanel'))
    check('sendMessage function', content.includes('sendMessage'))
    check('addMessage function', content.includes('addMessage'))
    check('sendVizCommand function', content.includes('sendVizCommand'))
    check('FreddieBridge import', content.includes("from '/src/sdk/FreddieBridge.js'"))
    check('/place command handler', content.includes("case 'place'"))
    check('/clear command handler', content.includes("case 'clear'"))
    check('/camera command handler', content.includes("case 'camera'"))
  } catch (e) {
    check('FreddieChatPanel', false, e.message)
  }

  // --- Phase 7: Node syntax check ---
  console.log('')
  console.log('--- Phase 7: Node.js syntax check ---')

  const { execSync } = await import('node:child_process')
  const jsFiles = [
    'client/editor/P2PRoomPanel.js',
    'client/editor/FreddieChatPanel.js',
    'src/protocol/MessageTypes.js',
  ]

  for (const file of jsFiles) {
    try {
      execSync(`node --check "${resolve(SDK_ROOT, file)}"`, { stdio: 'pipe', timeout: 10000 })
      check(`node --check ${file}`, true)
    } catch (e) {
      check(`node --check ${file}`, false, e.stderr?.toString().trim() || e.message)
    }
  }

  // --- Phase 8: Future phases (deferred) ---
  console.log('')
  console.log('--- Phase 8: Deferred (requires Playwright + running server) ---')
  console.log('  These checkpoints are defined but not yet exercised:')
  console.log('  8.1 Boot spoint server with e2e-ci-arena world')
  console.log('  8.2 Open thebird-host.html in headless Chromium')
  console.log('  8.3 Verify thebird desktop shell renders')
  console.log('  8.4 Verify spoint editor is embedded in the thebird desktop')
  console.log('  8.5 Click "P2P Room" button -> verify room panel opens')
  console.log('  8.6 Click "Host P2P Room" -> verify wireweave room created')
  console.log('  8.7 Copy room link to clipboard -> verify join URL format')
  console.log('  8.8 Open second browser tab with join URL -> verify peer connects')
  console.log('  8.9 Click "Freddie" button -> verify chat panel opens')
  console.log('  8.10 Send /place box 0 0 0 0xff0000 -> verify entity placed')
  console.log('  8.11 Send /clear -> verify entities removed')
  console.log('')

  // --- Summary ---
  console.log('=== Results ===')
  console.log(`  Passed: ${PASS.length}`)
  console.log(`  Failed: ${FAIL.length}`)

  if (FAIL.length > 0) {
    console.log('')
    console.log('Failures:')
    for (const f of FAIL) console.log(`  - ${f}`)
    process.exitCode = 1
  } else {
    console.log('  All checks passed.')
  }
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exitCode = 1
})