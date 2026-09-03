export class Particle {
  constructor() {
    this.position = new Float32Array(3);
    this.velocity = new Float32Array(3);
    this.acceleration = new Float32Array(3);
    this.color = new Uint8Array(4);
    this.size = 1;
    this.age = 0;
    this.lifetime = 1;
    this.rotation = 0;
    this.angularVelocity = 0;
    this.active = false;
  }

  reset() {
    this.position[0] = this.position[1] = this.position[2] = 0;
    this.velocity[0] = this.velocity[1] = this.velocity[2] = 0;
    this.acceleration[0] = this.acceleration[1] = this.acceleration[2] = 0;
    this.color[0] = this.color[1] = this.color[2] = 255;
    this.color[3] = 255;
    this.size = 1;
    this.age = 0;
    this.lifetime = 1;
    this.rotation = 0;
    this.angularVelocity = 0;
    this.active = false;
  }
}

export class ParticlePool {
  constructor(initialSize = 1000) {
    this.particles = [];
    this.activeCount = 0;
    this.maxSize = initialSize;
    this.typeGroups = new Map();

    for (let i = 0; i < initialSize; i++) {
      this.particles.push(new Particle());
    }
  }

  acquire(type = 'default') {
    if (this.activeCount >= this.particles.length) {
      this.expand();
    }

    const particle = this.particles[this.activeCount];
    this.activeCount++;
    particle.active = true;

    if (!this.typeGroups.has(type)) {
      this.typeGroups.set(type, []);
    }
    this.typeGroups.get(type).push(particle);

    return particle;
  }

  release(particle) {
    if (!particle.active) return;

    particle.reset();

    for (const [type, group] of this.typeGroups) {
      const idx = group.indexOf(particle);
      if (idx !== -1) {
        group.splice(idx, 1);
        break;
      }
    }

    const lastIdx = this.activeCount - 1;
    const lastParticle = this.particles[lastIdx];

    const currentIdx = this.particles.indexOf(particle);
    if (currentIdx !== lastIdx) {
      this.particles[currentIdx] = lastParticle;
      this.particles[lastIdx] = particle;
    }

    this.activeCount--;
  }

  expand() {
    const newSize = Math.floor(this.maxSize * 1.5);
    const addCount = newSize - this.maxSize;

    for (let i = 0; i < addCount; i++) {
      this.particles.push(new Particle());
    }

    this.maxSize = newSize;
  }

  shrink() {
    if (this.activeCount < this.maxSize * 0.25 && this.maxSize > 1000) {
      const newSize = Math.max(1000, Math.floor(this.maxSize * 0.75));
      this.particles.length = newSize;
      this.maxSize = newSize;
    }
  }

  getActiveParticles() {
    return this.particles.slice(0, this.activeCount);
  }

  getActiveCount() {
    return this.activeCount;
  }

  clear() {
    for (let i = 0; i < this.activeCount; i++) {
      this.particles[i].reset();
    }
    this.activeCount = 0;
    this.typeGroups.clear();
  }
}
