import { createAnchorField } from '../anchor-field.js'
import { bakeHpfTexels } from './ops-js.js'

self.onmessage = (ev) => {
  try {
    const { seed, res } = ev.data
    const data = bakeHpfTexels(createAnchorField({ seed }), res)
    self.postMessage({ ok: true, data }, [data.buffer])
  } catch (e) {
    self.postMessage({ ok: false, error: String(e && e.message || e) })
  }
}
