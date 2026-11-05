function requirePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
  return value;
}

export function elevation(speed, g, distance, rise) {
  requirePositive(speed, 'speed');
  requirePositive(g, 'g');
  if (!Number.isFinite(distance) || distance < 0) throw new RangeError('distance must be a finite number >= 0');
  if (!Number.isFinite(rise)) throw new RangeError('rise must be a finite number');
  if (distance === 0) return null;
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * distance * distance + 2 * rise * v2);
  if (disc < 0) return null;
  return Math.atan((v2 - Math.sqrt(disc)) / (g * distance));
}

export function solveShot(from, to, speed, g) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  const theta = elevation(speed, g, distance, to.y - from.y);
  if (theta === null) return null;
  const horizontal = speed * Math.cos(theta);
  return {
    vel: { x: (dx / distance) * horizontal, y: speed * Math.sin(theta), z: (dz / distance) * horizontal },
    time: distance / horizontal,
  };
}
