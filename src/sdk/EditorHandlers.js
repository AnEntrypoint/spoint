import { MSG } from '../protocol/MessageTypes.js'

const isNode = typeof process !== 'undefined' && process.versions?.node
let _fs = null, _path = null
if (isNode) {
  _fs = await import('node:fs')
  _path = await import('node:path')
}
const readdirSync = _fs?.readdirSync, existsSync = _fs?.existsSync
const readFileSync = _fs?.readFileSync, writeFileSync = _fs?.writeFileSync
const statSync = _fs?.statSync, mkdirSync = _fs?.mkdirSync
const resolvePath = _path?.resolve || (() => ''), joinPath = _path?.join || (() => '')

export function createEditorHandlers(ctx) {
  const { connections, appRuntime } = ctx

  function handle(type, payload, clientId) {
    if (type === MSG.EDITOR_UPDATE) {
      const { entityId, changes } = payload || {}
      if (entityId && changes) {
        const entity = appRuntime.entities.get(entityId)
        if (entity) {
          if (changes.position) entity.position = changes.position
          if (changes.rotation) entity.rotation = changes.rotation
          if (changes.scale) entity.scale = changes.scale
          if (changes.custom) entity.custom = { ...entity.custom, ...changes.custom }
          appRuntime.fireEvent(entityId, 'onEditorUpdate', changes)
          ctx.placedModelStorage?.persist(appRuntime)
        }
      }
      return true
    }
    if (type === MSG.PLACE_MODEL) {
      const { url, position } = payload || {}
      if (url) {
        const id = 'placed-' + Math.random().toString(36).slice(2, 10)
        appRuntime.spawnEntity(id, { model: url, position: position || [0,0,0], app: 'placed-model', config: { collider: 'none' } })
        connections.send(clientId, MSG.EDITOR_SELECT, { entityId: id })
        ctx.placedModelStorage?.persist(appRuntime)
      }
      return true
    }
    if (type === MSG.PLACE_APP) {
      const { appName, position, config } = payload || {}
      if (appName && appRuntime._appDefs.has(appName)) {
        const id = appName + '-' + Math.random().toString(36).slice(2, 8)
        appRuntime.spawnEntity(id, { app: appName, position: position || [0,0,0], config: config || {} })
        const appDef = appRuntime._appDefs.get(appName)
        const editorProps = (appDef?.server || appDef)?.editorProps || appDef?.editorProps || []
        connections.send(clientId, MSG.EDITOR_SELECT, { entityId: id, editorProps })
        ctx.placedModelStorage?.persist(appRuntime)
      }
      return true
    }
    if (type === MSG.LIST_APPS) {
      const apps = []
      if (isNode && readdirSync) {
        const appsRoot = resolvePath(process.cwd(), 'apps')
        try {
          for (const name of readdirSync(appsRoot)) {
            const idxPath = joinPath(appsRoot, name, 'index.js')
            if (!existsSync(idxPath)) continue
            const src = readFileSync(idxPath, 'utf8')
            const descMatch = src.match(/\/\/\s*(.+)/)
            const description = descMatch ? descMatch[1].trim() : ''
            const appDef = appRuntime._appDefs.get(name)
            const serverMod = appDef?.server || appDef
            apps.push({ name, description, hasEditorProps: !!(serverMod?.editorProps?.length) })
          }
        } catch (e) {}
      } else {
        for (const [name, appDef] of appRuntime._appDefs) {
          const serverMod = appDef?.server || appDef
          apps.push({ name, description: '', hasEditorProps: !!(serverMod?.editorProps?.length) })
        }
      }
      connections.send(clientId, MSG.APP_LIST, { apps })
      return true
    }
    if (type === MSG.LIST_APP_FILES) {
      const { appName } = payload || {}
      if (appName && isNode && readdirSync) {
        const appsRoot = resolvePath(process.cwd(), 'apps')
        const appDir = resolvePath(joinPath(appsRoot, appName))
        if (appDir.startsWith(appsRoot) && existsSync(appDir)) {
          const files = []
          const scan = (dir, prefix) => {
            try {
              for (const entry of readdirSync(dir)) {
                const full = joinPath(dir, entry)
                const rel = prefix ? prefix + '/' + entry : entry
                if (statSync(full).isDirectory()) scan(full, rel)
                else files.push(rel)
              }
            } catch (e) {}
          }
          scan(appDir, '')
          connections.send(clientId, MSG.APP_FILES, { appName, files })
        }
      } else if (appName) {
        connections.send(clientId, MSG.APP_FILES, { appName, files: ['index.js'] })
      }
      return true
    }
    if (type === MSG.GET_SOURCE) {
      const { appName, file } = payload || {}
      if (appName) {
        if (isNode && readFileSync) {
          const appsRoot = resolvePath(process.cwd(), 'apps')
          const filePath = resolvePath(joinPath(appsRoot, appName, file || 'index.js'))
          if (filePath.startsWith(appsRoot) && existsSync(filePath)) {
            connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source: readFileSync(filePath, 'utf8') })
          }
        } else {
          const source = ctx.appLoader?.getClientModule(appName) || ''
          connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source })
        }
      }
      return true
    }
    if (type === MSG.SAVE_SOURCE) {
      const { appName, file, source } = payload || {}
      if (appName && source != null) {
        if (isNode && writeFileSync) {
          const appsRoot = resolvePath(process.cwd(), 'apps')
          const filePath = resolvePath(joinPath(appsRoot, appName, file || 'index.js'))
          if (filePath.startsWith(appsRoot)) {
            writeFileSync(filePath, source, 'utf8')
            connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source })
          }
        } else {
          ctx.appLoader?.loadFromString(appName, source)
          connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source })
          connections.broadcast(MSG.APP_MODULE, { app: appName, code: source })
        }
      }
      return true
    }
    if (type === MSG.SCENE_GRAPH) {
      connections.send(clientId, MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
      return true
    }
    if (type === MSG.DESTROY_ENTITY) {
      const { entityId } = payload || {}
      if (entityId && appRuntime.entities.has(entityId)) {
        appRuntime.destroyEntity(entityId)
        ctx.placedModelStorage?.persist(appRuntime)
        connections.broadcast(MSG.DESTROY_ENTITY, { entityId })
      }
      return true
    }
    if (type === MSG.GET_EDITOR_PROPS) {
      const { entityId } = payload || {}
      if (entityId) {
        const entity = appRuntime.entities.get(entityId)
        const appName = entity?._appName
        const appDef = appName ? appRuntime._appDefs.get(appName) : null
        const serverMod = appDef?.server || appDef
        connections.send(clientId, MSG.EDITOR_PROPS, { entityId, editorProps: serverMod?.editorProps || [] })
      }
      return true
    }
    if (type === MSG.EVENT_LOG_QUERY) {
      connections.send(clientId, MSG.EVENT_LOG_DATA, { events: ctx.eventLog ? ctx.eventLog.query({}).slice(-60) : [] })
      return true
    }
    if (type === MSG.CREATE_APP) {
      const { appName } = payload || {}
      if (!appName || !/^[a-z0-9-]+$/.test(appName)) return true
      const template = `export default {\n  server: {\n    setup(ctx) {},\n    onEditorUpdate(ctx, changes) {\n      if (changes.position) ctx.entity.position = changes.position\n      if (changes.rotation) ctx.entity.rotation = changes.rotation\n      if (changes.scale) ctx.entity.scale = changes.scale\n      if (changes.custom) ctx.entity.custom = { ...ctx.entity.custom, ...changes.custom }\n    }\n  },\n  client: {\n    render(ctx) {\n      return { position: ctx.entity.position, rotation: ctx.entity.rotation, scale: ctx.entity.scale, model: ctx.entity.model }\n    }\n  }\n}\n`
      if (isNode && mkdirSync) {
        const appsRoot = resolvePath(process.cwd(), 'apps')
        const appDir = joinPath(appsRoot, appName)
        if (!existsSync(appDir)) {
          mkdirSync(appDir, { recursive: true })
          writeFileSync(joinPath(appDir, 'index.js'), template, 'utf8')
          connections.send(clientId, MSG.SOURCE, { appName, file: 'index.js', source: template })
        }
      } else {
        ctx.appLoader?.loadFromString(appName, template)
        connections.send(clientId, MSG.SOURCE, { appName, file: 'index.js', source: template })
        connections.broadcast(MSG.APP_MODULE, { app: appName, code: template })
      }
      return true
    }
    return false
  }

  return { handle }
}
