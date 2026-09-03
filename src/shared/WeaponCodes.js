// Compact equipped-weapon wire code (animation-weapon-signal-clientside-wiring).
//
// WHY: PlayerAnimator.setWeapon(name) (animation-aim-ik-camera-pitch-layer) and the WEAPON_AIM_POSES
// trio-selection mechanism it drives were built and unit-verified via direct animator calls, but until
// this file existed there was zero network representation of "what weapon is this player actually
// holding right now" -- every character rendered permanently on the WEAPON_AIM_POSES default ('Pistol')
// regardless of real server-side equip state. This table is the single source of truth both ends of the
// wire share: server-authoritative equip state (AppRuntime.setPlayerWeapon) stores a plain u8 code on
// the player's tick state (TickHandler.js st.weapon, mirroring st.crouch/st.expr) and rebroadcasts it
// verbatim on the FULL player wire record (SnapshotEncoder.js encodePlayer, next slot after expr). Every
// connected client (including the equipped player's own, for a consistent first-person view of its own
// held weapon) decodes the code back to a weapon NAME via codeToWeaponName and calls
// anim.setWeapon(name) in tickPlayerAnimators (client/app.js) -- the exact same entrypoint the parent
// row already built and exposed.
//
// Dual-imported (server TickHandler.js/AppRuntime.js + client app.js), same discipline as
// src/shared/vecGuard.js -- pure data + two tiny lookup functions, zero DOM/Node-only API surface.
//
// u8 code (not a raw string) for the same reason ExpressionCodes.js picked one: keeps the FULL player
// wire record a fixed-shape array of small numbers, avoids a variable-length string slot bloating every
// snapshot for every player every tick. 0 is UNARMED (matches the AnimationStateMachine.WEAPON_AIM_POSES
// contract of "no trio resolved" -- see PlayerAnimator._resolveAimTrio's null-safe fallback to the flat
// spine-pitch split), not a floor value that could collide with a real weapon slot.
export const WEAPON_UNARMED = 0
export const WEAPON_PISTOL = 1
// WEAPON_RIFLE now HAS a real WEAPON_AIM_POSES trio (animation-weapon-2nd-aim-clip-trio-authoring row
// baked RifleAimDown/Neutral/Up@4 pose clips into anim-lib.glb, distinct from the Pistol trio's
// one-handed stance) -- equipping it exercises PlayerAnimator._resolveAimTrio's real trio-RESOLVED
// branch with its own visually distinct pose, not just the graceful "no trio" fallback the code alone
// used to exercise before this row shipped.
export const WEAPON_RIFLE = 2

const CODE_TO_NAME = {
  [WEAPON_UNARMED]: null,
  [WEAPON_PISTOL]: 'Pistol',
  [WEAPON_RIFLE]: 'Rifle'
}
const NAME_TO_CODE = {
  Pistol: WEAPON_PISTOL,
  Rifle: WEAPON_RIFLE
}

export function weaponNameToCode(name) { return NAME_TO_CODE[name] ?? WEAPON_UNARMED }
// null (not 'Pistol'/a made-up default) for WEAPON_UNARMED -- callers (PlayerAnimator.setWeapon) already
// no-op-guard a falsy name, so an unarmed player correctly keeps whatever trio it last resolved rather
// than this table silently picking one for it.
export function codeToWeaponName(code) { return CODE_TO_NAME[code] ?? null }

export const WEAPON_CODE_COUNT = 8   // wire budget: 2 used today (Pistol/Rifle) + UNARMED, room to grow within one u8 byte
