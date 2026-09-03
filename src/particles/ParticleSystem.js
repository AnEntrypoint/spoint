import { ParticlePool } from './ParticlePool.js';
import { ParticleRenderer } from '../rendering/ParticleRenderer.js';
import { EffectLibrary } from './EffectLibrary.js';

export class ParticleSystem {
  constructor(scene, camera, config = {}) {
    this.scene = scene;
    this.camera = camera;

    this.pool = new ParticlePool(config.maxPoolSize ?? 5000);
    this.renderer = new ParticleRenderer(scene, camera, config.renderConfig ?? {});

    this.emitters = new Map();
    this.activeEmitters = [];
    this.particleSimulationCount = 0;

    this.gravity = config.gravity ?? [0, -9.8, 0];
    this.collisionHandlers = [];

    this.enableNetworkSync = config.enableNetworkSync ?? false;
    this.networkBroadcastInterval = config.networkBroadcastInterval ?? 1;
    this.networkBroadcastTimer = 0;

    this.rng = this.makeSeededRandom(config.seed ?? Math.random());
  }

  registerEmitter(id, emitter) {
    this.emitters.set(id, {
      emitter,
      particles: [],
      dirty: true
    });
  }

  unregisterEmitter(id) {
    const entry = this.emitters.get(id);
    if (entry) {
      entry.particles.forEach(p => this.pool.release(p));
      this.emitters.delete(id);
    }
  }

  spawnEffect(effectType, position, config = {}) {
    const emitter = EffectLibrary[`create${effectType.charAt(0).toUpperCase() + effectType.slice(1)}`]?.(config);
    if (!emitter) return null;

    emitter.setPosition(position[0], position[1], position[2]);

    const id = `${effectType}_${Date.now()}_${Math.random()}`;
    this.registerEmitter(id, emitter);

    return id;
  }

  onCollision(emitterConfig) {
    this.collisionHandlers.push(emitterConfig);
  }

  update(dt, worldColliders = []) {
    this.activeEmitters.length = 0;
    this.particleSimulationCount = 0;

    for (const [id, entry] of this.emitters) {
      const { emitter, particles } = entry;

      emitter.update(dt);

      const emission = emitter.update(dt);
      if (emission && emission.count > 0) {
        const newParticles = emitter.spawn(this.pool, emission.count);
        particles.push(...newParticles);
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        if (!p.active) {
          this.pool.release(p);
          particles.splice(i, 1);
          continue;
        }

        p.age += dt;

        const t = Math.min(p.age / Math.max(p.lifetime, 0.01), 1);

        p.velocity[0] -= (p.velocity[0] * emitter.drag) * dt;
        p.velocity[1] -= (p.velocity[1] * emitter.drag) * dt;
        p.velocity[2] -= (p.velocity[2] * emitter.drag) * dt;

        p.velocity[0] += emitter.gravity[0] * dt;
        p.velocity[1] += emitter.gravity[1] * dt;
        p.velocity[2] += emitter.gravity[2] * dt;

        p.position[0] += p.velocity[0] * dt;
        p.position[1] += p.velocity[1] * dt;
        p.position[2] += p.velocity[2] * dt;

        p.rotation += p.angularVelocity * dt;

        if (emitter.sizeOverLifetime) {
          p.size = emitter.sizeOverLifetime(t);
        }

        if (emitter.colorOverLifetime) {
          emitter.colorOverLifetime(t, p.color);
        }

        if (t >= 1) {
          p.active = false;
        }

        this.particleSimulationCount++;
      }

      if (particles.length > 0) {
        this.activeEmitters.push(entry);
      } else if (emitter.active && !this.isEmitterStillEmitting(emitter)) {
        this.unregisterEmitter(id);
      }
    }

    const allParticles = [];
    this.activeEmitters.forEach(entry => allParticles.push(...entry.particles));

    this.renderer.update(allParticles, this.camera);

    if (this.enableNetworkSync) {
      this.networkBroadcastTimer += dt;
      if (this.networkBroadcastTimer >= this.networkBroadcastInterval) {
        this.networkBroadcastTimer = 0;
        this.broadcastEmitterStates();
      }
    }
  }

  isEmitterStillEmitting(emitter) {
    if (emitter.mode === 'burst') {
      return false;
    }
    return emitter.active && emitter.emissionTime < 10;
  }

  simulateParticles(particles, dt) {
    for (const p of particles) {
      if (!p.active) continue;

      p.age += dt;
      const t = Math.min(p.age / Math.max(p.lifetime, 0.01), 1);

      p.velocity[0] += (this.gravity[0] ?? 0) * dt;
      p.velocity[1] += (this.gravity[1] ?? -9.8) * dt;
      p.velocity[2] += (this.gravity[2] ?? 0) * dt;

      p.position[0] += p.velocity[0] * dt;
      p.position[1] += p.velocity[1] * dt;
      p.position[2] += p.velocity[2] * dt;

      if (t >= 1) {
        p.active = false;
      }
    }
  }

  broadcastEmitterStates() {
    const emitterStates = [];

    for (const [id, entry] of this.emitters) {
      const { emitter } = entry;
      emitterStates.push({
        id,
        position: [emitter.position.x, emitter.position.y, emitter.position.z],
        seed: emitter.seed,
        emittedCount: emitter.emittedCount
      });
    }

    if (emitterStates.length > 0) {
      this.onEmitterStatesBroadcast?.(emitterStates);
    }
  }

  syncEmitterState(id, state) {
    let entry = this.emitters.get(id);

    if (!entry) {
      const tempEmitter = {
        position: { x: state.position[0], y: state.position[1], z: state.position[2] },
        velocity: { x: 0, y: 0, z: 0 },
        active: true,
        spawn: () => []
      };
      this.registerEmitter(id, tempEmitter);
      entry = this.emitters.get(id);
    }

    entry.emitter.setPosition(state.position[0], state.position[1], state.position[2]);
    entry.emitter.seed = state.seed;
    entry.emitter.emittedCount = state.emittedCount;
  }

  makeSeededRandom(seed) {
    const x = Math.sin(seed) * 10000;
    let index = 0;
    return () => {
      const val = Math.sin(x + index) * 10000;
      index += 0.1;
      return val - Math.floor(val);
    };
  }

  getStats() {
    return {
      emitterCount: this.emitters.size,
      particleCount: this.pool.getActiveCount(),
      simCount: this.particleSimulationCount,
      poolSize: this.pool.maxSize,
      activeEmitters: this.activeEmitters.length
    };
  }

  clear() {
    this.emitters.clear();
    this.activeEmitters.length = 0;
    this.pool.clear();
  }

  dispose() {
    this.clear();
    this.renderer.dispose();
  }
}
