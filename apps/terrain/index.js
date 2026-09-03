export const DEFAULT_TERRAIN = {
  enabled: true,
  anchorDir: [0, 1, 0],
  radius: 63600,
  reliefScale: 0.001,
  maxLevel: 11,
  offsetY: 0,
  center: [0, 0],
  seed: 0,
  physics: { extent: 256, resolution: 2 },
  vegetation: { enabled: false }
}

const mergeConfig = (override) => ({
  ...DEFAULT_TERRAIN,
  ...(override || {}),
  physics: { ...DEFAULT_TERRAIN.physics, ...((override && override.physics) || {}) },
  vegetation: { ...DEFAULT_TERRAIN.vegetation, ...((override && override.vegetation) || {}) }
})

export default {
  server: {
    setup(ctx) {
      // must NOT start the collider streamer here -- engine boot already starts it before stage load; doing it here races the spawn-finder (77->4 spawn points)
      ctx.state.terrainConfig = mergeConfig(ctx.config)
      ctx.debug.log('[terrain] config registered (streamer owned by engine boot order)')
    }
  },

  client: {
    setup(ctx) {
      // must NOT push a default-merged config here -- engineCtx has no entity config, and pushing one clobbers the real tuned config (killed vegetation before)
      if (!ctx.editor || !ctx.editor.mountPanel) return
      const cfg = (ctx.getTerrainConfig && ctx.getTerrainConfig()) || mergeConfig(null)
      ctx.editor.mountPanel({
        slot: 'inspector',
        label: 'Terrain',
        // must gate on selectedId: the inspector slot renders every mounted panel unconditionally, else these knobs show regardless of selection
        render(container, { selectedId }) {
          const ent = selectedId && ctx.editor.getServerEntity ? ctx.editor.getServerEntity(selectedId) : null
          // check all 3 spellings (app/_appName/appName) -- different entity-list sources use different field names
          const isTerrain = !!ent && (ent.app === 'terrain' || ent._appName === 'terrain' || ent.appName === 'terrain')
          container.innerHTML = ''
          if (!isTerrain) {
            const empty = document.createElement('div')
            empty.textContent = 'Select the terrain entity to edit'
            empty.style.cssText = 'color:rgba(255,255,255,0.35);font:12px system-ui,sans-serif'
            container.appendChild(empty)
            return
          }
          const root = document.createElement('div')
          root.style.cssText = 'font:12px/1.4 system-ui,sans-serif;color:#e8eaf0'
          const title = document.createElement('div')
          title.textContent = 'Terrain (seed + radius)'
          title.style.cssText = 'font-weight:600;margin-bottom:8px'
          root.appendChild(title)
          const radWrap = document.createElement('div'); radWrap.style.cssText = 'margin-bottom:10px;display:flex;gap:6px'
          const radIn = document.createElement('input'); radIn.type = 'number'; radIn.step = '1000'; radIn.min = '1000'
          radIn.value = String(cfg.radius || 63600)
          radIn.style.cssText = 'flex:1;min-width:0;background:rgba(0,0,0,0.35);color:#e8eaf0;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:4px 6px'
          const radBtn = document.createElement('button'); radBtn.textContent = 'Apply radius'
          radBtn.style.cssText = 'background:#3a6df0;color:#fff;border:none;border-radius:5px;padding:4px 10px;cursor:pointer'
          radBtn.addEventListener('click', () => {
            const r = +radIn.value
            if (Number.isFinite(r) && r > 0 && ctx.rebuildTerrain) ctx.rebuildTerrain({ radius: r })
          })
          radWrap.append(radIn, radBtn); root.appendChild(radWrap)
          // seed is server-authoritative: reshapes the whole planet + rebuilds the collider, broadcast to all clients
          const seedWrap = document.createElement('div'); seedWrap.style.cssText = 'margin-bottom:10px;display:flex;gap:6px'
          const seedIn = document.createElement('input'); seedIn.type = 'number'; seedIn.step = '1'
          seedIn.value = String(cfg.seed ?? 0)
          seedIn.style.cssText = 'flex:1;min-width:0;background:rgba(0,0,0,0.35);color:#e8eaf0;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:4px 6px'
          const seedBtn = document.createElement('button'); seedBtn.textContent = 'Reseed (all players)'
          seedBtn.style.cssText = 'background:#3a6df0;color:#fff;border:none;border-radius:5px;padding:4px 10px;cursor:pointer'
          seedBtn.addEventListener('click', () => {
            const s = Number.parseInt(seedIn.value, 10)
            if (Number.isFinite(s) && ctx.reseedTerrain) ctx.reseedTerrain(s)
          })
          seedWrap.append(seedIn, seedBtn); root.appendChild(seedWrap)

          // Raise/lower/smooth/flatten brush (height-delta slices of the sculpt/volume/event-graph epic
          // -- see AGENTS.md terrain-sculpt-volume-spline-event-graph-editing; paint-biome, the epic's
          // fifth/climate-override brush, is its own panel section below this one; both share
          // terrain-gpu-visible-sculpt-mesh-deformation as a follow-up for visibly updating the rendered
          // mesh/vegetation, not just the collider).
          // Writes a real heightfield DELTA over the procedural base (src/terrain/HeightDelta.js),
          // server-authoritative like reseed above. Lower is a negative-strength raise (same falloff
          // math, same wire message) -- the mode toggle below just flips which `brush` string is sent.
          // `strengthIn` always holds a positive/unsigned value, but its CONTRACT differs by mode: a
          // metres magnitude for raise/lower, a [0,1] blend factor for smooth/flatten (_applyStrengthContract
          // swaps step/min/max/default/title on mode change so the same input serves all three meanings).
          const sculptTitle = document.createElement('div')
          sculptTitle.textContent = 'Sculpt brush'
          sculptTitle.style.cssText = 'font-weight:600;margin:14px 0 8px;border-top:1px solid rgba(255,255,255,0.12);padding-top:10px'
          root.appendChild(sculptTitle)
          let _brushMode = 'raise'
          const modeWrap = document.createElement('div'); modeWrap.style.cssText = 'margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap'
          const raiseModeBtn = document.createElement('button'); raiseModeBtn.textContent = 'Raise'
          const lowerModeBtn = document.createElement('button'); lowerModeBtn.textContent = 'Lower'
          const smoothModeBtn = document.createElement('button'); smoothModeBtn.textContent = 'Smooth'
          const flattenModeBtn = document.createElement('button'); flattenModeBtn.textContent = 'Flatten'
          function _styleModeButtons() {
            const active = 'flex:1;background:#3a6df0;color:#fff;border:none;border-radius:5px;padding:4px 10px;cursor:pointer'
            const inactive = 'flex:1;background:rgba(255,255,255,0.08);color:#e8eaf0;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:4px 10px;cursor:pointer'
            raiseModeBtn.style.cssText = _brushMode === 'raise' ? active : inactive
            lowerModeBtn.style.cssText = _brushMode === 'lower' ? active : inactive
            smoothModeBtn.style.cssText = _brushMode === 'smooth' ? active : inactive
            flattenModeBtn.style.cssText = _brushMode === 'flatten' ? active : inactive
          }
          // Smooth/flatten's strength is a [0,1] blend factor (not a metres magnitude like raise/lower)
          // -- swap the input's step/min/max/default/title to match its contract on mode change, and
          // re-clamp any value the user typed while in raise/lower mode so switching to smooth/flatten
          // can't silently send an out-of-[0,1]-range value the server would otherwise have to clamp
          // defensively.
          function _applyStrengthContract() {
            if (_brushMode === 'smooth' || _brushMode === 'flatten') {
              strengthIn.step = '0.05'; strengthIn.min = '0'; strengthIn.max = '1'
              strengthIn.title = _brushMode === 'flatten' ? 'Flatten blend factor (0=no change, 1=fully flattened)' : 'Smoothing blend factor (0=no change, 1=fully averaged)'
              if (!Number.isFinite(+strengthIn.value) || +strengthIn.value <= 0) strengthIn.value = '1'
              else strengthIn.value = String(Math.min(1, Math.abs(+strengthIn.value)))
            } else {
              strengthIn.step = '0.5'; strengthIn.min = '0'; strengthIn.removeAttribute('max')
              strengthIn.title = 'Peak raise/lower magnitude (m)'
              if (!Number.isFinite(+strengthIn.value) || +strengthIn.value <= 0) strengthIn.value = '5'
            }
          }
          raiseModeBtn.addEventListener('click', () => { _brushMode = 'raise'; _styleModeButtons(); _applyStrengthContract(); _updateSculptBtnLabel() })
          lowerModeBtn.addEventListener('click', () => { _brushMode = 'lower'; _styleModeButtons(); _applyStrengthContract(); _updateSculptBtnLabel() })
          smoothModeBtn.addEventListener('click', () => { _brushMode = 'smooth'; _styleModeButtons(); _applyStrengthContract(); _updateSculptBtnLabel() })
          flattenModeBtn.addEventListener('click', () => { _brushMode = 'flatten'; _styleModeButtons(); _applyStrengthContract(); _updateSculptBtnLabel() })
          _styleModeButtons()
          modeWrap.append(raiseModeBtn, lowerModeBtn, smoothModeBtn, flattenModeBtn); root.appendChild(modeWrap)
          const paramWrap = document.createElement('div'); paramWrap.style.cssText = 'margin-bottom:8px;display:flex;gap:6px'
          const radiusIn = document.createElement('input'); radiusIn.type = 'number'; radiusIn.step = '1'; radiusIn.min = '1'
          radiusIn.value = '10'; radiusIn.title = 'Brush radius (m)'
          radiusIn.style.cssText = 'flex:1;min-width:0;background:rgba(0,0,0,0.35);color:#e8eaf0;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:4px 6px'
          const strengthIn = document.createElement('input'); strengthIn.type = 'number'; strengthIn.step = '0.5'; strengthIn.min = '0'
          strengthIn.value = '5'; strengthIn.title = 'Peak raise/lower magnitude (m)'
          strengthIn.style.cssText = 'flex:1;min-width:0;background:rgba(0,0,0,0.35);color:#e8eaf0;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:4px 6px'
          paramWrap.append(radiusIn, strengthIn); root.appendChild(paramWrap)
          const sculptBtn = document.createElement('button')
          function _idleLabel() { return `Click viewport to ${_brushMode}` }
          function _updateSculptBtnLabel() { if (!_armed) sculptBtn.textContent = _idleLabel() }
          sculptBtn.textContent = _idleLabel()
          sculptBtn.style.cssText = 'background:#3a6df0;color:#fff;border:none;border-radius:5px;padding:4px 10px;cursor:pointer;width:100%'
          let _armed = false, _canvasClickHandler = null
          function _disarm() {
            _armed = false
            sculptBtn.textContent = _idleLabel()
            sculptBtn.style.background = '#3a6df0'
            const canvas = document.querySelector('canvas')
            if (canvas && _canvasClickHandler) canvas.removeEventListener('click', _canvasClickHandler)
            _canvasClickHandler = null
          }
          sculptBtn.addEventListener('click', () => {
            if (_armed) { _disarm(); return }
            const canvas = document.querySelector('canvas')
            if (!canvas || !ctx.pickGround || !ctx.sculptTerrain) return
            _armed = true
            sculptBtn.textContent = 'Click a point in the viewport...'
            sculptBtn.style.background = '#e0a030'
            _canvasClickHandler = (ev) => {
              const p = ctx.pickGround(ev.clientX, ev.clientY)
              _disarm()
              if (!p) { console.warn(`[terrain] ${_brushMode} brush: no ground hit at click point`); return }
              const radius = +radiusIn.value, strength = Math.abs(+strengthIn.value)
              if (Number.isFinite(radius) && radius > 0 && Number.isFinite(strength) && strength !== 0) {
                ctx.sculptTerrain(_brushMode, p[0], p[2], radius, strength)
              }
            }
            canvas.addEventListener('click', _canvasClickHandler, { once: true })
          })
          root.appendChild(sculptBtn)

          // Paint-biome brush (fourth/final slice of the sculpt-brush epic -- src/terrain/BiomeOverride.js).
          // Distinct from the height brushes above: overrides the climate tuple (temp/humidity/erosion)
          // VegPlacement/RockPlacement/GrassPlacement's classify() reads, so a painted stroke changes
          // WHAT grows/how dense, not the ground height -- a swatch/dropdown picker instead of a
          // raise/lower-style strength-magnitude input. ctx.paintBiome mirrors ctx.sculptTerrain's
          // server-authoritative send-only contract.
          const biomeTitle = document.createElement('div')
          biomeTitle.textContent = 'Paint biome'
          biomeTitle.style.cssText = 'font-weight:600;margin:14px 0 8px;border-top:1px solid rgba(255,255,255,0.12);padding-top:10px'
          root.appendChild(biomeTitle)
          const BIOME_SWATCHES = [
            { id: 'desert', label: 'Desert', color: '#d8b56a' },
            { id: 'tundra', label: 'Tundra', color: '#a9c6d6' },
            { id: 'forest', label: 'Forest', color: '#2f7a3c' },
            { id: 'grassland', label: 'Grassland', color: '#8fbf4a' },
            { id: 'wetland', label: 'Wetland', color: '#3c6e5e' },
          ]
          let _biome = 'forest'
          const biomeWrap = document.createElement('div'); biomeWrap.style.cssText = 'margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap'
          const biomeBtns = {}
          function _styleBiomeButtons() {
            for (const { id, color } of BIOME_SWATCHES) {
              const btn = biomeBtns[id]
              const active = _biome === id
              btn.style.cssText = `flex:1;min-width:70px;background:${active ? color : 'rgba(255,255,255,0.08)'};color:${active ? '#111' : '#e8eaf0'};border:1px solid ${active ? color : 'rgba(255,255,255,0.15)'};border-radius:5px;padding:4px 8px;cursor:pointer;font-weight:${active ? 700 : 400}`
            }
          }
          for (const sw of BIOME_SWATCHES) {
            const btn = document.createElement('button'); btn.textContent = sw.label
            btn.addEventListener('click', () => { _biome = sw.id; _styleBiomeButtons(); _updateBiomeBtnLabel() })
            biomeBtns[sw.id] = btn
            biomeWrap.appendChild(btn)
          }
          _styleBiomeButtons()
          root.appendChild(biomeWrap)
          const biomeParamWrap = document.createElement('div'); biomeParamWrap.style.cssText = 'margin-bottom:8px;display:flex;gap:6px'
          const biomeRadiusIn = document.createElement('input'); biomeRadiusIn.type = 'number'; biomeRadiusIn.step = '1'; biomeRadiusIn.min = '1'
          biomeRadiusIn.value = '20'; biomeRadiusIn.title = 'Paint radius (m)'
          biomeRadiusIn.style.cssText = 'flex:1;min-width:0;background:rgba(0,0,0,0.35);color:#e8eaf0;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:4px 6px'
          const biomeStrengthIn = document.createElement('input'); biomeStrengthIn.type = 'number'; biomeStrengthIn.step = '0.05'; biomeStrengthIn.min = '0'; biomeStrengthIn.max = '1'
          biomeStrengthIn.value = '1'; biomeStrengthIn.title = 'Paint blend factor (0=no change, 1=fully painted)'
          biomeStrengthIn.style.cssText = 'flex:1;min-width:0;background:rgba(0,0,0,0.35);color:#e8eaf0;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:4px 6px'
          biomeParamWrap.append(biomeRadiusIn, biomeStrengthIn); root.appendChild(biomeParamWrap)
          const biomeBtn = document.createElement('button')
          function _biomeIdleLabel() { return `Click viewport to paint ${_biome}` }
          function _updateBiomeBtnLabel() { if (!_biomeArmed) biomeBtn.textContent = _biomeIdleLabel() }
          biomeBtn.textContent = _biomeIdleLabel()
          biomeBtn.style.cssText = 'background:#3a6df0;color:#fff;border:none;border-radius:5px;padding:4px 10px;cursor:pointer;width:100%'
          let _biomeArmed = false, _biomeCanvasClickHandler = null
          function _biomeDisarm() {
            _biomeArmed = false
            biomeBtn.textContent = _biomeIdleLabel()
            biomeBtn.style.background = '#3a6df0'
            const canvas = document.querySelector('canvas')
            if (canvas && _biomeCanvasClickHandler) canvas.removeEventListener('click', _biomeCanvasClickHandler)
            _biomeCanvasClickHandler = null
          }
          biomeBtn.addEventListener('click', () => {
            if (_biomeArmed) { _biomeDisarm(); return }
            const canvas = document.querySelector('canvas')
            if (!canvas || !ctx.pickGround || !ctx.paintBiome) return
            _biomeArmed = true
            biomeBtn.textContent = 'Click a point in the viewport...'
            biomeBtn.style.background = '#e0a030'
            _biomeCanvasClickHandler = (ev) => {
              const p = ctx.pickGround(ev.clientX, ev.clientY)
              _biomeDisarm()
              if (!p) { console.warn(`[terrain] paint-biome: no ground hit at click point`); return }
              const radius = +biomeRadiusIn.value, strength = Math.min(1, Math.max(0, +biomeStrengthIn.value))
              if (Number.isFinite(radius) && radius > 0 && Number.isFinite(strength)) {
                ctx.paintBiome(_biome, p[0], p[2], radius, strength)
              }
            }
            canvas.addEventListener('click', _biomeCanvasClickHandler, { once: true })
          })
          root.appendChild(biomeBtn)

          container.appendChild(root)
        }
      })
    }
  }
}
