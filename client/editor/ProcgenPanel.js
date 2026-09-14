import { h, applyDiff } from 'anentrypoint-design'
import { Btn, Toolbar, EmptyState } from './wm/ui.js'
import { runWFCWithRetries } from '/src/procgen/WFC.js'
import { generateLSystemTree, PRESETS as LSYSTEM_PRESETS } from '/src/procgen/LSystem.js'
import { generateHeightfield } from '/src/procgen/NoiseTerrain.js'

const DEFAULT_WFC_TILES = [
  { id: 'floor', weight: 4, sockets: { N: 'f', S: 'f', E: 'f', W: 'f' } },
  { id: 'wall-n', weight: 1, sockets: { N: 'w', S: 'f', E: 'f', W: 'f' } },
  { id: 'wall-s', weight: 1, sockets: { N: 'f', S: 'w', E: 'f', W: 'f' } },
  { id: 'wall-e', weight: 1, sockets: { N: 'f', S: 'f', E: 'w', W: 'f' } },
  { id: 'wall-w', weight: 1, sockets: { N: 'f', S: 'f', E: 'f', W: 'w' } },
  { id: 'void', weight: 1, sockets: { N: 'w', S: 'w', E: 'w', W: 'w' } }
]
const WFC_TILE_COLOR = { floor: '#3a6', 'wall-n': '#864', 'wall-s': '#864', 'wall-e': '#864', 'wall-w': '#864', void: '#222' }

const GENERATORS = [
  { id: 'wfc', label: 'WFC (grid layout)' },
  { id: 'lsystem', label: 'L-system (tree/branch)' },
  { id: 'noise', label: 'Noise terrain (heightfield)' }
]

function _numberField(label, key, value, params, onChange, opts = {}) {
  return h('label', { key: 'f-' + key, style: 'display:flex;flex-direction:column;gap:2px;font:11px var(--ff-mono,monospace);color:var(--panel-text-2)' },
    label,
    h('input', {
      type: 'number', class: 'ds-ui-input', value, step: opts.step || 1, min: opts.min, max: opts.max,
      oninput: (e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange({ ...params, [key]: v }) }
    })
  )
}

function _selectField(label, key, value, options, params, onChange) {
  return h('label', { key: 'f-' + key, style: 'display:flex;flex-direction:column;gap:2px;font:11px var(--ff-mono,monospace);color:var(--panel-text-2)' },
    label,
    h('select', { class: 'ds-ui-input', value, onchange: (e) => onChange({ ...params, [key]: e.target.value }) },
      ...options.map(o => h('option', { key: 'o-' + o, value: o, selected: o === value }, o))
    )
  )
}

export function runGenerator(kind, params) {
  try {
    if (kind === 'wfc') {
      const { width, height, seed } = params
      const res = runWFCWithRetries({ width, height, tiles: DEFAULT_WFC_TILES, seed }, 20)
      if (!res.ok) return { ok: false, error: 'WFC did not converge: ' + res.reason + ' (tried ' + (res.tried ? res.tried.length : 1) + ' seed(s))' }
      return { ok: true, result: res, meta: { width, height } }
    }
    if (kind === 'lsystem') {
      const preset = LSYSTEM_PRESETS[params.preset] || LSYSTEM_PRESETS.fractalPlant
      const { axiom, rules, iterations, ...turtleOpts } = preset
      const iters = params.iterations != null ? Math.round(params.iterations) : iterations
      const { segments } = generateLSystemTree({ axiom, rules, iterations: iters, seed: params.seed, ...turtleOpts })
      return { ok: true, result: segments, meta: { count: segments.length } }
    }
    if (kind === 'noise') {
      const { width, height, seed, octaves, frequency, amplitude } = params
      const heightfield = generateHeightfield({ width, height, seed, octaves, frequency, amplitude, shape: params.shape, normalize: true })
      return { ok: true, result: heightfield, meta: { min: heightfield.min, max: heightfield.max } }
    }
    return { ok: false, error: 'Unknown generator: ' + kind }
  } catch (e) {
    return { ok: false, error: e.message || String(e) }
  }
}

export function planPlacement(kind, result, params) {
  if (kind === 'wfc') {
    const spacing = params.spacing || 2
    const { grid, width, height } = result
    const plan = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const tile = grid[y * width + x]
        if (tile === 'void') continue
        plan.push({ appName: 'box-static', position: [x * spacing, 0.5, y * spacing], config: { color: WFC_TILE_COLOR[tile] || '#888', scale: [spacing * 0.9, 1, spacing * 0.9] } })
      }
    }
    return plan
  }
  if (kind === 'lsystem') {
    const scale = params.scale || 0.3
    return result.map(seg => {
      const mid = [(seg.start.x + seg.end.x) / 2 * scale, (seg.start.y + seg.end.y) / 2 * scale, (seg.start.z + seg.end.z) / 2 * scale]
      const r = Math.max(0.1, (seg.radius || 1) * scale * 0.3)
      return { appName: 'cylinder-static', position: mid, config: { color: seg.depth === 0 ? '#753' : '#3a6', scale: [r, r, r] } }
    })
  }
  if (kind === 'noise') {
    const spacing = params.spacing || 2
    const step = params.placeStep || 4
    const plan = []
    for (let y = 0; y < result.height; y += step) {
      for (let x = 0; x < result.width; x += step) {
        const h2 = result.heights[y * result.width + x]
        plan.push({ appName: 'box-static', position: [x * spacing, h2 / 2, y * spacing], config: { color: '#a94', scale: [spacing * step * 0.95, Math.max(0.2, h2), spacing * step * 0.95] } })
      }
    }
    return plan
  }
  return []
}

function _drawWFCPreview(ctx, w, h, result) {
  ctx.clearRect(0, 0, w, h)
  if (!result) return
  const { grid, width: cols, height: rows } = result
  if (!rows || !cols) return
  const cw = w / cols, ch = h / rows
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      ctx.fillStyle = WFC_TILE_COLOR[grid[y * cols + x]] || '#888'
      ctx.fillRect(x * cw, y * ch, Math.ceil(cw), Math.ceil(ch))
    }
  }
}

function _drawLSystemPreview(ctx, w, h, segments) {
  ctx.clearRect(0, 0, w, h)
  if (!segments || !segments.length) return
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const s of segments) {
    for (const p of [s.start, s.end]) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
  }
  const spanX = Math.max(1e-6, maxX - minX), spanY = Math.max(1e-6, maxY - minY)
  const pad = 12
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY)
  const toPx = (p) => [pad + (p.x - minX) * scale, h - pad - (p.y - minY) * scale]
  for (const s of segments) {
    const [x1, y1] = toPx(s.start), [x2, y2] = toPx(s.end)
    ctx.strokeStyle = s.depth === 0 ? '#8a5a30' : '#4a9'
    ctx.lineWidth = Math.max(1, (s.radius || 1) * scale * 0.4)
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
  }
}

function _drawNoisePreview(ctx, w, h, hf) {
  ctx.clearRect(0, 0, w, h)
  if (!hf) return
  const img = ctx.createImageData(hf.width, hf.height)
  const span = Math.max(1e-6, hf.max - hf.min)
  for (let i = 0; i < hf.heights.length; i++) {
    const t = (hf.heights[i] - hf.min) / span
    const v = Math.round(t * 255)
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255
  }
  const off = document.createElement('canvas')
  off.width = hf.width; off.height = hf.height
  off.getContext('2d').putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(off, 0, 0, hf.width, hf.height, 0, 0, w, h)
}

const DEFAULT_PARAMS = {
  wfc: { width: 10, height: 8, seed: 1337, spacing: 2 },
  lsystem: { preset: 'fractalPlant', iterations: 4, seed: 1337, scale: 0.3 },
  noise: { width: 64, height: 64, seed: 1337, octaves: 4, frequency: 0.08, amplitude: 6, shape: 'island', spacing: 2, placeStep: 4 }
}

export function createProcgenPanel(container, { onPlaceBatch } = {}) {
  let _kind = 'wfc'
  let _params = { ...DEFAULT_PARAMS.wfc }
  let _last = null
  let _placing = false

  container.classList.add('ds-ep-panel')

  function _regenerate() {
    _last = runGenerator(_kind, _params)
    render()
  }

  function _canvasVNode(draw) {
    return h('canvas', {
      width: 320, height: 240,
      style: 'width:100%;aspect-ratio:4/3;background:var(--panel-1);border:1px solid var(--rule);border-radius:6px;image-rendering:pixelated',
      ref: (el) => { if (el) draw(el) }
    })
  }

  function render() {
    const setKind = (k) => { _kind = k; _params = { ...DEFAULT_PARAMS[k] }; _last = null; render() }

    const picker = h('div', { style: 'display:flex;gap:6px;padding:8px' },
      ...GENERATORS.map(g => Btn({ key: 'gen-' + g.id, dense: true, primary: g.id === _kind, onClick: (e) => { e.preventDefault(); setKind(g.id) }, children: [g.label] }))
    )

    const fields = []
    if (_kind === 'wfc') {
      fields.push(
        _numberField('Width (cells)', 'width', _params.width, _params, p => { _params = p; render() }, { min: 2, max: 40, step: 1 }),
        _numberField('Height (cells)', 'height', _params.height, _params, p => { _params = p; render() }, { min: 2, max: 40, step: 1 }),
        _numberField('Spacing (m)', 'spacing', _params.spacing, _params, p => { _params = p; render() }, { min: 0.5, step: 0.5 }),
        _numberField('Seed', 'seed', _params.seed, _params, p => { _params = p; render() }, { step: 1 })
      )
    } else if (_kind === 'lsystem') {
      fields.push(
        _selectField('Preset', 'preset', _params.preset, Object.keys(LSYSTEM_PRESETS), _params, p => { _params = p; render() }),
        _numberField('Iterations', 'iterations', _params.iterations, _params, p => { _params = p; render() }, { min: 1, max: 7, step: 1 }),
        _numberField('Scale', 'scale', _params.scale, _params, p => { _params = p; render() }, { min: 0.01, step: 0.05 }),
        _numberField('Seed', 'seed', _params.seed, _params, p => { _params = p; render() }, { step: 1 })
      )
    } else if (_kind === 'noise') {
      fields.push(
        _numberField('Width (samples)', 'width', _params.width, _params, p => { _params = p; render() }, { min: 8, max: 256, step: 8 }),
        _numberField('Height (samples)', 'height', _params.height, _params, p => { _params = p; render() }, { min: 8, max: 256, step: 8 }),
        _numberField('Octaves', 'octaves', _params.octaves, _params, p => { _params = p; render() }, { min: 1, max: 8, step: 1 }),
        _numberField('Frequency', 'frequency', _params.frequency, _params, p => { _params = p; render() }, { min: 0.01, step: 0.01 }),
        _numberField('Amplitude (m)', 'amplitude', _params.amplitude, _params, p => { _params = p; render() }, { min: 0.5, step: 0.5 }),
        _selectField('Shape', 'shape', _params.shape, ['none', 'ridge', 'island'], _params, p => { _params = p; render() }),
        _numberField('Spacing (m)', 'spacing', _params.spacing, _params, p => { _params = p; render() }, { min: 0.5, step: 0.5 }),
        _numberField('Place step', 'placeStep', _params.placeStep, _params, p => { _params = p; render() }, { min: 1, max: 16, step: 1 }),
        _numberField('Seed', 'seed', _params.seed, _params, p => { _params = p; render() }, { step: 1 })
      )
    }

    const paramsGrid = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 8px 8px' }, ...fields)

    const summarySpan = _last && _last.ok
      ? h('span', { style: 'font:10px var(--ff-mono,monospace);color:var(--panel-text-3)' },
          _kind === 'wfc' ? `${_last.meta.width}x${_last.meta.height} cells`
            : _kind === 'lsystem' ? `${_last.meta.count} segments`
            : `min ${_last.meta.min.toFixed(2)} / max ${_last.meta.max.toFixed(2)}`)
      : null
    const toolbar = Toolbar({ children: [
      Btn({ primary: true, dense: true, onClick: (e) => { e.preventDefault(); _regenerate() }, children: ['Regenerate'] }),
      h('div', { class: 'ds-ed-bar-grow' }),
      ...(summarySpan ? [summarySpan] : [])
    ] })

    const previewArea = _last
      ? (_last.ok
          ? h('div', { style: 'padding:0 8px 8px' }, _canvasVNode((el) => {
              const ctx = el.getContext('2d')
              if (_kind === 'wfc') _drawWFCPreview(ctx, el.width, el.height, _last.result)
              else if (_kind === 'lsystem') _drawLSystemPreview(ctx, el.width, el.height, _last.result)
              else _drawNoisePreview(ctx, el.width, el.height, _last.result)
            }))
          : h('div', { style: 'padding:8px' }, EmptyState({ text: 'Generation error: ' + _last.error })))
      : h('div', { style: 'padding:8px' }, EmptyState({ text: 'Click Regenerate to preview' }))

    const plan = _last && _last.ok ? planPlacement(_kind, _last.result, _params) : []
    const placeBtn = Btn({
      primary: true, dense: true,
      title: plan.length ? `Place ${plan.length} entities into the world` : 'Regenerate first',
      onClick: async (e) => {
        e.preventDefault()
        if (!plan.length || _placing || !onPlaceBatch) return
        _placing = true
        render()
        try { await onPlaceBatch(plan) } finally { _placing = false; render() }
      },
      children: [_placing ? 'Placing...' : `Place into World (${plan.length})`]
    })
    const placeRow = h('div', { style: 'padding:0 8px 8px;display:flex' }, placeBtn)

    applyDiff(container, [
      toolbar,
      h('div', { class: 'ds-ep-panel-body flush', style: 'display:flex;flex-direction:column;overflow-y:auto' },
        picker, paramsGrid, previewArea, placeRow
      )
    ])
  }

  render()

  return {
    destroy() {}
  }
}
