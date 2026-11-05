const VEC3 = ['x', 'y', 'z']

function refusal(reasonCode, message) {
  return Object.assign(new Error(`SceneImport: ${message}`), { reasonCode })
}

function vec3(value, where) {
  if (value == null) return [0, 0, 0]
  if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) return [...value]
  if (typeof value === 'object' && VEC3.every(k => Number.isFinite(value[k]))) return VEC3.map(k => value[k])
  throw refusal('scene-vector', `${where} must be [x,y,z] or {x,y,z} of finite numbers`)
}

function quat(value, where) {
  if (value == null) return [0, 0, 0, 1]
  if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)) return [...value]
  throw refusal('scene-quaternion', `${where} must be [x,y,z,w] of finite numbers`)
}

function templateFor(kind, kindToTemplate, where) {
  const template = Object.hasOwn(kindToTemplate, kind) ? kindToTemplate[kind] : undefined
  if (typeof template !== 'string' || template.length === 0) {
    throw refusal('scene-kind-unmapped', `${where} kind "${kind}" has no template`)
  }
  return template
}

export function mapSceneObject(object, kindToTemplate, index = 0) {
  const where = `object[${index}]`
  if (!object || typeof object !== 'object') throw refusal('scene-object', `${where} must be an object`)
  if (typeof object.id !== 'string' || object.id.length === 0) throw refusal('scene-object-id', `${where} needs a non-empty string id`)
  return Object.freeze({
    id: object.id,
    template: templateFor(object.kind, kindToTemplate, where),
    position: vec3(object.position, `${where}.position`),
    rotation: quat(object.rotation, `${where}.rotation`),
    scale: vec3(object.scale ?? [1, 1, 1], `${where}.scale`),
    custom: object.state && typeof object.state === 'object' ? { ...object.state } : {},
  })
}

export function mapScene(scene, kindToTemplate) {
  if (!scene || typeof scene !== 'object') throw refusal('scene-root', 'scene must be an object')
  if (typeof scene.id !== 'string' || scene.id.length === 0) throw refusal('scene-id', 'scene needs a non-empty string id')
  if (!kindToTemplate || typeof kindToTemplate !== 'object') throw refusal('scene-kind-table', 'kindToTemplate must be an object')
  const objects = Array.isArray(scene.objects) ? scene.objects : []
  const seen = new Set()
  const placements = objects.map((object, index) => {
    const placement = mapSceneObject(object, kindToTemplate, index)
    if (seen.has(placement.id)) throw refusal('scene-object-duplicate', `object[${index}] id "${placement.id}" repeats`)
    seen.add(placement.id)
    return placement
  })
  return Object.freeze({
    place: Object.freeze({ id: scene.id, spawn: vec3(scene.spawn, 'scene.spawn') }),
    placements: Object.freeze(placements),
  })
}
