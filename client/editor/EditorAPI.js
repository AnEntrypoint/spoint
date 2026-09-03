import { drag, v3, propField, showToast } from './EditPanelDOM.js'

export function createEditorAPI({ client, entityMeshes, MSG, sendEditorUpdate, getSelectedId, setSelectedId, isOpen, floatingOrigin }) {
    const _sceneListeners = new Set()
    const _selectListeners = new Set()
    const _appsListeners = new Set()
    const _eventsListeners = new Set()
    const _tabListeners = new Set()
    const _panels = []
    let _lastEntities = []
    let _lastSelectedId = null
    let _lastApps = []
    let _lastEvents = []
    let _lastTab = 'Inspector'

    function _emitScene(entities) { _lastEntities = entities || []; for (const cb of _sceneListeners) try { cb(_lastEntities) } catch (e) { console.error('[editor.onSceneUpdate]', e.message) } }
    function _emitSelect(id, data) { _lastSelectedId = id; for (const cb of _selectListeners) try { cb(id, data) } catch (e) { console.error('[editor.onSelect]', e.message) } }
    function _emitApps(apps) { _lastApps = apps || []; for (const cb of _appsListeners) try { cb(_lastApps) } catch (e) { console.error('[editor.onAppsUpdate]', e.message) } }
    function _emitEvents(events) { _lastEvents = events || []; for (const cb of _eventsListeners) try { cb(_lastEvents) } catch (e) { console.error('[editor.onEventsUpdate]', e.message) } }
    function _emitTab(name) { _lastTab = name; for (const cb of _tabListeners) try { cb(name) } catch (e) { console.error('[editor.onTabChange]', e.message) } }

    function _awaitNext(listenerSet, label) {
        return new Promise((resolve, reject) => {
            let done = false
            const cb = (value) => { if (done) return; done = true; clearTimeout(t); listenerSet.delete(cb); resolve(value) }
            const t = setTimeout(() => { if (done) return; done = true; listenerSet.delete(cb); showToast('Request timed out: ' + label, 'error'); reject(new Error(`editor request timed out: ${label}`)) }, 5000)
            listenerSet.add(cb)
        })
    }

    function _renderPanels(slot, container) {
        const arg = { selectedId: _lastSelectedId, entities: _lastEntities, apps: _lastApps, events: _lastEvents, tab: _lastTab }
        for (const p of _panels) {
            if (p.slot !== slot) continue
            try {
                const sub = container.querySelector(`[data-editor-panel="${p.id}"]`)
                if (sub) { sub.innerHTML = ''; p.render(sub, arg) }
                else {
                    const div = document.createElement('div')
                    div.setAttribute('data-editor-panel', p.id)
                    div.className = slot === 'inspector'
                        ? 'ds-ed-panel-mount ds-ed-panel-mount--inspector'
                        : 'ds-ed-panel-mount'
                    container.appendChild(div)
                    p.render(div, arg)
                }
            } catch (e) { console.error('[editor.panel.render]', p.id, e.message) }
        }
    }

    const api = {
        get isOpen() { return isOpen() },
        getSelected: () => getSelectedId(),
        select(id) { setSelectedId(id) },
        destroy(id) { client.send(MSG.DESTROY_ENTITY, { entityId: id }) },
        // App-maker API contract: position always AUTHORITATIVE (local-frame) meters, matching
        // getEntity/getServerEntity below and MSG.PLACE_APP/PLACE_MODEL's own position params -- an app
        // calling update(id, {position: getEntity(id).position}) must round-trip correctly regardless of
        // how far the session has floating-origin-rebased. sendEditorUpdate (app.js's closure) sends
        // changes straight to the wire, so `changes.position` here is passed through UNCONVERTED (it is
        // already authoritative per this contract, not the render-space mesh.position editor.js's OWN
        // internal sendEditorUpdate has to convert -- that is a distinct function/closure from this one).
        update(id, changes) { sendEditorUpdate(id, changes) },
        // Three.js mesh transform, may lag server; getServerEntity is authoritative. position is still
        // converted through floatingOrigin.toAuthoritative here (matching _buildEntityData's inspector
        // fix) since mesh.position itself is render-space -- an app reading getEntity(id).position must
        // see the real local-frame coordinate, not a near-zero rebased one, or that same round-trip
        // through update() above would silently teleport the entity near the render-space origin.
        getEntity(id) { const m = entityMeshes.get(id); if (!m) return null; const p = floatingOrigin ? floatingOrigin.toAuthoritative(m.position) : m.position; return { id, position: [p.x, p.y, p.z], rotation: m.quaternion.toArray(), scale: m.scale.toArray(), custom: m.userData.custom || {}, _appName: m.userData._appName || null } },
        getServerEntity(id) { return _lastEntities.find(e => e && e.id === id) || null },
        get entities() { return _lastEntities },
        onSceneUpdate(cb) { _sceneListeners.add(cb); if (_lastEntities.length) try { cb(_lastEntities) } catch (_) {}; return () => _sceneListeners.delete(cb) },
        onSelect(cb) { _selectListeners.add(cb); return () => _selectListeners.delete(cb) },
        onAppsUpdate(cb) { _appsListeners.add(cb); if (_lastApps.length) try { cb(_lastApps) } catch (_) {}; return () => _appsListeners.delete(cb) },
        onEventsUpdate(cb) { _eventsListeners.add(cb); if (_lastEvents.length) try { cb(_lastEvents) } catch (_) {}; return () => _eventsListeners.delete(cb) },
        onTabChange(cb) { _tabListeners.add(cb); try { cb(_lastTab) } catch (_) {}; return () => _tabListeners.delete(cb) },
        get currentTab() { return _lastTab },
        requestApps() { client.send(MSG.LIST_APPS, {}); return _awaitNext(_appsListeners, 'LIST_APPS') },
        requestEvents() { client.send(MSG.EVENT_LOG_QUERY, {}); return _awaitNext(_eventsListeners, 'EVENT_LOG_QUERY') },
        placeApp(appName, position, config) { client.send(MSG.PLACE_APP, { appName, position: position || [0,0,0], config: config || {} }); return _awaitNext(_sceneListeners, 'PLACE_APP') },
        placeModel(url, position) { client.send(MSG.PLACE_MODEL, { url, position: position || [0,0,0] }); return _awaitNext(_sceneListeners, 'PLACE_MODEL') },
        mountPanel({ slot = 'inspector', label = '', render }) {
            if (typeof render !== 'function') throw new Error('mountPanel: render must be a function')
            const id = 'p_' + Math.random().toString(36).slice(2, 8)
            _panels.push({ id, slot, label, render })
            queueMicrotask(() => { try { for (const cb of _sceneListeners) cb(_lastEntities); for (const cb of _appsListeners) cb(_lastApps); for (const cb of _eventsListeners) cb(_lastEvents) } catch (_) {} })
            return () => { const i = _panels.findIndex(p => p.id === id); if (i >= 0) _panels.splice(i, 1) }
        },
        fields: { v3, propField, drag }
    }

    return { api, _emitScene, _emitSelect, _emitApps, _emitEvents, _emitTab, _renderPanels, _panels }
}
