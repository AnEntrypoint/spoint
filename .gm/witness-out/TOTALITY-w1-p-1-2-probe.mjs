import { parseInteractable } from '/workspace/spoint/src/apps/AppPhysics.js'
import { vecOK, nonNeg } from '/workspace/spoint/src/shared/vecGuard.js'
const tryIt = (f) => { try { return { ok: f() } } catch (e) { return { threw: e.constructor.name, msg: e.message } } }
const out = {
  vecOK_len3: vecOK([0, 0, 0], 3),
  nonNeg_neg5: tryIt(() => nonNeg(-5, '[probe] radius')),
  nonNeg_NaN: tryIt(() => nonNeg(NaN, '[probe] radius')),
  interactable_radius_m1: tryIt(() => parseInteractable({ radius: -1, cooldown: 500, prompt: 'E' })),
  interactable_radius_NaN: tryIt(() => parseInteractable({ radius: NaN, cooldown: 500, prompt: 'E' })),
  interactable_cooldown_Inf: tryIt(() => parseInteractable({ radius: 3, cooldown: Infinity, prompt: 'E' })),
  interactable_radius_str: tryIt(() => parseInteractable({ radius: '7', cooldown: 500, prompt: 'E' })),
  interactable_valid: tryIt(() => parseInteractable({ radius: 4, cooldown: 250, prompt: 'E' })),
}
console.log(JSON.stringify(out))
