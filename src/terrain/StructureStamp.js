const templates = new Map()

function finiteNumber(value, label, id) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`[structure-stamp] template "${id}" field ${label} is ${JSON.stringify(value)}: a part coordinate or size is a finite number, so a bad value is refused where the template is defined instead of placing a post at NaN`)
  }
  return value
}

function positiveRadius(value, id) {
  if (typeof value !== 'number' || !(value > 0) || !Number.isFinite(value)) {
    throw new TypeError(`[structure-stamp] template "${id}" footprint radius is ${JSON.stringify(value)}: a footprint is a positive finite radius in metres, so an empty or unbounded footprint is refused at definition`)
  }
  return value
}

function frozenPart(part, id) {
  if (!part || typeof part !== 'object' || typeof part.model !== 'string' || part.model.length === 0) {
    throw new TypeError(`[structure-stamp] template "${id}" has a part with model ${JSON.stringify(part?.model)}: every part names one model by a non-empty string`)
  }
  return Object.freeze({
    model: part.model,
    x: finiteNumber(part.x ?? 0, 'x', id),
    z: finiteNumber(part.z ?? 0, 'z', id),
    rotY: finiteNumber(part.rotY ?? 0, 'rotY', id),
    scale: finiteNumber(part.scale ?? 1, 'scale', id),
  })
}

export function defineStructureTemplate(id, spec) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError(`[structure-stamp] defineStructureTemplate got id ${JSON.stringify(id)}: a template id is a non-empty string, so a stamp can name the template it places`)
  }
  if (templates.has(id)) {
    throw new TypeError(`[structure-stamp] template "${id}" is already defined: one id owns one set of parts, so a second definition is refused instead of replacing the first`)
  }
  if (!spec || !Array.isArray(spec.parts) || spec.parts.length === 0) {
    throw new TypeError(`[structure-stamp] template "${id}" declares no parts: a structure is one or more model parts, so an empty template is refused where it is defined`)
  }
  const template = Object.freeze({
    id,
    footprintRadius: positiveRadius(spec.footprintRadius, id),
    parts: Object.freeze(spec.parts.map((part) => frozenPart(part, id))),
  })
  templates.set(id, template)
  return template
}

export function structureTemplate(id) {
  const template = templates.get(id)
  if (!template) {
    throw new TypeError(`[structure-stamp] template "${id}" has no definition: a stamp resolves its parts from a defined template, so an unknown id is refused where the stamp is requested`)
  }
  return template
}

function stampRecord(stamp, index) {
  if (!stamp || typeof stamp !== 'object') {
    throw new TypeError(`[structure-stamp] stamp ${index} is ${JSON.stringify(stamp)}: a stamp is an object naming a template and a chart-local x and z`)
  }
  const template = structureTemplate(stamp.template)
  return {
    index,
    template,
    x: finiteNumber(stamp.x, 'stamp.x', stamp.template),
    z: finiteNumber(stamp.z, 'stamp.z', stamp.template),
    rotY: finiteNumber(stamp.rotY ?? 0, 'stamp.rotY', stamp.template),
    priority: finiteNumber(stamp.priority ?? 0, 'stamp.priority', stamp.template),
  }
}

function insideFootprint(stamp, x, z) {
  const dx = x - stamp.x, dz = z - stamp.z
  const r = stamp.template.footprintRadius
  return dx * dx + dz * dz <= r * r
}

function rotatedOffset(part, rotY) {
  const c = Math.cos(rotY), s = Math.sin(rotY)
  return [part.x * c + part.z * s, -part.x * s + part.z * c]
}

function groundHeight(groundAt, x, z, template) {
  const y = groundAt(x, z)
  if (typeof y !== 'number' || !Number.isFinite(y)) {
    throw new TypeError(`[structure-stamp] template "${template.id}" found no ground at (${x}, ${z}): a post needs a height to stand on, so the stamp is refused rather than sinking a post at ${JSON.stringify(y)}`)
  }
  return y
}

export function stampStructures(stamps, groundAt) {
  if (!Array.isArray(stamps)) {
    throw new TypeError(`[structure-stamp] stampStructures got ${JSON.stringify(stamps)}: the stamps are an array, so an overlay has an order to resolve`)
  }
  if (typeof groundAt !== 'function') {
    throw new TypeError(`[structure-stamp] stampStructures got no ground sampler: every post reads its height from one (x, z) -> y function`)
  }
  const records = stamps.map(stampRecord)
  const order = records.slice().sort((a, b) => b.priority - a.priority || a.index - b.index)
  const posts = []
  for (const stamp of order) {
    const baseY = groundHeight(groundAt, stamp.x, stamp.z, stamp.template)
    for (const part of stamp.template.parts) {
      const [ox, oz] = rotatedOffset(part, stamp.rotY)
      const x = stamp.x + ox, z = stamp.z + oz
      if (order.some((higher) => higher.priority > stamp.priority && insideFootprint(higher, x, z))) continue
      posts.push({
        model: part.model,
        x,
        y: baseY,
        z,
        rotY: part.rotY + stamp.rotY,
        scale: part.scale,
        stamp: stamp.index,
      })
    }
  }
  return posts
}
