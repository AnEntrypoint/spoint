import { execFileSync } from 'node:child_process';

const REPO = 'AnEntrypoint/rs-plugkit';
const BROKEN = 'cddd35858f1ac18cc6a4f719bf96b3a14eae5098';
const FIX = '126a362ca82745bdd3683813d320ba1013c17df2';
const ORCH = 'crates/plugkit-core/src/orchestrator';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
}
function ghJson(args) {
  return JSON.parse(gh(args));
}
function srcAt(path, ref) {
  const b64 = gh(['api', 'repos/' + REPO + '/contents/' + path + '?ref=' + ref, '--jq', '.content']).trim();
  return Buffer.from(b64, 'base64').toString('utf8');
}

const results = [];
function check(name, pass, detail) {
  results.push({ name: name, pass: !!pass, detail: String(detail) });
}

const head = ghJson(['api', 'repos/' + REPO + '/commits/main', '--jq', '{sha:.sha,msg:(.commit.message|split("\\n")[0])}']);
check('main HEAD resolves to a 40-hex sha', /^[0-9a-f]{40}$/.test(head.sha), head.sha + ' ' + head.msg);

const runs = ghJson(['run', 'list', '-R', REPO, '--branch', 'main', '--limit', '20', '--json', 'name,conclusion,status,headSha,createdAt']);
check('main has CI runs', runs.length > 0, runs.length + ' runs');

const latest = runs[0];
check('latest run on main is completed', latest.status === 'completed', latest.name + ' ' + latest.status);
check('latest run on main is success', latest.conclusion === 'success', latest.name + ' ' + latest.conclusion + ' ' + latest.headSha);

const tip = latest.headSha;
for (const wf of ['native-check', 'release']) {
  const r = runs.find((x) => x.headSha === tip && x.name === wf);
  check(wf + ' success on main tip ' + tip.slice(0, 7), r && r.conclusion === 'success', r ? r.conclusion : 'no run on tip');
}

const red = runs.filter((r) => r.conclusion !== 'success');
check(
  'every red run on main is the filed broken sha ' + BROKEN.slice(0, 7),
  red.every((r) => r.headSha === BROKEN),
  red.map((r) => r.name + '@' + r.headSha.slice(0, 7) + ':' + r.conclusion).join(', ') || 'none'
);

const cas = srcAt(ORCH + '/cas.rs', head.sha);
const prd = srcAt(ORCH + '/prd.rs', head.sha);
check('cas.rs at main HEAD defines cas_retry_write_verified', /pub fn cas_retry_write_verified/.test(cas), 'E0425 cause absent at HEAD');
const callSites = (prd.match(/cas::cas_retry_write_verified\(/g) || []).length;
check('prd.rs at main HEAD calls cas::cas_retry_write_verified', callSites > 0, callSites + ' call sites');

const cmp = ghJson(['api', 'repos/' + REPO + '/compare/' + FIX + '...' + head.sha, '--jq', '{status:.status,behind_by:.behind_by}']);
check('fix ' + FIX.slice(0, 7) + ' is an ancestor of main HEAD', cmp.status === 'ahead' && cmp.behind_by === 0, JSON.stringify(cmp));

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + ' :: ' + r.detail);
console.log(failed.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(failed.length === 0 ? 0 : 1);
