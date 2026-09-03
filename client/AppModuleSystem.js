import { createElement, applyDiff } from 'webjsx'

export function createAppModuleSystem(client, uiRoot) {
  const appModules = new Map()
  let _appModuleList = []
  const _trustedApps = new Set()
  // renderAppUI diffs into a dedicated child of uiRoot, not uiRoot itself: applyDiff(uiRoot, hudVdom)
  // used to treat uiRoot as its OWN exclusively-owned tree, so any per-tick diff pass silently evicted
  // sibling nodes appended imperatively by other HUD widgets (client/hud/Chat.js's .ch-card,
  // client/hud/VoiceIndicator.js's .vi-card, PeerHostUI's room-code card, ...) the instant the app-HUD
  // rendered any UI -- live-witnessed both cards detached from the DOM (isConnected:false) within one
  // renderAppUI cycle after mount. A stable dedicated container keeps this diff scoped to only the
  // app-rendered fragment tree, leaving uiRoot's other children alone.
  const _appHudContainer = document.createElement('div')
  uiRoot.appendChild(_appHudContainer)
  function _ctxFor(appName, engineCtx) {
    if (_trustedApps.has(appName) && engineCtx?._editorAPI) {
      return Object.assign(Object.create(engineCtx), { editor: engineCtx._editorAPI })
    }
    return engineCtx
  }

  // Rewrites relative AND root-absolute imports in app code to blob URLs since app code has no base
  // URL to resolve against. Root-absolute ('/spoint/src/...') specifiers show up here because the
  // gh-pages deploy's path-patch step absolutizes deep relative '../../src/...' imports in apps/**/*.js
  // at build time (see .github/workflows/gh-pages.yml "Patch paths for gh-pages") -- a shipped app's
  // source can carry either form depending on how many directories deep it lives.
  async function _resolveDepsToBlobs(source, baseUrl, revokes, seen = new Map()) {
    const re = /((?:from|import)\s*)(['"])(\.[^'"]+|\/[^'"]+)\2/g
    const specs = new Set()
    let m
    while ((m = re.exec(source)) !== null) specs.add(m[3])
    const urlMap = {}
    for (const spec of specs) {
      const depUrl = new URL(spec, baseUrl).href
      if (seen.has(depUrl)) { urlMap[spec] = seen.get(depUrl); continue }
      try {
        const r = await fetch(depUrl)
        if (!r.ok) continue
        const depSrc = await r.text()
        const rewritten = await _resolveDepsToBlobs(depSrc, depUrl, revokes, seen)
        const blobUrl = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }))
        revokes.push(blobUrl)
        seen.set(depUrl, blobUrl)
        urlMap[spec] = blobUrl
      } catch (_) {}
    }
    return source.replace(re, (full, pre, q, spec) => urlMap[spec] ? `${pre}${q}${urlMap[spec]}${q}` : full)
  }

  async function evaluateAppModule(code, appName) {
    const revokes = []
    try {
      // Must resolve via import.meta.url, not a root-absolute path: 404s under a base-pathed host (gh-pages).
      const baseUrl = new URL(`./apps/${appName}/index.js`, import.meta.url).href
      const rewritten = code.includes('.') ? await _resolveDepsToBlobs(code, baseUrl, revokes) : code
      const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }))
      revokes.push(url)
      const mod = await import(url)
      return mod.default || mod
    } catch (e) {
      console.error(`[app-eval] ${appName}:`, e.message, e.stack)
      return null
    } finally {
      for (const u of revokes) URL.revokeObjectURL(u)
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

  // PER-PLAYER HUD/UI: render() runs CLIENT-side, once per connected client, and renderCtx.playerId is THAT
  // client's own id (proven live: playerId=1 on a real singleplayer client). So a per-player HUD is already
  // first-class -- an app renders different UI per viewer by branching on renderCtx.playerId. For a server-driven
  // per-player value (your score, your turn, your team), the server pushes it to ONE player with
  // ctx.players.send(playerId, {hud:...}) (AppRuntime.sendToPlayer -> that client's onEvent), the client app
  // stashes it keyed by playerId in onEvent, and render() reads it back via renderCtx.playerId. No global-only
  // constraint exists; the single-template appearance is only because most apps don't branch on playerId yet.
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
      // pointer-events:auto so an app's rendered UI (buttons, cards, forms) is clickable out of the box
      // -- the #hud overlay is pointer-events:none to let clicks reach the game, and previously every
      // interactive app fragment had to re-opt-in manually. Apps can still set pointer-events:none inside.
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
