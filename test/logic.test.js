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

test('доска печати: ручной порядок, сортировка по сроку и перенос', () => {
  const cards = [
    { id: 'a', col: 'aziz', order: 0, due: '2026-11-05' },
    { id: 'b', col: 'aziz', order: 1, due: '2026-11-01' },
    { id: 'c', col: 'aziz', order: 2 },
    { id: 'd', col: 'aziz', order: 3, done: true, doneAt: 5 },
    { id: 'e', col: 'anvar', order: 0 },
  ];
  const ids = (col, sort) => L.boardColumn(cards, col, sort).map((c) => c.id).join('');
  assert.strictEqual(ids('aziz', 'manual'), 'abcd');
  assert.strictEqual(ids('aziz', 'due'), 'bacd');
  L.moveCard(cards, 'c', 'aziz', 'a'); // наверх
  assert.strictEqual(ids('aziz', 'manual'), 'cabd');
  L.moveCard(cards, 'e', 'aziz', 'b'); // из другой колонки между a и b
  assert.strictEqual(ids('aziz', 'manual'), 'caebd');
  assert.strictEqual(ids('anvar', 'manual'), '');
  L.moveCard(cards, 'a', 'anvar', null); // в конец пустой колонки
  assert.strictEqual(ids('anvar', 'manual'), 'a');
  assert.strictEqual(ids('aziz', 'manual'), 'cebd');
});

test('светофор проекта и матрица Эйзенхауэра', () => {
  const late = { id: 'p1', stage: 'analysis', stageStartedAt: '2026-10-19', deadline: '2026-10-30' };
  const ok = { id: 'p2', stage: 'print', stageStartedAt: '2026-10-19', deadline: '2026-11-20' };
  assert.strictEqual(L.ragStatus(late, S, '2026-10-19'), 'red');
  assert.strictEqual(L.ragStatus(ok, S, '2026-10-19'), 'green');
  assert.strictEqual(L.ragStatus({ ...ok, rag: 'amber' }, S, '2026-10-19'), 'amber'); // вручную
  assert.strictEqual(L.ragStatus({ ...ok, closed: true }, S, '2026-10-19'), 'gray');
  const pm = { p1: late, p2: ok };
  const q = (t) => L.eisenhower(t, pm, S, '2026-10-19');
  assert.strictEqual(q({ priority: 'A', due: '2026-10-20' }), 1);
  assert.strictEqual(q({ priority: 'A', due: '2026-11-10' }), 2);
  assert.strictEqual(q({ priority: 'B', due: '2026-10-21' }), 3);
  assert.strictEqual(q({ priority: 'B' }), 4);
  assert.strictEqual(q({ priority: 'B', projectId: 'p1' }), 2); // «красный» проект делает задачу важной
  assert.strictEqual(L.dueColor('2026-10-16', S, '2026-10-19'), 'red');
  assert.strictEqual(L.dueColor('2026-10-21', S, '2026-10-19'), 'amber');
  assert.strictEqual(L.dueColor('2026-10-30', S, '2026-10-19'), 'green');
  assert.strictEqual(L.dueColor('', S, '2026-10-19'), 'gray');
});

test('доска печати: цвет срочности и пауза', () => {
  const cards = [
    { id: 'a', col: 'x', order: 0, heat: 'pause' },
    { id: 'b', col: 'x', order: 1 },
    { id: 'c', col: 'x', order: 2, heat: 'fire', due: '2026-11-10' },
    { id: 'd', col: 'x', order: 3, heat: 'urgent', due: '2026-11-01' },
    { id: 'e', col: 'x', order: 4, heat: 'fire', due: '2026-11-02' },
  ];
  const ids = (sort) => L.boardColumn(cards, 'x', sort).map((c) => c.id).join('');
  assert.strictEqual(ids('manual'), 'bcdea'); // пауза уходит вниз, остальное — как расставили
  assert.strictEqual(ids('heat'), 'ecdba'); // горит (по сроку) → срочно → в работе → пауза
  assert.strictEqual(ids('due'), 'decba');
  assert.strictEqual(L.heatOf({}), 'normal');
});
