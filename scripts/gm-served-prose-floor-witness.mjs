// Witness for the served gm-config orchestrator prose (row gm-config-served-prose-subagent-floor-10).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flagValue, positionalArg, requireExternalTarget } from './lib/external-target.mjs';

const FILES = ['complete.md', 'entry.md', 'entry-extended.md', 'lean-p3.md', 'lean-p4.md'];
const UNDER_CHECKOUT = 'gm-config/prose';
const argv = process.argv.slice(2);
const { path: proseDir, source } = requireExternalTarget({
  witness: 'gm-served-prose-floor-witness',
  label: 'served gm-config prose directory',
  flagName: 'prose-dir',
  envName: 'GM_PROSE_DIR',
  underCheckout: UNDER_CHECKOUT,
  flag: flagValue(argv, 'prose-dir') ?? positionalArg(argv),
  argv,
});

let failures = 0;
const report = (ok, name, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
};

console.log(`prose dir: ${proseDir}`);
console.log(`prose dir source: ${source}`);
const texts = {};
const missing = [];
for (const file of FILES) {
  const path = join(proseDir, file);
  try {
    texts[file] = readFileSync(path, 'utf8');
  } catch (error) {
    missing.push(`${path} (${error.code ?? 'unreadable'})`);
  }
}
report(
  missing.length === 0,
  'five prose files readable',
  missing.length === 0 ? FILES.join(', ') : `missing ${missing.join('; ')}`,
);

if (missing.length === 0) {
  const lineHits = (needle, keep = () => true) => {
    const hits = [];
    for (const file of FILES) {
      texts[file].split(/\r?\n/).forEach((line, index) => {
        if (line.includes(needle) && keep(line)) hits.push(`${file}:${index + 1}`);
      });
    }
    return hits;
  };

  const countedAlone = lineHits('subagents_running', (line) => !line.includes('ListAgents'));
  report(
    countedAlone.length === 0,
    'no line counts from subagents_running alone',
    countedAlone.length === 0
      ? 'every subagents_running line also names ListAgents'
      : `offending lines: ${countedAlone.join(' ')}`,
  );

  const under5 = lineHits('under 5');
  report(
    under5.length === 0,
    "no 'under 5'",
    under5.length === 0 ? 'absent' : `present at ${under5.join(' ')}`,
  );

  const launch16 = lineHits('launch until 16');
  report(
    launch16.length === 0,
    "no 'launch until 16'",
    launch16.length === 0 ? 'absent' : `present at ${launch16.join(' ')}`,
  );

  const floorOk = /floor is 10\b/.test(texts['entry.md']);
  report(
    floorOk,
    'floor 10 appears in entry.md',
    floorOk ? 'matched /floor is 10\\b/' : 'no match for /floor is 10\\b/',
  );
}

console.log(`checks: ${failures === 0 ? 'all passed' : `${failures} failed`}`);
console.log(failures === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(failures === 0 ? 0 : 1);
