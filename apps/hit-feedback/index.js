const HIT_EVENT = 'hit-feedback'
const HEAL_EVENT = 'heal-feedback'
const DAMAGE_PER_IMPULSE_UNIT = 10

function toVec3(v) {
  if (Array.isArray(v)) return [v[0] || 0, v[1] || 0, v[2] || 0]
  if (v && typeof v === 'object') return [v.x || 0, v.y || 0, v.z || 0]
  return null
}

function toPoint(v) {
  return Array.isArray(v) ? { x: v[0], y: v[1], z: v[2] } : null
}

export default {
  description: 'Hit feedback system: screen shake and sound effects via backend. UI delegated to design-kit DamageNumbers component.',
  server: {
    editorProps: [
      { key: 'screenShakeIntensity', label: 'Screen shake intensity', type: 'range', min: 0, max: 3, step: 0.1, default: 1 },
      { key: 'showDamageNumbers', label: 'Show damage numbers', type: 'checkbox', default: true },
      { key: 'soundVolume', label: 'Hit sound volume', type: 'range', min: 0, max: 1, step: 0.1, default: 0.8 }
    ],
    setup(ctx) {
      ctx.state.lastDamageTime = 0

      ctx.bus.on('damage', ({ data }) => {
        if (!data || data.target !== ctx.entity.id) return
        const cfg = ctx.config
        const amount = data.amount || 0
        const direction = toVec3(data.direction)
        ctx.state.lastDamageTime = Date.now()
        ctx.players.broadcast({
          type: HIT_EVENT,
          entityId: ctx.entity.id,
          amount,
          position: toVec3(data.position) || [...ctx.entity.position],
          direction,
          from: data.by ?? null,
          screenShakeIntensity: cfg.screenShakeIntensity ?? 1,
          showDamageNumbers: cfg.showDamageNumbers !== false,
          soundVolume: cfg.soundVolume ?? 0.8
        })
        if (direction && ctx.entity.bodyType === 'dynamic') {
          const scale = amount / DAMAGE_PER_IMPULSE_UNIT
          ctx.world.applyImpulse(ctx.entity.id, [direction[0] * scale, 0, direction[2] * scale])
        }
      })

      ctx.bus.on('heal', ({ data }) => {
        if (!data || data.target !== ctx.entity.id) return
        ctx.players.broadcast({
          type: HEAL_EVENT,
          entityId: ctx.entity.id,
          amount: data.amount || 0,
          position: toVec3(data.position) || [...ctx.entity.position],
          showDamageNumbers: ctx.config.showDamageNumbers !== false
        })
      })
    }
  },
  client: {
    setup(engine) {
      engine._hitFeedback = { effects: null }
    },
    onEvent(payload, engine) {
      const type = payload?.type
      if (type !== HIT_EVENT && type !== HEAL_EVENT) return
      const hf = engine._hitFeedback
      if (!hf) return
      const point = toPoint(payload.position)
      if (type === HIT_EVENT) {
        hf.effects ||= window.__damageEffects?.createDamageEffects?.(engine.scene, engine.camera, null) || null
        hf.effects?.triggerDamage(payload.amount, point, {
          hitDirection: payload.direction,
          soundVolume: payload.soundVolume,
          screenShakeIntensity: payload.screenShakeIntensity,
          showNumbers: payload.showDamageNumbers
        })
      }
      if (payload.showDamageNumbers === false || !point) return
      const heal = type === HEAL_EVENT
      window.__DamageNumbers?.addNumber({
        damage: payload.amount,
        position: point,
        color: heal ? '#00ff00' : payload.amount > 25 ? '#ff0000' : '#ff4444',
        size: heal ? 28 : 32 + payload.amount / 10,
        isHeal: heal
      })
    },
    onFrame(dt, engine) {
      engine._hitFeedback?.effects?.update()
    }
  }
}
