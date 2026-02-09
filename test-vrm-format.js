import { request } from 'node:http'
import { readFileSync } from 'node:fs'

console.log('Test 1: Fetching Cleetus.vrm from server...\n')

const options = {
  hostname: 'localhost',
  port: 8080,
  path: '/apps/tps-game/Cleetus.vrm',
  method: 'GET'
}

const req = request(options, (res) => {
  console.log('Status:', res.statusCode)
  console.log('Content-Type:', res.headers['content-type'])
  console.log('Content-Encoding:', res.headers['content-encoding'] || '(none)')

  let chunks = []
  res.on('data', (chunk) => chunks.push(chunk))
  res.on('end', () => {
    const buffer = Buffer.concat(chunks)
    console.log('Total bytes:', buffer.length)

    // Show first 64 bytes in hex and ASCII
    console.log('\nFirst 64 bytes:')
    for (let i = 0; i < Math.min(64, buffer.length); i += 16) {
      const hex = buffer.slice(i, i + 16).toString('hex').match(/.{1,2}/g).join(' ')
      const ascii = buffer
        .slice(i, i + 16)
        .toString('ascii')
        .replace(/[^\x20-\x7E]/g, '.')
      console.log(`${i.toString(16).padStart(4, '0')}: ${hex.padEnd(48, ' ')} | ${ascii}`)
    }

    // Parse GLB structure
    console.log('\nGLB Structure Analysis:')

    // Check magic
    const magic = buffer.readUInt32LE(0)
    const magicStr = String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3])
    console.log(`Magic: 0x${magic.toString(16)} ("${magicStr}")`)

    if (magicStr === 'glTF') {
      console.log('✓ Valid GLB magic number')

      // Check version
      const version = buffer.readUInt32LE(4)
      console.log(`Version: ${version}`)

      // Check file size
      const fileSize = buffer.readUInt32LE(8)
      console.log(`File size field: ${fileSize}`)
      console.log(`Actual size: ${buffer.length}`)

      if (fileSize === buffer.length) {
        console.log('✓ File size matches')
      } else {
        console.log(`✗ File size mismatch: field says ${fileSize}, actual is ${buffer.length}`)
      }

      // JSON chunk
      const jsonChunkSize = buffer.readUInt32LE(12)
      const jsonChunkType = buffer.readUInt32LE(16)
      const jsonChunkTypeStr = String.fromCharCode(
        jsonChunkType & 0xFF,
        (jsonChunkType >> 8) & 0xFF,
        (jsonChunkType >> 16) & 0xFF,
        (jsonChunkType >> 24) & 0xFF
      )

      console.log(`\nJSON Chunk:`)
      console.log(`  Size: ${jsonChunkSize}`)
      console.log(`  Type: 0x${jsonChunkType.toString(16)} ("${jsonChunkTypeStr}")`)

      if (jsonChunkTypeStr === 'JSON') {
        console.log('  ✓ Valid JSON chunk')

        // Try to parse JSON
        try {
          const jsonData = buffer.slice(20, 20 + jsonChunkSize).toString('utf-8')
          const json = JSON.parse(jsonData)
          console.log(`  JSON keys: ${Object.keys(json).join(', ')}`)

          if (json.extensions?.VRM) {
            console.log('  ✓ VRM extension found in JSON')
          }
        } catch (e) {
          console.log(`  ✗ Failed to parse JSON: ${e.message}`)
        }
      }

      // Binary chunk
      const binaryChunkOffset = 20 + jsonChunkSize
      if (binaryChunkOffset < buffer.length) {
        const binChunkSize = buffer.readUInt32LE(binaryChunkOffset)
        const binChunkType = buffer.readUInt32LE(binaryChunkOffset + 4)
        const binChunkTypeStr = String.fromCharCode(
          binChunkType & 0xFF,
          (binChunkType >> 8) & 0xFF,
          (binChunkType >> 16) & 0xFF,
          (binChunkType >> 24) & 0xFF
        )

        console.log(`\nBinary Chunk:`)
        console.log(`  Offset: ${binaryChunkOffset}`)
        console.log(`  Size: ${binChunkSize}`)
        console.log(`  Type: 0x${binChunkType.toString(16)} ("${binChunkTypeStr}")`)

        if (binChunkTypeStr === 'BIN\0') {
          console.log('  ✓ Valid BIN chunk')
        }
      }
    } else {
      console.log('✗ Invalid magic number')
    }

    // Test 2: Check file format on disk
    console.log('\n\nTest 2: Checking file on disk...\n')
    try {
      const diskBuffer = readFileSync('./apps/tps-game/Cleetus.vrm')
      console.log(`Disk file size: ${diskBuffer.length} bytes`)

      const diskMagic = String.fromCharCode(diskBuffer[0], diskBuffer[1], diskBuffer[2], diskBuffer[3])
      console.log(`Disk file magic: "${diskMagic}"`)

      if (diskBuffer.length === buffer.length) {
        console.log('✓ Disk file size matches HTTP response')
      } else {
        console.log(`✗ Size mismatch: disk=${diskBuffer.length}, http=${buffer.length}`)
      }

      // Compare bytes
      let bytesMatch = true
      for (let i = 0; i < Math.min(diskBuffer.length, buffer.length); i++) {
        if (diskBuffer[i] !== buffer[i]) {
          console.log(`✗ Byte mismatch at offset ${i}: disk=0x${diskBuffer[i].toString(16)}, http=0x${buffer[i].toString(16)}`)
          bytesMatch = false
          break
        }
      }

      if (bytesMatch) {
        console.log('✓ All bytes match between disk and HTTP response')
      }
    } catch (e) {
      console.log(`✗ Cannot read disk file: ${e.message}`)
    }
  })
})

req.on('error', (e) => console.error('Request error:', e))
req.end()
