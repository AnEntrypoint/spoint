const isMorphMesh = (node) => node.isMesh === true &&
  node.morphTargetDictionary != null && Array.isArray(node.morphTargetInfluences)

const unitWeight = (name, weight) => {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) {
    throw new TypeError(`[ShapeKeys] weight for "${name}" must be a finite number`)
  }
  return Math.min(1, Math.max(0, weight))
}

export function createShapeKeyDriver(root) {
  const targets = []
  root.traverse((node) => {
    if (isMorphMesh(node)) targets.push(node)
  })

  const find = (name) => targets.filter((mesh) => name in mesh.morphTargetDictionary)

  const names = () => {
    const set = new Set()
    for (const mesh of targets) for (const key of Object.keys(mesh.morphTargetDictionary)) set.add(key)
    return [...set]
  }

  const requireTargets = (name) => {
    const owners = find(name)
    if (owners.length === 0) throw new Error(`[ShapeKeys] no shape key named "${name}"`)
    return owners
  }

  const set = (name, weight) => {
    const w = unitWeight(name, weight)
    for (const mesh of requireTargets(name)) mesh.morphTargetInfluences[mesh.morphTargetDictionary[name]] = w
    return w
  }

  const get = (name) => {
    const owners = requireTargets(name)
    const mesh = owners[0]
    return mesh.morphTargetInfluences[mesh.morphTargetDictionary[name]]
  }

  const setMany = (weights) => {
    for (const name of Object.keys(weights)) set(name, weights[name])
  }

  const reset = () => {
    for (const mesh of targets) mesh.morphTargetInfluences.fill(0)
  }

  const snapshot = () => {
    const out = {}
    for (const name of names()) out[name] = get(name)
    return out
  }

  return { names, get, set, setMany, reset, snapshot, meshCount: targets.length }
}

export default createShapeKeyDriver
