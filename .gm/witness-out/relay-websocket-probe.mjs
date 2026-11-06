const urls = ['wss://relay.damus.io', 'wss://nos.lol']
const probe = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url)
  const t = setTimeout(() => { try { ws.close() } catch {} resolve(`${url} timeout`) }, 8000)
  ws.onopen = () => { clearTimeout(t); ws.close(); resolve(`${url} open`) }
  ws.onerror = (e) => { clearTimeout(t); resolve(`${url} error ${e?.message || e?.type || 'event'}`) }
})
for (const line of await Promise.all(urls.map(probe))) console.log(line)
