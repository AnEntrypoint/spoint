export const STARVED_NEUTRAL_KEEPS_HORIZONTAL_VELOCITY = false

export function holdStarvedNeutralVelocity(velocity) {
  if (STARVED_NEUTRAL_KEEPS_HORIZONTAL_VELOCITY) return velocity
  velocity[0] = 0
  velocity[2] = 0
  return velocity
}
