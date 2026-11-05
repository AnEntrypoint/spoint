import { buildPhysicsAPI } from '/workspace/spoint/src/apps/AppPhysics.js'
import { AppContext } from '/workspace/spoint/src/apps/AppContext.js'

const rt = () => ({ _interactableIds: new Set(), _physics: null })
const ent = (id) => ({ id, custom: {}, position: [0, 0, 0] })
const attempt = (fn) => { try { return { ok: true, value: fn() } } catch (e) { return { ok: false, error: e.constructor.name + ': ' + e.message } } }
const out = {}

for (const r of [-1, NaN, 7]) {
  const e = ent('phys' + r); const rtm = rt()
  const res = attempt(() => buildPhysicsAPI(e, rtm).setInteractable(r))
  out['physics.setInteractable(' + r + ')'] = { result: res, _interactable: e._interactable, _interactRadius: e._interactRadius, customHasInteractable: e.custom._interactable !== undefined, inIds: rtm._interactableIds.has(e.id) }
}
const e2 = ent('ctx'); const rt2 = rt()
out['AppContext.interactable({radius:-1})'] = attempt(() => new AppContext(e2, rt2).interactable({ radius: -1 }))
const e3 = ent('ctx2'); const rt3 = rt()
out['AppContext.interactable({radius:5})'] = { result: attempt(() => new AppContext(e3, rt3).interactable({ radius: 5 })), custom: e3.custom._interactable }
console.log(JSON.stringify(out, null, 2))
