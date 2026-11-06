import { launch } from '/workspace/spoint/scripts/lib/cdp-browser.mjs'
const browser = await launch({})
const ctx = await browser.newContext()
const page = await ctx.newPage()
await page.enableDomain('Runtime')
await page.goto('http://127.0.0.1:1/')
const out = await page.evaluate(async () => {
  const res = await Promise.race([
    navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted').catch(e => 'error: ' + e.name),
    new Promise(r => setTimeout(() => r('hung-3s'), 3000)),
  ])
  return { getUserMedia: res }
}).catch(e => ({ err: String(e).slice(0, 120) }))
await page.close()
await browser.close()
console.log(JSON.stringify(out))
