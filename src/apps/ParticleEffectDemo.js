import { ParticleSystem } from '../particles/ParticleSystem.js';
import { EffectLibrary } from '../particles/EffectLibrary.js';

export async function setupParticleEffectDemo(ctx) {
  const { scene, camera, renderer } = ctx.getRenderContext?.();
  if (!scene || !camera || !renderer) {
    console.warn('ParticleEffectDemo: render context not available');
    return;
  }

  const particleSystem = new ParticleSystem(scene, camera, {
    maxPoolSize: 5000,
    enableNetworkSync: true,
    seed: Math.random()
  });

  const demoState = {
    particleSystem,
    activeEffects: new Map(),
    spawnLocation: [0, 2, 0],
    effectType: 'explosion'
  };

  const spawnEffect = (type, position = demoState.spawnLocation) => {
    const config = {
      particleCount: 100,
      startSize: 0.2,
      endSize: 0.02
    };

    const effectId = particleSystem.spawnEffect(type, position, config);
    if (effectId) {
      demoState.activeEffects.set(effectId, {
        type,
        spawnTime: performance.now()
      });

      console.log(`Spawned ${type} effect at`, position);
    }
  };

  const updateLoop = (dt) => {
    particleSystem.update(dt);

    const stats = particleSystem.getStats();
    if (ctx.updateDebugPanel) {
      ctx.updateDebugPanel?.({
        particleStats: {
          emitters: stats.emitterCount,
          particles: stats.particleCount,
          simulated: stats.simCount,
          poolSize: stats.poolSize
        }
      });
    }
  };

  ctx.on?.('update', updateLoop);

  ctx.on?.('input', (input) => {
    if (input.key === ' ') {
      spawnEffect('explosion', demoState.spawnLocation);
    }
    if (input.key === '1') spawnEffect('fire', demoState.spawnLocation);
    if (input.key === '2') spawnEffect('smoke', demoState.spawnLocation);
    if (input.key === '3') spawnEffect('sparks', demoState.spawnLocation);
    if (input.key === '4') spawnEffect('impact', demoState.spawnLocation);
    if (input.key === 'e') spawnEffect('explosion', demoState.spawnLocation);
  });

  return {
    spawnEffect,
    getStats: () => particleSystem.getStats(),
    dispose: () => {
      ctx.off?.('update', updateLoop);
      particleSystem.dispose();
    }
  };
}

export default {
  name: 'ParticleEffectDemo',
  description: 'Interactive particle effect demonstration',
  version: '1.0.0',
  init: setupParticleEffectDemo,
  defaultConfig: {
    maxPoolSize: 5000,
    enableNetworkSync: false
  }
};
