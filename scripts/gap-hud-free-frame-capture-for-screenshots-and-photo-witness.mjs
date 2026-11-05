import { captureHudFreeFrame } from '../client/core/frameCapture.js'

const results = []
function expect(name, ok, detail) {
  results.push(ok === true)
  console.log(`${ok === true ? 'ok' : 'FAIL'} ${name}${ok === true ? '' : ` ${detail ?? ''}`}`)
}

function hudEl(visibility) {
  return { style: { visibility } }
}

function fakeRenderer({ throwOnRender = false, nullBlob = false } = {}) {
  const log = { hiddenDuringRender: null, hiddenDuringBlob: null, blobType: null, blobQuality: null }
  const hud = [hudEl('visible'), hudEl('')]
  const canvas = {
    toBlob(cb, type, quality) {
      log.hiddenDuringBlob = hud.map((el) => el.style.visibility)
      log.blobType = type
      log.blobQuality = quality
      cb(nullBlob ? null : { size: 4, type })
    },
  }
  const renderer = {
    domElement: canvas,
    render() {
      log.hiddenDuringRender = hud.map((el) => el.style.visibility)
      if (throwOnRender) throw new Error('boom')
    },
  }
  return { renderer, hud, log }
}

{
  const { renderer, hud, log } = fakeRenderer()
  const blob = await captureHudFreeFrame({ renderer, scene: {}, camera: {}, hudElements: hud, type: 'image/jpeg', quality: 0.8 })
  expect('returns the blob from toBlob', blob && blob.type === 'image/jpeg', JSON.stringify(blob))
  expect('hud hidden during render', log.hiddenDuringRender.every((v) => v === 'hidden'), JSON.stringify(log.hiddenDuringRender))
  expect('hud hidden when the bitmap is snapshotted', log.hiddenDuringBlob.every((v) => v === 'hidden'), JSON.stringify(log.hiddenDuringBlob))
  expect('hud restored to prior visibility', hud[0].style.visibility === 'visible' && hud[1].style.visibility === '', JSON.stringify(hud.map((h) => h.style.visibility)))
  expect('type and quality forwarded to toBlob', log.blobType === 'image/jpeg' && log.blobQuality === 0.8, JSON.stringify([log.blobType, log.blobQuality]))
}

{
  const { renderer, hud } = fakeRenderer({ throwOnRender: true })
  let threw = false
  try {
    await captureHudFreeFrame({ renderer, scene: {}, camera: {}, hudElements: hud })
  } catch (e) {
    threw = e.message === 'boom'
  }
  expect('render error propagates', threw)
  expect('hud restored after render error', hud.every((h) => h.style.visibility !== 'hidden'), JSON.stringify(hud.map((h) => h.style.visibility)))
}

{
  const { renderer, hud } = fakeRenderer({ nullBlob: true })
  let code = null
  try {
    await captureHudFreeFrame({ renderer, scene: {}, camera: {}, hudElements: hud })
  } catch (e) {
    code = e.message
  }
  expect('null blob refused as capture_unavailable', code === 'capture_unavailable', String(code))
  expect('hud restored after null blob', hud.every((h) => h.style.visibility !== 'hidden'))
}

{
  const { renderer } = fakeRenderer()
  const blob = await captureHudFreeFrame({ renderer, scene: {}, camera: {} })
  expect('works with no hud elements', blob != null)
}

const pass = results.length > 0 && results.every(Boolean)
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(pass ? 0 : 1)
