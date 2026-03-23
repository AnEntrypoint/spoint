import { MSG } from '../protocol/MessageTypes.js'
import { readdirSync, existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

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
      const appsRoot = resolve(process.cwd(), 'apps')
      const apps = []
      try {
        for (const name of readdirSync(appsRoot)) {
          const idxPath = join(appsRoot, name, 'index.js')
          if (!existsSync(idxPath)) continue
          const src = readFileSync(idxPath, 'utf8')
          const descMatch = src.match(/\/\/\s*(.+)/)
          const description = descMatch ? descMatch[1].trim() : ''
          const appDef = appRuntime._appDefs.get(name)
          const serverMod = appDef?.server || appDef
          const hasEditorProps = !!(serverMod?.editorProps?.length)
          apps.push({ name, description, hasEditorProps })
        }
      } catch (e) {}
      connections.send(clientId, MSG.APP_LIST, { apps })
      return true
    }
    if (type === MSG.LIST_APP_FILES) {
      const { appName } = payload || {}
      if (appName) {
        const appsRoot = resolve(process.cwd(), 'apps')
        const appDir = resolve(join(appsRoot, appName))
        if (appDir.startsWith(appsRoot) && existsSync(appDir)) {
          const files = []
          const scan = (dir, prefix) => {
            try {
              for (const entry of readdirSync(dir)) {
                const full = join(dir, entry)
                const rel = prefix ? prefix + '/' + entry : entry
                if (statSync(full).isDirectory()) scan(full, rel)
                else files.push(rel)
              }
            } catch (e) {}
          }
          scan(appDir, '')
          connections.send(clientId, MSG.APP_FILES, { appName, files })
        }
      }
      return true
    }
    if (type === MSG.GET_SOURCE) {
      const { appName, file } = payload || {}
      if (appName) {
        const appsRoot = resolve(process.cwd(), 'apps')
        const filePath = resolve(join(appsRoot, appName, file || 'index.js'))
        if (filePath.startsWith(appsRoot) && existsSync(filePath)) {
          const source = readFileSync(filePath, 'utf8')
          connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source })
        }
      }
      return true
    }
    if (type === MSG.SAVE_SOURCE) {
      const { appName, file, source } = payload || {}
      if (appName && source != null) {
        const appsRoot = resolve(process.cwd(), 'apps')
        const filePath = resolve(join(appsRoot, appName, file || 'index.js'))
        if (filePath.startsWith(appsRoot)) {
          writeFileSync(filePath, source, 'utf8')
          connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source })
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
        const editorProps = serverMod?.editorProps || []
        connections.send(clientId, MSG.EDITOR_PROPS, { entityId, editorProps })
      }
      return true
    }
    if (type === MSG.EVENT_LOG_QUERY) {
      const events = ctx.eventLog ? ctx.eventLog.query({}).slice(-60) : []
      connections.send(clientId, MSG.EVENT_LOG_DATA, { events })
      return true
    }
    if (type === MSG.CREATE_APP) {
      const { appName } = payload || {}
      if (!appName || !/^[a-z0-9-]+$/.test(appName)) return true
      const appsRoot = resolve(process.cwd(), 'apps')
      const appDir = join(appsRoot, appName)
      if (!existsSync(appDir)) {
        mkdirSync(appDir, { recursive: true })
        const template = `export default {
  server: {
    setup(ctx) {},
    onEditorUpdate(ctx, changes) {
      if (changes.position) ctx.entity.position = changes.position
      if (changes.rotation) ctx.entity.rotation = changes.rotation
      if (changes.scale) ctx.entity.scale = changes.scale
      if (changes.custom) ctx.entity.custom = { ...ctx.entity.custom, ...changes.custom }
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, scale: ctx.entity.scale, model: ctx.entity.model }
    }
  }
}
`
        writeFileSync(join(appDir, 'index.js'), template, 'utf8')
        connections.send(clientId, MSG.SOURCE, { appName, file: 'index.js', source: template })
      }
      return true
    }
    return false
  }

  return { handle }
}
