/**
 * ReplayBotTraining.js — Training data extraction from .spointreplay files.
 *
 * PRD row: ugc-replay-bot-training
 * FIRST SLICE: define the training data format (extract input/output pairs from replay files).
 *
 * The .spointreplay v2 format (src/netcode/ReplayFile.js) already records:
 *  - header: { worldName, tickRate, startTick, endTick, collisionSteps, players[{id,name,spawn}] }
 *  - inputs: [{ tick, playerId, sequence, data }] — every real per-tick input applied
 *  - ticks:  [{ tick, dt }] — the exact per-tick dt TickHandler.onTick received
 *  - events: [...] — session EventLog snapshot
 *
 * This module defines the TRAINING-DATA extraction layer on top of that format:
 * given a decoded .spointreplay envelope, it produces a flat array of training examples
 * where each example is a (state, action) pair suitable for imitation learning of
 * bot movement behavior.
 *
 * Training example shape:
 *  {
 *    tick: number,          // the tick this example was recorded at
 *    dt: number,            // the dt that was applied to physics.step() this tick
 *    playerId: string,      // which player's behavior this example models
 *    input: {               // the ACTION (what the player did)
 *      moveX: number,       // -1..1, WASD lateral
 *      moveY: number,       // -1..1, WASD forward/back
 *      lookYaw: number,     // mouse yaw delta
 *      lookPitch: number,   // mouse pitch delta
 *      jump: boolean,
 *      sprint: boolean,
 *      interact: boolean,
 *      // ... any other fields the real input.data carries
 *    },
 *    // STATE features are NOT included in the training-data format itself —
 *    // they are extracted DURING training by replaying the world through the
 *    // physics engine with the exact recorded dt sequence. A replay that
 *    // produces the same state given the same inputs+dt is the determinism
 *    // precondition the sibling row deterministic-simulation-record-and-replay-dt
 *    // (resolved) already ships.
 *  }
 *
 * The "state" side of the (state, action) pair is intentionally NOT stored in the
 * extracted training data. Storing it would:
 *  1. Duplicate the replay file (which already has the inputs+dt to reproduce state)
 *  2. Freeze the state representation, blocking iteration on features
 *  3. Bloat the training corpus (state has many more dimensions than action)
 *
 * Instead, the training pipeline:
 *  1. Decodes a .spointreplay file
 *  2. Calls extractTrainingExamples() to get the action sequence
 *  3. Replays the world through the physics engine using the recorded dt+inputs
 *  4. Samples state features (position, velocity, nearby entities, etc.) at each tick
 *  5. Pairs each state sample with its corresponding action from step 2
 *
 * This separation keeps the training-data format stable (only depends on the input
 * wire format, which changes rarely) while the state features can evolve independently.
 *
 * Output format for a training corpus file (one .spointreplay → one .jsonl):
 *  Each line is a JSON object:
 *  {
 *    "tick": 147,
 *    "dt": 0.016666666666666666,
 *    "playerId": "a1b2c3...",
 *    "input": { "moveX": 0, "moveY": 1, "lookYaw": -0.02, "jump": false, "sprint": true }
 *  }
 */

/**
 * Extract training examples from a decoded .spointreplay v2 envelope.
 *
 * @param {object} replay — the decoded envelope from decodeReplay()
 * @param {object} [opts]
 * @param {string} [opts.playerId] — filter to a single player (omit for all)
 * @param {number} [opts.minTick] — skip ticks before this
 * @param {number} [opts.maxTick] — skip ticks after this
 * @returns {Array<{tick:number, dt:number, playerId:string, input:object}>}
 */
export function extractTrainingExamples(replay, opts = {}) {
  const { playerId, minTick = -Infinity, maxTick = Infinity } = opts

  // Build a tick->dt lookup from the ticks array (v2 only; v1 files have empty ticks).
  const dtByTick = new Map()
  for (const { tick, dt } of replay.ticks || []) {
    dtByTick.set(tick, dt)
  }

  const examples = []
  for (const entry of replay.inputs) {
    if (entry.tick < minTick || entry.tick > maxTick) continue
    if (playerId && entry.playerId !== playerId) continue

    const dt = dtByTick.has(entry.tick)
      ? dtByTick.get(entry.tick)
      : (1 / (replay.header.tickRate || 60)) // fallback for v1 files

    examples.push({
      tick: entry.tick,
      dt,
      playerId: entry.playerId,
      input: entry.data || {},
    })
  }

  return examples
}

/**
 * Compute basic corpus statistics for a set of extracted examples.
 * Useful for sanity-checking a training corpus before feeding it to a model.
 *
 * @param {Array} examples — output of extractTrainingExamples()
 * @returns {{ count: number, playerIds: string[], tickRange: [number,number], dtStats: {min,max,avg}, inputKeys: string[] }}
 */
export function computeCorpusStats(examples) {
  if (examples.length === 0) {
    return { count: 0, playerIds: [], tickRange: [0, 0], dtStats: { min: 0, max: 0, avg: 0 }, inputKeys: [] }
  }
  const playerIds = [...new Set(examples.map(e => e.playerId))]
  const ticks = examples.map(e => e.tick)
  const dts = examples.map(e => e.dt)
  const keys = new Set()
  for (const e of examples) {
    for (const k of Object.keys(e.input)) keys.add(k)
  }
  return {
    count: examples.length,
    playerIds,
    tickRange: [Math.min(...ticks), Math.max(...ticks)],
    dtStats: {
      min: Math.min(...dts),
      max: Math.max(...dts),
      avg: dts.reduce((a, b) => a + b, 0) / dts.length,
    },
    inputKeys: [...keys].sort(),
  }
}