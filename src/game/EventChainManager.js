/**
 * EventChainManager.js
 * Universal Game Event Chain Engine for spoint.
 * Manages Event Triggers, Conditions, Actions, and Delays for visual game logic without code.
 */

export class EventChainManager {
  constructor(options = {}) {
    this.chains = new Map() // chainId -> chainSpec
    this.variables = new Map() // varName -> value
    this.inventories = new Map() // entityId/playerId -> Map(itemId -> count)
    this.activeDelayedActions = [] // queue of pending delayed actions
    this.eventLogs = [] // execution log history for editor debugging
    this.maxLogs = options.maxLogs || 100
    this.ctx = options.ctx || null // optional runtime context (world, players, scene, sound, etc.)

    // Event listeners attached externally
    this.listeners = new Map()
  }

  /**
   * Set or attach runtime context (e.g. engine/server ctx)
   */
  setContext(ctx) {
    this.ctx = ctx
  }

  /**
   * Register a new event chain spec
   * @param {Object} chainSpec
   * @returns {Object} registered chain
   */
  addChain(chainSpec) {
    if (!chainSpec.id) {
      chainSpec.id = 'chain_' + Math.random().toString(36).substr(2, 9)
    }
    const chain = {
      id: chainSpec.id,
      name: chainSpec.name || 'Event Chain ' + chainSpec.id,
      enabled: chainSpec.enabled !== false,
      trigger: chainSpec.trigger || { type: 'onInteract', entityId: '*' },
      conditions: chainSpec.conditions || [],
      actions: chainSpec.actions || [],
      metadata: chainSpec.metadata || {}
    }
    this.chains.set(chain.id, chain)
    this._log('chain_added', { chainId: chain.id, name: chain.name })
    return chain
  }

  /**
   * Remove an event chain by ID
   */
  removeChain(chainId) {
    const deleted = this.chains.delete(chainId)
    if (deleted) {
      this._log('chain_removed', { chainId })
    }
    return deleted
  }

  /**
   * Retrieve a chain by ID
   */
  getChain(chainId) {
    return this.chains.get(chainId)
  }

  /**
   * Get all registered chains as an array
   */
  getChains() {
    return Array.from(this.chains.values())
  }

  /**
   * Set a global variable
   */
  setVariable(name, value) {
    this.variables.set(name, value)
    this._log('variable_set', { name, value })
  }

  /**
   * Get a variable value
   */
  getVariable(name, defaultValue = undefined) {
    if (this.variables.has(name)) {
      return this.variables.get(name)
    }
    return defaultValue
  }

  /**
   * Get all global variables as a plain object
   */
  getAllVariables() {
    const obj = {}
    for (const [k, v] of this.variables.entries()) {
      obj[k] = v
    }
    return obj
  }

  /**
   * Set inventory items for an entity or player
   */
  setInventoryItem(ownerId, itemId, count = 1) {
    if (!this.inventories.has(ownerId)) {
      this.inventories.set(ownerId, new Map())
    }
    const inv = this.inventories.get(ownerId)
    inv.set(itemId, Math.max(0, count))
  }

  /**
   * Get item count in inventory
   */
  getInventoryItem(ownerId, itemId) {
    const inv = this.inventories.get(ownerId)
    if (!inv) return 0
    return inv.get(itemId) || 0
  }

  /**
   * Trigger an event into the engine (e.g., 'onInteract', 'onEnterZone', 'onTimer', 'onDestroy', 'onCollision')
   * @param {string} eventType 
   * @param {Object} context Event details (entityId, player, zoneId, targetEntityId, etc.)
   */
  triggerEvent(eventType, context = {}) {
    this._log('event_triggered', { eventType, context })
    const matchedChains = []

    for (const chain of this.chains.values()) {
      if (!chain.enabled) continue
      if (!this._matchesTrigger(chain.trigger, eventType, context)) continue
      matchedChains.push(chain)
    }

    const results = []
    for (const chain of matchedChains) {
      const chainResult = this.runChain(chain.id, context)
      results.push(chainResult)
    }

    return results
  }

  /**
   * Check if a chain trigger matches the incoming event
   */
  _matchesTrigger(trigger, eventType, context) {
    if (!trigger || trigger.type !== eventType) return false

    // Target entity filter
    if (trigger.entityId && trigger.entityId !== '*') {
      const target = context.entityId || (context.entity && context.entity.id)
      if (target !== trigger.entityId) return false
    }

    // Zone filter for onEnterZone
    if (eventType === 'onEnterZone' && trigger.zoneId && trigger.zoneId !== '*') {
      if (context.zoneId !== trigger.zoneId) return false
    }

    // Collision filter for onCollision
    if (eventType === 'onCollision' && trigger.targetEntityId && trigger.targetEntityId !== '*') {
      if (context.targetEntityId !== trigger.targetEntityId) return false
    }

    // Timer filter for onTimer
    if (eventType === 'onTimer' && trigger.timerId) {
      if (context.timerId !== trigger.timerId) return false
    }

    return true
  }

  /**
   * Run a specific event chain by ID given an optional context
   */
  runChain(chainId, context = {}) {
    const chain = this.chains.get(chainId)
    if (!chain) {
      return { success: false, reason: 'Chain not found' }
    }

    this._log('chain_executing', { chainId: chain.id, name: chain.name, context })

    // Evaluate all conditions
    const conditionResults = []
    for (const cond of chain.conditions) {
      const passed = this.evaluateCondition(cond, context)
      conditionResults.push({ condition: cond, passed })
      if (!passed) {
        this._log('chain_condition_failed', { chainId: chain.id, condition: cond })
        return { success: false, reason: 'Condition failed', conditionResults }
      }
    }

    // Execute actions sequence (handling delays)
    this._executeActionSequence(chain.actions, context, 0, chain.id)

    return { success: true, chainId: chain.id, conditionResults }
  }

  /**
   * Evaluate a single condition object
   */
  evaluateCondition(cond, context = {}) {
    if (!cond || !cond.type) return true

    switch (cond.type) {
      case 'ifVariable': {
        const name = cond.variableName
        const op = cond.operator || '=='
        const targetVal = cond.value
        let currentVal = this.getVariable(name)
        if (currentVal === undefined && context.variables) {
          currentVal = context.variables[name]
        }
        if (currentVal === undefined && this.ctx && this.ctx.state) {
          currentVal = this.ctx.state[name]
        }

        return this._compareValues(currentVal, op, targetVal)
      }

      case 'ifItemInInventory': {
        const ownerId = cond.ownerId || context.playerId || (context.player && context.player.id) || context.entityId || 'global'
        const itemId = cond.itemId
        const requiredCount = cond.count !== undefined ? Number(cond.count) : 1
        const currentCount = this.getInventoryItem(ownerId, itemId)

        const op = cond.operator || '>='
        return this._compareValues(currentCount, op, requiredCount)
      }

      default:
        // Support custom condition functions or unknown types default to true if unhandled
        return true
    }
  }

  /**
   * Helper comparison method
   */
  _compareValues(val1, op, val2) {
    // Attempt numeric conversions if possible
    const num1 = Number(val1)
    const num2 = Number(val2)
    const isNum = !isNaN(num1) && !isNaN(num2) && val1 !== '' && val2 !== '' && val1 !== null && val2 !== null

    const a = isNum ? num1 : val1
    const b = isNum ? num2 : val2

    switch (op) {
      case '==':
      case '=':
        return a == b
      case '!=':
        return a != b
      case '>':
        return a > b
      case '<':
        return a < b
      case '>=':
        return a >= b
      case '<=':
        return a <= b
      case 'contains':
        return String(a).includes(String(b))
      case 'boolean':
        return Boolean(a) === Boolean(b)
      default:
        return a == b
    }
  }

  /**
   * Execute sequence of actions (supports delay nodes/fields)
   */
  _executeActionSequence(actions, context, index, chainId) {
    if (!actions || index >= actions.length) return

    const action = actions[index]
    const delay = action.delay !== undefined ? Number(action.delay) : (action.type === 'delay' ? Number(action.duration || 0) : 0)

    if (delay > 0) {
      this._log('action_delayed', { chainId, action, delaySeconds: delay })
      this.activeDelayedActions.push({
        remaining: delay,
        actions,
        context,
        index,
        chainId
      })
    } else {
      this.executeAction(action, context, chainId)
      this._executeActionSequence(actions, context, index + 1, chainId)
    }
  }

  /**
   * Execute a single action object
   */
  executeAction(action, context = {}, chainId = null) {
    if (!action) return null
    if (action.type === 'delay') {
      // Handled in sequence runner
      return { type: 'delay', duration: action.duration }
    }

    this._log('action_executing', { chainId, action, context })

    const result = { type: action.type, action, success: true }

    switch (action.type) {
      case 'playSound': {
        const soundName = action.sound || action.soundUrl
        const volume = action.volume !== undefined ? Number(action.volume) : 1.0
        const loop = Boolean(action.loop)
        const targetEntity = action.targetEntityId || context.entityId

        if (this.ctx) {
          if (this.ctx.audio && typeof this.ctx.audio.play === 'function') {
            this.ctx.audio.play(soundName, { volume, loop, targetEntity })
          } else if (this.ctx.players && typeof this.ctx.players.broadcast === 'function') {
            this.ctx.players.broadcast({ type: 'play_sound', sound: soundName, volume, loop, targetEntity })
          }
        }
        result.details = { soundName, volume, targetEntity }
        break
      }

      case 'spawnPrefab': {
        const prefabId = action.prefabId || action.appName || 'box-static'
        const pos = action.position || context.position || [0, 0, 0]
        const config = action.config || {}
        const spawnId = action.spawnEntityId || ('spawned_' + Math.random().toString(36).substr(2, 6))

        if (this.ctx && this.ctx.world && typeof this.ctx.world.spawn === 'function') {
          const spawned = this.ctx.world.spawn(spawnId, {
            app: prefabId,
            position: pos,
            config
          })
          result.spawnedEntity = spawned
        }
        result.details = { prefabId, spawnId, pos }
        break
      }

      case 'setVariable': {
        const name = action.variableName
        const op = action.operator || '='
        const val = action.value

        let cur = this.getVariable(name, 0)
        let next = val

        if (op === '+=') {
          next = Number(cur) + Number(val)
        } else if (op === '-=') {
          next = Number(cur) - Number(val)
        } else if (op === 'toggle') {
          next = !Boolean(cur)
        }

        this.setVariable(name, next)
        if (this.ctx && this.ctx.state) {
          this.ctx.state[name] = next
        }
        result.details = { name, op, previous: cur, newValue: next }
        break
      }

      case 'triggerAnimation': {
        const target = action.targetEntityId || context.playerId || context.entityId
        const clip = action.clip || 'idle'
        const loop = action.loop !== false
        const fade = action.fade !== undefined ? Number(action.fade) : 0.15

        if (this.ctx && this.ctx.players && typeof this.ctx.players.playAnimation === 'function') {
          this.ctx.players.playAnimation(target, clip, { loop, fade })
        }
        result.details = { target, clip, loop, fade }
        break
      }

      case 'loadLevel': {
        const levelId = action.levelId || action.sceneName || action.worldPath
        if (this.ctx) {
          if (typeof this.ctx.loadLevel === 'function') {
            this.ctx.loadLevel(levelId)
          } else if (this.ctx.players && typeof this.ctx.players.broadcast === 'function') {
            this.ctx.players.broadcast({ type: 'load_level', levelId })
          }
        }
        result.details = { levelId }
        break
      }

      case 'emitParticle': {
        const particleType = action.particleType || 'spark'
        const count = action.count !== undefined ? Number(action.count) : 10
        const pos = action.position || context.position || [0, 0, 0]
        const color = action.color || 0xffff00
        const scale = action.scale !== undefined ? Number(action.scale) : 1.0

        if (this.ctx && this.ctx.players && typeof this.ctx.players.broadcast === 'function') {
          this.ctx.players.broadcast({
            type: 'emit_particle',
            particleType,
            count,
            position: pos,
            color,
            scale
          })
        }
        result.details = { particleType, count, pos, color, scale }
        break
      }

      default:
        // Support custom action callback if defined
        if (typeof action.execute === 'function') {
          action.execute(context, this)
        }
        break
    }

    return result
  }

  /**
   * Advance delay timers by dt (in seconds)
   */
  tick(dt = 0.016) {
    if (this.activeDelayedActions.length === 0) return

    const remainingItems = []
    for (const item of this.activeDelayedActions) {
      item.remaining -= dt
      if (item.remaining <= 0) {
        // Time expired, execute delayed action and continue sequence
        const action = item.actions[item.index]
        this.executeAction(action, item.context, item.chainId)
        this._executeActionSequence(item.actions, item.context, item.index + 1, item.chainId)
      } else {
        remainingItems.push(item)
      }
    }

    this.activeDelayedActions = remainingItems
  }

  /**
   * Append to internal event execution logs
   */
  _log(type, details) {
    const entry = {
      timestamp: Date.now(),
      type,
      details
    }
    this.eventLogs.push(entry)
    if (this.eventLogs.length > this.maxLogs) {
      this.eventLogs.shift()
    }
    this._notifyListeners(entry)
  }

  /**
   * Get log entries
   */
  getLogs() {
    return [...this.eventLogs]
  }

  /**
   * Clear log history
   */
  clearLogs() {
    this.eventLogs = []
  }

  /**
   * Add log listener
   */
  onLog(callback) {
    this.listeners.set(callback, callback)
    return () => this.listeners.delete(callback)
  }

  _notifyListeners(entry) {
    for (const cb of this.listeners.values()) {
      try {
        cb(entry)
      } catch (e) {
        console.error('Error in EventChainManager log listener:', e)
      }
    }
  }

  /**
   * Reset engine state (clears active timers, variables, logs, inventories)
   */
  reset() {
    this.activeDelayedActions = []
    this.variables.clear()
    this.inventories.clear()
    this.eventLogs = []
  }

  /**
   * Export manager state to JSON
   */
  toJSON() {
    return {
      chains: Array.from(this.chains.values()),
      variables: this.getAllVariables()
    }
  }

  /**
   * Load manager state from JSON
   */
  fromJSON(data = {}) {
    this.chains.clear()
    this.variables.clear()

    if (Array.isArray(data.chains)) {
      for (const c of data.chains) {
        this.addChain(c)
      }
    }

    if (data.variables && typeof data.variables === 'object') {
      for (const [k, v] of Object.entries(data.variables)) {
        this.setVariable(k, v)
      }
    }
  }
}
