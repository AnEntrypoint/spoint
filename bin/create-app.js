#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = import.meta.dirname || dirname(fileURLToPath(import.meta.url))

const TEMPLATES = {
  simple: 'simple',
  physics: 'physics',
  interactive: 'interactive',
  spawner: 'spawner'
}

function showHelp() {
  console.log(`
Usage: spoint create-app [options] <app-name>

Options:
  --template <type>   Template to use: simple, physics, interactive, spawner (default: simple)
  --help              Show this help message

Examples:
  spoint create-app my-app
  spoint create-app --template physics my-physics-object
  spoint create-app --template spawner my-spawner
  spoint-create-app my-app
`)
}

function parseArgs(argv) {
  const args = { name: null, template: 'simple' }
  
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') {
      showHelp()
      process.exit(0)
    }
    if (argv[i] === '--template' && argv[i + 1]) {
      args.template = argv[++i]
    } else if (!argv[i].startsWith('--')) {
      args.name = argv[i]
    }
  }
  
  return args
}

function getTemplateContent(templateType) {
  const templates = {
    simple: `export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = {
        mesh: 'box',
        color: 0x00ff00
      }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
    },

    update(ctx, dt) {
      // Your update logic here
    },

    teardown(ctx) {
      // Cleanup resources
    }
  },

  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom
      }
    }
  }
}`,

    physics: `export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = {
        mesh: 'box',
        color: 0xff8800,
        sx: 1,
        sy: 1,
        sz: 1
      }
      ctx.physics.setDynamic(true)
      ctx.physics.setMass(5)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
    }
  },

  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom
      }
    }
  }
}`,

    interactive: `export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = {
        mesh: 'box',
        color: 0x00ff88,
        sx: 1.5,
        sy: 0.5,
        sz: 1.5,
        label: 'INTERACT'
      }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([0.75, 0.25, 0.75])
      ctx.state.interactionCount = 0
      ctx.state.interactionRadius = 3.5
      ctx.state.interactionCooldown = new Map()
    },

    update(ctx, dt) {
      const nearby = ctx.players.getNearest(ctx.entity.position, ctx.state.interactionRadius)
      if (!nearby?.state?.interact) return

      const now = Date.now()
      const playerId = nearby.id
      const lastInteract = ctx.state.interactionCooldown.get(playerId) || 0

      if (now - lastInteract > 500) {
        ctx.state.interactionCooldown.set(playerId, now)
        ctx.state.interactionCount++

        ctx.players.send(playerId, {
          type: 'interact_response',
          message: 'You interacted!',
          count: ctx.state.interactionCount
        })

        ctx.network.broadcast({
          type: 'interact_effect',
          position: ctx.entity.position
        })
      }
    },

    teardown(ctx) {
      ctx.state.interactionCooldown?.clear()
    }
  },

  client: {
    setup(engine) {
      this._lastMessage = null
      this._messageExpire = 0
      this._canInteract = false
      this._entityPos = null
    },

    onFrame(dt, engine) {
      const local = engine.client?.state?.players?.find(p => p.id === engine.playerId)
      if (!this._entityPos || !local?.position) {
        this._canInteract = false
        return
      }

      const dx = this._entityPos[0] - local.position[0]
      const dy = this._entityPos[1] - local.position[1]
      const dz = this._entityPos[2] - local.position[2]
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      this._canInteract = dist < 3.5
    },

    onEvent(payload, engine) {
      if (payload.type === 'interact_response') {
        this._lastMessage = payload.message
        this._messageExpire = Date.now() + 2000
      }
    },

    render(ctx) {
      this._entityPos = ctx.entity.position
      const custom = { ...ctx.entity.custom }
      if (this._canInteract) {
        custom.glow = true
        custom.glowColor = 0x00ff88
      }

      const ui = []
      if (this._lastMessage && Date.now() < this._messageExpire) {
        const opacity = Math.max(0, (this._messageExpire - Date.now()) / 2000)
        if (ctx.h) {
          ui.push(
            ctx.h('div', {
              style: \`position:fixed;top:30%;left:50%;transform:translate(-50%,-50%);padding:16px 32px;background:rgba(0,0,0,0.8);border-radius:12px;color:#0f0;font-weight:bold;font-size:20px;opacity:\${opacity}\`
            }, this._lastMessage)
          )
        }
      }

      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom,
        ui: ui.length > 0 ? ctx.h('div', null, ...ui) : null
      }
    }
  }
}`,

    spawner: `const CONFIG = {
  spawnInterval: 5,
  maxEntities: 10,
  entityApp: 'physics-crate'
}

export default {
  server: {
    setup(ctx) {
      ctx.state.entities = new Set()
      ctx.state.nextId = 0

      ctx.entity.custom = {
        mesh: 'box',
        color: 0x4488ff,
        sx: 1.5,
        sy: 1.5,
        sz: 1.5,
        label: 'SPAWNER'
      }

      ctx.time.every(CONFIG.spawnInterval, () => {
        if (ctx.state.entities.size >= CONFIG.maxEntities) return

        const id = \`spawned_\${ctx.state.nextId++}\`
        const pos = [
          ctx.entity.position[0] + (Math.random() - 0.5) * 4,
          ctx.entity.position[1] + 2,
          ctx.entity.position[2] + (Math.random() - 0.5) * 4
        ]

        ctx.world.spawn(id, {
          position: pos,
          app: CONFIG.entityApp
        })
        ctx.state.entities.add(id)
      })
    },

    onMessage(ctx, msg) {
      if (msg.type === 'entity_destroyed') {
        ctx.state.entities.delete(msg.entityId)
      }
    },

    teardown(ctx) {
      ctx.state.entities.forEach(id => ctx.world.destroy(id))
      ctx.state.entities.clear()
    }
  },

  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom
      }
    }
  }
}`
  }

  return templates[templateType] || templates.simple
}

function createApp(name, template) {
  const appsDir = resolve('apps')
  const appDir = join(appsDir, name)

  if (existsSync(appDir)) {
    console.error(`Error: App '${name}' already exists at ${appDir}`)
    process.exit(1)
  }

  mkdirSync(appDir, { recursive: true })

  const indexJsPath = join(appDir, 'index.js')
  const indexJsContent = getTemplateContent(template)
  writeFileSync(indexJsPath, indexJsContent)

  console.log(`✓ Created app: ${name}`)
  console.log(`  Location: ${appDir}`)
  console.log(`  Template: ${template}`)
  console.log(`\nTo test your app:`)
  console.log(`  1. Start server: npm start`)
  console.log(`  2. Connect to http://localhost:3001`)
  console.log(`  3. Add app to apps/world/index.js entities with app: '${name}'`)
  console.log(`  4. Edit ${indexJsPath} to make changes`)
  console.log(`  5. Server hot-reloads automatically`)
}

const args = parseArgs(process.argv.slice(2))

if (!args.name) {
  console.error('Error: App name required')
  showHelp()
  process.exit(1)
}

if (args.template && !TEMPLATES[args.template]) {
  console.error(`Error: Unknown template '${args.template}'`)
  console.log(`Available: ${Object.keys(TEMPLATES).join(', ')}`)
  process.exit(1)
}

createApp(args.name, args.template)
