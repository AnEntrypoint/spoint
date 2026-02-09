import { request } from 'node:http'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

console.log('Test 1: Fetching Cleetus.vrm from server...\n')

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/apps/tps-game/Cleetus.vrm',
  method: 'GET'
}

const req = request(options, async (res) => {
  console.log('Status:', res.statusCode)
  console.log('Content-Type:', res.headers['content-type'])
  console.log('Content-Encoding:', res.headers['content-encoding'])

  let chunks = []
  res.on('data', (chunk) => chunks.push(chunk))
  res.on('end', async () => {
    const buffer = Buffer.concat(chunks)
    console.log('Total bytes:', buffer.length)

    // Show first 16 bytes as hex
    const hex = buffer.slice(0, 16).toString('hex').match(/.{1,2}/g).join(' ')
    console.log('First 16 bytes (hex):', hex)

    // Check magic
    if (buffer[0] === 0x67 && buffer[1] === 0x6c && buffer[2] === 0x54 && buffer[3] === 0x46) {
      console.log('✓ GLB magic detected (67 6c 54 46 = "glTF")')
    } else {
      console.log('✗ Wrong magic:', buffer.slice(0, 4).toString('hex'))
    }

    // Convert to Uint8Array like browser does
    const uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    console.log('\nTest 2: Attempt parseAsync with THREE.GLTFLoader...\n')

    try {
      const loader = new GLTFLoader()
      const gltf = await loader.parseAsync(buffer, '')

      console.log('✓ parseAsync succeeded!')
      console.log('GLTF userData keys:', Object.keys(gltf.userData))

      if (gltf.userData.vrm) {
        console.log('✓ VRM plugin loaded successfully')
        console.log('VRM scene:', gltf.userData.vrm.scene ? 'Present' : 'Missing')
      } else {
        console.log('✗ NO VRM IN USERDATA')
      }
    } catch (e) {
      console.log('✗ parseAsync FAILED')
      console.log('Error message:', e.message)
      console.log('Error:', e.toString())
      if (e.stack) console.log('Stack:', e.stack)
    }
  })
})

req.on('error', (e) => console.error('Request error:', e))
req.end()
