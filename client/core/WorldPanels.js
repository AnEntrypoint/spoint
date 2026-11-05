const CANVAS_WIDTH_PX = 512
const FONT_FAMILY = 'system-ui, sans-serif'
const DEFAULTS = Object.freeze({ width: 1, height: 0.25, color: '#ffffff', background: null, align: 'center' })
const ALIGN_X = Object.freeze({ left: 0, center: 0.5, right: 1 })

export class WorldPanelError extends Error {
  constructor(reasonCode, detail) {
    super(`[world-panel] ${reasonCode}${detail === undefined ? '' : `: ${String(detail)}`}`)
    this.name = 'WorldPanelError'
    this.reasonCode = reasonCode
  }
}

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

function parsePosition(p) {
  if (Array.isArray(p) && p.length === 3 && p.every(finite)) return p
  if (p && finite(p.x) && finite(p.y) && finite(p.z)) return [p.x, p.y, p.z]
  throw new WorldPanelError('position', p)
}

function parseMetres(v, fallback, reasonCode) {
  if (v === undefined) return fallback
  if (!finite(v) || v <= 0) throw new WorldPanelError(reasonCode, v)
  return v
}

function parseSpec(spec) {
  if (!spec || typeof spec.text !== 'string') throw new WorldPanelError('text', spec?.text)
  if (spec.color !== undefined && typeof spec.color !== 'string') throw new WorldPanelError('color', spec.color)
  if (spec.background !== undefined && spec.background !== null && typeof spec.background !== 'string') throw new WorldPanelError('background', spec.background)
  if (spec.align !== undefined && !(spec.align in ALIGN_X)) throw new WorldPanelError('align', spec.align)
  const width = parseMetres(spec.width, DEFAULTS.width, 'width')
  const height = parseMetres(spec.height, DEFAULTS.height, 'height')
  return {
    position: parsePosition(spec.position),
    text: spec.text,
    color: spec.color ?? DEFAULTS.color,
    background: spec.background ?? DEFAULTS.background,
    align: spec.align ?? DEFAULTS.align,
    width,
    height
  }
}

function drawPanel(ctx2d, canvas, spec) {
  const w = canvas.width
  const h = canvas.height
  ctx2d.clearRect(0, 0, w, h)
  if (spec.background) {
    ctx2d.fillStyle = spec.background
    ctx2d.fillRect(0, 0, w, h)
  }
  const fontPx = Math.floor(h * 0.5)
  ctx2d.font = `${fontPx}px ${FONT_FAMILY}`
  ctx2d.textBaseline = 'middle'
  ctx2d.textAlign = spec.align
  ctx2d.fillStyle = spec.color
  ctx2d.fillText(spec.text, ALIGN_X[spec.align] * w, h / 2, w * 0.96)
}

function createRecord(THREE, scene, spec) {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH_PX
  canvas.height = Math.max(1, Math.round(CANVAS_WIDTH_PX * spec.height / spec.width))
  const texture = new THREE.CanvasTexture(canvas)
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })
  const geometry = new THREE.PlaneGeometry(spec.width, spec.height)
  const mesh = new THREE.Mesh(geometry, material)
  scene.add(mesh)
  return { canvas, ctx2d: canvas.getContext('2d'), texture, material, geometry, mesh, width: spec.width, height: spec.height, text: null, color: null, background: null, align: null }
}

function disposeRecord(scene, record) {
  scene.remove(record.mesh)
  record.geometry.dispose()
  record.material.dispose()
  record.texture.dispose()
}

export function createWorldPanels(THREE, scene) {
  const records = new Map()
  const seen = new Set()

  function set(key, specInput) {
    const spec = parseSpec(specInput)
    let record = records.get(key)
    if (record && (record.width !== spec.width || record.height !== spec.height)) {
      disposeRecord(scene, record)
      records.delete(key)
      record = null
    }
    if (!record) {
      record = createRecord(THREE, scene, spec)
      records.set(key, record)
    }
    if (record.text !== spec.text || record.color !== spec.color || record.background !== spec.background || record.align !== spec.align) {
      drawPanel(record.ctx2d, record.canvas, spec)
      record.texture.needsUpdate = true
      record.text = spec.text
      record.color = spec.color
      record.background = spec.background
      record.align = spec.align
    }
    record.mesh.position.set(spec.position[0], spec.position[1], spec.position[2])
    seen.add(key)
  }

  function commit(camera) {
    for (const [key, record] of records) {
      if (!seen.has(key)) {
        disposeRecord(scene, record)
        records.delete(key)
        continue
      }
      if (camera) record.mesh.quaternion.copy(camera.quaternion)
    }
    seen.clear()
  }

  function dispose() {
    for (const record of records.values()) disposeRecord(scene, record)
    records.clear()
    seen.clear()
  }

  return { set, commit, dispose, get size() { return records.size } }
}
