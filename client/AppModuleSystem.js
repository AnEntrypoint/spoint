import { createElement, applyDiff } from 'webjsx'

export function createAppModuleSystem(client, uiRoot) {
  const appModules = new Map()
  let _appModuleList = []

  function evaluateAppModule(code) {
    try {
      let stripped = code.replace(/^import\s+.*$/gm, '')
      stripped = stripped.replace(/const\s+__dirname\s*=.*import\.meta\.url.*$/gm, 'const __dirname = "/"')
      stripped = stripped.replace(/export\s+/g, '')
      const exportDefaultIdx = stripped.search(/\bdefault\s*[\{(]/)
      let wrapped
      if (exportDefaultIdx !== -1) {
        const before = stripped.slice(0, exportDefaultIdx)
        const after = stripped.slice(exportDefaultIdx + 'default'.length).trimStart()
        wrapped = before + '\nreturn ' + after + '\n//# sourceURL=app-module.js'
      } else {
        wrapped = stripped.replace(/\bdefault\s*/, 'return ') + '\n//# sourceURL=app-module.js'
      }
      const join = (...parts) => parts.filter(Boolean).join('/')
      return new Function('join', 'readdirSync', 'statSync', 'fileURLToPath', wrapped)(
        join, () => [], () => ({ isDirectory: () => false }), () => '/'
      )
    } catch (e) { console.error('[app-eval]', e.message, e.stack); return null }
  }

  function loadAppModule(d, engineCtx) {
    const a = evaluateAppModule(d.code)
    if (a?.client) {
      appModules.set(d.app, a.client)
      _appModuleList = [...appModules.values()]
      if (a.client.setup) try { a.client.setup(engineCtx) } catch (e) { console.error('[app-setup]', d.app, e.message) }
    }
  }

  function createDispatcher(method, errorLabel) {
    return function(arg, engineCtx) {
      for (let i = 0; i < _appModuleList.length; i++) {
        const mod = _appModuleList[i]
        if (mod[method]) try { mod[method](arg, engineCtx) } catch (e) { if (errorLabel) console.error(errorLabel, e.message) }
      }
    }
  }

  function _buildInteractPrompt(state, playerId) {
    const local = state.players.find(p => p.id === playerId)
    if (!local?.position) return null
    const lx = local.position[0], ly = local.position[1], lz = local.position[2]
    for (const entity of state.entities) {
      const cfg = entity.custom?._interactable
      if (!cfg || !entity.position) continue
      const dx = entity.position[0] - lx, dy = entity.position[1] - ly, dz = entity.position[2] - lz
      if (dx * dx + dy * dy + dz * dz < cfg.radius * cfg.radius) {
        return createElement('div', { style: 'position:fixed;bottom:40%;left:50%;transform:translateX(-50%);color:#fff;background:rgba(0,0,0,0.7);padding:8px 16px;border-radius:8px;pointer-events:none' }, cfg.prompt)
      }
    }
    return null
  }

  function renderAppUI(state, engineCtx, scene, camera, renderer, fpsDisplay) {
    const uiFragments = []
    for (const entity of state.entities) {
      const appName = engineCtx.entityAppMap?.get(entity.id)
      if (!appName) continue
      const appClient = appModules.get(appName)
      if (!appClient?.render) continue
      try {
        const renderCtx = { entity, state: entity.custom || {}, h: createElement, engine: engineCtx, players: state.players, network: { send: (msg) => client.send(0x33, { ...msg, entityId: entity.id }) }, THREE: engineCtx.THREE, scene, camera, renderer, playerId: client.playerId, clock: { elapsed: performance.now() / 1000 } }
        const result = appClient.render(renderCtx)
        if (result?.ui) uiFragments.push({ id: entity.id, ui: result.ui })
      } catch (e) { console.error('[ui]', entity.id, e.message) }
    }
    const interactPrompt = _buildInteractPrompt(state, client.playerId)
    const hudVdom = createElement('div', { id: 'hud' },
      createElement('div', { id: 'info' }, `FPS: ${fpsDisplay} | Players: ${state.players.length} | Tick: ${client.currentTick} | RTT: ${Math.round(client.getRTT())}ms | Buf: ${client.getBufferHealth()}`),
      ...uiFragments.map(f => createElement('div', { 'data-app': f.id }, f.ui)),
      interactPrompt
    )
    try { applyDiff(uiRoot, hudVdom) } catch (e) { console.error('[ui] diff:', e.message) }
  }

  const dispatchKeyDown = createDispatcher('onKeyDown', null)
  const dispatchKeyUp = createDispatcher('onKeyUp', null)
  const dispatchInput = createDispatcher('onInput', '[app-input]')
  const dispatchFrame = createDispatcher('onFrame', null)
  const dispatchEvent = createDispatcher('onEvent', '[app-event]')
  const dispatchMouseDown = createDispatcher('onMouseDown', null)
  const dispatchMouseUp = createDispatcher('onMouseUp', null)

  return { appModules, loadAppModule, renderAppUI, dispatchKeyDown, dispatchKeyUp, dispatchInput, dispatchFrame, dispatchEvent, dispatchMouseDown, dispatchMouseUp, get list() { return _appModuleList } }
}
