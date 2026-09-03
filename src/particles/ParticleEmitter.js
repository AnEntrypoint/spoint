import { Vector3, Quaternion } from 'three';

export const EmitterShapeType = {
  POINT: 'point',
  SPHERE: 'sphere',
  BOX: 'box',
  CONE: 'cone'
};

export const EmitterMode = {
  BURST: 'burst',
  CONTINUOUS: 'continuous'
};

export class ParticleEmitter {
  constructor(config = {}) {
    this.position = new Vector3(
      config.position?.[0] ?? 0,
      config.position?.[1] ?? 0,
      config.position?.[2] ?? 0
    );
    this.velocity = new Vector3(
      config.velocity?.[0] ?? 0,
      config.velocity?.[1] ?? 0,
      config.velocity?.[2] ?? 0
    );
    this.rotation = new Quaternion();

    this.mode = config.mode ?? EmitterMode.BURST;
    this.shapeType = config.shapeType ?? EmitterShapeType.POINT;
    this.shapeSize = config.shapeSize ?? [1, 1, 1];
    this.shapeAngle = config.shapeAngle ?? 45;

    this.spawnRate = config.spawnRate ?? 100;
    this.burstCount = config.burstCount ?? 100;
    this.lifetime = config.lifetime ?? 1;
    this.lifetimeVariance = config.lifetimeVariance ?? 0;

    this.initialVelocity = config.initialVelocity ?? [0, 1, 0];
    this.velocityVariance = config.velocityVariance ?? [0.5, 0.5, 0.5];
    this.velocityRandomness = config.velocityRandomness ?? 0.1;

    this.gravity = config.gravity ?? [0, -9.8, 0];
    this.drag = config.drag ?? 0.01;
    this.angularVelocity = config.angularVelocity ?? 0;
    this.angularVelocityVariance = config.angularVelocityVariance ?? 0.5;

    this.startSize = config.startSize ?? 0.1;
    this.endSize = config.endSize ?? 0.05;
    this.sizeOverLifetime = config.sizeOverLifetime ?? this.defaultSizeOverLifetime;

    this.startColor = config.startColor ?? [255, 255, 255, 255];
    this.endColor = config.endColor ?? [255, 255, 255, 0];
    this.colorOverLifetime = config.colorOverLifetime ?? this.defaultColorOverLifetime;

    this.active = config.active ?? true;
    this.emissionTime = 0;
    this.emittedCount = 0;
    this.seed = config.seed ?? Math.random();
  }

  defaultSizeOverLifetime(t) {
    return this.startSize * (1 - t) + this.endSize * t;
  }

  defaultColorOverLifetime(t, color) {
    for (let i = 0; i < 4; i++) {
      color[i] = Math.round(
        this.startColor[i] * (1 - t) + this.endColor[i] * t
      );
    }
  }

  spawn(pool, count = 1) {
    const particles = [];

    for (let i = 0; i < count; i++) {
      const particle = pool.acquire(this.shapeType);
      if (!particle) break;

      const localPos = this.getShapePoint();
      particle.position[0] = this.position.x + localPos[0];
      particle.position[1] = this.position.y + localPos[1];
      particle.position[2] = this.position.z + localPos[2];

      const velocity = this.getInitialVelocity();
      particle.velocity[0] = velocity[0];
      particle.velocity[1] = velocity[1];
      particle.velocity[2] = velocity[2];

      particle.acceleration[0] = this.gravity[0];
      particle.acceleration[1] = this.gravity[1];
      particle.acceleration[2] = this.gravity[2];

      particle.age = 0;
      particle.lifetime = this.lifetime + (Math.random() - 0.5) * 2 * this.lifetimeVariance;
      particle.lifetime = Math.max(0.01, particle.lifetime);

      particle.size = this.startSize;

      this.startColor.forEach((c, i) => {
        particle.color[i] = Math.round(c);
      });

      particle.rotation = Math.random() * Math.PI * 2;
      particle.angularVelocity = (Math.random() - 0.5) * 2 * this.angularVelocity;

      particles.push(particle);
    }

    return particles;
  }

  getShapePoint() {
    const seededRandom = this.makeSeededRandom(this.seed + this.emittedCount);

    switch (this.shapeType) {
      case EmitterShapeType.SPHERE:
        return this.getRandomSpherePoint(seededRandom);
      case EmitterShapeType.BOX:
        return this.getRandomBoxPoint(seededRandom);
      case EmitterShapeType.CONE:
        return this.getRandomConePoint(seededRandom);
      case EmitterShapeType.POINT:
      default:
        return [0, 0, 0];
    }
  }

  getRandomSpherePoint(random) {
    const radius = this.shapeSize[0] * random();
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);

    return [
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi)
    ];
  }

  getRandomBoxPoint(random) {
    return [
      (random() - 0.5) * this.shapeSize[0] * 2,
      (random() - 0.5) * this.shapeSize[1] * 2,
      (random() - 0.5) * this.shapeSize[2] * 2
    ];
  }

  getRandomConePoint(random) {
    const radius = this.shapeSize[0] * Math.sqrt(random());
    const theta = random() * Math.PI * 2;
    const angle = (this.shapeAngle * Math.PI) / 180;
    const height = this.shapeSize[1] * random();

    return [
      radius * Math.cos(theta),
      height,
      radius * Math.sin(theta)
    ];
  }

  getInitialVelocity() {
    const seededRandom = this.makeSeededRandom(this.seed + this.emittedCount * 1.5);

    const baseVel = [...this.initialVelocity];
    const variance = this.velocityVariance;

    baseVel[0] += (seededRandom() - 0.5) * 2 * variance[0];
    baseVel[1] += (seededRandom() - 0.5) * 2 * variance[1];
    baseVel[2] += (seededRandom() - 0.5) * 2 * variance[2];

    this.emittedCount++;
    return baseVel;
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

  update(dt) {
    if (!this.active) return;

    this.emissionTime += dt;

    if (this.mode === EmitterMode.BURST && this.emissionTime > 0 && !this.burstEmitted) {
      this.burstEmitted = true;
      return { mode: 'burst', count: this.burstCount };
    }

    if (this.mode === EmitterMode.CONTINUOUS) {
      const toEmit = Math.floor(this.spawnRate * dt);
      if (toEmit > 0) {
        return { mode: 'continuous', count: toEmit };
      }
    }

    return null;
  }

  setPosition(x, y, z) {
    this.position.set(x, y, z);
  }

  setVelocity(x, y, z) {
    this.velocity.set(x, y, z);
  }

  setActive(active) {
    this.active = active;
    if (!active) {
      this.burstEmitted = false;
    }
  }
}
