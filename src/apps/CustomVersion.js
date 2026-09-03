// Version-counter tracking for entity.custom, replacing a per-tick JSON.stringify-and-compare in
// SnapshotEncoder.custToStr. entity.custom is a plain object apps mutate two ways: wholesale
// reassignment (ctx.entity.custom = {...}) and in-place field writes (ctx.entity.custom.color = x,
// ent.custom._collider = y). Both must bump a version counter so the snapshot encoder can detect a
// real change with an integer compare instead of re-stringifying every tick -- and, since reference
// equality alone can't see in-place mutation (a real latent bug: the object identity never changes),
// this is also a correctness fix, not just a perf one.
//
// installCustomVersion(entity) defines entity.custom as an accessor property: the raw value lives in
// entity._customRaw, entity._customV is a monotonic counter bumped by wrapMutable's Proxy on any
// set/deleteProperty trap (nested writes) and by the custom setter itself (wholesale reassignment).
// Nested plain-object/array values inside custom are wrapped too (recursively, lazily on first get)
// so a deep write like custom.weapon.ammo = 3 is also tracked.
export function installCustomVersion(entity) {
  if (Object.getOwnPropertyDescriptor(entity, 'custom')?.get) return // already installed
  const initial = entity.custom
  entity._customRaw = null
  entity._customV = 0
  Object.defineProperty(entity, 'custom', {
    enumerable: true,
    configurable: true,
    get() { return entity._customRaw },
    set(v) {
      if (v !== null && v !== undefined && (typeof v !== 'object' || Array.isArray(v))) throw new TypeError('entity.custom must be null or a plain object')
      entity._customRaw = v == null ? null : wrapMutable(v, entity)
      entity._customV++
    }
  })
  entity.custom = initial || null
}

function bump(entity) { entity._customV++ }

function wrapMutable(obj, entity) {
  if (obj === null || typeof obj !== 'object' || obj.__isCustomVersionProxy) return obj
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (prop === '__isCustomVersionProxy') return true
      // Lazily wrap nested plain objects/arrays so deep writes (custom.a.b = x) also bump the version --
      // only wrap plain data (object/array), never functions or already-wrapped values.
      if (v !== null && typeof v === 'object' && !v.__isCustomVersionProxy && (v.constructor === Object || Array.isArray(v))) {
        const wrapped = wrapMutable(v, entity)
        Reflect.set(target, prop, wrapped)
        return wrapped
      }
      return v
    },
    set(target, prop, value, receiver) {
      const ok = Reflect.set(target, prop, value, receiver)
      if (ok) bump(entity)
      return ok
    },
    deleteProperty(target, prop) {
      const ok = Reflect.deleteProperty(target, prop)
      if (ok) bump(entity)
      return ok
    }
  })
}
