import { readFileSync } from 'node:fs'

// Load the VRM file
const diskBuffer = readFileSync('./apps/tps-game/Cleetus.vrm')

console.log('Testing GLTFLoader with different buffer types:\n')

console.log('diskBuffer type:', diskBuffer.constructor.name)
console.log('diskBuffer.buffer type:', diskBuffer.buffer.constructor.name)
console.log('new Uint8Array(diskBuffer) type:', new Uint8Array(diskBuffer).constructor.name)
console.log()

// Test what happens when we pass each type
console.log('Test 1: Using diskBuffer directly (Buffer)')
console.log('  typeof diskBuffer:', typeof diskBuffer)
console.log('  instanceof ArrayBuffer:', diskBuffer instanceof ArrayBuffer)
console.log('  instanceof Uint8Array:', diskBuffer instanceof Uint8Array)
console.log('  instanceof Buffer:', Buffer.isBuffer(diskBuffer))
console.log()

// Create a Uint8Array like LoadingManager does
const reconstructed = Buffer.allocUnsafe(diskBuffer.length)
let pos = 0
const chunks = [
  diskBuffer.slice(0, 1000),
  diskBuffer.slice(1000, 2000),
  diskBuffer.slice(2000, 3000)
]
for (const chunk of chunks) {
  reconstructed.set(chunk, pos)
  pos += chunk.length
}

console.log('Test 2: Reconstructed buffer (like LoadingManager does)')
console.log('  reconstructed type:', reconstructed.constructor.name)
console.log('  instanceof ArrayBuffer:', reconstructed instanceof ArrayBuffer)
console.log('  instanceof Uint8Array:', reconstructed instanceof Uint8Array)
console.log('  instanceof Buffer:', Buffer.isBuffer(reconstructed))
console.log()

// What about a true Uint8Array?
const uint8array = new Uint8Array(diskBuffer.buffer, diskBuffer.byteOffset, diskBuffer.byteLength)
console.log('Test 3: True Uint8Array')
console.log('  uint8array type:', uint8array.constructor.name)
console.log('  instanceof ArrayBuffer:', uint8array instanceof ArrayBuffer)
console.log('  instanceof Uint8Array:', uint8array instanceof Uint8Array)
console.log('  uint8array.buffer type:', uint8array.buffer.constructor.name)
console.log()

// What about just a plain ArrayBuffer?
const plainArrayBuffer = diskBuffer.buffer.slice(diskBuffer.byteOffset, diskBuffer.byteOffset + diskBuffer.byteLength)
console.log('Test 4: Plain ArrayBuffer')
console.log('  plainArrayBuffer type:', plainArrayBuffer.constructor.name)
console.log('  instanceof ArrayBuffer:', plainArrayBuffer instanceof ArrayBuffer)
console.log('  instanceof Uint8Array:', plainArrayBuffer instanceof Uint8Array)
console.log()

console.log('The issue:')
console.log('- LoadingManager returns a Buffer/Uint8Array')
console.log('- GLTFLoader.parseAsync() may expect an ArrayBuffer')
console.log('- The fix: convert Uint8Array.buffer or use the internal .buffer property')
