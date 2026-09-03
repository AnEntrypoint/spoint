export default {
  description: 'Hit feedback system: screen shake and sound effects via backend. UI delegated to design-kit DamageNumbers component.',
  server: {
    editorProps: [
      { key: 'screenShakeIntensity', label: 'Screen shake intensity', type: 'range', min: 0, max: 3, step: 0.1, default: 1 },
      { key: 'showDamageNumbers', label: 'Show damage numbers', type: 'checkbox', default: true },
      { key: 'soundVolume', label: 'Hit sound volume', type: 'range', min: 0, max: 1, step: 0.1, default: 0.8 }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.state.lastDamageTime = 0
      ctx.state.damageQueue = []

      ctx.bus.on('damage', (event) => {
        const { by, target, amount, position, direction } = event
        if (target !== ctx.entity.id) return

        ctx.state.lastDamageTime = Date.now()
        ctx.state.damageQueue.push({
          amount: amount || 0,
          position: position || ctx.entity.position,
          direction: direction || null,
          by: by || null,
          timestamp: Date.now()
        })

        const payload = {
          damage: {
            amount: amount || 0,
            position: position || [ctx.entity.position.x, ctx.entity.position.y, ctx.entity.position.z],
            direction: direction || null,
            from: by || null,
            config: {
              screenShakeIntensity: c.screenShakeIntensity ?? 1,
              showDamageNumbers: c.showDamageNumbers !== false,
              soundVolume: c.soundVolume ?? 0.8
            }
          }
        }

        ctx.bus.emit('hit-feedback', payload)

        if (ctx.physics?.applyImpulse && direction) {
          const impulseScale = (amount || 0) / 10
          ctx.physics.applyImpulse({
            x: (direction.x || 0) * impulseScale,
            y: 0,
            z: (direction.z || 0) * impulseScale
          })
        }
      })

      ctx.bus.on('heal', (event) => {
        const { target, amount } = event
        if (target !== ctx.entity.id) return

        ctx.bus.emit('heal-feedback', {
          heal: {
            amount: amount || 0,
            position: [ctx.entity.position.x, ctx.entity.position.y, ctx.entity.position.z]
          }
        })
      })

      ctx.onConfigChange?.((cfg) => {
        if (cfg) {
          c.screenShakeIntensity = cfg.screenShakeIntensity ?? c.screenShakeIntensity
          c.showDamageNumbers = cfg.showDamageNumbers !== false
          c.soundVolume = cfg.soundVolume ?? 0.8
        }
      })
    }
  },
  client: {
    setup(ctx, entities) {
      const c = ctx.config || {}
      let damageEffects = null
      let damageNumbersComponent = null

      ctx.bus.on('hit-feedback', (event) => {
        const { damage } = event
        if (!damageEffects) return

        const worldPos = damage.position ? {
          x: damage.position[0],
          y: damage.position[1],
          z: damage.position[2]
        } : null

        damageEffects.triggerDamage(damage.amount, worldPos, {
          hitDirection: damage.direction,
          soundVolume: damage.config?.soundVolume ?? 0.8,
          screenShakeIntensity: damage.config?.screenShakeIntensity ?? 1,
          showNumbers: damage.config?.showDamageNumbers !== false
        })

        if (damageNumbersComponent && damage.config?.showDamageNumbers !== false) {
          const DamageNumbers = window.__DamageNumbers
          if (DamageNumbers && typeof DamageNumbers.addNumber === 'function') {
            const color = damage.amount > 25 ? '#ff0000' : '#ff4444'
            const size = 32 + (damage.amount / 10)
            DamageNumbers.addNumber({
              damage: damage.amount,
              position: worldPos,
              color,
              size
            })
          }
        }
      })

      ctx.bus.on('heal-feedback', (event) => {
        const { heal } = event
        if (!damageNumbersComponent) return

        const worldPos = heal.position ? {
          x: heal.position[0],
          y: heal.position[1],
          z: heal.position[2]
        } : null

        const DamageNumbers = window.__DamageNumbers
        if (DamageNumbers && typeof DamageNumbers.addNumber === 'function') {
          DamageNumbers.addNumber({
            damage: heal.amount,
            position: worldPos,
            color: '#00ff00',
            size: 28,
            isHeal: true
          })
        }
      })

      return {
        onUpdate(dt) {
          if (damageEffects && typeof damageEffects.update === 'function') {
            damageEffects.update()
          }
        },
        onClientRender(renderContext) {
          if (!damageEffects && renderContext.scene && renderContext.camera) {
            try {
              const DamageEffectsModule = window.__damageEffects || {}
              if (DamageEffectsModule.createDamageEffects) {
                damageEffects = DamageEffectsModule.createDamageEffects(
                  renderContext.scene,
                  renderContext.camera,
                  renderContext.audioListener,
                  c
                )
              }
            } catch (_) {}
          }

          if (!damageNumbersComponent && window.__DamageNumbers) {
            damageNumbersComponent = window.__DamageNumbers
          }
        }
      }
    }
  }
}
