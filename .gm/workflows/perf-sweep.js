export const meta = {
  name: 'spoint-perf-sweep',
  description: 'Fan out perf profilers across spoint subsystems, adversarially verify each finding, synthesize a ranked optimization plan',
  phases: [
    { title: 'Profile', detail: 'one agent per subsystem hot-path' },
    { title: 'Verify', detail: 'adversarially confirm each finding is real, safe, and a net win' },
    { title: 'Synthesize', detail: 'rank confirmed findings into an ordered plan' },
  ],
}

// Subsystems to profile. Each agent reads the named files, runs the app/tests
// where useful, and returns concrete, ranked findings (file:line + measured or
// reasoned cost + a specific fix + a regression risk).
const SUBSYSTEMS = [
  { key: 'render-loop', files: 'client/app.js (animate, tickPlayerAnimators, tickAnimatedEntities, updateSunShadow, LOD cull), client/EntityLoader.js',
    focus: 'per-frame allocations, redundant matrix/quaternion work, draw-call batching, sun-shadow/LOD update cadence, console.log in the hot loop, frustum/distance culling effectiveness' },
  { key: 'vrm-anim', files: 'client/PlayerAnimator.js, client/AnimationStateMachine.js, client/facial-animation.js, client/AnimationUtils.js',
    focus: 'mixer.update cost, bone override math per frame, per-frame Quaternion/Euler allocation, animation-LOD throttling for distant players, expression/spring/look-at update gating' },
  { key: 'modelpool', files: 'client/ModelPoolAdapter.js, client/PlayerManager.js, and node_modules/streaming-gltf/examples/local-progressive/model-pool.js (read-only, how spoint drives it)',
    focus: 'pool.update() cost, LOD tier-swap churn, VRM multi-driver parse concurrency, texture-LOD work, instancing utilization, whether players that could batch are batching' },
  { key: 'server-tick', files: 'src/sdk/TickHandler.js, src/shared/movement.js, src/sdk/server.js',
    focus: 'per-tick allocations, PHYSICS_PLAYER_DIVISOR dilation, idle-skip correctness, redundant trig (sin/cos per input), snapshot build cost, entity tick rate' },
  { key: 'physics', files: 'src/physics/ (all .js)',
    focus: 'Jolt step cost, collider resolution, terrain tick decouple, per-body work that could be spatial-culled, getPointer/array-float marshalling' },
  { key: 'netcode-protocol', files: 'src/netcode/ (all), src/protocol/ (all), src/client/SnapshotProcessor.js, src/client/SmoothInterpolation.js',
    focus: 'serialization byte cost + allocations, snapshot delta efficiency, Kalman/jitter buffer per-frame cost, quantization, relevance/AOI filtering' },
  { key: 'spatial', files: 'src/spatial/ (all)',
    focus: 'spatial grid/octree rebuild cost, query allocations, getNearbyPlayers efficiency, AOI radius work' },
]

phase('Profile')
const findings = await pipeline(
  SUBSYSTEMS,
  s => agent(
    `You are a performance engineer profiling the spoint multiplayer game engine (a real-time three.js client + Node tick-loop server).\n` +
    `Profile this subsystem: ${s.key}.\nFiles: ${s.files}\nFocus: ${s.focus}\n\n` +
    `Read the files. Identify concrete, high-confidence performance problems: per-frame/per-tick heap allocations in hot loops, redundant computation, missing caching, work that should be distance/frustum/AOI culled, O(n^2) where O(n) is reachable, synchronous work that blocks the loop, and any debug logging left in a hot path.\n` +
    `For EACH finding return: file:line, what the cost is and roughly how often it runs, a SPECIFIC minimal fix, the expected win (qualitative is fine), and the regression risk. Only report findings you are confident are real and reachable without architectural rewrites. Prefer fewer high-confidence findings over many speculative ones. Do NOT edit any files - this is analysis only.`,
    { label: `profile:${s.key}`, phase: 'Profile', agentType: 'Explore',
      schema: { type: 'object', additionalProperties: false, required: ['subsystem', 'findings'], properties: {
        subsystem: { type: 'string' },
        findings: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['title', 'location', 'cost', 'fix', 'win', 'risk', 'confidence'], properties: {
            title: { type: 'string' }, location: { type: 'string' }, cost: { type: 'string' },
            fix: { type: 'string' }, win: { type: 'string' }, risk: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] } } } } } } }
  ).then(r => r && ({ ...r, _key: s.key })),
  // Verify each finding as soon as its subsystem profile lands.
  prof => prof ? parallel((prof.findings || []).map(f => () =>
    agent(
      `Adversarially verify this claimed spoint performance finding. Read the actual code at the location and decide if it is REAL, SAFE to fix as described, and a genuine NET win (not a micro-optimization that hurts readability for no measurable gain, not already-handled elsewhere, not behind a debug flag that is off in production).\n\n` +
      `Finding: ${JSON.stringify(f)}\n\n` +
      `Default to real=false if the code does not actually do what the finding claims, if the hot path is already guarded/cached, or if the fix would change behavior. Return your verdict with the reason.`,
      { label: `verify:${prof._key}:${(f.title||'').slice(0,24)}`, phase: 'Verify', agentType: 'Explore',
        schema: { type: 'object', additionalProperties: false, required: ['real', 'safe', 'netWin', 'reason'], properties: {
          real: { type: 'boolean' }, safe: { type: 'boolean' }, netWin: { type: 'boolean' }, reason: { type: 'string' } } } }
    ).then(v => ({ ...f, subsystem: prof._key, verdict: v }))
  )) : []
)

const confirmed = findings.flat().filter(Boolean).filter(f => f.verdict && f.verdict.real && f.verdict.safe && f.verdict.netWin)
log(`confirmed ${confirmed.length} net-win findings of ${findings.flat().filter(Boolean).length} profiled`)

phase('Synthesize')
const plan = await agent(
  `You are the lead engineer. Here are adversarially-confirmed performance findings for the spoint engine, each real+safe+net-win:\n` +
  JSON.stringify(confirmed, null, 1) +
  `\n\nProduce an ORDERED optimization plan: rank by (impact / risk / effort), group related fixes, and for each give a one-line actionable instruction with its file:line. Put the highest-impact, lowest-risk wins first. Flag any that need a live browser/profiler witness to confirm the win. Be concrete and concise.`,
  { label: 'synthesize-plan', phase: 'Synthesize',
    schema: { type: 'object', additionalProperties: false, required: ['orderedPlan', 'summary'], properties: {
      summary: { type: 'string' },
      orderedPlan: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['rank', 'subsystem', 'instruction', 'location', 'impact', 'risk'], properties: {
          rank: { type: 'number' }, subsystem: { type: 'string' }, instruction: { type: 'string' },
          location: { type: 'string' }, impact: { type: 'string' }, risk: { type: 'string' } } } } } } }
)

return { confirmedCount: confirmed.length, confirmed, plan }
