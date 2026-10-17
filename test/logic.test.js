const test = require('node:test');
const assert = require('node:assert');
const L = require('../renderer/logic.js');

const S = { workdays: [1, 2, 3, 4, 5], hoursPerDay: 8, reactiveShare: 0.4, personalWeekday: 2, personalWeekend: 4 };

test('рабочие дни пропускают выходные', () => {
  // 2026-10-16 — пятница
  assert.strictEqual(L.addWorkdays('2026-10-16', 1), '2026-10-19');
  assert.strictEqual(L.addWorkdays('2026-10-19', -1), '2026-10-16');
  assert.strictEqual(L.workdaysBetween('2026-10-16', '2026-10-23'), 5);
  assert.strictEqual(L.workdaysBetween('2026-10-23', '2026-10-16'), -5);
  assert.strictEqual(L.weekStart('2026-10-18'), '2026-10-12');
});

test('план от дедлайна: этапы стыкуются без пропусков', () => {
  const plan = L.planBackward('2026-11-20', S);
  assert.deepStrictEqual(plan.print, { start: '2026-11-18', end: '2026-11-20' });
  assert.strictEqual(plan.presentation.end, '2026-11-17');
  assert.strictEqual(L.addWorkdays(plan.design.end, 1), plan.presentation.start);
  assert.strictEqual(L.addWorkdays(plan.analysis.end, 1), plan.design.start);
  assert.strictEqual(L.workdaysBetween(plan.analysis.start, plan.analysis.end) + 1, 5);
  assert.strictEqual(plan.closing.start, '2026-11-23');
});

test('дедлайн в выходной сдвигается на пятницу', () => {
  assert.strictEqual(L.planBackward('2026-11-22', S).print.end, '2026-11-20');
});

test('прогноз: опоздание и запас', () => {
  const late = L.forecast({ stage: 'analysis', stageStartedAt: '2026-10-19', deadline: '2026-10-30' }, S, '2026-10-19');
  assert.strictEqual(late.status, 'late');
  assert.ok(late.slack < 0);
  const ok = L.forecast({ stage: 'print', stageStartedAt: '2026-10-19', deadline: '2026-11-20' }, S, '2026-10-19');
  assert.strictEqual(ok.status, 'ok');
  assert.ok(ok.slack > 2);
});

test('круги правок сдвигают прогноз', () => {
  const base = { stage: 'presentation', stageStartedAt: '2026-10-19', deadline: '2026-11-20' };
  const a = L.forecast(base, S, '2026-10-19');
  const b = L.forecast({ ...base, rounds: { presentation: 3 } }, { ...S, roundDays: 2 }, '2026-10-19');
  assert.strictEqual(a.slack - b.slack, 4);
});

test('калибровка: нужно минимум 3 задачи, коэффициент ограничен', () => {
  const t = (est, min, type) => ({ status: 'done', estimate: est, manualMinutes: min, type, sessions: [] });
  assert.strictEqual(L.calibration([t(30, 60, 'texts')], 'texts').ratio, 1);
  const tasks = [t(30, 45, 'texts'), t(60, 90, 'texts'), t(30, 45, 'texts')];
  assert.strictEqual(L.calibration(tasks, 'texts').ratio, 1.5);
  assert.strictEqual(L.realisticMinutes({ estimate: 40, type: 'texts' }, tasks), 60);
  assert.strictEqual(L.calibration([t(10, 100), t(10, 100), t(10, 100)]).ratio, 3);
  assert.strictEqual(L.realisticMinutes({ estimate: 90, area: 'personal' }, tasks), 90);
});

test('ёмкость дня: буфер на внезапное и личное время', () => {
  assert.deepStrictEqual(L.dayCapacity('2026-10-19', S, 'work'), { total: 480, focus: 288, buffer: 192 });
  assert.strictEqual(L.dayCapacity('2026-10-18', S, 'work').total, 0);
  assert.strictEqual(L.dayCapacity('2026-10-18', S, 'personal').total, 240);
  assert.strictEqual(L.dayCapacity('2026-10-19', S, 'personal').total, 120);
});

test('загрузка дня: внезапные рабочие задачи не входят в план', () => {
  const tasks = [
    { plannedFor: '2026-10-19', status: 'todo', estimate: 60, sessions: [] },
    { plannedFor: '2026-10-19', status: 'todo', estimate: 30, unplanned: true, sessions: [] },
    { plannedFor: '2026-10-19', status: 'todo', estimate: 45, area: 'personal', sessions: [] },
  ];
  assert.strictEqual(L.dayLoad('2026-10-19', tasks, 'work'), 60);
  assert.strictEqual(L.dayLoad('2026-10-19', tasks, 'personal'), 45);
});

test('время сессий таймера', () => {
  const t = { sessions: [{ start: 0, end: 30 * 60000 }, { start: 0, end: 15 * 60000 }], manualMinutes: 5 };
  assert.strictEqual(L.actualMinutes(t), 50);
  assert.strictEqual(L.fmtMin(50), '50 мин');
  assert.strictEqual(L.fmtMin(125), '2 ч 5 мин');
});
