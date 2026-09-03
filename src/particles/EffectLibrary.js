import { ParticleEmitter, EmitterShapeType, EmitterMode } from './ParticleEmitter.js';
import { BlendMode } from '../rendering/ParticleRenderer.js';

export class EffectLibrary {
  static createExplosion(config = {}) {
    const baseConfig = {
      shapeType: EmitterShapeType.SPHERE,
      shapeSize: [config.radius ?? 0.5, 0.5, 0.5],
      mode: EmitterMode.BURST,
      burstCount: config.particleCount ?? 100,
      lifetime: 1.5,
      lifetimeVariance: 0.3,
      initialVelocity: [0, 2, 0],
      velocityVariance: [3, 1, 3],
      gravity: [0, -5, 0],
      drag: 0.02,
      startSize: config.startSize ?? 0.2,
      endSize: config.endSize ?? 0.02,
      startColor: config.startColor ?? [255, 200, 100, 255],
      endColor: config.endColor ?? [255, 100, 50, 0],
      ...config
    };

    return new ParticleEmitter(baseConfig);
  }

  static createImpact(config = {}) {
    const baseConfig = {
      shapeType: EmitterShapeType.CONE,
      shapeSize: [config.spread ?? 1, 0.2, 1],
      shapeAngle: 30,
      mode: EmitterMode.BURST,
      burstCount: config.particleCount ?? 50,
      lifetime: 0.8,
      lifetimeVariance: 0.2,
      initialVelocity: config.direction ?? [0, 1, 0],
      velocityVariance: [1, 0.5, 1],
      gravity: [0, -8, 0],
      drag: 0.05,
      startSize: config.startSize ?? 0.15,
      endSize: config.endSize ?? 0.02,
      startColor: config.startColor ?? [200, 150, 100, 255],
      endColor: config.endColor ?? [100, 75, 50, 0],
      ...config
    };

    return new ParticleEmitter(baseConfig);
  }

  static createFire(config = {}) {
    const baseConfig = {
      shapeType: EmitterShapeType.BOX,
      shapeSize: [config.size ?? 0.3, 0.1, 0.3],
      mode: EmitterMode.CONTINUOUS,
      spawnRate: config.spawnRate ?? 200,
      lifetime: 1.5,
      lifetimeVariance: 0.3,
      initialVelocity: [0, 1.5, 0],
      velocityVariance: [0.3, 0.2, 0.3],
      gravity: [0, -0.5, 0],
      drag: 0.01,
      angularVelocity: Math.PI * 2,
      angularVelocityVariance: Math.PI * 4,
      startSize: config.startSize ?? 0.25,
      endSize: config.endSize ?? 0.05,
      startColor: config.startColor ?? [255, 200, 50, 255],
      endColor: config.endColor ?? [255, 100, 50, 0],
      ...config
    };

    return new ParticleEmitter(baseConfig);
  }

  static createSmoke(config = {}) {
    const baseConfig = {
      shapeType: EmitterShapeType.SPHERE,
      shapeSize: [config.radius ?? 0.2, 0.2, 0.2],
      mode: EmitterMode.CONTINUOUS,
      spawnRate: config.spawnRate ?? 100,
      lifetime: 2,
      lifetimeVariance: 0.4,
      initialVelocity: [0, 0.5, 0],
      velocityVariance: [0.2, 0.1, 0.2],
      gravity: [0, -0.2, 0],
      drag: 0.005,
      startSize: config.startSize ?? 0.3,
      endSize: config.endSize ?? 0.8,
      startColor: config.startColor ?? [150, 150, 150, 200],
      endColor: config.endColor ?? [100, 100, 100, 0],
      ...config
    };

    return new ParticleEmitter(baseConfig);
  }

  static createSparks(config = {}) {
    const baseConfig = {
      shapeType: EmitterShapeType.POINT,
      mode: EmitterMode.BURST,
      burstCount: config.particleCount ?? 80,
      lifetime: 0.5,
      lifetimeVariance: 0.1,
      initialVelocity: [0, 2, 0],
      velocityVariance: [2, 1, 2],
      gravity: [0, -15, 0],
      drag: 0.1,
      angularVelocity: Math.PI * 4,
      angularVelocityVariance: Math.PI * 8,
      startSize: config.startSize ?? 0.08,
      endSize: config.endSize ?? 0.01,
      startColor: config.startColor ?? [255, 220, 100, 255],
      endColor: config.endColor ?? [255, 100, 0, 0],
      ...config
    };

    return new ParticleEmitter(baseConfig);
  }

  static createBlood(config = {}) {
    const baseConfig = {
      shapeType: EmitterShapeType.CONE,
      shapeSize: [config.spread ?? 0.5, 0.1, 0.5],
      shapeAngle: 45,
      mode: EmitterMode.BURST,
      burstCount: config.particleCount ?? 40,
      lifetime: 1.2,
      lifetimeVariance: 0.2,
      initialVelocity: config.direction ?? [0, 1, 0],
      velocityVariance: [1.5, 0.5, 1.5],
      gravity: [0, -8, 0],
      drag: 0.03,
      startSize: config.startSize ?? 0.12,
      endSize: config.endSize ?? 0.03,
      startColor: config.startColor ?? [180, 20, 30, 255],
      endColor: config.endColor ?? [100, 10, 10, 0],
      ...config
    };

    return new ParticleEmitter(baseConfig);
  }

  static createWaterSplash(config = {}) {
    const baseConfig = {
      shapeType: EmitterShapeType.SPHERE,
      shapeSize: [config.radius ?? 0.3, 0.3, 0.3],
      mode: EmitterMode.BURST,
      burstCount: config.particleCount ?? 60,
      lifetime: 1,
      lifetimeVariance: 0.2,
      initialVelocity: [0, 2, 0],
      velocityVariance: [1.5, 0.8, 1.5],
      gravity: [0, -9.8, 0],
      drag: 0.05,
      startSize: config.startSize ?? 0.1,
      endSize: config.endSize ?? 0.02,
      startColor: config.startColor ?? [100, 150, 200, 200],
      endColor: config.endColor ?? [50, 100, 150, 0],
      ...config
    };

    return new ParticleEmitter(baseConfig);
  }

  static createDust(config = {}) {
    const baseConfig = {
      shapeType: EmitterShapeType.BOX,
      shapeSize: [config.width ?? 0.5, 0.1, config.width ?? 0.5],
      mode: EmitterMode.CONTINUOUS,
      spawnRate: config.spawnRate ?? 50,
      lifetime: 2.5,
      lifetimeVariance: 0.5,
      initialVelocity: [0, 0.3, 0],
      velocityVariance: [0.4, 0.2, 0.4],
      gravity: [0, -0.3, 0],
      drag: 0.002,
      startSize: config.startSize ?? 0.2,
      endSize: config.endSize ?? 0.6,
      startColor: config.startColor ?? [180, 160, 140, 150],
      endColor: config.endColor ?? [120, 100, 80, 0],
      ...config
    };

    return new ParticleEmitter(baseConfig);
  }

  static getRenderConfig(effectType) {
    const configs = {
      explosion: {
        blendMode: BlendMode.ADDITIVE,
        lodDistance: 150,
        lodFactor: 0.7
      },
      impact: {
        blendMode: BlendMode.NORMAL,
        lodDistance: 100,
        lodFactor: 0.6
      },
      fire: {
        blendMode: BlendMode.ADDITIVE,
        lodDistance: 200,
        lodFactor: 0.5
      },
      smoke: {
        blendMode: BlendMode.NORMAL,
        lodDistance: 300,
        lodFactor: 0.4
      },
      sparks: {
        blendMode: BlendMode.ADDITIVE,
        lodDistance: 150,
        lodFactor: 0.6
      },
      blood: {
        blendMode: BlendMode.NORMAL,
        lodDistance: 50,
        lodFactor: 0.8
      },
      water: {
        blendMode: BlendMode.NORMAL,
        lodDistance: 100,
        lodFactor: 0.6
      },
      dust: {
        blendMode: BlendMode.NORMAL,
        lodDistance: 250,
        lodFactor: 0.5
      }
    };

    return configs[effectType] ?? configs.explosion;
  }
}
