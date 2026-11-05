const { EventEmitter } = await import('/workspace/spoint/src/protocol/EventEmitter.js')
const out = {}
{
  const e = new EventEmitter(); const seen = []
  const a = () => seen.push('a'), b = () => { seen.push('b'); e.off('x', a) }, c = () => seen.push('c')
  e.on('x', a).on('x', b).on('x', c)
  const origErr = console.error; console.error = () => {}
  const r = e.emit('x'); console.error = origErr
  out.removalDuringEmit = { seen, returned: r }
}
{
  const e = new EventEmitter(); let calls = 0
  e.once('y', () => { calls++; throw new Error('boom') })
  const origErr = console.error; console.error = () => {}
  e.emit('y'); e.emit('y'); console.error = origErr
  out.onceThrowing = { calls, remaining: e.listenerCount('y') }
}
{
  const e = new EventEmitter()
  e.on('z', () => { throw new Error('a') })
  const origErr = console.error; console.error = () => {}
  const r = e.emit('z'); console.error = origErr
  out.allThrew = { returned: r }
}
{
  const e = new EventEmitter(); e.on('ok', () => {})
  out.delivered = { returned: e.emit('ok') }
}
console.log(JSON.stringify(out))
