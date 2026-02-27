const { chromium } = require('playwright');

async function test() {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const page = await browser.newPage();
  
  console.log('Opening localhost:3001...');
  await page.goto('http://localhost:3001', { waitUntil: 'domcontentloaded', timeout: 60000 });
  
  // Wait for game to load
  console.log('Page loaded, waiting 60 seconds for game...');
  await page.waitForTimeout(60000);
  
  await browser.close();
}

test().catch(console.error);
