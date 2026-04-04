const SMART_OBJECT_TEMPLATES = { door:{displayName:'Door',collider:{type:'box',size:[1.5,2.5,0.1]},config:{open:false,openTime:0.5,closeTime:0.5,openAngle:Math.PI/2}}, platform:{displayName:'Moving Platform',collider:{type:'box',size:[4,0.5,4]},config:{waypoints:[[0,0,0]],speed:5,waitTime:1}}, trigger:{displayName:'Trigger Volume',collider:{type:'box',size:[2,3,2]},config:{eventName:'trigger',oneshot:false}}, hazard:{displayName:'Hazard Zone',collider:{type:'sphere',radius:2},config:{damage:10,damageInterval:0.5}}, lootBox:{displayName:'Loot Box',collider:{type:'box',size:[1,1.5,1]},config:{lootType:'ammo',quantity:30}}, pillar:{displayName:'Pillar/Column',collider:{type:'capsule',radius:0.5,halfHeight:2},config:{decorative:true}} }
const _PC = { door:0x0066ff,platform:0x00cc00,trigger:0xffff00,hazard:0xff0000,lootBox:0x885533,pillar:0x888888,unknown:0xcccccc }
const getPlaceholderColor = n => _PC[n] || _PC.unknown
const isValidTemplate = n => n in SMART_OBJECT_TEMPLATES
const getTemplate = n => SMART_OBJECT_TEMPLATES[n] || null
let _readdirSync = null, _statSync = null, _join = null, _modelsDir = ''

function discoverModels() {
  const registry = {}
  try {
    if (!_readdirSync) return registry
    const categories = _readdirSync(_modelsDir).filter(f => _statSync(_join(_modelsDir, f)).isDirectory())
    for (const cat of categories) {
      const catPath = _join(_modelsDir, cat)
      const files = _readdirSync(catPath).filter(f => f.endsWith('.glb') || f.endsWith('.gltf'))
      registry[cat] = files
    }
  } catch (e) {
    console.log('[Environment] Model discovery skipped (models dir not found)')
  }
  return registry
}

export default {
  server: {
    async setup(ctx) {
      if (!_readdirSync && typeof process !== 'undefined' && process.versions?.node) {
        try { const { readdirSync, statSync } = await import('node:fs'); const { join } = await import('node:path'); const { fileURLToPath } = await import('node:url'); _readdirSync = readdirSync; _statSync = statSync; _join = join; _modelsDir = join(fileURLToPath(new URL('.', import.meta.url)), 'models') } catch {}
      }
      try {
        await ctx.physics.addColliderFromConfig({ type: 'trimesh' })
      } catch (e) {
        console.log(`[Environment] Trimesh collider failed: ${e.message}, using box collider`)
        ctx.physics.addColliderFromConfig({ type: 'box', size: [100, 25, 100] })
      }

      ctx.state.smartObjects = new Map()
      ctx.state.editorMode = false
      ctx.state.nextSmartObjectId = 0
      ctx.state.modelRegistry = discoverModels()

      ctx.debug.log(`[Environment] Initialized with ${Object.keys(SMART_OBJECT_TEMPLATES).length} smart object templates, ${Object.values(ctx.state.modelRegistry).flat().length} models discovered`)
    },

    update(ctx, dt) {
      if (!ctx.state.smartObjects || typeof ctx.state.smartObjects[Symbol.iterator] !== 'function') {
        return
      }
      for (const [id, obj] of ctx.state.smartObjects) {
        if (obj.template === 'platform') updatePlatform(ctx, id, obj, dt)
        if (obj.template === 'hazard') updateHazard(ctx, id, obj, dt)
      }
    },

    onEvent(payload, ctx) {
      if (payload.type === 'dropModel' && payload.position && payload.modelPath) {
        const id = `dropped_model_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        const entity = ctx.world.spawnChild(id, {
          position: payload.position,
          rotation: payload.rotation || [0, 0, 0, 1],
          model: payload.modelPath
        })
        if (entity) {
          entity.custom = {
            droppedModel: true,
            modelPath: payload.modelPath,
            scale: payload.scale || [1, 1, 1]
          }
          ctx.debug.log(`[Environment] Dropped model spawned: ${id}`)
        }
      }
    }
  }
}

function addCollider(ctx, collider) {
  if (!collider) return
  ctx.physics.addColliderFromConfig(collider)
}

function updatePlatform(ctx, id, obj, dt) {
  if (!obj.config || !obj.config.waypoints || obj.config.waypoints.length < 2) return

  const waypoints = obj.config.waypoints
  const speed = obj.config.speed || 5
  const waitTime = obj.config.waitTime || 1

  if (obj.waitTimer === undefined) obj.waitTimer = 0
  if (obj.currentWaypoint === undefined) obj.currentWaypoint = 0

  obj.waitTimer -= dt
  if (obj.waitTimer > 0) return

  const entity = ctx.world.getEntity(id)
  if (!entity) return

  const current = waypoints[obj.currentWaypoint]
  const next = waypoints[(obj.currentWaypoint + 1) % waypoints.length]

  const dx = next[0] - entity.position[0]
  const dy = next[1] - entity.position[1]
  const dz = next[2] - entity.position[2]
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

  if (dist < 0.1) {
    obj.currentWaypoint = (obj.currentWaypoint + 1) % waypoints.length
    obj.waitTimer = waitTime
    return
  }

  const moveDistance = Math.min(speed * dt, dist)
  entity.position[0] += (dx / dist) * moveDistance
  entity.position[1] += (dy / dist) * moveDistance
  entity.position[2] += (dz / dist) * moveDistance
}

function updateHazard(ctx, id, obj, dt) {
  if (!obj.config) return
  if (obj.damageTimer === undefined) obj.damageTimer = 0

  obj.damageTimer -= dt
  if (obj.damageTimer > 0) return

  obj.damageTimer = obj.config.damageInterval || 0.5

  const entity = ctx.world.getEntity(id)
  if (!entity) return

  const damage = obj.config.damage || 10
  const players = ctx.players.getAll()

  for (const player of players) {
    if (!player.state) continue
    const pp = player.state.position
    const dx = pp[0] - entity.position[0]
    const dy = pp[1] - entity.position[1]
    const dz = pp[2] - entity.position[2]
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const radius = obj.collider?.radius || 2

    if (dist < radius) {
      player.state.health = Math.max(0, (player.state.health || 100) - damage * dt)
      ctx.network.broadcast({ type: 'hazard_damage', playerId: player.id, damage: Math.round(damage * dt) })
    }
  }
}

function spawnSmartObject(ctx, templateName, position, rotation = [0, 0, 0, 1], parent = null) {
  if (!isValidTemplate(templateName)) {
    ctx.debug.log(`[Environment] Invalid template: ${templateName}`)
    return null
  }

  const template = getTemplate(templateName)
  const id = `smart_${templateName}_${ctx.state.nextSmartObjectId++}`

  const entity = ctx.world.spawnChild(id, {
    position,
    rotation,
    parent,
    model: template.model
  })

  if (!entity) return null

  const isEditor = ctx.state.editorMode

  entity.custom = {
    smartObject: true,
    template: templateName,
    editorPlaceholder: isEditor,
    color: getPlaceholderColor(templateName)
  }

  ctx.state.smartObjects.set(id, {
    template: templateName,
    config: { ...template.config },
    collider: template.collider
  })

  if (!isEditor && template.collider) {
    addCollider(ctx, template.collider)
  }

  return entity
}

export const spawn = (ctx, template, position, config) => {
  const obj = spawnSmartObject(ctx, template, position)
  if (obj && config) Object.assign(ctx.state.smartObjects.get(obj.id).config, config)
  return obj
}

export const setEditorMode = (ctx, enabled) => { ctx.state.editorMode = enabled }
