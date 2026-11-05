const ORIENTATIONS = Object.freeze(['orthogonal'])

function importError(reasonCode, message) {
  return Object.assign(new Error(`TiledImport: ${message}`), { reasonCode })
}

function requireArray(value, where) {
  if (!Array.isArray(value)) throw importError('tiled-shape', `${where} must be an array`)
  return value
}

function propertyMap(list) {
  const out = {}
  for (const p of list ?? []) {
    if (typeof p?.name !== 'string') throw importError('tiled-property', 'property without a name')
    out[p.name] = p.value
  }
  return out
}

function tileLayerPlacements(layer, tileSize) {
  const width = layer.width
  const rows = []
  if (!Number.isInteger(width) || width <= 0) throw importError('tiled-layer', `tile layer "${layer.name}" has no width`)
  const data = requireArray(layer.data, `tile layer "${layer.name}" data`)
  for (let i = 0; i < data.length; i++) {
    const gid = data[i]
    if (!Number.isInteger(gid)) throw importError('tiled-gid', `tile layer "${layer.name}" holds a non-integer gid at index ${i}`)
    if (gid === 0) continue
    const col = i % width
    const row = Math.floor(i / width)
    rows.push({ kind: 'tile', layer: layer.name, gid, col, row, x: col * tileSize, y: row * tileSize })
  }
  return rows
}

function objectLayerPlacements(layer) {
  return requireArray(layer.objects, `object layer "${layer.name}" objects`).map(obj => {
    if (!Number.isFinite(obj.x) || !Number.isFinite(obj.y)) throw importError('tiled-object', `object ${obj.id} in "${layer.name}" has no position`)
    return {
      kind: 'object',
      layer: layer.name,
      id: obj.id,
      name: obj.name ?? '',
      type: obj.type ?? '',
      x: obj.x,
      y: obj.y,
      width: obj.width ?? 0,
      height: obj.height ?? 0,
      rotation: obj.rotation ?? 0,
      visible: obj.visible !== false,
      gid: obj.gid ?? null,
      properties: propertyMap(obj.properties),
    }
  })
}

export function importTiledMap(map) {
  if (!map || typeof map !== 'object') throw importError('tiled-shape', 'map must be an object')
  if (!ORIENTATIONS.includes(map.orientation)) throw importError('tiled-orientation', `orientation "${map.orientation}" is not one of ${ORIENTATIONS.join(', ')}`)
  if (!Number.isInteger(map.tilewidth) || map.tilewidth <= 0) throw importError('tiled-tilesize', 'tilewidth must be a positive integer')
  const layers = requireArray(map.layers, 'layers')
  const placements = []
  for (const layer of layers) {
    if (layer.visible === false) continue
    if (layer.type === 'tilelayer') placements.push(...tileLayerPlacements(layer, map.tilewidth))
    else if (layer.type === 'objectgroup') placements.push(...objectLayerPlacements(layer))
  }
  return {
    width: map.width,
    height: map.height,
    tileSize: map.tilewidth,
    properties: propertyMap(map.properties),
    placements,
  }
}
