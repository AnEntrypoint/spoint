import { pathToFileURL } from 'node:url'
const R = '/workspace/spoint'
const result = await new Promise((resolve) => {
  import(pathToFileURL(R + '/src/protocol/msgpack.js').href).then((mp) => {
    let immediate = 'not-run'
    try { mp.pack({ a: 1 }); immediate = 'pack-ok' } catch (e) { immediate = 'threw: ' + e.message.slice(0, 70) }
    mp.ensurePacked.then(() => {
      let after = 'not-run'
      try { after = JSON.stringify(mp.unpack(mp.pack({ a: 1 }))) } catch (e) { after = 'threw: ' + e.message.slice(0, 70) }
      resolve({ immediate, after })
    })
  })
})
console.log(`csproto-3 ${result.immediate.startsWith('threw') && result.after === '{"a":1}' ? 'CONFIRMED' : 'NOT-CONFIRMED'} immediate=${result.immediate} afterSettle=${result.after}`)
