export function installCustomVersion(entity) {
  if (Object.getOwnPropertyDescriptor(entity, 'custom')?.get) return
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
      const isUnwrappedPlainData = v !== null && typeof v === 'object' && !v.__isCustomVersionProxy && (v.constructor === Object || Array.isArray(v))
      if (isUnwrappedPlainData) {
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
