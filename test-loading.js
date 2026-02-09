
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    // Set viewport for screenshots
    await page.setViewport({ width: 1280, height: 720 });
    
    // Navigate to the app
    console.log('Navigating to http://localhost:3000...');
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 10000 });
    
    // Wait a bit for loading to progress
    await page.waitForTimeout(1000);
    
    // Check if loading overlay exists
    const hasLoadingOverlay = await page.evaluate(() => {
      return document.getElementById('loading-overlay') !== null;
    });
    
    console.log('Loading overlay visible:', hasLoadingOverlay);
    
    // Get current loading state
    const loadingState = await page.evaluate(() => {
      const overlay = document.getElementById('loading-overlay');
      if (!overlay) return null;
      return {
        visible: overlay.style.display !== 'none' && !overlay.classList.contains('fade-out'),
        stageText: overlay.querySelector('.loading-stage-text')?.textContent || '',
        percent: overlay.querySelector('.loading-percent')?.textContent || '0%',
        progressWidth: overlay.querySelector('.loading-progress-fill')?.style.width || '0%'
      };
    });
    
    console.log('Loading state:', loadingState);
    
    // Wait more and check again
    await page.waitForTimeout(2000);
    
    const loadingState2 = await page.evaluate(() => {
      const overlay = document.getElementById('loading-overlay');
      if (!overlay) return null;
      return {
        visible: overlay.style.display !== 'none' && !overlay.classList.contains('fade-out'),
        stageText: overlay.querySelector('.loading-stage-text')?.textContent || '',
        percent: overlay.querySelector('.loading-percent')?.textContent || '0%',
        progressWidth: overlay.querySelector('.loading-progress-fill')?.style.width || '0%'
      };
    });
    
    console.log('Loading state after 2s:', loadingState2);
    
    // Take screenshot
    await page.screenshot({ path: 'loading-screenshot.png' });
    console.log('Screenshot saved as loading-screenshot.png');
    
    // Check if there are any console errors
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    // Wait a bit more
    await page.waitForTimeout(1000);
    
    if (errors.length > 0) {
      console.log('Console errors:', errors);
    } else {
      console.log('No console errors detected');
    }
    
  } catch (err) {
    console.error('Test error:', err.message);
  } finally {
    await browser.close();
  }
})();
