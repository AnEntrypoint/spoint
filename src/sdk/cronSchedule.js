const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
];

const PART = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

export class CronSyntaxError extends Error {
  constructor(reasonCode, detail) {
    super(`[cron] ${reasonCode}: ${detail}`);
    this.name = 'CronSyntaxError';
    this.reasonCode = reasonCode;
  }
}

function parseField(text, field) {
  const values = new Set();
  for (const part of text.split(',')) {
    const m = PART.exec(part);
    if (!m) throw new CronSyntaxError('bad-field', `${field.name}: ${part}`);
    const step = m[3] === undefined ? 1 : Number(m[3]);
    if (!(step >= 1)) throw new CronSyntaxError('bad-step', `${field.name}: ${part}`);
    const lo = m[1] === '*' ? field.min : Number(m[1]);
    const hi = m[2] !== undefined ? Number(m[2]) : m[1] === '*' || m[3] !== undefined ? field.max : lo;
    if (lo < field.min || hi > field.max || lo > hi) {
      throw new CronSyntaxError('out-of-range', `${field.name}: ${part}`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, wildcard: text === '*' };
}

export function parseCron(expr) {
  if (typeof expr !== 'string') throw new CronSyntaxError('not-a-string', typeof expr);
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) throw new CronSyntaxError('field-count', expr);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = FIELDS.map((f, i) => parseField(parts[i], f));
  return {
    expr,
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dayOfWeek.values,
    domRestricted: !dayOfMonth.wildcard,
    dowRestricted: !dayOfWeek.wildcard,
  };
}

export function cronMatches(cron, date) {
  if (!cron.minute.has(date.getUTCMinutes())) return false;
  if (!cron.hour.has(date.getUTCHours())) return false;
  if (!cron.month.has(date.getUTCMonth() + 1)) return false;
  const domOk = cron.dayOfMonth.has(date.getUTCDate());
  const dowOk = cron.dayOfWeek.has(date.getUTCDay());
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

export function parseCrons(entries) {
  const seen = new Set();
  return entries.map(({ name, schedule }) => {
    if (seen.has(name)) throw new CronSyntaxError('duplicate-name', name);
    seen.add(name);
    return { name, cron: parseCron(schedule) };
  });
}

export function dueCrons(crons, nowMs) {
  const minute = new Date(Math.floor(nowMs / 60000) * 60000);
  return crons.filter((c) => cronMatches(c.cron, minute)).map((c) => c.name);
}
