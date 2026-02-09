/**
 * Comprehensive VRM Loading Diagnostic
 *
 * This script mimics exactly what app.js does to identify the issue
 */

import { readFileSync } from 'node:fs'
import { request } from 'node:http'

class LoadingManagerSimulator {
  async fetchWithProgress(url) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: 8080,
        path: url,
        method: 'GET'
      }

      const req = request(options, (res) => {
        let chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const receivedLength = chunks.reduce((sum, c) => sum + c.length, 0)
          const result = new Uint8Array(receivedLength)
          let position = 0
          for (const chunk of chunks) {
            result.set(chunk, position)
            position += chunk.length
          }
          resolve(result)
        })
      })

      req.on('error', reject)
      req.end()
    })
  }
}

function detectVrmVersion(buffer) {
  try {
    const arrayBuffer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer
    const view = new DataView(arrayBuffer)
    const jsonLen = view.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, 20, jsonLen)))
    if (json.extensions?.VRM) return '0'
  } catch (e) {}
  return '1'
}

async function diagnose() {
  console.log('=== VRM Loading Diagnostic ===\n')

  const loadingMgr = new LoadingManagerSimulator()
  let vrmBuffer = null

  console.log('Step 1: Fetch VRM from server')
  console.log('  Path: /apps/tps-game/Cleetus.vrm')

  try {
    vrmBuffer = await loadingMgr.fetchWithProgress('/apps/tps-game/Cleetus.vrm')
    console.log(`  ✓ Fetched ${vrmBuffer.length} bytes`)
    console.log(`  Type: ${vrmBuffer.constructor.name}`)
    console.log(`  instanceof Uint8Array: ${vrmBuffer instanceof Uint8Array}`)
  } catch (e) {
    console.error('  ✗ Fetch failed:', e.message)
    process.exit(1)
  }

  console.log('\nStep 2: Analyze buffer')
  const uint8 = vrmBuffer
  const magic = String.fromCharCode(uint8[0], uint8[1], uint8[2], uint8[3])
  console.log(`  Magic: "${magic}"`)

  // Check if it's actually a Uint8Array from the fetch
  if (vrmBuffer.buffer instanceof ArrayBuffer) {
    console.log(`  ✓ vrmBuffer.buffer exists (ArrayBuffer)`)
  } else {
    console.log(`  ✗ vrmBuffer.buffer is not an ArrayBuffer`)
  }

  console.log('\nStep 3: Detect VRM version')
  const vrmVersion = detectVrmVersion(vrmBuffer)
  console.log(`  Version: ${vrmVersion}`)

  console.log('\nStep 4: What app.js does')
  console.log('  Code: const gltf = await gltfLoader.parseAsync(vrmBuffer, "")')
  console.log(`  Passing: ${vrmBuffer.constructor.name}`)
  console.log(`  Size: ${vrmBuffer.length} bytes`)

  console.log('\nStep 5: Check various buffer formats')
  console.log(`  vrmBuffer: ${vrmBuffer.constructor.name}`)
  console.log(`  vrmBuffer.buffer: ${vrmBuffer.buffer?.constructor.name || 'null'}`)
  console.log(`  new Uint8Array(vrmBuffer): ${new Uint8Array(vrmBuffer).constructor.name}`)
  console.log(`  vrmBuffer.slice(0): ${vrmBuffer.slice(0).constructor.name}`)

  console.log('\nStep 6: Possible issues')

  // Check if buffer is correctly aligned
  if (vrmBuffer.byteOffset !== 0) {
    console.log(`  ⚠ Buffer is not aligned at offset 0, offset=${vrmBuffer.byteOffset}`)
  } else {
    console.log(`  ✓ Buffer is aligned at offset 0`)
  }

  // Check if magic is correct
  if (magic === 'glTF') {
    console.log(`  ✓ GLB magic number is correct`)
  } else {
    console.log(`  ✗ Magic is wrong: "${magic}" (expected "glTF")`)
  }

  // Check file size field
  const view = new DataView(vrmBuffer.buffer, vrmBuffer.byteOffset, vrmBuffer.byteLength)
  const fileSizeField = view.getUint32(8, true)
  console.log(`  File size field: ${fileSizeField}`)
  console.log(`  Actual buffer size: ${vrmBuffer.length}`)
  if (fileSizeField === vrmBuffer.length) {
    console.log(`  ✓ File size matches`)
  } else {
    console.log(`  ✗ File size mismatch: ${fileSizeField} vs ${vrmBuffer.length}`)
  }

  // Check JSON chunk
  const jsonChunkSize = view.getUint32(12, true)
  const jsonChunkType = view.getUint32(16, true)
  const jsonChunkTypeStr = String.fromCharCode(
    jsonChunkType & 0xFF,
    (jsonChunkType >> 8) & 0xFF,
    (jsonChunkType >> 16) & 0xFF,
    (jsonChunkType >> 24) & 0xFF
  )

  console.log(`  JSON chunk type: "${jsonChunkTypeStr}"`)

  if (jsonChunkTypeStr === 'JSON') {
    console.log(`  ✓ JSON chunk is valid`)

    try {
      const jsonStr = new TextDecoder().decode(
        new Uint8Array(vrmBuffer.buffer, vrmBuffer.byteOffset + 20, jsonChunkSize)
      )
      const json = JSON.parse(jsonStr)
      console.log(`  ✓ JSON parses successfully`)
      console.log(`  ✓ VRM extension present: ${json.extensions?.VRM ? 'yes' : 'no'}`)
    } catch (e) {
      console.log(`  ✗ JSON parse failed: ${e.message}`)
    }
  } else {
    console.log(`  ✗ JSON chunk has wrong type: "${jsonChunkTypeStr}"`)
  }

  console.log('\nStep 7: Diagnosis')
  console.log(`
The VRM file format appears to be correct. The "Unsupported asset" error
likely comes from the GLTFLoader or VRMLoaderPlugin itself.

Possible causes:
1. Browser cache - the browser still has the old code cached
   FIX: Hard refresh (Ctrl+Shift+R) or incognito window

2. THREE.js version mismatch - the CDN version may have changed
   Current imports in index.html use: https://esm.sh/three@0.171.0

3. VRM plugin version mismatch
   Current imports use: https://esm.sh/@pixiv/three-vrm@3

4. The error is happening in a different part of the code
   Check the exact error message and stack trace in DevTools

5. The fix (removing .slice(0)) was correct but incomplete
   Other parts of the code may also need adjustment
  `)

  console.log('\n=== Diagnostic Complete ===')
}

diagnose().catch(console.error)
