import { chromium } from 'playwright'

async function runTest() {
  console.log('Starting quick browser test...\n')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()

  // Capture all console messages
  const logs = []
  page.on('console', (msg) => {
    const logMsg = `[${msg.type().toUpperCase()}] ${msg.text()}`
    logs.push(logMsg)
    console.log(logMsg)
  })

  try {
    console.log('Opening test page...')
    await page.goto('http://localhost:3000/test-vrm-browser.html', { waitUntil: 'networkidle', timeout: 15000 })
    console.log('✓ Page loaded\n')

    // Inject and run fetch test directly
    console.log('Injecting fetch test...')
    const result = await page.evaluate(async () => {
      return new Promise(async (resolve) => {
        try {
          console.log('Fetching /apps/tps-game/Cleetus.vrm...')
          const response = await fetch('/apps/tps-game/Cleetus.vrm')
          console.log(`HTTP ${response.status}`)

          const arrayBuffer = await response.arrayBuffer()
          console.log(`Received ${arrayBuffer.byteLength} bytes`)

          const uint8 = new Uint8Array(arrayBuffer)
          const magic = String.fromCharCode(uint8[0], uint8[1], uint8[2], uint8[3])
          console.log(`Magic: "${magic}"`)

          // Try to parse
          console.log('Attempting GLTFLoader parse...')
          const { GLTFLoader } = await import('https://cdn.jsdelivr.net/npm/three@0.171.0/examples/jsm/loaders/GLTFLoader.js')
          const { VRMLoaderPlugin } = await import('https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@3/lib/index.mjs')

          const loader = new GLTFLoader()
          loader.register((parser) => new VRMLoaderPlugin(parser))

          const gltf = await loader.parseAsync(arrayBuffer, '')
          console.log('parseAsync completed')
          console.log('userData keys: ' + Object.keys(gltf.userData).join(', '))

          if (gltf.userData.vrm) {
            console.log('✓ VRM DATA FOUND!')
            resolve({ success: true, vrm: 'present' })
          } else {
            console.log('✗ NO VRM IN USERDATA')
            resolve({ success: false, vrm: 'missing' })
          }
        } catch (e) {
          console.error(`ERROR: ${e.message}`)
          console.error(`Stack: ${e.stack}`)
          resolve({ success: false, error: e.message })
        }
      })
    })

    console.log('\n--- Test Result ---')
    console.log(JSON.stringify(result, null, 2))

    if (result.success) {
      console.log('\n✓✓✓ VRM LOADING SUCCESS ✓✓✓')
    } else {
      console.log('\n✗✗✗ VRM LOADING FAILED ✗✗✗')
    }
  } catch (e) {
    console.error('Test error:', e.message)
  } finally {
    await browser.close()
    console.log('\nBrowser closed.')
  }
}

runTest().catch(console.error)
