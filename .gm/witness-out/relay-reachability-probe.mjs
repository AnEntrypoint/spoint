import net from 'node:net'
const hosts = ['relay.damus.io', 'relay.primal.net', 'nos.lol', 'relay.snort.social']
const check = (host) => new Promise((resolve) => {
  const s = net.connect({ host, port: 443, timeout: 5000 })
  s.on('connect', () => { s.destroy(); resolve(`${host} reachable`) })
  s.on('timeout', () => { s.destroy(); resolve(`${host} timeout`) })
  s.on('error', (e) => resolve(`${host} error ${e.code || e.message}`))
})
for (const line of await Promise.all(hosts.map(check))) console.log(line)
