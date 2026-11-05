import { parseCron, cronMatches, parseCrons, dueCrons, CronSyntaxError } from '../src/sdk/cronSchedule.js';

let checks = 0;
let failed = 0;
function expect(name, got, want) {
  checks += 1;
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) failed += 1;
  console.log(`${same ? 'ok  ' : 'FAIL'} ${name} | got ${JSON.stringify(got)} | want ${JSON.stringify(want)}`);
}

const at = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi));
const firstDay = (pred) => {
  for (let t = Date.UTC(2026, 0, 1); ; t += 86400000) {
    if (pred(new Date(t))) return new Date(t);
  }
};
const throwsWith = (fn, code) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof CronSyntaxError && e.reasonCode === code;
  }
};

const every5 = parseCron('*/5 * * * *');
expect('every-5-matches-minute-05', cronMatches(every5, at(2026, 11, 5, 0, 5)), true);
expect('every-5-rejects-minute-04', cronMatches(every5, at(2026, 11, 5, 0, 4)), false);

const weekdays9 = parseCron('0 9 * * 1-5');
const weekday = firstDay((d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5);
const weekend = firstDay((d) => d.getUTCDay() === 0);
expect('weekday-9am-matches-weekday', cronMatches(weekdays9, new Date(weekday.getTime() + 9 * 3600000)), true);
expect('weekday-9am-rejects-sunday', cronMatches(weekdays9, new Date(weekend.getTime() + 9 * 3600000)), false);

const orRule = parseCron('0 0 13 * 5');
const friday = firstDay((d) => d.getUTCDay() === 5 && d.getUTCDate() !== 13);
const monthThirteenth = firstDay((d) => d.getUTCDate() === 13 && d.getUTCDay() !== 5);
expect('dom-or-dow-matches-friday', cronMatches(orRule, friday), true);
expect('dom-or-dow-matches-thirteenth', cronMatches(orRule, monthThirteenth), true);

expect('step-range-minutes', [...parseCron('1-10/3 * * * *').minute], [1, 4, 7, 10]);
expect('list-minutes', [...parseCron('5,35 * * * *').minute], [5, 35]);
expect('start-step-runs-to-max', [...parseCron('50/5 * * * *').minute], [50, 55]);

expect('refuses-four-fields', throwsWith(() => parseCron('* * * *'), 'field-count'), true);
expect('refuses-out-of-range', throwsWith(() => parseCron('60 * * * *'), 'out-of-range'), true);
expect('refuses-zero-step', throwsWith(() => parseCron('*/0 * * * *'), 'bad-step'), true);
expect('refuses-non-string', throwsWith(() => parseCron(5), 'not-a-string'), true);
expect('refuses-garbage-field', throwsWith(() => parseCron('a * * * *'), 'bad-field'), true);

expect(
  'refuses-duplicate-name',
  throwsWith(() => parseCrons([{ name: 'a', schedule: '* * * * *' }, { name: 'a', schedule: '* * * * *' }]), 'duplicate-name'),
  true,
);

const crons = parseCrons([
  { name: 'respawn', schedule: '*/5 * * * *' },
  { name: 'economy', schedule: '30 * * * *' },
]);
expect('due-at-half-hour-both', dueCrons(crons, Date.UTC(2026, 10, 5, 0, 30, 42)), ['respawn', 'economy']);
expect('due-ignores-seconds', dueCrons(crons, Date.UTC(2026, 10, 5, 0, 30, 59)), ['respawn', 'economy']);
expect('due-quiet-minute', dueCrons(crons, Date.UTC(2026, 10, 5, 0, 31, 0)), []);

const result = failed === 0 ? 'PASS' : 'FAIL';
console.log(`checks ${checks} failed ${failed}`);
console.log(`RESULT: ${result}`);
process.exit(failed === 0 ? 0 : 1);
