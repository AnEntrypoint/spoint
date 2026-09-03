// defineAudio(spec) -> a tiny client-side music/SFX manager for game apps. Sound is a CLIENT concern (the
// server app has no speakers), so this is meant to be constructed and driven from a client app's render()/onEvent
// -- typically the server broadcasts a "play the win jingle" event and every client app calls audio.play('win').
// It de-dupes by key (a track already loading/playing isn't re-fetched), loops music, one-shots SFX, and controls
// volume. On the SERVER (or anywhere with no Audio/window global -- e.g. the singleplayer in-Worker BrowserServer)
// EVERY method is a safe no-op: importing this module server-side never throws and never touches a missing global,
// so an app can `import { defineAudio }` at top level in a dual-loaded file without guarding.
//
// spec = {
//   tracks?: { [key]: url },   // named urls, so callers say play('bgm') not a raw path
//   volume?: number,           // master 0..1 (default 1)
//   base?: string,             // url prefix prepended to every track url (default '')
//   audibleRange?: number,     // positional playback: distance (m) at which linear falloff reaches 0 (default 40)
// }
// Returns {
//   play(key, { loop?, volume?, restart?, position?: [x,y,z] }) -> the Audio element (or null server-side),
//   stop(key), stopAll(), setVolume(v), isPlaying(key) -> bool,
//   preload(key), has(key), setPosition(key, [x,y,z]) -> move an already-playing positional track's emitter
// }
// The returned object is inert (all no-ops, isPlaying=false) when constructed off the client.
//
// --- Positional playback + raycast occlusion muffle ---
// play(key, { position: [x,y,z] }) makes the track POSITIONAL: a per-track update loop (throttled, see
// OCCLUSION_INTERVAL_MS below -- never every frame) re-derives (1) a distance-falloff gain, linear from
// full volume at 0m to silent at `audibleRange` meters (default 40), using the listener position (the
// local player's camera -- window.__camera, the same global client/app.js already exposes for scene
// debugging: window.__camera=camera) vs the given emitter position, and (2) an OCCLUSION check: a ray
// cast from the listener toward the emitter against window.__scene (client/app.js: window.__scene=scene,
// BVH-accelerated via three-mesh-bvh same as the rest of the client's raycasts) -- the client-side
// equivalent of ctx.canSee (src/physics/World.js), which only exists server-side (ctx.physics has no
// client counterpart; audio.js runs client-only, so it needs its own raycast against the rendered scene
// rather than sharing a raycast surface with server apps). A blocked line of sight applies an EXTRA
// muffle multiplicatively on top of (not instead of) the distance falloff: OCCLUDED_VOLUME_MUL cuts
// volume further and a Web Audio BiquadFilterNode lowpass (OCCLUDED_LOWPASS_HZ) cuts high frequencies,
// so a sound behind a wall reads as both quieter AND duller than the same sound merely far away.
//
// The lowpass filter needs a real Web Audio graph (AudioContext -> MediaElementAudioSourceNode ->
// BiquadFilterNode -> GainNode -> destination) layered on top of the plain HTMLAudioElement used for
// every non-positional track; a track's graph is built ONCE ever (lazy, per-key, cached even across a
// stop()+re-play()) because createMediaElementSource can only be called once per HTMLMediaElement --
// rebuilding it on every fresh positional session would permanently fail from the second play() on.
// Every step degrades to plain non-occluded playback rather than throwing: no AudioContext support, no
// window.__scene/__camera yet (e.g. called during boot before the scene exists), a malformed position,
// or a MediaElementAudioSourceNode already claimed by another consumer all fall back to plain
// distance-only (or fully unattenuated) playback.

const _CLIENT = (typeof window !== 'undefined') && (typeof Audio !== 'undefined')

// Positional-audio tuning. Kept as named constants (not magic numbers inline) so a future tuning pass
// has one place to look, matching the codebase's existing tuned-constant convention (e.g. ShadowPipeline's
// texelWorld, SceneOcclusion's hideStreak/unhideStreak).
const OCCLUSION_INTERVAL_MS = 200     // per-track raycast+falloff re-evaluation cadence (throttled, not every frame/tick)
const OCCLUDED_VOLUME_MUL = 0.35      // extra volume cut when line-of-sight is blocked, ON TOP OF distance falloff
const OCCLUDED_LOWPASS_HZ = 800       // BiquadFilterNode lowpass cutoff when occluded (duller/muffled)
const UNOCCLUDED_LOWPASS_HZ = 22000   // effectively "off" -- above audible range, clear line of sight
const DEFAULT_AUDIBLE_RANGE = 40      // meters; distance at which linear falloff reaches 0
const LOWPASS_LERP = 0.35             // per-update-tick smoothing toward the target cutoff/volume, avoids a click on occlusion flip

// Client-side line-of-sight raycast, the audio-graph equivalent of ctx.canSee (src/physics/World.js,
// server-app-only). audio.js has no ctx.physics access (it is a pure client library, not a dual-import
// app module with a server ctx) so it raycasts the RENDERED scene directly via the same globals
// client/app.js already exposes for debugging (window.__scene/window.__camera). Returns true (audible,
// unoccluded) when the scene/camera aren't ready yet or the raycast throws -- fail-open, matching this
// module's overall "never throw, degrade to plain playback" discipline.
function _hasLineOfSight(listenerPos, emitterPos) {
  const scene = (typeof window !== 'undefined') ? window.__scene : null
  const THREE = (typeof window !== 'undefined') ? window.THREE : null
  if (!scene || !THREE || !THREE.Raycaster || !THREE.Vector3) return true
  try {
    const from = new THREE.Vector3(listenerPos[0], listenerPos[1], listenerPos[2])
    const to = new THREE.Vector3(emitterPos[0], emitterPos[1], emitterPos[2])
    const delta = to.clone().sub(from)
    const dist = delta.length()
    if (dist < 1e-4) return true
    const dir = delta.normalize()
    const ray = new THREE.Raycaster(from, dir, 0, dist)
    const hits = ray.intersectObject(scene, true)
    if (!hits || hits.length === 0) return true
    // Tolerance mirrors ctx.canSee's default (0.5m): a hit essentially AT the emitter (its own mesh)
    // doesn't count as an occluder.
    return hits[0].distance >= dist - 0.5
  } catch (_) {
    return true
  }
}

// Global mixer registry: every live defineAudio() instance registers itself here so a single
// settings-menu control (master/sfx/music sliders) can reach every app's audio manager without
// each app needing to expose its own instance on a shared global. `category` buckets an instance
// under 'sfx' | 'music' | 'master' (default 'master', scaled by both the category level AND the
// overall master level) -- a game app doesn't have to know about the mixer to be controlled by it.
// Purely additive: an app that never touches the mixer behaves exactly as before (spec.volume/
// setVolume still work standalone).
const _mixerLevels = { master: 1, sfx: 1, music: 1 }
const _registry = new Set()   // live { setBaseVolume, category } handles

function _effectiveLevel(category) {
  const cat = (category === 'sfx' || category === 'music') ? _mixerLevels[category] : 1
  return clamp01(_mixerLevels.master, 1) * clamp01(cat, 1)
}

function _applyMixerToAll() {
  for (const handle of _registry) handle._applyMixer()
}

// setMixerVolume('master'|'sfx'|'music', v) -- driven by the in-game settings menu. Immediately
// re-scales every registered instance's live elements, same as a per-instance setVolume() call.
function setMixerVolume(category, v) {
  if (category !== 'master' && category !== 'sfx' && category !== 'music') { console.warn(`[audio] setMixerVolume: unknown category '${category}'`); return }
  _mixerLevels[category] = clamp01(v, _mixerLevels[category])
  _applyMixerToAll()
}
function getMixerVolume(category) { return _mixerLevels[category] ?? 1 }

export function defineAudio(spec = {}) {
  const tracks = { ...(spec.tracks || {}) }
  const base = typeof spec.base === 'string' ? spec.base : ''
  const category = spec.category === 'sfx' || spec.category === 'music' ? spec.category : 'master'
  const audibleRange = (typeof spec.audibleRange === 'number' && spec.audibleRange > 0) ? spec.audibleRange : DEFAULT_AUDIBLE_RANGE
  let baseVolume = clamp01(spec.volume, 1)   // this instance's own volume, BEFORE the global mixer scale
  const _els = new Map()   // key -> HTMLAudioElement
  // Positional state, keyed by track key. { position:[x,y,z], perCallVolume, timer } -- the Web Audio
  // graph itself lives in `_graphs` (below), NOT here, since createMediaElementSource can only be called
  // ONCE per HTMLMediaElement ever: a track that goes positional -> stop() -> positional again would
  // otherwise try to rebuild a graph on the SAME already-wired <audio> element and permanently fail
  // (caught by _ensureGraph's try/catch, degrading silently to no-muffle) every time after the first.
  const _positional = new Map()
  const _graphs = new Map()   // key -> { source, filter, gain } | null (null = build already failed for this key, don't retry)
  let _sharedCtx = null   // one AudioContext per defineAudio instance, shared by every positional track

  function urlFor(key) {
    // A key is either a registered track name or a literal url; either way prefix with base.
    const u = tracks[key] || key
    return typeof u === 'string' ? base + u : null
  }
  function elFor(key) {
    let el = _els.get(key)
    if (el) return el
    const url = urlFor(key); if (!url) return null
    el = new Audio(url); el.preload = 'auto'; _els.set(key, el)
    return el
  }
  function effectiveVolume(perCallVolume) {
    return baseVolume * clamp01(perCallVolume, 1) * _effectiveLevel(category)
  }

  // Distance-falloff gain: 1 at 0m, linear down to 0 at `audibleRange` meters. Malformed/missing listener
  // or emitter positions fail open to full volume (no positional data -> can't attenuate, matching this
  // module's degrade-not-throw discipline elsewhere).
  function _distanceGain(listenerPos, emitterPos) {
    if (!Array.isArray(listenerPos) || !Array.isArray(emitterPos)) return 1
    const dx = emitterPos[0] - listenerPos[0], dy = emitterPos[1] - listenerPos[1], dz = emitterPos[2] - listenerPos[2]
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (!Number.isFinite(dist)) return 1
    return clamp01(1 - dist / audibleRange, 1)
  }
  function _listenerPos() {
    const cam = (typeof window !== 'undefined') ? window.__camera : null
    return (cam && cam.position) ? [cam.position.x, cam.position.y, cam.position.z] : null
  }

  // Lazily build the Web Audio graph for one track's element (once ever, per key -- see `_graphs`'
  // declaration comment for why this can't live on the per-play `_positional` state): AudioContext ->
  // MediaElementAudioSourceNode -> BiquadFilterNode(lowpass) -> GainNode -> destination. Returns null on
  // any failure (no AudioContext support, or a genuinely unexpected error) and caches the null so a
  // failed build isn't silently retried every throttle tick -- the caller falls back to plain el.volume
  // attenuation, no muffle, rather than throwing.
  function _ensureGraph(key, el) {
    if (_graphs.has(key)) return _graphs.get(key)
    try {
      const Ctx = (typeof AudioContext !== 'undefined') ? AudioContext : (typeof webkitAudioContext !== 'undefined') ? webkitAudioContext : null
      if (!Ctx) { _graphs.set(key, null); return null }
      if (!_sharedCtx || _sharedCtx.state === 'closed') _sharedCtx = new Ctx()
      const source = _sharedCtx.createMediaElementSource(el)
      const filter = _sharedCtx.createBiquadFilter()
      filter.type = 'lowpass'; filter.frequency.value = UNOCCLUDED_LOWPASS_HZ
      const gain = _sharedCtx.createGain()
      gain.gain.value = 1
      source.connect(filter); filter.connect(gain); gain.connect(_sharedCtx.destination)
      const graph = { source, filter, gain }
      _graphs.set(key, graph)
      return graph
    } catch (_) {
      _graphs.set(key, null)   // e.g. el already routed through a MediaElementAudioSourceNode elsewhere; don't retry every tick
      return null
    }
  }

  // Re-evaluate one positional track's falloff+occlusion and apply it. Runs on the track's own throttled
  // timer (OCCLUSION_INTERVAL_MS), never every frame -- a raycast per active positioned sound per frame
  // would scale badly with many simultaneous emitters (matches the codebase's throttled-not-every-frame
  // convention, e.g. ShadowPipeline's texel-step cadence, SceneOcclusion's still-camera idle-throttle).
  function _updatePositional(key) {
    const state = _positional.get(key)
    if (!state) return
    const el = _els.get(key)
    if (!el || el.paused || el.ended) return   // track stopped/finished; timer keeps running (cheap no-op) until stop()/dispose() clears it
    const listener = _listenerPos()
    const distGain = listener ? _distanceGain(listener, state.position) : 1
    const occluded = listener ? !_hasLineOfSight(listener, state.position) : false
    const occludeGain = occluded ? OCCLUDED_VOLUME_MUL : 1
    const targetVolume = effectiveVolume(state.perCallVolume) * distGain * occludeGain
    el.volume = clamp01(targetVolume, el.volume)
    const graph = _ensureGraph(key, el)
    if (graph) {
      const targetHz = occluded ? OCCLUDED_LOWPASS_HZ : UNOCCLUDED_LOWPASS_HZ
      const cur = graph.filter.frequency.value
      // Smoothed toward the target rather than snapped, so an occlusion-state flip (walking behind/out
      // from a wall) doesn't produce an audible click from an instantaneous filter-cutoff jump.
      graph.filter.frequency.value = cur + (targetHz - cur) * LOWPASS_LERP
      // GainNode carries the SAME distance+occlusion attenuation as el.volume when the Web Audio graph
      // is live (source is routed through the graph to destination, not el's own output), keeping both
      // paths' effective loudness consistent regardless of which one is actually driving playback.
      graph.gain.gain.value = clamp01(targetVolume, graph.gain.gain.value)
    }
  }

  function _stopPositional(key) {
    const state = _positional.get(key)
    if (!state) return
    if (state.timer) clearInterval(state.timer)
    _positional.delete(key)
  }

  if (!_CLIENT) {
    // Server / no-Audio environment: a fully inert surface with the identical shape, so call sites are guard-free.
    return {
      play() { return null }, stop() {}, stopAll() {}, setVolume(v) { baseVolume = clamp01(v, baseVolume) },
      isPlaying() { return false }, preload() {}, has(key) { return key in tracks },
    }
  }

  const handle = {
    // Start a track. `loop` for music, omit for a one-shot SFX. `volume` (0..1) scales the master for this track.
    // `position` [x,y,z] makes it POSITIONAL (distance falloff + raycast occlusion muffle vs the local
    // player's camera, see module header) -- omit for a plain non-positional 2D sound (unchanged behavior).
    // By default re-calling play() on an already-playing track is a no-op (dedupe); pass restart:true to seek to 0.
    play(key, { loop = false, volume, restart = false, position } = {}) {
      const el = elFor(key); if (!el) return null
      el.loop = !!loop
      const hasPos = Array.isArray(position) && position.length === 3 && position.every(Number.isFinite)
      if (hasPos) {
        let state = _positional.get(key)
        if (!state) {
          state = { position, perCallVolume: volume, timer: null }
          _positional.set(key, state)
          state.timer = setInterval(() => _updatePositional(key), OCCLUSION_INTERVAL_MS)
        } else {
          state.position = position
          state.perCallVolume = volume
        }
        _updatePositional(key)   // apply immediately, don't wait for the first timer tick
      } else if (_positional.has(key)) {
        _stopPositional(key)     // re-played non-positionally: drop stale positional state/timer
        el.volume = effectiveVolume(volume)
      } else {
        el.volume = effectiveVolume(volume)
      }
      if (restart || el.paused || el.ended) {
        try { el.currentTime = 0 } catch (_) {}
        // A MediaElementAudioSourceNode-routed element must still be resumed via its own .play() (Web
        // Audio only intercepts where the decoded audio ROUTES, not playback start/stop) -- and a
        // suspended AudioContext (autoplay policy) needs an explicit resume or the graph stays silent.
        if (_sharedCtx && _sharedCtx.state === 'suspended') { _sharedCtx.resume().catch(() => {}) }
        el.play().catch(() => {})
      }
      return el
    },
    stop(key) { const el = _els.get(key); if (el) { el.pause(); try { el.currentTime = 0 } catch (_) {} }; _stopPositional(key) },
    stopAll() { for (const el of _els.values()) { el.pause(); try { el.currentTime = 0 } catch (_) {} }; for (const key of Array.from(_positional.keys())) _stopPositional(key) },
    // Re-apply baseVolume to every live element so a settings slider takes effect immediately.
    setVolume(v) { baseVolume = clamp01(v, baseVolume); handle._applyMixer() },
    isPlaying(key) { const el = _els.get(key); return !!el && !el.paused && !el.ended },
    preload(key) { const el = elFor(key); if (el) { try { el.load() } catch (_) {} } },
    has(key) { return key in tracks || _els.has(key) },
    // Update a positional track's emitter position every frame/tick without restarting playback or the
    // occlusion timer (e.g. a moving footstep-source entity) -- a no-op if `key` isn't currently positional.
    setPosition(key, position) {
      const state = _positional.get(key)
      if (state && Array.isArray(position) && position.length === 3 && position.every(Number.isFinite)) state.position = position
    },
    dispose() {
      _registry.delete(handle)
      handle.stopAll()
      if (_sharedCtx) { try { _sharedCtx.close() } catch (_) {}; _sharedCtx = null }
      _graphs.clear()   // every cached graph's nodes belonged to the now-closed AudioContext
    },
    // Internal: re-derive every live element's .volume from baseVolume * per-call volume * mixer. Per-call
    // volume isn't retained per-element, so this re-applies baseVolume*mixer only (a playing track keeps its
    // own per-call scale baked in until it's re-played) -- close enough for a live settings slider, and exact
    // for the common case (no per-call volume override). Positional tracks are left alone here: their own
    // throttled timer already re-derives volume from baseVolume*mixer every tick via effectiveVolume().
    _applyMixer() { for (const [key, el] of _els.entries()) { if (!_positional.has(key)) el.volume = baseVolume * _effectiveLevel(category) } },
  }
  _registry.add(handle)
  return handle
}

export const AudioMixer = { setVolume: setMixerVolume, getVolume: getMixerVolume }

// Hoisted module-level helper: used by both the inert (server) branch and the live client surface, and referenced
// inside defineAudio before this line (function declarations hoist), so master-volume defaulting has one home.
function clamp01(v, dflt) { return (typeof v === 'number' && Number.isFinite(v)) ? Math.min(1, Math.max(0, v)) : dflt }
