export const CHASE_CAMERA_DEFAULTS = Object.freeze({
  dist: 7,
  height: 3.7,
  aim: 1.4,
  headingRate: 5,
  recenterRate: 1.5,
  restSeconds: 0.35,
});

export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function createChaseCamera(options = {}) {
  const cfg = { ...CHASE_CAMERA_DEFAULTS, ...options };
  let heading = null;
  let bias = 0;
  let lastLookYaw = 0;
  let restFor = 0;

  function update(dt, hullYaw, feet, look) {
    if (heading === null) heading = hullYaw;
    heading = wrapAngle(heading + wrapAngle(hullYaw - heading) * (1 - Math.exp(-cfg.headingRate * dt)));

    if (look.yaw !== lastLookYaw) {
      lastLookYaw = look.yaw;
      restFor = 0;
    } else {
      restFor += dt;
    }
    if (restFor > cfg.restSeconds) {
      bias = wrapAngle(bias + lastLookYaw) * Math.exp(-cfg.recenterRate * dt) - lastLookYaw;
    }

    const base = heading + bias;
    const yaw = base + lastLookYaw;
    const cp = Math.cos(look.pitch);
    return {
      frameYaw: base,
      eye: {
        x: feet.x + Math.sin(yaw) * cp * cfg.dist,
        y: feet.y + cfg.height - Math.sin(look.pitch) * cfg.dist,
        z: feet.z + Math.cos(yaw) * cp * cfg.dist,
      },
      lookAt: { x: feet.x, y: feet.y + cfg.aim, z: feet.z },
    };
  }

  return { update };
}
