import { chromium } from 'playwright';

async function test() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  
  console.log('Opening localhost:3001...');
  await page.goto('http://localhost:3001', { waitUntil: 'networkidle' });
  
  // Wait for game to load
  await page.waitForTimeout(5000);
  
  // Take screenshot
  await page.screenshot({ path: 'test-screenshot.png', fullPage: true });
  console.log('Screenshot saved to test-screenshot.png');
  
  // Keep browser open for 30 seconds
  console.log('Waiting 30 seconds for visual inspection...');
  await page.waitForTimeout(30000);
  
  await browser.close();
}

test().catch(console.error);
