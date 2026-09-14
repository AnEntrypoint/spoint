import { createElement, applyDiff } from 'webjsx'

export function createAppModuleSystem(client, uiRoot) {
  const appModules = new Map()
  let _appModuleList = []
  const _trustedApps = new Set()
  const _appHudContainer = document.createElement('div')
  uiRoot.appendChild(_appHudContainer)
  function _ctxFor(appName, engineCtx) {
    if (_trustedApps.has(appName) && engineCtx?._editorAPI) {
      return Object.assign(Object.create(engineCtx), { editor: engineCtx._editorAPI })
    }
    return engineCtx
  }

  const PATH_SPECIFIER = /((?:from|import)\s*)(['"])(\.[^'"]+|\/[^'"]+)\2/g

  function _anchorPathSpecifiersAt(source, moduleUrl) {
    return source.replace(PATH_SPECIFIER, (full, pre, q, spec) => `${pre}${q}${new URL(spec, moduleUrl).href}${q}`)
  }

  async function evaluateAppModule(code, appName) {
    let blobUrl = null
    try {
      const appEntryUrl = new URL(`./apps/${appName}/index.js`, import.meta.url).href
      blobUrl = URL.createObjectURL(new Blob([_anchorPathSpecifiersAt(code, appEntryUrl)], { type: 'text/javascript' }))
      const mod = await import(blobUrl)
      return mod.default || mod
    } catch (e) {
      console.error(`[app-eval] ${appName}:`, e.message, e.stack)
      return null
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }

  async function loadAppModule(d, engineCtx) {
    const a = await evaluateAppModule(d.code, d.app)
    if (a?.client) {
      if (d.trusted) _trustedApps.add(d.app)
      appModules.set(d.app, a.client)
      _appModuleList = [...appModules.values()]
      a.client._appName = d.app
      if (a.client.setup) try { a.client.setup(_ctxFor(d.app, engineCtx)) } catch (e) { console.error('[app-setup]', d.app, e.message) }
    }
  }

  function createDispatcher(method, errorLabel) {
    return function(arg, engineCtx) {
      for (let i = 0; i < _appModuleList.length; i++) {
        const mod = _appModuleList[i]
        if (mod[method]) try { mod[method](arg, _ctxFor(mod._appName, engineCtx)) } catch (e) { if (errorLabel) console.error(errorLabel, e.message) }
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

  function renderAppUI(state, engineCtx, scene, camera, renderer, fpsDisplay, runtimeStatsUI = null) {
    const c = engineCtx.client; if (!c) return
    const uiFragments = []
    for (const entity of state.entities) {
      const appName = engineCtx.entityAppMap?.get(entity.id)
      if (!appName) continue
      const appClient = appModules.get(appName)
      if (!appClient?.render) continue
      try {
        const _engine = _ctxFor(appName, engineCtx)
        const renderCtx = { entity, state: entity.custom || {}, h: createElement, engine: _engine, editor: _engine.editor, kit: engineCtx.kit, players: state.players, network: { send: (msg) => c.send(0x33, { ...msg, entityId: entity.id }) }, THREE: engineCtx.THREE, scene, camera, renderer, playerId: c.playerId, clock: { elapsed: performance.now() / 1000 } }
        const result = appClient.render(renderCtx)
        if (result?.ui) uiFragments.push({ id: entity.id, ui: result.ui })
      } catch (e) { console.error('[ui]', entity.id, e.message) }
    }
    const interactPrompt = _buildInteractPrompt(state, c.playerId)
    const hudVdom = createElement('div', { id: 'hud' },
      runtimeStatsUI ? null : createElement('div', { id: 'info' }, `FPS: ${fpsDisplay} | Players: ${state.players.length} | Tick: ${c.currentTick} | RTT: ${Math.round(c.getRTT())}ms | Buf: ${c.getBufferHealth()}`),
      runtimeStatsUI,
      ...uiFragments.map(f => createElement('div', { 'data-app': f.id, style: 'pointer-events:auto' }, f.ui)),
      ...(interactPrompt ? [interactPrompt] : [])
    )
    try { applyDiff(_appHudContainer, hudVdom) } catch (e) { console.error('[ui] diff:', e.message) }
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
