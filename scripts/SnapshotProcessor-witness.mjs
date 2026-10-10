import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WITNESS = 'scripts/SnapshotProcessor-witness.mjs';
const DEFAULT_MODULE = resolve(REPO, 'src/client/SnapshotProcessor.js');
const ENCODER_MODULE = resolve(REPO, 'src/netcode/SnapshotEncoder.js');
const FLAG_DEFAULTS = { module: null, out: null, log: null, run: 'adhoc', row: '-', session: '-' };
const EPS = 1e-9;
const QUAT_EPS = 1e-6;
const YAW_STEP = (2 * Math.PI) / 256;
const PITCH_STEP = Math.PI / 255;
const TICK_OF = (call) => 99 + call;

const lines = [];
const failures = [];
let measurements = 0;

const report = (line) => {
  lines.push(line);
  console.log(line);
};
const errorText = (err) => String(err && err.message ? err.message : err).split(/\r?\n/)[0];
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const utcStamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const displayPath = (path) => (path.startsWith(REPO + sep) ? relative(REPO, path) : path).split(sep).join('/');
const shown = (value) => (value === undefined ? 'undefined' : JSON.stringify(value));

const near = (got, want, tol = EPS) =>
  Array.isArray(got) && got.length === want.length && want.every((w, i) => Math.abs(got[i] - w) <= tol)
    ? true
    : `want ${shown(want)} got ${shown(got)}`;
const scalar = (got, want, tol = EPS) =>
  typeof got === 'number' && Math.abs(got - want) <= tol ? true : `want ${want} got ${shown(got)}`;
const exact = (got, want) => (JSON.stringify(got) === JSON.stringify(want) ? true : `want ${shown(want)} got ${shown(got)}`);
const absent = (got) => (got === undefined ? true : `want undefined got ${shown(got)}`);
const all = (...verdicts) => verdicts.find((v) => v !== true) ?? true;

const claim = (name, check) => {
  measurements++;
  let verdict;
  try {
    verdict = check();
  } catch (err) {
    verdict = `threw ${errorText(err)}`;
  }
  if (verdict === true) {
    report(`ok   ${name}`);
    return;
  }
  failures.push(name);
  report(`FAIL ${name}`);
  report(`     ${typeof verdict === 'string' ? verdict : 'expectation not met'}`);
};

const P1 = { id: 1, position: [12.5, 1.25, -3.75], velocity: [2.5, 0, -1.25], rotation: [0, 0, 0, 1], onGround: true, health: 87, crouch: 0, lookPitch: 0, lookYaw: 0, expr: 2, weapon: 1 };
const P1_MOVED = { ...P1, position: [13.5, 1.25, -3.75] };
const P2 = { id: 2, position: [-8, 0, 4], velocity: [0, 0, 0], rotation: [0, 0, 0, 1], onGround: false, health: 100, crouch: 1, lookPitch: 0, lookYaw: 0, expr: 0, weapon: 0 };
const P4_OBJECT = { id: 4, position: [30, 0, 30], rotation: [0, 0, 0, 1], velocity: [1, 0, 0], onGround: true, health: 50, inputSequence: 7, crouch: 0, lookPitch: 0, lookYaw: 0, expr: 0, weapon: 0, inputBuffer: 2 };
const P3_REDUCED = [3, 1500, -200, 0, 1];
const E10 = { id: 10, model: 'crate', position: [1, 2, 3], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], scale: [1, 1, 1], bodyType: 'dynamic', custom: { hp: 5 } };
const E10_MOVED = { ...E10, position: [1, 2, 4], custom: { hp: 4 } };
const E11 = { id: 11, model: 'rock', position: [20, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], scale: [1, 1, 1], bodyType: 'static', custom: null };
const E12 = { id: 12, model: 'pillar', position: [4, 0, 6], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], scale: [1, 1, 1], bodyType: 'static', custom: null };
const SELF = { inputSequence: 42, inputBuffer: 3, groundNormal: [0, 1, 0], wallNormals: [1, 0], position: P1.position };

const frame = (SnapshotEncoder, tick, rawPlayers, rawEntities, extraPlayers = []) => {
  const encoded = SnapshotEncoder.encode({ tick, serverTime: tick * 50, players: rawPlayers, entities: rawEntities });
  encoded.players.push(...extraPlayers);
  return encoded;
};

const scenario = (SnapshotProcessor, SnapshotEncoder, encodeSelfBlock) => {
  const events = { joined: [], left: [], added: [], removed: [], corrupt: [], full: 0 };
  const proc = new SnapshotProcessor({
    callbacks: {
      onPlayerJoined: (id) => events.joined.push(id),
      onPlayerLeft: (id) => events.left.push(id),
      onEntityAdded: (id) => events.added.push(id),
      onEntityRemoved: (id) => events.removed.push(id),
      onDeltaCorruption: (id) => events.corrupt.push(id),
      onFullSnapshotRequested: () => {
        events.full += 1;
      },
    },
  });
  const player = (id) => proc.getPlayerState(id);
  const entity = (id) => proc.getEntity(id);
  const observed = {};

  const first = frame(SnapshotEncoder, 100, [P1, P2], [E10, E11], [P4_OBJECT]);
  first.me = encodeSelfBlock(SELF);
  const firstOut = proc.processSnapshot(first, 100, 1);

  claim('full frame tracks three players, array-form and object-form', () => scalar(proc.getAllPlayerStates().size, 3, 0));
  claim('state accessors return Maps', () => exact([proc.getAllPlayerStates() instanceof Map, proc.getAllEntities() instanceof Map], [true, true]));
  claim('array player 1 position decodes from the 22-byte bin', () => near(player(1).position, [12.5, 1.25, -3.75]));
  claim('array player 1 velocity decodes from the bin', () => near(player(1).velocity, [2.5, 0, -1.25]));
  claim('array player 1 rotation decodes from the packed quaternion', () => near(player(1).rotation, [0, 0, 0, 1], QUAT_EPS));
  claim('array player 1 onGround, health, crouch, expr and weapon decode', () =>
    exact([player(1).onGround, player(1).health, player(1).crouch, player(1).expr, player(1).weapon], [true, 87, 0, 2, 1]));
  claim('array player 1 look angles decode within one wire step', () => {
    const yaw = scalar(player(1).lookYaw, 0, YAW_STEP);
    return yaw === true ? scalar(player(1).lookPitch, 0, PITCH_STEP) : yaw;
  });
  claim('self block sets inputSequence and inputBuffer on the self id', () => exact([player(1).inputSequence, player(1).inputBuffer], [42, 3]));
  claim('self block unpacks the ground normal', () => near(player(1).groundNormal, [0, 1, 0]));
  claim('self block unpacks the wall plane as [nx, nz, offset]', () => near(player(1).wallPlanes, [1, 0, 12.5]));
  claim('self block leaves other players untouched', () => exact([player(2).inputSequence, player(2).inputBuffer], [0, -1]));
  claim('array player 2 position, onGround and crouch decode', () => exact([player(2).position, player(2).onGround, player(2).crouch], [[-8, 0, 4], false, 1]));
  claim('object-form player 4 keeps the fields it carries', () =>
    all(
      near(player(4).position, [30, 0, 30]),
      exact([player(4).velocity, player(4).health, player(4).onGround, player(4).inputSequence, player(4).inputBuffer], [[1, 0, 0], 50, true, 7, 2]),
    ));
  claim('entity 10 decodes from the 29-byte bin with model, body type, custom block and scale', () =>
    all(
      near(entity(10).position, [1, 2, 3]),
      exact([entity(10).model, entity(10).bodyType, entity(10).custom, entity(10).scale, entity(10).sleeping], ['crate', 'dynamic', { hp: 5 }, [1, 1, 1], false]),
    ));
  claim('entity 11 decodes as a static entity with a null custom block', () =>
    all(
      near(entity(11).position, [20, 0, 0]),
      exact([entity(11).model, entity(11).bodyType, entity(11).custom], ['rock', 'static', null]),
    ));
  claim('full frame fires one join per new player and one add per new entity', () => exact([events.joined, events.added], [[1, 2, 4], [10, 11]]));
  claim('full frame returns the processed snapshot at tick 100 with 3 players and 2 entities', () =>
    exact([firstOut.tick, firstOut.players.length, firstOut.entities.length], [100, 3, 2]));

  const second = frame(SnapshotEncoder, 101, [P1, P2], [], [P4_OBJECT]);
  second.entities = [[99, 1, new Uint8Array(29)]];
  second.delta = 1;
  const secondOut = proc.processSnapshot(second, 101, 1);
  claim('field delta for an unknown entity raises one corruption event and tracks nothing', () => all(exact(events.corrupt, [99]), absent(entity(99))));
  claim('corruption-only delta leaves the three players and two entities in place', () =>
    exact([proc.getAllPlayerStates().size, proc.getAllEntities().size, secondOut.entities.length], [3, 2, 0]));

  const baseline = SnapshotEncoder.encodeDelta({ tick: 100, serverTime: 5000, players: [P1, P2], entities: [E10, E11] }, new Map());
  const third = SnapshotEncoder.encodeDelta({ tick: 102, serverTime: 5100, players: [P1_MOVED], entities: [E10_MOVED] }, baseline.entityMap).encoded;
  third.players.push(P4_OBJECT);
  const thirdOut = proc.processSnapshot(third, 102, 1);
  claim('field delta moves entity 10 and replaces its custom block', () =>
    all(
      near(entity(10).position, [1, 2, 4]),
      exact([entity(10).model, entity(10).bodyType, entity(10).custom], ['crate', 'dynamic', { hp: 4 }]),
    ));
  claim('field delta removes entity 11 through the removed list', () => all(absent(entity(11)), exact(events.removed, [11])));
  claim('delta frame moves player 1, keeps its velocity and drops absent player 2', () =>
    all(
      near(player(1).position, [13.5, 1.25, -3.75]),
      near(player(1).velocity, [2.5, 0, -1.25]),
      absent(player(2)),
      exact(events.left, [2]),
    ));
  claim('delta output lists only the changed entity and both remaining players', () =>
    exact([thirdOut.entities.length, thirdOut.entities[0].id, thirdOut.players.length], [1, 10, 2]));

  const fourth = frame(SnapshotEncoder, 103, [P1_MOVED], [E12], [P4_OBJECT, P3_REDUCED]);
  proc.processSnapshot(fourth, 103, 1);
  claim('full frame drops entity 10 missing from the entity list', () => all(absent(entity(10)), exact(events.removed, [11, 10])));
  claim('full frame adds static entity 12 at its position', () =>
    all(
      near(entity(12).position, [4, 0, 6]),
      exact([entity(12).model, entity(12).bodyType, entity(12).custom], ['pillar', 'static', null]),
    ));
  claim('reduced-tier record for player 3 joins at tier 1 with its position', () =>
    all(exact(player(3).tier, 1), near(player(3).position, [15, 0, -2])));
  claim('joins and adds fire in arrival order across the frames so far', () => exact([events.joined, events.added], [[1, 2, 4, 3], [10, 11, 12]]));

  for (let call = 5; call <= 44; call++) {
    proc.processSnapshot(frame(SnapshotEncoder, TICK_OF(call), [P1_MOVED], [E12], [P4_OBJECT]), TICK_OF(call), 1);
    if (call === 43) observed.p3KeptAt43 = player(3) !== undefined;
    if (call === 44) observed.p3DroppedAt44 = player(3) === undefined;
  }
  claim('reduced-tier player 3 survives 39 absent snapshots', () => exact(observed.p3KeptAt43, true));
  claim('reduced-tier player 3 is dropped by the 40th absent snapshot', () => exact(observed.p3DroppedAt44, true));
  claim('dropping player 3 fires onPlayerLeft after player 2', () => exact(events.left, [2, 3]));
  claim('lastSnapshotTick follows the last processed tick', () => exact(proc.lastSnapshotTick, 143));

  const shiftX = {
    point: (p) => {
      p[0] += 100;
    },
    vector: () => {},
    yawRotation: () => {},
    rotation: () => {},
    look: () => {},
  };
  proc.applyChartTransfer(shiftX);
  claim('chart transfer moves every tracked position through the pass', () =>
    exact([player(1).position[0], player(4).position[0], entity(12).position[0]], [113.5, 130, 104]));
  claim('chart transfer empties the wall planes of the array-form player', () => exact(player(1).wallPlanes.length, 0));
  claim('chart transfer leaves velocities unchanged', () => near(player(1).velocity, [2.5, 0, -1.25]));

  proc.removePlayer(1);
  claim('removePlayer drops only the named player', () => all(absent(player(1)), exact(proc.getAllPlayerStates().size, 1)));
  proc.clear();
  claim('clear empties the player and entity maps', () => exact([proc.getAllPlayerStates().size, proc.getAllEntities().size], [0, 0]));
  claim('no full-snapshot request was raised', () => exact(events.full, 0));
};

const verdictFor = async (modulePath, moduleHash) => {
  let mod;
  let encoderMod;
  try {
    mod = await import(pathToFileURL(modulePath).href);
  } catch (err) {
    return { exit: 1, line: `RESULT: FAIL -- module failed to load: ${errorText(err)}` };
  }
  try {
    encoderMod = await import(pathToFileURL(ENCODER_MODULE).href);
  } catch (err) {
    return { exit: 1, line: `RESULT: FAIL -- wire encoder failed to load: ${errorText(err)}` };
  }
  if (typeof mod.SnapshotProcessor !== 'function') {
    return { exit: 1, line: `RESULT: FAIL -- module exports no SnapshotProcessor class (module sha256_16=${moduleHash})` };
  }
  try {
    scenario(mod.SnapshotProcessor, encoderMod.SnapshotEncoder, encoderMod.encodeSelfBlock);
  } catch (err) {
    failures.push('scenario-aborted');
    report(`FAIL scenario-aborted ${errorText(err)}`);
  }
  if (failures.length === 0) {
    return { exit: 0, line: `RESULT: PASS -- ${measurements} claim(s) of SnapshotProcessor hold, module sha256_16=${moduleHash}` };
  }
  return { exit: 1, line: `RESULT: FAIL -- ${failures.length} failed of ${measurements} claim(s): ${failures.slice(0, 3).join('; ')}` };
};

const parseArgs = (argv) => {
  const flags = { ...FLAG_DEFAULTS };
  for (const arg of argv) {
    const match = /^--([a-z]+)=(.*)$/.exec(arg);
    if (!match || !Object.hasOwn(flags, match[1])) return { error: `unknown argument ${arg}` };
    flags[match[1]] = match[2];
  }
  return { flags };
};

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    report(`RESULT: FAIL -- ${parsed.error}`);
    return 1;
  }
  const flags = parsed.flags;
  const modulePath = flags.module === null ? DEFAULT_MODULE : resolve(flags.module);
  const outPath = flags.out === null ? null : resolve(flags.out);
  if (outPath !== null && existsSync(outPath)) {
    report(`RESULT: FAIL -- refusing to overwrite existing output file ${displayPath(outPath)}`);
    return 1;
  }
  const present = existsSync(modulePath);
  const moduleHash = present ? sha256Hex(readFileSync(modulePath)).slice(0, 16) : 'missing';
  const startedAt = utcStamp();
  report(`[SnapshotProcessor-witness] run=${flags.run} ts=${startedAt} module=${displayPath(modulePath)} sha256_16=${moduleHash}`);
  const verdict = present
    ? await verdictFor(modulePath, moduleHash)
    : { exit: 1, line: `RESULT: FAIL -- module path not found: ${displayPath(modulePath)}` };
  report(verdict.line);
  const text = `${lines.join('\n')}\n`;
  let outShown = 'none';
  let outDigest = 'n/a';
  if (outPath !== null) {
    writeFileSync(outPath, text, { flag: 'wx' });
    outShown = displayPath(outPath);
    outDigest = sha256Hex(text);
  }
  if (flags.log !== null) {
    const entry = [
      utcStamp(),
      `witness=${WITNESS}`,
      `run=${flags.run}`,
      `target=${displayPath(modulePath)}`,
      `module_sha256_16=${moduleHash}`,
      `exit=${verdict.exit}`,
      verdict.line,
      `out=${outShown}`,
      `sha256=${outDigest}`,
      `row=${flags.row}`,
      `session=${flags.session}`,
    ].join(' | ');
    appendFileSync(resolve(flags.log), `${entry}\n`);
  }
  return verdict.exit;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    report(`RESULT: FAIL -- ${errorText(err)}`);
    process.exitCode = 1;
  },
);
