import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function runTest() {
  console.log('Starting browser test...\n')

  const browser = await chromium.launch({ headless: false })
  const context = await browser.createBrowserContext()
  const page = await context.newPage()

  // Set up console logging
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error(`[BROWSER ERROR] ${msg.text()}`)
    } else if (msg.type() === 'warn') {
      console.warn(`[BROWSER WARN] ${msg.text()}`)
    } else {
      console.log(`[BROWSER LOG] ${msg.text()}`)
    }
  })

  page.on('error', (err) => console.error('[PAGE ERROR]', err))

  try {
    console.log('Opening http://localhost:3000/test-vrm-browser.html\n')
    await page.goto('http://localhost:3000/test-vrm-browser.html')

    // Wait for page to load
    await page.waitForLoadState('networkidle')
    console.log('✓ Page loaded\n')

    // Click step 1 button
    console.log('--- Clicking Step 1: Fetch VRM ---')
    await page.click('button:has-text("Fetch from")')

    // Wait for fetch to complete (max 30s)
    await page.waitForFunction(
      () => document.getElementById('test1').innerText.includes('Ready for step 2'),
      { timeout: 30000 }
    )
    console.log('✓ Step 1 complete\n')

    // Get step 1 output
    const test1Output = await page.textContent('#test1')
    console.log('Step 1 Output:')
    console.log(test1Output)
    console.log()

    // Click step 2 button
    console.log('--- Clicking Step 2: Parse with GLTFLoader ---')
    await page.click('button:has-text("Parse with GLTFLoader")')

    // Wait for parse to complete (max 30s)
    await page.waitForFunction(
      () => {
        const text = document.getElementById('test2').innerText
        return text.includes('Ready for step 3') || text.includes('FAILED')
      },
      { timeout: 30000 }
    )
    console.log('✓ Step 2 complete\n')

    // Get step 2 output
    const test2Output = await page.textContent('#test2')
    console.log('Step 2 Output:')
    console.log(test2Output)
    console.log()

    // Check if VRM was loaded
    const hasVRMError = test2Output.includes('NO VRM IN USERDATA')
    const hasVRMSuccess = test2Output.includes('VRM found in userData')

    if (hasVRMSuccess) {
      console.log('✓✓✓ VRM LOADED SUCCESSFULLY! ✓✓✓')

      // Click step 3 button
      console.log('\n--- Clicking Step 3: Check VRM Data ---')
      await page.click('button:has-text("Check VRM Data")')

      await page.waitForFunction(
        () => document.getElementById('test3').innerText.includes('accessible'),
        { timeout: 10000 }
      )
      console.log('✓ Step 3 complete\n')

      const test3Output = await page.textContent('#test3')
      console.log('Step 3 Output:')
      console.log(test3Output)
      console.log()

      // Click step 4 button
      console.log('--- Clicking Step 4: Detailed Analysis ---')
      await page.click('button:has-text("Run Detailed Analysis")')

      await page.waitForFunction(
        () => document.getElementById('test4').innerText.includes('complete'),
        { timeout: 10000 }
      )
      console.log('✓ Step 4 complete\n')

      const test4Output = await page.textContent('#test4')
      console.log('Step 4 Output:')
      console.log(test4Output)
    } else if (hasVRMError) {
      console.log('\n✗✗✗ VRM LOADING FAILED ✗✗✗')
      console.log('\nThis means:')
      console.log('1. GLTFLoader.parseAsync() executed successfully')
      console.log('2. But the VRMLoaderPlugin did NOT add VRM data to userData')
      console.log('3. The issue is with the VRM plugin, not the GLB format or fetch')
    } else {
      console.log('\n⚠ Test status unclear')
    }

    // Keep browser open for 5 seconds to see the UI
    console.log('\n\nBrowser will stay open for 10 seconds...')
    await page.waitForTimeout(10000)
  } catch (e) {
    console.error('\n✗ Test failed:', e.message)
    if (e.stack) console.error(e.stack)
  } finally {
    await browser.close()
    console.log('\nBrowser closed.')
  }
}

runTest().catch(console.error)
