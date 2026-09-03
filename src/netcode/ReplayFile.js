import { pack, unpack } from '../protocol/msgpack.js'

// .spointreplay file format
//
// A replay is a single msgpack-encoded envelope:
//   {
//     magic: 'spointreplay',
//     version: 1 | 2,
//     header: {
//       worldName: string,           // world def name/path used to boot the session (server.loadWorld input)
//       tickRate: number,            // ticks/sec the session ran at -- playback must use the SAME tickRate
//       startTick: number,           // first tick a real input/event was recorded at (usually the tick right after boot)
//       endTick: number,             // last tick recorded
//       recordedAt: number,          // Date.now() at record start
//       collisionSteps: number,      // v2+: World.js's step(dt, collisionSteps) param actually used while recording
//       players: [{ id, name, spawn: {position,rotation,health} }],  // per-player initial join state, in join order
//     },
//     inputs: [ { tick, playerId, sequence, data } ],   // every real per-tick input actually applied to a player,
//                                                        // in the SAME order TickHandler.processPlayerMovement consumed them
//     ticks: [ { tick, dt } ],       // v2+: the REAL per-tick dt TickHandler.onTick received while recording
//                                     // (src/netcode/TickSystem.js's dilationFactor-derived, real-load-adaptive,
//                                     // wall-clock-driven value -- NOT a constant 1/tickRate). Empty on a v1 file
//                                     // or an env captured with no ReplayRecorder tick hook.
//     events: [ ... ],               // the session's EventLog._toArray() snapshot (bus events, spawns/destroys,
//                                     // anticheat flags, etc) -- context/audit trail, replayed via EventLog.replay
//   }
//
// Determinism scope (honest, matches the spointreplay-file-format-deterministic-playback PRD row and the
// deterministic-simulation-jolt-fixed-point-rollback probe that split off this row): the probe found Jolt's
// own solver is bit-exact for same-process/same-build/same-input replay (5/5 runs, zero divergence) -- the
// real, measured replay-drift source was never Jolt, it was TickSystem's real-load-adaptive dilationFactor
// producing a DIFFERENT dt sequence on replay than during recording (a single-tick 1e-6 relative dt
// perturbation alone measured a 0.75mm divergence; a realistic 50-tick 10% dilation dip measured 25cm).
// v2 closes that gap: the recorder captures the EXACT per-tick dt (and collisionSteps) the session actually
// ran, and ReplayPlayer drives physics.step/appRuntime.tick/etc with those exact recorded values instead of
// letting a fresh TickSystem re-derive its own wall-clock/load-dependent dt on replay. This still does NOT
// guarantee bit-exact Jolt physics across different OS/CPU-arch/compiler WASM builds -- that is the separate,
// harder, unprobed deterministic-simulation-cross-platform-probe row. Same-machine/same-build replay is now
// driven by the exact recorded input+dt+collisionSteps sequence through the real production tick handler
// (not a mock), which is the strongest same-build reproduction this format supports.
//
// v1 files (no header.collisionSteps, no ticks array) remain readable: decodeReplay never rejects them,
// callers that need dt-exact replay should check header.collisionSteps != null / ticks.length > 0 before
// relying on it, and ReplayPlayer falls back to its original wall-clock-driven ticking when ticks is empty.

export const SPOINTREPLAY_MAGIC = 'spointreplay'
export const SPOINTREPLAY_VERSION = 2

export function encodeReplay({ header, inputs, ticks, events }) {
  if (!header || typeof header !== 'object') throw new Error('encodeReplay requires a header object')
  if (!Array.isArray(inputs)) throw new Error('encodeReplay requires an inputs array')
  return pack({
    magic: SPOINTREPLAY_MAGIC,
    version: SPOINTREPLAY_VERSION,
    header,
    inputs,
    ticks: Array.isArray(ticks) ? ticks : [],
    events: Array.isArray(events) ? events : [],
  })
}

export function decodeReplay(buf) {
  let env
  try { env = unpack(buf) } catch (e) { throw new Error(`decodeReplay: not a valid .spointreplay file (msgpack decode failed: ${e.message})`) }
  if (!env || env.magic !== SPOINTREPLAY_MAGIC) throw new Error('decodeReplay: not a .spointreplay file (bad magic)')
  if (env.version !== 1 && env.version !== SPOINTREPLAY_VERSION) throw new Error(`decodeReplay: unsupported version ${env.version} (expected 1 or ${SPOINTREPLAY_VERSION})`)
  if (!env.header || !Array.isArray(env.inputs)) throw new Error('decodeReplay: malformed envelope (missing header/inputs)')
  // v1 files predate the ticks array -- default to empty so every downstream reader (ReplayPlayer) can
  // treat "ticks.length === 0" as the single dt-exactness-unavailable signal, never touching env.version.
  if (!Array.isArray(env.ticks)) env.ticks = []
  return env
}
