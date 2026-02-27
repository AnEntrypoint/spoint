const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ 
    headless: false, 
    slowMo: 50,
    args: ['--disable-cache']
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true
  });
  const page = await context.newPage();
  
  // Clear all storage
  await page.context().clearCookies();
  
  // Capture console logs
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('entity') || text.includes('model') || text.includes('schwust') || text.includes('arena') || text.includes('environment')) {
      console.log('BROWSER:', text);
    }
  });
  
  console.log('Opening localhost:3001 with fresh browser...');
  await page.goto('http://localhost:3001', { waitUntil: 'domcontentloaded', timeout: 60000 });
  
  // Wait for game to load and check entities
  console.log('Page loaded, checking entities...');
  await page.waitForTimeout(10000);
  
  // Check what entities are in the scene
  const entityInfo = await page.evaluate(() => {
    const debug = window.debug;
    if (!debug) return 'no debug';
    const meshes = Array.from(debug.entityMeshes?.keys() || []);
    return { meshCount: meshes.length, meshIds: meshes };
  });
  console.log('Entity meshes:', JSON.stringify(entityInfo));
  
  // Take screenshot
  await page.screenshot({ path: 'game-screenshot.png' });
  console.log('Screenshot saved to game-screenshot.png');
  
  // Keep open for inspection
  console.log('Waiting 30 more seconds...');
  await page.waitForTimeout(30000);
  
  await browser.close();
})().catch(console.error);
