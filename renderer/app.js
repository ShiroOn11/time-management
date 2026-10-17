/* global Logic */
'use strict';

const L = Logic;
const bridge = window.api || {
  // Запасной вариант для просмотра в обычном браузере (без Electron).
  load: async () => {
    try { return JSON.parse(localStorage.getItem('tm-data')); } catch (e) { return null; }
  },
  save: async (d) => {
    try { localStorage.setItem('tm-data', JSON.stringify(d)); } catch (e) { /* нет хранилища */ }
  },
  exportData: async () => false,
  importData: async () => null,
  checkUpdate: async () => ({ ok: false, reason: 'browser' }),
  installUpdate: async () => ({ ok: false }),
  version: async () => 'dev',
  updateTray: () => {},
  on: () => {},
};

// ============================================================
// Состояние
// ============================================================

const DEFAULT_SETTINGS = {
  hoursPerDay: 8,
  reactiveShare: 0.4,
  workdays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '18:00',
  personalWeekday: 2,
  personalWeekend: 4,
  roundDays: 2,
  stageDays: {},
  templates: null,
  autoStageTasks: true,
  notifications: true,
};

const REVIEW_CHECKS = [
  ['inbox', 'Разобрать «Входящие» до нуля', 'У каждой задачи — проект или «Личное», оценка и день.'],
  ['projects', 'Пройти все активные проекты', 'Этап, прогноз, следующий конкретный шаг.'],
  ['waiting', 'Проверить «Жду ответа»', 'Кому напомнить в понедельник?'],
  ['load', 'Посмотреть загрузку следующей недели', 'Если красные дни — перенести или отказаться заранее.'],
  ['goals', 'Выбрать 3 главных результата недели', 'Работа и личное. Остальное — по остаточному принципу.'],
  ['airtable', 'Сверить статусы с Airtable', 'Чтобы команда видела то же, что и вы.'],
];

let S = null; // данные
const ui = {
  view: 'today',
  taskTab: 'open',
  taskArea: 'all',
  taskProject: '',
  projFilter: 'active',
  weekOffset: 0,
  reviewOffset: 0,
};
let lastNotified = {};
const upd = { info: null, progress: null, error: '', version: '' };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const today = () => L.todayISO();
const nowMs = () => Date.now();

function fresh() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    projects: [],
    tasks: [],
    timer: null,
    days: {},
    reviews: {},
    createdAt: nowMs(),
  };
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => bridge.save(S), 250);
}
function commit() {
  save();
  render();
}

const settings = () => S.settings;
const taskById = (id) => S.tasks.find((t) => t.id === id);
const projectById = (id) => S.projects.find((p) => p.id === id);
const projectsMap = () => Object.fromEntries(S.projects.map((p) => [p.id, p]));
const dayRec = (iso) => (S.days[iso] = S.days[iso] || {});
const templates = () => settings().templates || L.TEMPLATES;

// ============================================================
// Утилиты
// ============================================================

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WD = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const WD_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function fmtDate(iso, withWd) {
  if (!iso) return '';
  const d = L.parseISO(iso);
  const base = d.getDate() + ' ' + MONTHS_SHORT[d.getMonth()];
  return withWd ? WD_SHORT[d.getDay()] + ', ' + base : base;
}
function relDate(iso) {
  if (!iso) return '';
  const t = today();
  if (iso === t) return 'сегодня';
  if (iso === L.addDays(t, 1)) return 'завтра';
  if (iso === L.addDays(t, -1)) return 'вчера';
  return fmtDate(iso, true);
}
function hm(min) {
  min = Math.round(min);
  return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0');
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}
function timeToMin(hhmm) {
  const [h, m] = (hhmm || '0:0').split(':').map(Number);
  return h * 60 + m;
}
function nowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}
function notify(title, body) {
  if (!settings().notifications || typeof Notification === 'undefined') return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => window.focus();
  } catch (e) { /* уведомления недоступны */ }
}

// ============================================================
// Действия с задачами
// ============================================================

function newTask(fields) {
  const t = {
    id: uid(),
    title: '',
    area: 'work',
    type: 'other',
    category: 'home',
    person: '',
    projectId: '',
    estimate: 0,
    priority: 'B',
    due: '',
    plannedFor: '',
    status: 'todo',
    waitingFor: '',
    remindAt: '',
    unplanned: false,
    sessions: [],
    manualMinutes: 0,
    note: '',
    createdAt: nowMs(),
    doneAt: null,
    ...fields,
  };
  S.tasks.push(t);
  return t;
}

function startTimer(id) {
  if (S.timer && S.timer.taskId === id) return;
  stopTimer(true);
  const t = taskById(id);
  if (!t) return;
  t.sessions.push({ start: nowMs(), end: null });
  if (t.status === 'inbox') t.status = 'todo';
  if (!t.plannedFor) t.plannedFor = today();
  S.timer = { taskId: id };
  commit();
}

function stopTimer(silent) {
  if (!S.timer) return;
  const t = taskById(S.timer.taskId);
  if (t) {
    const open = t.sessions.find((s) => !s.end);
    if (open) open.end = nowMs();
  }
  S.timer = null;
  if (!silent) commit();
}

function toggleDone(id) {
  const t = taskById(id);
  if (!t) return;
  if (t.status === 'done') {
    t.status = 'todo';
    t.doneAt = null;
  } else {
    if (S.timer && S.timer.taskId === id) stopTimer(true);
    t.status = 'done';
    t.doneAt = nowMs();
    if (!t.plannedFor) t.plannedFor = today();
    const est = t.estimate;
    const act = L.actualMinutes(t);
    if (est && act) toast('Готово. Оценка ' + L.fmtMin(est) + ' → факт ' + L.fmtMin(act));
    else toast('Готово');
  }
  commit();
}

function deleteTask(id) {
  if (S.timer && S.timer.taskId === id) S.timer = null;
  S.tasks = S.tasks.filter((t) => t.id !== id);
  Object.values(S.days).forEach((d) => {
    if (d.frogId === id) d.frogId = null;
  });
  commit();
}

function openTasks(area) {
  return S.tasks.filter((t) => t.status !== 'done' && (!area || L.areaOf(t) === area));
}

// ============================================================
// Действия с проектами
// ============================================================

function createStageTasks(p, stageId) {
  const tpl = templates()[stageId] || [];
  const plan = p.deadline ? L.planBackward(p.deadline, settings())[stageId] : null;
  tpl.forEach(([title, est, type]) => {
    newTask({ title, estimate: est, type: type || 'other', projectId: p.id, due: plan ? plan.end : '', stage: stageId });
  });
  return tpl.length;
}

function advanceStage(id) {
  const p = projectById(id);
  const idx = L.stageIndex(p.stage);
  if (idx === L.STAGES.length - 1) {
    p.closed = true;
    p.closedAt = today();
    p.waiting = null;
    p.history.push({ stage: 'closed', at: today() });
    toast('Проект закрыт 🎉');
  } else {
    const next = L.STAGES[idx + 1].id;
    p.stage = next;
    p.stageStartedAt = today();
    p.history.push({ stage: next, at: today() });
    let n = 0;
    if (settings().autoStageTasks) n = createStageTasks(p, next);
    toast('Этап: ' + L.STAGES[idx + 1].name + (n ? ' · добавлено задач: ' + n : ''));
  }
  commit();
}

function addRound(id) {
  const p = projectById(id);
  p.rounds = p.rounds || {};
  const n = (p.rounds[p.stage] || 0) + 1;
  p.rounds[p.stage] = n;
  newTask({
    title: 'Правки, круг ' + n + ': передать фидбек и проверить результат',
    estimate: 45,
    type: 'control',
    projectId: p.id,
    due: L.addWorkdays(today(), settings().roundDays || 2, settings().workdays),
    stage: p.stage,
  });
  toast(n > 1 ? 'Круг правок ' + n + ' — прогноз сдвинут на ' + (settings().roundDays || 2) + ' р.д.' : 'Круг правок ' + n);
  commit();
}

// ============================================================
// Отрисовка
// ============================================================

const VIEWS = [
  ['today', '☀︎', 'Сегодня'],
  ['tasks', '☰', 'Задачи'],
  ['projects', '◧', 'Проекты'],
  ['week', '▦', 'Неделя'],
  ['review', '◎', 'Итоги недели'],
  ['guide', '?', 'Как пользоваться'],
  ['settings', '⚙︎', 'Настройки'],
];

function render() {
  renderNav();
  renderTimerBar();
  const v = document.getElementById('view');
  const scroll = v.scrollTop;
  const fn = { today: viewToday, tasks: viewTasks, projects: viewProjects, week: viewWeek, review: viewReview, guide: viewGuide, settings: viewSettings }[ui.view];
  v.innerHTML = fn();
  v.scrollTop = scroll;
}

function renderNav() {
  const inbox = S.tasks.filter((t) => t.status === 'inbox').length;
  const t = today();
  const tails = S.tasks.filter((x) => x.status !== 'done' && x.status !== 'inbox' && x.plannedFor && x.plannedFor < t).length;
  const late = S.projects.filter((p) => !p.closed && L.forecast(p, settings()).status === 'late').length;
  const counts = { today: tails ? [tails, true] : null, tasks: inbox ? [inbox, inbox > 5] : null, projects: late ? [late, true] : null };
  document.getElementById('nav').innerHTML = VIEWS.map(([id, ico, name]) => {
    const c = counts[id];
    return `<a class="${ui.view === id ? 'active' : ''}" data-act="go" data-v="${id}">
      <span class="ico">${ico}</span>${name}${c ? `<span class="count ${c[1] ? 'hot' : ''}">${c[0]}</span>` : ''}</a>`;
  }).join('');

  const tracked = S.tasks.reduce((sum, x) => sum + minutesOnDay(x, t), 0);
  const un = L.unplannedOn(t, S.tasks);
  document.getElementById('sidebarFoot').innerHTML = updateBadge() +
    `Сегодня в работе: <b>${L.fmtMin(tracked)}</b><br>Внезапных: <b>${un.count}</b>${un.minutes ? ' · ' + L.fmtMin(un.minutes) : ''}`;
}

function renderTimerBar() {
  const el = document.getElementById('timerBar');
  if (!S.timer) {
    el.innerHTML = '';
    return;
  }
  const t = taskById(S.timer.taskId);
  if (!t) {
    S.timer = null;
    el.innerHTML = '';
    return;
  }
  const open = t.sessions.find((s) => !s.end);
  el.innerHTML = `<div class="timer-bar">
    <span>⏱</span><span class="time" id="timerClock">${fmtClock(nowMs() - (open ? open.start : nowMs()))}</span>
    <span class="name">${esc(t.title)}${t.estimate ? ' · оценка ' + L.fmtMin(t.estimate) : ''}</span>
    <button data-act="stopTimer">■ Стоп</button>
    <button data-act="doneTimer">✓ Готово</button></div>`;
}

// ---------- фрагменты ----------

function taskMeta(t, opts = {}) {
  const tags = [];
  const p = t.projectId && projectById(t.projectId);
  if (t.priority === 'A') tags.push('<span class="tag prio-A">A</span>');
  if (L.areaOf(t) === 'personal') tags.push(`<span class="tag personal">${esc(L.PERSONAL[t.category] || 'Личное')}</span>`);
  else {
    if (p && !opts.noProject) tags.push(`<span class="tag project">${esc(p.name)}</span>`);
    if (t.type && t.type !== 'other') tags.push(`<span class="tag">${esc(L.TYPES[t.type])}</span>`);
    if (t.person) tags.push(`<span class="tag">${esc(t.person)}</span>`);
  }
  if (t.unplanned) tags.push('<span class="tag unplanned">внезапно</span>');
  const act = L.actualMinutes(t);
  if (t.estimate || act) {
    const real = L.realisticMinutes(t, S.tasks);
    let s = t.estimate ? L.fmtMin(t.estimate) : '';
    if (t.estimate && real > t.estimate * 1.15 && t.status !== 'done') s += ' (реально ~' + L.fmtMin(real) + ')';
    if (act) s += (s ? ' · ' : '') + 'факт ' + L.fmtMin(act);
    tags.push(`<span class="tag">${s}</span>`);
  }
  if (t.due && t.status !== 'done') {
    const late = t.due < today();
    tags.push(`<span class="tag ${late ? 'late' : t.due === today() ? 'warn' : ''}">срок ${relDate(t.due)}</span>`);
  }
  if (opts.showPlanned && t.plannedFor && t.status !== 'done') tags.push(`<span class="tag">в плане: ${relDate(t.plannedFor)}</span>`);
  if (t.status === 'waiting') {
    tags.push(`<span class="tag warn">жду: ${esc(t.waitingFor || '—')}${t.remindAt ? ' · напомнить ' + relDate(t.remindAt) : ''}</span>`);
  }
  return tags.join('');
}

function taskRow(t, opts = {}) {
  const running = S.timer && S.timer.taskId === t.id;
  const extra = opts.extra ? opts.extra(t) : '';
  return `<div class="task ${t.status === 'done' ? 'done' : ''} ${running ? 'running' : ''}" data-id="${t.id}">
    <button class="check" data-act="toggleDone" data-id="${t.id}" title="Выполнено">${t.status === 'done' ? '✓' : ''}</button>
    <div class="body" data-act="editTask" data-id="${t.id}">
      <div class="title">${esc(t.title)}</div>
      <div class="meta">${taskMeta(t, opts)}</div>
    </div>
    <div class="acts">
      ${extra}
      ${t.status !== 'done' ? (running
        ? `<button class="icon-btn stop" data-act="stopTimer" title="Остановить">■</button>`
        : `<button class="icon-btn play" data-act="startTimer" data-id="${t.id}" title="Начать (таймер)">▶</button>`) : ''}
    </div>
  </div>`;
}

function capBar(label, load, cap, kind, note) {
  const total = Math.max(cap.focus, 1);
  const over = load > cap.focus;
  const pct = Math.min(100, (load / total) * 100);
  return `<div class="cap">
    <div class="cap-top"><span>${label}</span><span><b>${L.fmtMin(load)}</b> из ${L.fmtMin(cap.focus)}</span></div>
    <div class="bar"><span class="${over ? 'over' : kind}" style="width:${pct}%"></span></div>
    ${over ? `<div class="cap-note bad">Перегруз на ${L.fmtMin(load - cap.focus)} — перенесите что-то на другой день</div>` : note ? `<div class="cap-note">${note}</div>` : ''}
  </div>`;
}

function minutesOnDay(t, iso) {
  let ms = 0;
  (t.sessions || []).forEach((s) => {
    if (L.toISO(new Date(s.start)) === iso) ms += (s.end || nowMs()) - s.start;
  });
  let m = ms / 60000;
  if (t.manualMinutes && t.doneAt && L.toISO(new Date(t.doneAt)) === iso) m += t.manualMinutes;
  return m;
}
function minutesInRange(t, from, toExcl) {
  let m = 0;
  for (let d = from; d < toExcl; d = L.addDays(d, 1)) m += minutesOnDay(t, d);
  return m;
}

// ---------- Сегодня ----------

function viewToday() {
  const t = today();
  const d = L.parseISO(t);
  const st = settings();
  const rec = dayRec(t);
  const frog = rec.frogId && taskById(rec.frogId);

  const capW = L.dayCapacity(t, st, 'work');
  const capP = L.dayCapacity(t, st, 'personal');
  const loadW = L.dayLoad(t, S.tasks, 'work');
  const loadP = L.dayLoad(t, S.tasks, 'personal');
  const un = L.unplannedOn(t, S.tasks);

  const planned = S.tasks.filter((x) => x.plannedFor === t && x.id !== rec.frogId && !(x.unplanned && L.areaOf(x) === 'work'));
  const work = planned.filter((x) => L.areaOf(x) === 'work').sort(byOrder);
  const personal = planned.filter((x) => L.areaOf(x) === 'personal').sort(byOrder);
  const workOpen = work.filter((x) => x.status !== 'done').length;
  const unplannedToday = S.tasks.filter((x) => x.unplanned && L.areaOf(x) === 'work' && L.toISO(new Date(x.createdAt)) === t);

  const tails = S.tasks.filter((x) => x.status !== 'done' && x.status !== 'inbox' && x.plannedFor && x.plannedFor < t);
  const waitingDue = S.tasks.filter((x) => x.status === 'waiting' && x.remindAt && x.remindAt <= t);
  const projWaiting = S.projects.filter((p) => !p.closed && p.waiting && p.waiting.remindAt && p.waiting.remindAt <= t);
  const risky = S.projects
    .filter((p) => !p.closed)
    .map((p) => ({ p, f: L.forecast(p, st) }))
    .filter((x) => x.f.status === 'late' || x.f.status === 'risk');
  const pm = projectsMap();
  const candidates = S.tasks
    .filter((x) => x.status === 'todo' && x.plannedFor !== t && !(x.plannedFor && x.plannedFor < t))
    .map((x) => ({ x, s: L.frogScore(x, pm, st, t) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6);
  const inboxCount = S.tasks.filter((x) => x.status === 'inbox').length;

  // утренний и вечерний баннеры
  let banner = '';
  const isWork = L.isWorkday(t, st.workdays);
  if (!rec.morningDone && nowMin() < timeToMin(st.workStart) + 240) {
    const s1 = inboxCount === 0;
    const s2 = !!frog;
    const s3 = work.length > 0;
    banner = `<div class="banner">
      <div><b>План на день · 5 минут</b><div class="hint">Минута планирования экономит до 10 минут работы (Б. Трейси)</div></div>
      <div class="steps">
        <div class="step ${s1 ? 'ok' : ''}"><span class="n">${s1 ? '✓' : 1}</span>${s1 ? 'Входящие пусты' : `<a href="#" data-act="go" data-v="tasks" data-tab="inbox">Разобрать входящие (${inboxCount})</a>`}</div>
        <div class="step ${s2 ? 'ok' : ''}"><span class="n">${s2 ? '✓' : 2}</span>Выбрать лягушку</div>
        <div class="step ${s3 ? 'ok' : ''}"><span class="n">${s3 ? '✓' : 3}</span>До 3 задач в план</div>
      </div>
      <button class="btn" data-act="morningDone">Готово</button></div>`;
  } else if (isWork && !rec.eveningDone && nowMin() >= timeToMin(st.workEnd) - 30) {
    const left = S.tasks.filter((x) => x.plannedFor === t && x.status !== 'done' && x.status !== 'waiting').length;
    banner = `<div class="banner evening">
      <div style="flex:1"><b>Закрыть рабочий день</b><div class="hint">${left ? 'Незавершённых в плане: ' + left + '. Перенесите их осознанно, а не держите в голове.' : 'Всё из плана сделано. Отличный день.'}</div></div>
      ${left ? '<button class="btn" data-act="moveLeftToTomorrow">Перенести на завтра</button>' : ''}
      <button class="btn" data-act="eveningDone">Закрыть день</button></div>`;
  }

  const frogCard = frog
    ? `<div class="card tint-frog"><h2>🐸 Лягушка дня <span class="right"><button class="btn ghost sm" data-act="clearFrog">сменить</button></span></h2>
        <div class="frog">
          <div style="min-width:0">
            <div class="t" style="${frog.status === 'done' ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(frog.title)}</div>
            <div class="task" style="padding:4px 0;border:0;background:none"><div class="meta">${taskMeta(frog)}</div></div>
          </div>
          <div class="actions">
            ${frog.status === 'done' ? '<span class="hint">Съедена ✓ — дальше всё проще</span>' : `
              ${S.timer && S.timer.taskId === frog.id ? '<button class="btn" data-act="stopTimer">■ Пауза</button>' : `<button class="btn frog" data-act="startTimer" data-id="${frog.id}">▶ Начать</button>`}
              <button class="btn" data-act="toggleDone" data-id="${frog.id}">✓ Сделано</button>`}
          </div>
        </div></div>`
    : `<div class="card tint-frog"><h2>🐸 Лягушка дня</h2>
        <div class="hint" style="margin-bottom:10px">Самая важная и неприятная задача. Сделайте её первой, до почты и мессенджеров.</div>
        ${candidates.length ? `<div class="chips">${candidates.slice(0, 4).map((c) => `<button class="chip" data-act="setFrog" data-id="${c.x.id}">${esc(c.x.title)}</button>`).join('')}</div>` : '<div class="empty">Добавьте задачи с приоритетом A — и здесь появятся кандидаты.</div>'}
      </div>`;

  const unByPerson = {};
  unplannedToday.forEach((x) => {
    const k = x.person || 'Без отметки';
    unByPerson[k] = (unByPerson[k] || 0) + 1;
  });

  return `
    <div class="view-head"><div><div class="greet">${greeting()}</div><h1>${WD[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}</h1>
      <div class="sub">${isWork ? 'Рабочий день' : 'Выходной'} · ${planned.filter((x) => x.status === 'done').length + (frog && frog.status === 'done' ? 1 : 0)} из ${planned.length + (frog ? 1 : 0)} в плане сделано</div></div>
      <div class="spacer"></div>
      <button class="btn" data-act="newTask" data-planned="${t}">＋ Задача на сегодня</button>
    </div>
    ${banner}
    <div class="grid-today">
      <div class="col">
        ${frogCard}
        <div class="card">
          <h2>Работа · план <span class="right">${workOpen > 3 ? '<span class="tag warn">больше 3 задач — что-то лишнее?</span>' : ''}</span></h2>
          ${work.length ? work.map((x) => taskRow(x, { extra: unplanBtn })).join('') : '<div class="empty">Пока пусто. Добавьте 2–3 задачи из списка справа или нажмите «＋ Задача на сегодня».</div>'}
        </div>
        <div class="card">
          <h2>Личное <span class="right"><button class="btn ghost sm" data-act="newTask" data-planned="${t}" data-area="personal">＋ добавить</button></span></h2>
          ${personal.length ? personal.map((x) => taskRow(x, { extra: unplanBtn })).join('') : '<div class="empty">Спорт, семья, дела, учёба — запишите хотя бы одно, иначе работа съест всё время.</div>'}
        </div>
        <div class="card">
          <h2>Внезапное сегодня <span class="right">${un.count ? un.count + ' · ' + L.fmtMin(un.minutes) : ''}</span></h2>
          ${unplannedToday.length ? `
            <div class="chips" style="margin-bottom:8px">${Object.entries(unByPerson).map(([k, v]) => `<span class="tag">${esc(k)}: ${v}</span>`).join('')}</div>
            ${unplannedToday.map((x) => taskRow(x, { showPlanned: true })).join('')}`
            : '<div class="empty">Звонок, просьба дизайнера, правка от клиента — жмите ⌥⌘N и записывайте. Через неделю увидите, сколько времени это съедает на самом деле.</div>'}
        </div>
      </div>
      <div class="col side">
        <div class="card">
          <h2>Загрузка дня</h2>
          ${capBar('Работа (план)', loadW, capW, '', capW.buffer ? `+ буфер ${L.fmtMin(capW.buffer)} на внезапное · уже ушло ${L.fmtMin(un.minutes)}` : 'Выходной — работу лучше не планировать')}
          ${capBar('Личное', loadP, capP, 'personal')}
        </div>
        ${tails.length ? `<div class="card tint-warn"><h2>Хвосты с прошлых дней · ${tails.length}</h2>
          ${tails.map((x) => taskRow(x, { showPlanned: true, extra: (z) => `<button class="btn sm" data-act="planToday" data-id="${z.id}">сегодня</button><button class="btn sm" data-act="unplan" data-id="${z.id}">снять</button>` })).join('')}
          <div style="margin-top:8px;display:flex;gap:6px"><button class="btn sm" data-act="tailsToday">Все на сегодня</button><button class="btn sm" data-act="tailsUnplan">Все в общий список</button></div></div>` : ''}
        ${waitingDue.length || projWaiting.length ? `<div class="card"><h2>Пора напомнить</h2>
          ${projWaiting.map((p) => `<div class="task"><div class="body" data-act="openProject" data-id="${p.id}"><div class="title">${esc(p.name)}: ${esc(p.waiting.note || 'жду клиента')}</div>
            <div class="meta"><span class="tag warn">ждём ${L.workdaysBetween(p.waiting.since, t, st.workdays)} р.д.</span></div></div>
            <div class="acts" style="opacity:1"><button class="btn sm" data-act="snoozeProjectWait" data-id="${p.id}">+2 дня</button><button class="btn sm" data-act="clientReplied" data-id="${p.id}">ответил</button></div></div>`).join('')}
          ${waitingDue.map((x) => taskRow(x, { extra: (z) => `<button class="btn sm" data-act="snoozeWait" data-id="${z.id}">+2 дня</button><button class="btn sm" data-act="gotReply" data-id="${z.id}">ответили</button>` })).join('')}
        </div>` : ''}
        ${risky.length ? `<div class="card"><h2>Проекты под риском</h2>
          ${risky.map(({ p, f }) => `<div class="task"><div class="body" data-act="openProject" data-id="${p.id}">
            <div class="title">${esc(p.name)}</div>
            <div class="meta"><span class="tag ${f.status === 'late' ? 'late' : 'warn'}">${f.status === 'late' ? 'опоздание ' + -f.slack + ' р.д.' : f.lateStage ? 'этап просрочен на ' + f.lateStage + ' р.д.' : 'запас ' + f.slack + ' р.д.'}</span><span class="tag">${L.STAGES[L.stageIndex(p.stage)].short}</span></div></div></div>`).join('')}
        </div>` : ''}
        <div class="card"><h2>Взять в план</h2>
          ${candidates.length ? candidates.map(({ x }) => taskRow(x, { extra: (z) => `<button class="btn sm" data-act="planToday" data-id="${z.id}">＋ сегодня</button>` })).join('') : '<div class="empty">Нет открытых задач вне плана.</div>'}
        </div>
      </div>
    </div>`;
}
function unplanBtn(t) {
  return t.status !== 'done' ? `<button class="icon-btn" data-act="toTomorrow" data-id="${t.id}" title="На завтра">→</button>` : '';
}
function byOrder(a, b) {
  const done = (a.status === 'done') - (b.status === 'done');
  if (done) return done;
  const pr = (a.priority || 'B').localeCompare(b.priority || 'B');
  if (pr) return pr;
  return a.createdAt - b.createdAt;
}

// ---------- Задачи ----------

function viewTasks() {
  const t = today();
  const tabs = [
    ['inbox', 'Входящие', S.tasks.filter((x) => x.status === 'inbox').length],
    ['open', 'Открытые', S.tasks.filter((x) => x.status === 'todo').length],
    ['waiting', 'Жду ответа', S.tasks.filter((x) => x.status === 'waiting').length],
    ['done', 'Выполненные', null],
  ];
  let list = S.tasks.filter((x) => (ui.taskTab === 'open' ? x.status === 'todo' : x.status === ui.taskTab));
  if (ui.taskArea !== 'all') list = list.filter((x) => L.areaOf(x) === ui.taskArea);
  if (ui.taskProject) list = list.filter((x) => x.projectId === ui.taskProject);
  if (ui.taskTab === 'done') {
    list.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    list = list.slice(0, 150);
  } else list.sort((a, b) => (a.priority || 'B').localeCompare(b.priority || 'B') || (a.due || '9').localeCompare(b.due || '9') || a.createdAt - b.createdAt);

  const hints = {
    inbox: 'Сюда падает всё, что записано на бегу. Разбирайте раз в день: проект, оценка, день — или удалить.',
    open: 'Все дела, которые ещё не сделаны. Перетащите их на дни во вкладке «Неделя».',
    waiting: 'Мяч на чужой стороне. У каждой задачи должна быть дата «напомнить», иначе она зависнет.',
    done: 'Последние выполненные. Отсюда считается ваш личный коэффициент «оценка → факт».',
  };
  const activeProjects = S.projects.filter((p) => !p.closed);

  return `
    <div class="view-head"><div><h1>Задачи</h1><div class="sub">${hints[ui.taskTab]}</div></div>
      <div class="spacer"></div><button class="btn primary" data-act="newTask">＋ Задача</button></div>
    <div class="tabs">${tabs.map(([id, n, c]) => `<button class="${ui.taskTab === id ? 'on' : ''}" data-act="taskTab" data-tab="${id}">${n}${c ? ' · ' + c : ''}</button>`).join('')}</div>
    <div style="display:flex;gap:10px;margin-bottom:12px;align-items:center">
      <div class="seg">${[['all', 'Всё'], ['work', 'Работа'], ['personal', 'Личное']].map(([k, n]) => `<button class="${ui.taskArea === k ? 'on' : ''}" data-act="taskArea" data-k="${k}">${n}</button>`).join('')}</div>
      <select class="input" style="width:240px" data-change="taskProject"><option value="">Все проекты</option>
        ${activeProjects.map((p) => `<option value="${p.id}" ${ui.taskProject === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    </div>
    <div class="card">${list.length ? list.map((x) => taskRow(x, {
      showPlanned: true,
      extra: (z) => (z.status === 'inbox'
        ? `<button class="btn sm" data-act="editTask" data-id="${z.id}">Разобрать</button>`
        : z.status === 'todo' && z.plannedFor !== t ? `<button class="btn sm" data-act="planToday" data-id="${z.id}">＋ сегодня</button>` : ''),
    })).join('') : '<div class="empty">Здесь пусто.</div>'}</div>`;
}

// ---------- Проекты ----------

function viewProjects() {
  const st = settings();
  let list = S.projects.filter((p) => (ui.projFilter === 'active' ? !p.closed : p.closed));
  const order = { late: 0, risk: 1, ok: 2, nodeadline: 3, closed: 4 };
  list = list.map((p) => ({ p, f: L.forecast(p, st) })).sort((a, b) => order[a.f.status] - order[b.f.status] || (a.p.deadline || '9').localeCompare(b.p.deadline || '9'));
  const active = S.projects.filter((p) => !p.closed);
  const inDesign = active.filter((p) => p.stage === 'design').length;

  return `
    <div class="view-head"><div><h1>Проекты</h1>
      <div class="sub">Только ваш взгляд: сроки этапов назад от сдачи в печать, прогноз и «мяч у клиента». Полная база — в Airtable.</div></div>
      <div class="spacer"></div>
      <div class="seg">${[['active', 'Активные · ' + active.length], ['closed', 'Закрытые']].map(([k, n]) => `<button class="${ui.projFilter === k ? 'on' : ''}" data-act="projFilter" data-k="${k}">${n}</button>`).join('')}</div>
      <button class="btn primary" data-act="newProject">＋ Проект</button></div>
    ${inDesign >= 4 ? `<div class="banner" style="background:var(--warn-soft)"><div>В дизайне одновременно <b>${inDesign}</b> проекта. Каждое переключение между проектами стоит ~20 минут на «вход». Сгруппируйте проверки по дням.</div></div>` : ''}
    ${list.length ? `<div class="projects">${list.map(({ p, f }) => projectCard(p, f)).join('')}</div>` : `<div class="card"><div class="empty">${ui.projFilter === 'active' ? 'Добавьте проекты, которые ведёте лично. Достаточно названия и даты сдачи в печать — план этапов посчитается сам.' : 'Закрытых проектов пока нет.'}</div></div>`}`;
}

function forecastTag(f) {
  if (f.status === 'closed') return '<span class="tag">закрыт</span>';
  if (f.status === 'nodeadline') return '<span class="tag">нет даты сдачи</span>';
  if (f.slack == null) return '<span class="tag project">после сдачи</span>';
  if (f.status === 'late') return `<span class="tag late">опоздание ${-f.slack} р.д.</span>`;
  if (f.status === 'risk') return `<span class="tag warn">${f.lateStage ? 'этап просрочен ' + f.lateStage + ' р.д.' : 'запас ' + f.slack + ' р.д.'}</span>`;
  return `<span class="tag project">запас ${f.slack} р.д.</span>`;
}

function projectCard(p, f) {
  const st = settings();
  const idx = L.stageIndex(p.stage);
  const tasks = S.tasks.filter((x) => x.projectId === p.id);
  const open = tasks.filter((x) => x.status !== 'done').length;
  const spent = tasks.reduce((s, x) => s + L.actualMinutes(x), 0);
  const rounds = (p.rounds && p.rounds[p.stage]) || 0;
  const totalRounds = Object.values(p.rounds || {}).reduce((a, b) => a + b, 0);
  const canRound = !p.closed && ['design', 'presentation', 'print'].includes(p.stage);
  const nextName = idx < L.STAGES.length - 1 ? L.STAGES[idx + 1].short : null;
  return `<div class="card project">
    <div class="head"><div style="min-width:0"><h3>${esc(p.name)}</h3><div class="client">${esc(p.client || '')}</div></div>
      <div class="badges">${forecastTag(f)}${p.waiting ? `<span class="tag warn">мяч у клиента · ${L.workdaysBetween(p.waiting.since, today(), st.workdays)} р.д.</span>` : ''}</div></div>
    <div class="pipeline">${L.STAGES.map((s, i) => `<span class="${p.closed || i < idx ? 'past' : i === idx ? 'cur' : ''}"></span>`).join('')}</div>
    <div class="pipeline-labels">${L.STAGES.map((s, i) => `<span class="${!p.closed && i === idx ? 'cur' : ''}">${s.short}</span>`).join('')}</div>
    <dl class="kv">
      <dt>Сдача в печать</dt><dd>${p.deadline ? fmtDate(p.deadline, true) : '—'}</dd>
      ${!p.closed && f.plannedStage ? `<dt>Этап по плану до</dt><dd>${fmtDate(f.plannedStage.end, true)}</dd>` : ''}
      ${!p.closed && f.end && f.slack != null ? `<dt>Прогноз сдачи</dt><dd>${fmtDate(f.end, true)}</dd>` : ''}
      <dt>Задачи / время</dt><dd>${open} открыто · ${L.fmtMin(spent)}</dd>
      ${totalRounds ? `<dt>Круги правок</dt><dd>${rounds ? 'на этапе: ' + rounds + ' · ' : ''}всего ${totalRounds}</dd>` : ''}
    </dl>
    <div class="foot">
      ${p.closed ? '' : `<button class="btn primary sm" data-act="advance" data-id="${p.id}">${nextName ? '→ ' + nextName : '✓ Закрыть проект'}</button>
      ${p.waiting ? `<button class="btn sm" data-act="clientReplied" data-id="${p.id}">Клиент ответил</button>` : `<button class="btn sm" data-act="waitClient" data-id="${p.id}">Жду клиента</button>`}
      ${canRound ? `<button class="btn sm" data-act="addRound" data-id="${p.id}">＋ Круг правок</button>` : ''}`}
      <button class="btn ghost sm" data-act="openProject" data-id="${p.id}" style="margin-left:auto">Открыть</button>
    </div></div>`;
}

// ---------- Неделя ----------

function viewWeek() {
  const st = settings();
  const t = today();
  const start = L.addDays(L.weekStart(t), ui.weekOffset * 7);
  const days = [...Array(7)].map((_, i) => L.addDays(start, i));
  const end = L.addDays(start, 7);
  const pool = S.tasks.filter((x) => x.status === 'todo' && !x.plannedFor).sort(byOrder);

  const milestones = {};
  S.projects.filter((p) => !p.closed && p.deadline).forEach((p) => {
    const plan = L.planBackward(p.deadline, st);
    const cur = plan[p.stage];
    if (cur) (milestones[cur.end] = milestones[cur.end] || []).push({ cls: '', text: 'Конец этапа «' + L.STAGES[L.stageIndex(p.stage)].short + '»: ' + p.name });
    const dl = L.snapWorkday(p.deadline, -1, st.workdays);
    (milestones[dl] = milestones[dl] || []).push({ cls: 'deadline', text: 'Сдача в печать: ' + p.name });
  });

  let weekLoad = 0;
  let weekCap = 0;
  days.forEach((d) => {
    weekLoad += L.dayLoad(d, S.tasks, 'work');
    weekCap += L.dayCapacity(d, st, 'work').focus;
  });

  const col = (d) => {
    const capW = L.dayCapacity(d, st, 'work');
    const capP = L.dayCapacity(d, st, 'personal');
    const lw = L.dayLoad(d, S.tasks, 'work');
    const lp = L.dayLoad(d, S.tasks, 'personal');
    const tasks = S.tasks.filter((x) => x.plannedFor === d && !(x.unplanned && L.areaOf(x) === 'work')).sort(byOrder);
    const over = lw > capW.focus && lw > 0;
    const dd = L.parseISO(d);
    return `<div class="week-col ${d === t ? 'today' : ''} ${capW.total ? '' : 'off'} ${over ? 'over' : ''}" data-drop="${d}">
      <div class="dh"><span>${WD_SHORT[dd.getDay()]}</span><span class="d">${dd.getDate()} ${MONTHS_SHORT[dd.getMonth()]}</span></div>
      ${capW.total ? `<div class="bar"><span class="${over ? 'over' : ''}" style="width:${Math.min(100, (lw / Math.max(capW.focus, 1)) * 100)}%"></span></div>
        <div class="mini">${hm(lw)} из ${hm(capW.focus)}</div>` : '<div class="mini">выходной</div>'}
      <div class="bar" style="height:4px"><span class="personal" style="width:${Math.min(100, (lp / Math.max(capP.focus, 1)) * 100)}%"></span></div>
      ${(milestones[d] || []).map((m) => `<div class="milestone ${m.cls}">${esc(m.text)}</div>`).join('')}
      ${tasks.map(wtask).join('')}
      <button class="btn ghost sm" data-act="newTask" data-planned="${d}">＋</button>
    </div>`;
  };

  return `
    <div class="view-head"><div><h1>Неделя</h1>
      <div class="sub">Перетаскивайте задачи на дни. Красная колонка — перегруз: перенесите заранее, а не в последний вечер.</div></div>
      <div class="spacer"></div>
      <span class="hint">Работа на неделю: <b>${L.fmtMin(weekLoad)}</b> из ${L.fmtMin(weekCap)}</span>
      <button class="btn" data-act="week" data-d="-1">‹</button>
      <button class="btn" data-act="week" data-d="0">${fmtDate(start)} – ${fmtDate(L.addDays(end, -1))}</button>
      <button class="btn" data-act="week" data-d="1">›</button></div>
    <div class="week">
      <div class="week-col" data-drop="">
        <div class="dh"><span>Без дня</span><span class="d">${pool.length}</span></div>
        <div class="mini">Открытые задачи без даты. Перетащите на день.</div>
        ${pool.map(wtask).join('')}
      </div>
      ${days.map(col).join('')}
    </div>`;
}

function wtask(x) {
  const p = x.projectId && projectById(x.projectId);
  const real = L.realisticMinutes(x, S.tasks);
  return `<div class="wtask ${L.areaOf(x) === 'personal' ? 'personal' : ''} ${x.status === 'done' ? 'done' : ''}" draggable="true" data-drag="${x.id}" data-act="editTask" data-id="${x.id}">
    ${x.priority === 'A' ? '<b style="color:var(--danger)">A</b> ' : ''}${esc(x.title)}
    <div class="m">${p ? esc(p.name) + ' · ' : ''}${real ? L.fmtMin(real) : 'без оценки'}</div></div>`;
}

// ---------- Итоги недели ----------

function viewReview() {
  const st = settings();
  const start = L.addDays(L.weekStart(today()), ui.reviewOffset * 7);
  const end = L.addDays(start, 7);
  const rev = (S.reviews[start] = S.reviews[start] || { checks: {}, goals: ['', '', ''], note: '' });

  let work = 0;
  let personal = 0;
  const byCat = {};
  const byProject = {};
  S.tasks.forEach((x) => {
    const m = minutesInRange(x, start, end);
    if (!m) return;
    if (L.areaOf(x) === 'personal') {
      personal += m;
      byCat[x.category] = (byCat[x.category] || 0) + m;
    } else {
      work += m;
      const k = x.projectId || '';
      byProject[k] = (byProject[k] || 0) + m;
    }
  });
  const done = S.tasks.filter((x) => x.doneAt && L.toISO(new Date(x.doneAt)) >= start && L.toISO(new Date(x.doneAt)) < end);
  const unpl = S.tasks.filter((x) => x.unplanned && L.areaOf(x) === 'work' && L.toISO(new Date(x.createdAt)) >= start && L.toISO(new Date(x.createdAt)) < end);
  const unMin = unpl.reduce((s, x) => s + L.actualMinutes(x), 0);
  const byPerson = {};
  unpl.forEach((x) => {
    const k = x.person || 'Без отметки';
    byPerson[k] = byPerson[k] || { n: 0, m: 0 };
    byPerson[k].n++;
    byPerson[k].m += L.actualMinutes(x);
  });
  const frogs = [];
  for (let d = start; d < end; d = L.addDays(d, 1)) {
    const f = S.days[d] && S.days[d].frogId && taskById(S.days[d].frogId);
    if (f) frogs.push(f);
  }
  const frogsDone = frogs.filter((f) => f.status === 'done').length;

  // калибровка по типам — за всё время
  const calRows = Object.keys(L.TYPES).map((k) => {
    const sample = S.tasks.filter((x) => x.type === k && L.areaOf(x) === 'work' && x.status === 'done' && x.estimate > 0 && L.actualMinutes(x) > 0);
    const est = sample.reduce((s, x) => s + x.estimate, 0);
    const act = sample.reduce((s, x) => s + L.actualMinutes(x), 0);
    return { k, n: sample.length, est, act, ratio: est ? act / est : 0 };
  }).filter((r) => r.n);

  // реальная доля внезапного за последние 10 рабочих дней
  let sumUn = 0;
  let sumCap = 0;
  let dcur = today();
  for (let i = 0; i < 10; i++) {
    dcur = L.addWorkdays(dcur, -1, st.workdays);
    sumUn += L.unplannedOn(dcur, S.tasks).minutes;
    sumCap += L.dayCapacity(dcur, st, 'work').total;
  }
  const realShare = sumCap ? sumUn / sumCap : 0;

  const maxProj = Math.max(1, ...Object.values(byProject));
  const maxCat = Math.max(1, ...Object.values(byCat));
  const maxPerson = Math.max(1, ...Object.values(byPerson).map((v) => v.m));
  const checksDone = REVIEW_CHECKS.filter(([k]) => rev.checks[k]).length;

  return `
    <div class="view-head"><div><h1>Итоги недели</h1>
      <div class="sub">15 минут в пятницу. Без еженедельного обзора любая система разваливается за 2–3 недели (Д. Аллен, GTD).</div></div>
      <div class="spacer"></div>
      <button class="btn" data-act="review" data-d="-1">‹</button>
      <button class="btn" data-act="review" data-d="0">${fmtDate(start)} – ${fmtDate(L.addDays(end, -1))}</button>
      <button class="btn" data-act="review" data-d="1">›</button></div>
    <div class="stats">
      <div class="card stat"><div class="v">${L.fmtMin(work)}</div><div class="l">работа по таймеру</div></div>
      <div class="card stat"><div class="v" style="color:var(--personal)">${L.fmtMin(personal)}</div><div class="l">личное по таймеру</div></div>
      <div class="card stat"><div class="v">${done.length}</div><div class="l">задач выполнено</div></div>
      <div class="card stat"><div class="v">${frogsDone}/${frogs.length}</div><div class="l">лягушек съедено</div></div>
    </div>
    <div class="grid-today">
      <div class="col">
        <div class="card"><h2>Обзор <span class="right">${checksDone}/${REVIEW_CHECKS.length}</span></h2>
          <div class="checklist">${REVIEW_CHECKS.map(([k, t, d]) => `<label><input type="checkbox" data-change="reviewCheck" data-k="${k}" data-w="${start}" ${rev.checks[k] ? 'checked' : ''}>
            <div><div>${t}</div><div class="d">${d}</div></div></label>`).join('')}</div></div>
        <div class="card"><h2>3 главных результата следующей недели</h2>
          ${[0, 1, 2].map((i) => `<input class="input" style="margin-bottom:8px" placeholder="${['Например: сдать в печать проект X', 'Например: согласовать дизайн Y', 'Например: 3 тренировки'][i]}" value="${esc(rev.goals[i])}" data-change="reviewGoal" data-i="${i}" data-w="${start}">`).join('')}
          <textarea class="input" placeholder="Что мешало? Что изменить на следующей неделе?" data-change="reviewNote" data-w="${start}">${esc(rev.note)}</textarea></div>
        <div class="card"><h2>Время по проектам</h2>
          ${Object.keys(byProject).length ? `<table class="table">${Object.entries(byProject).sort((a, b) => b[1] - a[1]).map(([id, m]) => `<tr><td>${esc(id ? (projectById(id) || {}).name || '—' : 'Без проекта')}</td>
            <td style="width:40%"><div class="hbar" style="width:${(m / maxProj) * 100}%"></div></td><td class="num">${L.fmtMin(m)}</td></tr>`).join('')}</table>` : '<div class="empty">Запускайте таймер ▶ на задачах — здесь появится картина.</div>'}</div>
      </div>
      <div class="col">
        <div class="card"><h2>Внезапное за неделю</h2>
          <div style="font-size:20px;font-weight:700">${unpl.length} · ${L.fmtMin(unMin)}</div>
          <div class="hint" style="margin-bottom:10px">Средняя доля внезапного за 10 рабочих дней: <b>${Math.round(realShare * 100)}%</b>, в настройках буфер ${Math.round(st.reactiveShare * 100)}%.
            ${sumUn && Math.abs(realShare - st.reactiveShare) > 0.1 ? `<br><a href="#" data-act="applyShare" data-v="${Math.round(realShare * 20) / 20}">Поставить буфер ${Math.round(realShare * 20) * 5}%</a>` : ''}</div>
          ${Object.keys(byPerson).length ? `<table class="table">${Object.entries(byPerson).sort((a, b) => b[1].m - a[1].m).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td>
            <td style="width:35%"><div class="hbar warn" style="width:${(v.m / maxPerson) * 100}%"></div></td><td class="num">${L.fmtMin(v.m)}</td></tr>`).join('')}</table>` : ''}</div>
        <div class="card"><h2>Точность оценок</h2>
          ${calRows.length ? `<table class="table"><tr><th>Тип</th><th class="num">задач</th><th class="num">оценка → факт</th><th class="num">×</th></tr>
            ${calRows.map((r) => `<tr><td>${L.TYPES[r.k]}</td><td class="num">${r.n}</td><td class="num">${L.fmtMin(r.est)} → ${L.fmtMin(r.act)}</td>
            <td class="num" style="color:${r.ratio > 1.3 ? 'var(--danger)' : 'inherit'};font-weight:700">${r.ratio.toFixed(2)}</td></tr>`).join('')}</table>
            <div class="hint" style="margin-top:8px">Коэффициент автоматически применяется к оценкам: «реально ~…» в задачах и загрузке дня.</div>`
            : '<div class="empty">Ставьте оценку и запускайте таймер. После 3 задач появится ваш личный коэффициент — люди почти всегда недооценивают время (ошибка планирования).</div>'}</div>
        <div class="card"><h2>Личное</h2>
          ${Object.keys(byCat).length ? `<table class="table">${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, m]) => `<tr><td>${esc(L.PERSONAL[k] || k)}</td>
            <td style="width:40%"><div class="hbar personal" style="width:${(m / maxCat) * 100}%"></div></td><td class="num">${L.fmtMin(m)}</td></tr>`).join('')}</table>` : '<div class="empty">Личного времени по таймеру на этой неделе нет.</div>'}</div>
      </div>
    </div>`;
}

// ---------- Настройки ----------

function viewSettings() {
  const st = settings();
  const sd = L.stageDays(st);
  const tpl = templates();
  return `
    <div class="view-head"><div><h1>Настройки</h1><div class="sub">Данные хранятся только на этом Mac. Резервная копия — каждый день, 30 последних.</div></div></div>
    <div class="settings">
      <div class="card"><h2>Рабочее время</h2>
        <div class="row">
          <div class="field"><label>Часов работы в день</label><input class="input" type="number" min="1" max="16" step="0.5" value="${st.hoursPerDay}" data-change="set" data-k="hoursPerDay" data-num="1"></div>
          <div class="field"><label>Буфер на внезапное, %</label><input class="input" type="number" min="0" max="90" step="5" value="${Math.round(st.reactiveShare * 100)}" data-change="setShare"></div>
          <div class="field"><label>Начало дня</label><input class="input" type="time" value="${st.workStart}" data-change="set" data-k="workStart"></div>
          <div class="field"><label>Конец дня</label><input class="input" type="time" value="${st.workEnd}" data-change="set" data-k="workEnd"></div>
        </div>
        <div class="field"><label>Рабочие дни</label><div class="wd">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label><input type="checkbox" data-change="workday" data-d="${d}" ${st.workdays.includes(d) ? 'checked' : ''}>${WD_SHORT[d]}</label>`).join('')}</div></div>
        <div class="hint">Буфер — часть дня, которую вы не планируете: звонки, просьбы команды, правки. Для проджект-менеджера 40–50% — нормально. Реальную долю покажет «Итоги недели».</div>
      </div>
      <div class="card"><h2>Личное время</h2>
        <div class="row">
          <div class="field"><label>Часов в будни</label><input class="input" type="number" min="0" max="12" step="0.5" value="${st.personalWeekday}" data-change="set" data-k="personalWeekday" data-num="1"></div>
          <div class="field"><label>Часов в выходные</label><input class="input" type="number" min="0" max="16" step="0.5" value="${st.personalWeekend}" data-change="set" data-k="personalWeekend" data-num="1"></div>
        </div></div>
      <div class="card"><h2>Длительность этапов (рабочие дни)</h2>
        <div class="row">${L.STAGES.map((s) => `<div class="field"><label>${s.short}</label><input class="input" type="number" min="1" max="60" value="${sd[s.id]}" data-change="stageDays" data-k="${s.id}"></div>`).join('')}</div>
        <div class="row"><div class="field" style="max-width:240px"><label>+ дней за каждый круг правок после первого</label><input class="input" type="number" min="0" max="10" value="${st.roundDays}" data-change="set" data-k="roundDays" data-num="1"></div><div></div></div>
        <div class="hint">По вашим словам: анализ с дебрифом ~5 дней, анализ + дизайн ~14 дней, печать 2–3 дня. Дата сдачи в печать — конец этапа «Печать», план считается назад от неё.</div>
      </div>
      <div class="card"><h2>Шаблоны задач по этапам</h2>
        <label style="display:flex;gap:8px;margin-bottom:12px"><input type="checkbox" data-change="autoStageTasks" ${st.autoStageTasks ? 'checked' : ''}> Создавать задачи этапа автоматически при переходе</label>
        ${L.STAGES.map((s) => `<div class="field"><label>${s.name} — одна задача в строке: «Название | минуты | тип»</label>
          <textarea class="input" rows="${(tpl[s.id] || []).length + 1}" data-change="template" data-k="${s.id}">${esc((tpl[s.id] || []).map((r) => r.join(' | ')).join('\n'))}</textarea></div>`).join('')}
        <div class="hint">Типы: ${Object.entries(L.TYPES).map(([k, v]) => k + ' — ' + v).join(', ')}. <a href="#" data-act="resetTemplates">Вернуть стандартные</a></div>
      </div>
      <div class="card"><h2>Обновления</h2>
        <div style="display:flex;gap:12px;align-items:center">
          <div style="flex:1">Версия <b>${esc(upd.version || '—')}</b>. ${updateStatusText()}</div>
          <button class="btn" data-act="checkUpdate">Проверить</button>
          ${upd.info && upd.info.available ? '<button class="btn primary" data-act="installUpdate">Обновить</button>' : ''}
        </div>
        <div class="hint" style="margin-top:8px">Приложение проверяет обновления при запуске и раз в 6 часов. Задачи и настройки при обновлении сохраняются.</div>
      </div>
      <div class="card"><h2>Прочее</h2>
        <label style="display:flex;gap:8px;margin-bottom:12px"><input type="checkbox" data-change="notifications" ${st.notifications ? 'checked' : ''}> Уведомления: утренний план, напоминания «жду ответа», долгий таймер, конец дня</label>
        <div style="display:flex;gap:8px"><button class="btn" data-act="export">Экспорт в файл…</button><button class="btn" data-act="import">Импорт из файла…</button></div>
      </div>
    </div>`;
}

// ---------- Как пользоваться ----------

function viewGuide() {
  const step = (n, title, body) => `<div class="g-step"><div class="g-n">${n}</div><div><div class="g-t">${title}</div><div class="g-b">${body}</div></div></div>`;
  return `
    <div class="view-head"><div><h1>Как пользоваться</h1>
      <div class="sub">Вся механика — 10 минут в день и 15 минут в пятницу. Остальное время приложение просто напоминает и считает.</div></div>
      <div class="spacer"></div><button class="btn primary" data-act="go" data-v="today">Начать</button></div>

    <div class="card g-flow">
      <div class="g-box"><b>Входящие</b><span>всё, что прилетело на бегу</span></div><div class="g-arrow">→</div>
      <div class="g-box"><b>Неделя / день</b><span>разложить по дням</span></div><div class="g-arrow">→</div>
      <div class="g-box"><b>Сегодня</b><span>лягушка + до 3 задач</span></div><div class="g-arrow">→</div>
      <div class="g-box"><b>▶ Таймер</b><span>работаете — время считается</span></div><div class="g-arrow">→</div>
      <div class="g-box"><b>✓ Готово</b><span>оценка сравнивается с фактом</span></div><div class="g-arrow">→</div>
      <div class="g-box"><b>Итоги</b><span>пятница, 15 минут</span></div>
    </div>

    <div class="grid-today">
      <div class="col">
        <div class="card"><h2>Каждый день</h2>
          ${step('1', 'Утро — 5 минут на «Сегодня»', 'Разберите <b>Входящие</b> (у каждой задачи — проект, оценка в минутах и день). Выберите <b>🐸 лягушку</b> — самое важное и неприятное, делаете первым. Добавьте ещё <b>2–3 задачи</b> из списка «Взять в план». Посмотрите на полосу <b>«Загрузка дня»</b>: если красная — перенесите лишнее стрелкой →.')}
          ${step('2', 'Днём — записывать всё, что прилетает', 'Клиент написал, дизайнер спросил, маркетолог попросил — нажмите <b>⌥⌘N</b> (работает из любой программы), впишите одной строкой и отметьте <b>от кого</b>. Сделали сразу — «Уже сделал» и сколько минут. Не срочно — «Во входящие», разберёте завтра утром.')}
          ${step('3', 'Работаете над задачей — жмите ▶', 'Таймер виден в строке меню вверху экрана. Закончили — <b>✓</b>. Через 3–5 задач приложение узнает, во сколько раз вы недооцениваете время, и начнёт показывать «реально ~…». Отдельно считается проверка текстов с Claude.')}
          ${step('4', 'Вечер — закрыть день', 'Около конца рабочего дня появится кнопка <b>«Перенести на завтра»</b>: незавершённое уходит на следующий рабочий день, а не остаётся в голове.')}
        </div>
        <div class="card"><h2>Проекты</h2>
          ${step('→', 'Новый проект', 'Название, клиент и <b>дата сдачи в печать</b>. План этапов посчитается назад от этой даты: анализ 5 дней, дизайн 9, презентация 3, печать 3 (меняется в Настройках). Задачи этапа создадутся сами.')}
          ${step('→', 'Этап закончился', 'Кнопка <b>«→ следующий этап»</b> на карточке. Задачи нового этапа появятся со сроками.')}
          ${step('→', 'Ждёте клиента', '<b>«Жду клиента»</b> + дата напоминания. В нужный день приложение напомнит, а на карточке видно, сколько дней проект стоит не по вашей вине.')}
          ${step('→', 'Клиент прислал правки', '<b>«＋ Круг правок»</b>. Каждый круг после первого сдвигает прогноз на 2 дня — сразу видно, успеваете ли.')}
        </div>
      </div>
      <div class="col side">
        <div class="card"><h2>Что значат цифры</h2>
          <dl class="kv" style="grid-template-columns:auto 1fr;margin:0">
            <dt>Загрузка дня</dt><dd>Сколько минут уже запланировано на сегодня из доступных. 40% рабочего дня специально не планируется — это буфер на внезапное.</dd>
            <dt>реально ~</dt><dd>Ваша оценка × личный коэффициент. Если пишете «30 мин», а уходит 45 — будет «реально ~45».</dd>
            <dt>запас N р.д.</dt><dd>Сколько рабочих дней остаётся до сдачи в печать при текущем темпе. Красное «опоздание» — пора что-то менять сейчас, а не в последний день.</dd>
            <dt>Хвосты</dt><dd>Задачи из плана прошлых дней, которые не сделаны. Перенесите на сегодня или снимите с плана.</dd>
          </dl>
        </div>
        <div class="card"><h2>Пятница · 15 минут</h2>
          <div class="g-b">Откройте <b>«Итоги недели»</b> и пройдите чек-лист: входящие пусты, проекты проверены, кому напомнить, загрузка следующей недели, 3 главных результата. Там же видно, кто сколько времени съел внезапными просьбами.</div>
        </div>
        <div class="card"><h2>Личное</h2>
          <div class="g-b">В быстрой задаче переключите <b>Работа / Личное</b>. У личного свой запас часов (в будни 2 ч, в выходные 4 ч) и свои категории: здоровье, семья, учёба, быт, финансы, отдых.</div>
        </div>
        <div class="card"><h2>Горячие клавиши</h2>
          <dl class="kv" style="margin:0">
            <dt>⌥⌘N</dt><dd>быстрая задача откуда угодно</dd>
            <dt>⌘1 … ⌘5</dt><dd>Сегодня · Задачи · Проекты · Неделя · Итоги</dd>
            <dt>⌘/</dt><dd>эта страница</dd>
            <dt>⏎ / ⌘⏎</dt><dd>в быстрой задаче: во входящие / на сегодня</dd>
          </dl>
        </div>
      </div>
    </div>`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

// ---------- обновления ----------

function updateStatusText() {
  if (upd.progress != null) return 'Скачиваю обновление… ' + upd.progress + '%';
  if (upd.error) return '<span style="color:var(--danger)">' + esc(upd.error) + '</span>';
  const i = upd.info;
  if (!i) return 'Проверяю…';
  if (i.ok && i.available) return 'Доступна новая версия <b>' + esc(i.latest) + '</b>.';
  if (i.ok) return 'Установлена последняя версия.';
  if (i.reason === 'private') return 'Автообновление недоступно: репозиторий на GitHub закрыт. Сделайте его публичным (Settings → Change visibility).';
  if (i.reason === 'offline') return 'Нет интернета — проверю позже.';
  if (i.reason === 'browser') return '';
  return 'Не удалось проверить обновления.';
}
function updateBadge() {
  if (upd.progress != null) return `<div class="upd">Обновление… ${upd.progress}%</div>`;
  if (upd.info && upd.info.available) return `<button class="upd" data-act="installUpdate">⬆︎ Обновить до ${esc(upd.info.latest)}</button>`;
  return '';
}
async function checkUpdate(manual) {
  upd.error = '';
  upd.info = await bridge.checkUpdate();
  if (manual && upd.info.ok && !upd.info.available) toast('Установлена последняя версия');
  render();
}
async function installUpdate() {
  if (!upd.info || !upd.info.available) return;
  stopTimer(true);
  clearTimeout(saveTimer);
  await bridge.save(S);
  upd.progress = 0;
  upd.error = '';
  render();
  const r = await bridge.installUpdate(upd.info.url);
  if (!r.ok) {
    upd.progress = null;
    upd.error = r.error || 'Не удалось обновить';
    render();
  }
}

// ============================================================
// Модальные окна
// ============================================================

function openModal(html, wide) {
  const root = document.getElementById('modal');
  root.innerHTML = `<div class="modal-backdrop" data-act="closeModalBg"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
  const first = root.querySelector('[autofocus]') || root.querySelector('input,textarea,select');
  if (first) setTimeout(() => first.focus(), 20);
}
function closeModal() {
  document.getElementById('modal').innerHTML = '';
}
const modalOpen = () => !!document.getElementById('modal').innerHTML;

// ---------- быстрая задача ----------

const qa = {};
function quickAdd() {
  Object.assign(qa, { area: 'work', person: '', projectId: '', estimate: 15, priority: 'B', category: 'home', unplanned: true });
  renderQuickAdd();
}
function renderQuickAdd(keepTitle) {
  const title = keepTitle != null ? keepTitle : '';
  const projects = S.projects.filter((p) => !p.closed);
  openModal(`
    <h3>Быстрая задача</h3>
    <input class="input qa-title" id="qaTitle" placeholder="Что нужно сделать?" value="${esc(title)}" autofocus>
    <div style="display:flex;gap:10px;margin:12px 0;align-items:center">
      <div class="seg"><button class="${qa.area === 'work' ? 'on' : ''}" data-act="qaSet" data-k="area" data-v="work">Работа</button><button class="${qa.area === 'personal' ? 'on' : ''}" data-act="qaSet" data-k="area" data-v="personal">Личное</button></div>
      ${qa.area === 'work' ? `<label style="display:flex;gap:6px;align-items:center" class="hint"><input type="checkbox" id="qaUnplanned" ${qa.unplanned ? 'checked' : ''}> пришло внезапно</label>` : ''}
    </div>
    ${qa.area === 'work' ? `
      <div class="field"><span class="lbl">От кого</span><div class="chips">${L.PEOPLE.map((p) => `<button class="chip ${qa.person === p ? 'on' : ''}" data-act="qaSet" data-k="person" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div></div>
      <div class="field"><span class="lbl">Проект</span><select class="input" id="qaProject"><option value="">Без проекта</option>${projects.map((p) => `<option value="${p.id}" ${qa.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>`
      : `<div class="field"><span class="lbl">Категория</span><div class="chips">${Object.entries(L.PERSONAL).map(([k, v]) => `<button class="chip personal ${qa.category === k ? 'on' : ''}" data-act="qaSet" data-k="category" data-v="${k}">${v}</button>`).join('')}</div></div>`}
    <div class="row">
      <div class="field"><span class="lbl">Оценка</span><div class="chips">${[5, 15, 30, 60, 120].map((m) => `<button class="chip ${qa.estimate === m ? 'on' : ''}" data-act="qaSet" data-k="estimate" data-v="${m}">${L.fmtMin(m)}</button>`).join('')}</div></div>
      <div class="field" style="flex:0 0 auto"><span class="lbl">Приоритет</span><div class="chips">${['A', 'B', 'C'].map((p) => `<button class="chip ${qa.priority === p ? 'on' : ''}" data-act="qaSet" data-k="priority" data-v="${p}">${p}</button>`).join('')}</div></div>
    </div>
    <div class="foot">
      <input class="input" id="qaDoneMin" type="number" min="1" placeholder="мин" style="width:70px">
      <button class="btn" data-act="qaSave" data-mode="done" title="Уже сделано — записать, сколько заняло">✓ Уже сделал</button>
      <button class="btn" data-act="qaSave" data-mode="now">▶ Сейчас</button>
      <button class="btn" data-act="qaSave" data-mode="today">На сегодня</button>
      <button class="btn primary" data-act="qaSave" data-mode="inbox">Во входящие</button>
    </div>
    <div class="hint" style="text-align:right;margin-top:8px">⏎ во входящие · ⌘⏎ на сегодня · Esc закрыть</div>`);
}
function qaSave(mode) {
  const title = document.getElementById('qaTitle').value.trim();
  if (!title) {
    document.getElementById('qaTitle').focus();
    return;
  }
  const projSel = document.getElementById('qaProject');
  const unpl = document.getElementById('qaUnplanned');
  const t = newTask({
    title,
    area: qa.area,
    person: qa.area === 'work' ? qa.person : '',
    category: qa.category,
    projectId: projSel ? projSel.value : '',
    estimate: qa.estimate,
    priority: qa.priority,
    unplanned: qa.area === 'work' && !!(unpl && unpl.checked),
    status: mode === 'inbox' ? 'inbox' : 'todo',
    plannedFor: mode === 'inbox' ? '' : today(),
  });
  closeModal();
  if (mode === 'now') return startTimer(t.id);
  if (mode === 'done') {
    const m = Number(document.getElementById('qaDoneMin').value) || qa.estimate;
    t.manualMinutes = m;
    t.status = 'done';
    t.doneAt = nowMs();
    toast('Записано: ' + L.fmtMin(m));
  } else toast(mode === 'inbox' ? 'Во входящих' : 'Добавлено на сегодня');
  commit();
}

// ---------- задача ----------

function editTask(id, preset) {
  const t = id ? taskById(id) : { ...newTaskDraft(), ...(preset || {}) };
  const isNew = !id;
  const projects = S.projects.filter((p) => !p.closed || p.id === t.projectId);
  const act = id ? L.actualMinutes(t) : 0;
  const tracked = id ? Math.round(L.sessionMinutes(t)) : 0;
  openModal(`
    <h3>${isNew ? 'Новая задача' : 'Задача'}</h3>
    <input type="hidden" id="tId" value="${id || ''}">
    <div class="field"><input class="input qa-title" id="tTitle" value="${esc(t.title)}" placeholder="Конкретное действие: «Отправить ТЗ дизайнеру», а не «Дизайн»" autofocus></div>
    <div class="row">
      <div class="field"><label>Сфера</label><select class="input" id="tArea" data-change="tAreaToggle"><option value="work" ${L.areaOf(t) === 'work' ? 'selected' : ''}>Работа</option><option value="personal" ${L.areaOf(t) === 'personal' ? 'selected' : ''}>Личное</option></select></div>
      <div class="field work-only"><label>Тип</label><select class="input" id="tType">${Object.entries(L.TYPES).map(([k, v]) => `<option value="${k}" ${t.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field personal-only"><label>Категория</label><select class="input" id="tCategory">${Object.entries(L.PERSONAL).map(([k, v]) => `<option value="${k}" ${t.category === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>Приоритет</label><select class="input" id="tPriority">${[['A', 'A — обязательно'], ['B', 'B — желательно'], ['C', 'C — можно позже']].map(([k, v]) => `<option value="${k}" ${t.priority === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="row work-only">
      <div class="field"><label>Проект</label><select class="input" id="tProject"><option value="">Без проекта</option>${projects.map((p) => `<option value="${p.id}" ${t.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>С кем / от кого</label><select class="input" id="tPerson"><option value="">—</option>${L.PEOPLE.map((p) => `<option ${t.person === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>Оценка, мин</label><input class="input" id="tEst" type="number" min="0" step="5" value="${t.estimate || ''}"></div>
      <div class="field"><label>Сделать в день</label><input class="input" id="tPlanned" type="date" value="${t.plannedFor || ''}"></div>
      <div class="field"><label>Крайний срок</label><input class="input" id="tDue" type="date" value="${t.due || ''}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Статус</label><select class="input" id="tStatus" data-change="tStatusToggle">${[['inbox', 'Входящие'], ['todo', 'К выполнению'], ['waiting', 'Жду ответа'], ['done', 'Выполнено']].map(([k, v]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field waiting-only"><label>Жду от кого</label><input class="input" id="tWaitingFor" value="${esc(t.waitingFor)}" placeholder="Клиент, дизайнер…"></div>
      <div class="field waiting-only"><label>Напомнить</label><input class="input" id="tRemind" type="date" value="${t.remindAt || ''}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Добавить время вручную, мин${act ? ` · сейчас: таймер ${L.fmtMin(tracked)}${t.manualMinutes ? ' + вручную ' + L.fmtMin(t.manualMinutes) : ''}` : ''}</label><input class="input" id="tManual" type="number" min="0" step="5" value="${t.manualMinutes || ''}"></div>
      <div class="field" style="justify-content:flex-end"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="tUnplanned" ${t.unplanned ? 'checked' : ''}> внезапная (не из плана)</label></div>
    </div>
    <div class="field"><label>Заметка</label><textarea class="input" id="tNote" placeholder="Ссылки, детали, что сказал клиент…">${esc(t.note)}</textarea></div>
    <div class="foot">
      ${isNew ? '' : `<button class="btn danger left" data-act="deleteTask" data-id="${id}">Удалить</button>`}
      <button class="btn" data-act="closeModal">Отмена</button>
      <button class="btn primary" data-act="saveTask">${isNew ? 'Добавить' : 'Сохранить'}</button>
    </div>`);
  syncTaskForm();
}
function newTaskDraft() {
  return { title: '', area: 'work', type: 'other', category: 'home', person: '', projectId: '', estimate: 30, priority: 'B', due: '', plannedFor: '', status: 'todo', waitingFor: '', remindAt: '', unplanned: false, manualMinutes: 0, note: '' };
}
function syncTaskForm() {
  const area = document.getElementById('tArea').value;
  const status = document.getElementById('tStatus').value;
  document.querySelectorAll('.work-only').forEach((el) => (el.style.display = area === 'work' ? '' : 'none'));
  document.querySelectorAll('.personal-only').forEach((el) => (el.style.display = area === 'personal' ? '' : 'none'));
  document.querySelectorAll('.waiting-only').forEach((el) => (el.style.display = status === 'waiting' ? '' : 'none'));
}
function saveTask() {
  const v = (id) => document.getElementById(id).value;
  const title = v('tTitle').trim();
  if (!title) return document.getElementById('tTitle').focus();
  const id = v('tId');
  const fields = {
    title,
    area: v('tArea'),
    type: v('tType'),
    category: v('tCategory'),
    priority: v('tPriority'),
    projectId: v('tArea') === 'work' ? v('tProject') : '',
    person: v('tArea') === 'work' ? v('tPerson') : '',
    estimate: Number(v('tEst')) || 0,
    plannedFor: v('tPlanned'),
    due: v('tDue'),
    status: v('tStatus'),
    waitingFor: v('tWaitingFor'),
    remindAt: v('tRemind'),
    manualMinutes: Number(v('tManual')) || 0,
    unplanned: document.getElementById('tUnplanned').checked,
    note: v('tNote'),
  };
  if (fields.status === 'waiting' && !fields.remindAt) fields.remindAt = L.addWorkdays(today(), 2, settings().workdays);
  let t = id && taskById(id);
  if (t) {
    if (fields.status === 'done' && t.status !== 'done') fields.doneAt = nowMs();
    if (fields.status !== 'done') fields.doneAt = null;
    if (fields.status === 'done' && S.timer && S.timer.taskId === t.id) stopTimer(true);
    Object.assign(t, fields);
  } else {
    t = newTask(fields);
    if (fields.status === 'done') t.doneAt = nowMs();
  }
  closeModal();
  commit();
}

// ---------- проект ----------

function editProject(id) {
  const p = id ? projectById(id) : { name: '', client: '', deadline: '', stage: 'analysis', stageStartedAt: today(), note: '' };
  const st = settings();
  const plan = p.deadline ? L.planBackward(p.deadline, st) : null;
  const f = id ? L.forecast(p, st) : null;
  const tasks = id ? S.tasks.filter((x) => x.projectId === id).sort(byOrder) : [];
  openModal(`
    <h3>${id ? esc(p.name) : 'Новый проект'}</h3>
    <input type="hidden" id="pId" value="${id || ''}">
    <div class="row">
      <div class="field"><label>Название</label><input class="input" id="pName" value="${esc(p.name)}" autofocus></div>
      <div class="field"><label>Клиент</label><input class="input" id="pClient" value="${esc(p.client)}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Сдача в печать (дедлайн)</label><input class="input" id="pDeadline" type="date" value="${p.deadline || ''}"></div>
      <div class="field"><label>Текущий этап</label><select class="input" id="pStage">${L.STAGES.map((s) => `<option value="${s.id}" ${p.stage === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select></div>
      <div class="field"><label>Этап начат</label><input class="input" id="pStageStart" type="date" value="${p.stageStartedAt || today()}"></div>
    </div>
    ${id ? '' : `<label style="display:flex;gap:8px;margin-bottom:12px"><input type="checkbox" id="pTpl" ${st.autoStageTasks ? 'checked' : ''}> Создать задачи текущего этапа по шаблону</label>`}
    <div class="field"><label>Заметка</label><textarea class="input" id="pNote" placeholder="Ссылка на карточку в Airtable, контакты, особенности клиента…">${esc(p.note)}</textarea></div>
    ${plan ? `<div class="field"><label>План этапов от даты сдачи</label>
      <table class="plan-table"><tr><th>Этап</th><th>Начать</th><th>Закончить</th><th></th></tr>
      ${L.STAGES.map((s) => {
        const r = plan[s.id];
        const late = !p.closed && L.stageIndex(s.id) >= L.stageIndex(p.stage) && r.start < today() && s.id !== p.stage;
        return `<tr class="${s.id === p.stage && !p.closed ? 'cur' : ''}"><td>${s.name}</td><td>${fmtDate(r.start, true)}</td><td>${fmtDate(r.end, true)}</td>
          <td>${late ? '<span class="tag late">должен был начаться</span>' : ''}</td></tr>`;
      }).join('')}</table>
      ${f && f.end ? `<div class="hint" style="margin-top:6px">Прогноз окончания «Печати» при текущем темпе: <b>${fmtDate(f.end, true)}</b> · ${forecastTag(f)}</div>` : ''}</div>` : ''}
    ${id ? `<div class="field"><label>Задачи проекта
        <button class="btn ghost sm" data-act="newTask" data-project="${id}">＋ задача</button>
        <button class="btn ghost sm" data-act="stageTasks" data-id="${id}">＋ по шаблону этапа</button></label>
      <div>${tasks.length ? tasks.map((x) => taskRow(x, { noProject: true, showPlanned: true })).join('') : '<div class="empty">Задач нет.</div>'}</div></div>` : ''}
    <div class="foot">
      ${id ? `<button class="btn danger left" data-act="deleteProject" data-id="${id}">Удалить проект</button>` : ''}
      ${id && p.closed ? `<button class="btn" data-act="reopenProject" data-id="${id}">Вернуть в работу</button>` : ''}
      <button class="btn" data-act="closeModal">Отмена</button>
      <button class="btn primary" data-act="saveProject">${id ? 'Сохранить' : 'Создать'}</button>
    </div>`, true);
}
function saveProject() {
  const v = (x) => document.getElementById(x).value;
  const name = v('pName').trim();
  if (!name) return document.getElementById('pName').focus();
  const id = v('pId');
  const fields = { name, client: v('pClient').trim(), deadline: v('pDeadline'), stage: v('pStage'), stageStartedAt: v('pStageStart') || today(), note: v('pNote') };
  if (id) {
    const p = projectById(id);
    if (p.stage !== fields.stage) p.history.push({ stage: fields.stage, at: today() });
    Object.assign(p, fields);
  } else {
    const p = { id: uid(), ...fields, history: [{ stage: fields.stage, at: fields.stageStartedAt }], rounds: {}, waiting: null, closed: false, createdAt: nowMs() };
    S.projects.push(p);
    if (document.getElementById('pTpl').checked) createStageTasks(p, p.stage);
    const f = L.forecast(p, settings());
    if (f.status === 'late') toast('Внимание: по плану уже опаздываете на ' + -f.slack + ' р.д.');
  }
  closeModal();
  commit();
}

function waitClient(id) {
  const p = projectById(id);
  openModal(`<h3>Мяч у клиента · ${esc(p.name)}</h3>
    <input type="hidden" id="wId" value="${id}">
    <div class="field"><label>Чего ждём</label><input class="input" id="wNote" placeholder="Фидбек по дизайну, тексты, логотип…" autofocus></div>
    <div class="field"><label>Напомнить клиенту</label><input class="input" id="wRemind" type="date" value="${L.addWorkdays(today(), 2, settings().workdays)}"></div>
    <div class="hint">Задержки клиента — главная причина сдвига сроков. Здесь видно, сколько дней проект стоит не по вашей вине.</div>
    <div class="foot"><button class="btn" data-act="closeModal">Отмена</button><button class="btn primary" data-act="saveWait">Сохранить</button></div>`);
}

function confirmBox(text, onYes) {
  confirmBox.cb = onYes;
  openModal(`<h3>${esc(text)}</h3><div class="foot"><button class="btn" data-act="closeModal">Отмена</button><button class="btn primary" data-act="confirmYes">Да</button></div>`);
}

// ============================================================
// События
// ============================================================

const ACTIONS = {
  go: (el) => {
    ui.view = el.dataset.v;
    if (el.dataset.tab) ui.taskTab = el.dataset.tab;
    document.getElementById('view').scrollTop = 0;
    render();
  },
  quickAdd,
  closeModal,
  closeModalBg: (el, e) => {
    if (e.target === el) closeModal();
  },
  confirmYes: () => {
    closeModal();
    confirmBox.cb && confirmBox.cb();
  },
  startTimer: (el) => startTimer(el.dataset.id),
  stopTimer: () => stopTimer(),
  doneTimer: () => S.timer && toggleDone(S.timer.taskId),
  toggleDone: (el) => toggleDone(el.dataset.id),
  editTask: (el) => editTask(el.dataset.id),
  newTask: (el) => editTask(null, {
    plannedFor: el.dataset.planned || '',
    area: el.dataset.area || 'work',
    projectId: el.dataset.project || (ui.view === 'tasks' ? ui.taskProject : ''),
  }),
  saveTask,
  deleteTask: (el) => confirmBox('Удалить задачу?', () => deleteTask(el.dataset.id)),
  setFrog: (el) => {
    const t = taskById(el.dataset.id);
    dayRec(today()).frogId = t.id;
    t.plannedFor = today();
    if (t.status === 'inbox') t.status = 'todo';
    commit();
  },
  clearFrog: () => {
    dayRec(today()).frogId = null;
    commit();
  },
  planToday: (el) => {
    const t = taskById(el.dataset.id);
    t.plannedFor = today();
    if (t.status === 'inbox') t.status = 'todo';
    commit();
  },
  toTomorrow: (el) => {
    const t = taskById(el.dataset.id);
    t.plannedFor = L.addWorkdays(today(), 1, settings().workdays);
    if (dayRec(today()).frogId === t.id) dayRec(today()).frogId = null;
    toast('Перенесено на ' + relDate(t.plannedFor));
    commit();
  },
  unplan: (el) => {
    taskById(el.dataset.id).plannedFor = '';
    commit();
  },
  tailsToday: () => {
    S.tasks.forEach((x) => {
      if (x.status !== 'done' && x.status !== 'inbox' && x.plannedFor && x.plannedFor < today()) x.plannedFor = today();
    });
    commit();
  },
  tailsUnplan: () => {
    S.tasks.forEach((x) => {
      if (x.status !== 'done' && x.status !== 'inbox' && x.plannedFor && x.plannedFor < today()) x.plannedFor = '';
    });
    commit();
  },
  moveLeftToTomorrow: () => {
    const next = L.addWorkdays(today(), 1, settings().workdays);
    let n = 0;
    S.tasks.forEach((x) => {
      if (x.plannedFor === today() && x.status !== 'done' && x.status !== 'waiting') {
        x.plannedFor = next;
        n++;
      }
    });
    toast('Перенесено: ' + n);
    commit();
  },
  morningDone: () => {
    dayRec(today()).morningDone = true;
    commit();
  },
  eveningDone: () => {
    stopTimer(true);
    dayRec(today()).eveningDone = true;
    commit();
  },
  snoozeWait: (el) => {
    taskById(el.dataset.id).remindAt = L.addWorkdays(today(), 2, settings().workdays);
    commit();
  },
  gotReply: (el) => {
    const t = taskById(el.dataset.id);
    t.status = 'todo';
    t.plannedFor = today();
    toast('Задача вернулась в план на сегодня');
    commit();
  },
  taskTab: (el) => {
    ui.taskTab = el.dataset.tab;
    render();
  },
  taskArea: (el) => {
    ui.taskArea = el.dataset.k;
    render();
  },
  projFilter: (el) => {
    ui.projFilter = el.dataset.k;
    render();
  },
  newProject: () => editProject(null),
  openProject: (el) => editProject(el.dataset.id),
  saveProject,
  advance: (el) => {
    const p = projectById(el.dataset.id);
    const idx = L.stageIndex(p.stage);
    const open = S.tasks.filter((x) => x.projectId === p.id && x.stage === p.stage && x.status !== 'done').length;
    const msg = idx === L.STAGES.length - 1 ? 'Закрыть проект «' + p.name + '»?' : 'Перевести «' + p.name + '» на этап «' + L.STAGES[idx + 1].name + '»?' + (open ? ' Незакрытых задач этапа: ' + open + '.' : '');
    confirmBox(msg, () => advanceStage(p.id));
  },
  addRound: (el) => addRound(el.dataset.id),
  waitClient: (el) => waitClient(el.dataset.id),
  saveWait: () => {
    const p = projectById(document.getElementById('wId').value);
    p.waiting = { note: document.getElementById('wNote').value.trim(), since: today(), remindAt: document.getElementById('wRemind').value };
    closeModal();
    commit();
  },
  clientReplied: (el) => {
    const p = projectById(el.dataset.id);
    const days = L.workdaysBetween(p.waiting.since, today(), settings().workdays);
    p.waitLog = p.waitLog || [];
    p.waitLog.push({ ...p.waiting, until: today(), days });
    p.waiting = null;
    toast('Клиент ответил' + (days ? ' спустя ' + days + ' ' + L.plural(days, 'рабочий день', 'рабочих дня', 'рабочих дней') : ''));
    commit();
  },
  snoozeProjectWait: (el) => {
    projectById(el.dataset.id).waiting.remindAt = L.addWorkdays(today(), 2, settings().workdays);
    commit();
  },
  stageTasks: (el) => {
    const p = projectById(el.dataset.id);
    const n = createStageTasks(p, p.stage);
    save();
    editProject(p.id);
    toast('Добавлено задач: ' + n);
  },
  deleteProject: (el) => confirmBox('Удалить проект? Задачи останутся, но без проекта.', () => {
    const id = el.dataset.id;
    S.projects = S.projects.filter((p) => p.id !== id);
    S.tasks.forEach((t) => {
      if (t.projectId === id) t.projectId = '';
    });
    commit();
  }),
  reopenProject: (el) => {
    const p = projectById(el.dataset.id);
    p.closed = false;
    p.closedAt = null;
    closeModal();
    commit();
  },
  week: (el) => {
    const d = Number(el.dataset.d);
    ui.weekOffset = d === 0 ? 0 : ui.weekOffset + d;
    render();
  },
  review: (el) => {
    const d = Number(el.dataset.d);
    ui.reviewOffset = d === 0 ? 0 : ui.reviewOffset + d;
    render();
  },
  applyShare: (el) => {
    settings().reactiveShare = Number(el.dataset.v);
    commit();
  },
  resetTemplates: () => {
    settings().templates = null;
    commit();
  },
  qaSet: (el) => {
    const title = document.getElementById('qaTitle').value;
    const sel = document.getElementById('qaProject');
    if (sel) qa.projectId = sel.value;
    const unpl = document.getElementById('qaUnplanned');
    if (unpl) qa.unplanned = unpl.checked;
    const k = el.dataset.k;
    let v = el.dataset.v;
    if (k === 'estimate') v = Number(v);
    qa[k] = k === 'person' && qa.person === v ? '' : v;
    renderQuickAdd(title);
  },
  qaSave: (el) => qaSave(el.dataset.mode),
  export: () => bridge.exportData(S).then((ok) => ok && toast('Сохранено')),
  checkUpdate: () => checkUpdate(true),
  installUpdate: () => confirmBox('Скачать и установить новую версию? Приложение перезапустится, задачи сохранятся.', installUpdate),
  import: doImport,
};

function doImport() {
  bridge.importData().then((data) => {
    if (!data || !Array.isArray(data.tasks)) return data && toast('Файл не похож на данные приложения');
    confirmBox('Заменить все текущие данные данными из файла?', () => {
      S = normalize(data);
      commit();
      toast('Импортировано');
    });
  });
}

const CHANGES = {
  taskProject: (el) => {
    ui.taskProject = el.value;
    render();
  },
  set: (el) => {
    settings()[el.dataset.k] = el.dataset.num ? Number(el.value) : el.value;
    commit();
  },
  setShare: (el) => {
    settings().reactiveShare = Math.min(0.9, Math.max(0, Number(el.value) / 100));
    commit();
  },
  workday: (el) => {
    const d = Number(el.dataset.d);
    const set = new Set(settings().workdays);
    if (el.checked) set.add(d);
    else set.delete(d);
    settings().workdays = [...set];
    commit();
  },
  stageDays: (el) => {
    settings().stageDays[el.dataset.k] = Math.max(1, Number(el.value) || 1);
    commit();
  },
  autoStageTasks: (el) => {
    settings().autoStageTasks = el.checked;
    commit();
  },
  notifications: (el) => {
    settings().notifications = el.checked;
    commit();
  },
  template: (el) => {
    const tpl = JSON.parse(JSON.stringify(templates()));
    tpl[el.dataset.k] = el.value.split('\n').map((line) => line.split('|').map((s) => s.trim())).filter((r) => r[0])
      .map(([title, min, type]) => [title, Number(min) || 30, L.TYPES[type] ? type : 'other']);
    settings().templates = tpl;
    commit();
  },
  reviewCheck: (el) => {
    S.reviews[el.dataset.w].checks[el.dataset.k] = el.checked;
    commit();
  },
  reviewGoal: (el) => {
    S.reviews[el.dataset.w].goals[Number(el.dataset.i)] = el.value;
    save();
  },
  reviewNote: (el) => {
    S.reviews[el.dataset.w].note = el.value;
    save();
  },
  tAreaToggle: syncTaskForm,
  tStatusToggle: syncTaskForm,
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  e.stopPropagation();
  fn(el, e);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && CHANGES[el.dataset.change]) CHANGES[el.dataset.change](el, e);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOpen()) return closeModal();
  if (e.key === 'Enter' && document.getElementById('qaTitle') && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    return qaSave(e.metaKey || e.ctrlKey ? 'today' : 'inbox');
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && document.getElementById('tTitle')) return saveTask();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && document.getElementById('pName')) return saveProject();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && document.getElementById('wNote')) return ACTIONS.saveWait();
});

// перетаскивание на неделе
document.addEventListener('dragstart', (e) => {
  const el = e.target.closest('[data-drag]');
  if (el) e.dataTransfer.setData('text/plain', el.dataset.drag);
});
document.addEventListener('dragover', (e) => {
  const col = e.target.closest('[data-drop]');
  if (!col) return;
  e.preventDefault();
  document.querySelectorAll('.week-col.drop').forEach((c) => c !== col && c.classList.remove('drop'));
  col.classList.add('drop');
});
document.addEventListener('dragleave', (e) => {
  const col = e.target.closest('[data-drop]');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drop');
});
document.addEventListener('drop', (e) => {
  const col = e.target.closest('[data-drop]');
  if (!col) return;
  e.preventDefault();
  const t = taskById(e.dataTransfer.getData('text/plain'));
  if (!t) return;
  t.plannedFor = col.dataset.drop;
  if (t.status === 'inbox') t.status = 'todo';
  commit();
});

// ============================================================
// Фоновые проверки: таймер, строка меню, уведомления
// ============================================================

let lastTray = null;
function tick() {
  let title = '';
  if (S.timer) {
    const t = taskById(S.timer.taskId);
    const open = t && t.sessions.find((s) => !s.end);
    if (open) {
      const ms = nowMs() - open.start;
      const clock = document.getElementById('timerClock');
      if (clock) clock.textContent = fmtClock(ms);
      const m = Math.floor(ms / 60000);
      const name = t.title.length > 22 ? t.title.slice(0, 21) + '…' : t.title;
      title = ' ' + Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ' ' + name;
      if (ms > 2 * 3600000 && !lastNotified['long:' + open.start]) {
        lastNotified['long:' + open.start] = true;
        notify('Таймер идёт больше 2 часов', '«' + t.title + '» — вы всё ещё над этим работаете?');
      }
    }
  }
  const key = title + '|' + !!S.timer;
  if (key !== lastTray) {
    lastTray = key;
    bridge.updateTray(title, !!S.timer);
  }
}

let lastDay = today();
function minuteCheck() {
  const t = today();
  if (t !== lastDay) {
    lastDay = t;
    render();
  }
  const st = settings();
  const nm = nowMin();
  const rec = dayRec(t);
  const isWork = L.isWorkday(t, st.workdays);
  const once = (key, fn) => {
    if (rec.notified && rec.notified[key]) return;
    rec.notified = rec.notified || {};
    rec.notified[key] = true;
    save();
    fn();
  };
  if (isWork && nm >= timeToMin(st.workStart) && nm < timeToMin(st.workStart) + 180 && !rec.morningDone) {
    once('morning', () => notify('План на день · 5 минут', 'Разберите входящие и выберите лягушку — самую важную задачу.'));
  }
  if (isWork && nm >= timeToMin(st.workStart)) {
    const due = S.tasks.filter((x) => x.status === 'waiting' && x.remindAt && x.remindAt <= t);
    const pdue = S.projects.filter((p) => !p.closed && p.waiting && p.waiting.remindAt && p.waiting.remindAt <= t);
    if (due.length + pdue.length) {
      once('waiting', () => notify('Пора напомнить', [...pdue.map((p) => p.name), ...due.map((x) => x.title)].slice(0, 3).join(', ')));
    }
  }
  if (isWork && nm >= timeToMin(st.workEnd) && !rec.eveningDone) {
    once('evening', () => notify('Конец рабочего дня', 'Перенесите незавершённое на завтра и закройте день — голова освободится.'));
  }
}

// ============================================================
// Запуск
// ============================================================

function normalize(data) {
  const d = { ...fresh(), ...data };
  d.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  d.settings.stageDays = d.settings.stageDays || {};
  d.tasks = (d.tasks || []).map((t) => ({ sessions: [], manualMinutes: 0, area: 'work', ...t }));
  d.projects = (d.projects || []).map((p) => ({ history: [], rounds: {}, ...p }));
  d.days = d.days || {};
  d.reviews = d.reviews || {};
  return d;
}

async function init() {
  const data = await bridge.load();
  S = data ? normalize(data) : fresh();
  if (!data) save();
  bridge.on('quick-add', () => {
    if (!document.getElementById('qaTitle')) quickAdd();
  });
  bridge.on('timer-stop', () => stopTimer());
  bridge.on('menu', (cmd) => {
    if (cmd.startsWith('view:')) {
      ui.view = cmd.slice(5);
      render();
    } else if (cmd === 'update') {
      ui.view = 'settings';
      checkUpdate(true);
    } else if (cmd === 'export') ACTIONS.export();
    else if (cmd === 'import') doImport();
  });
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (e) { /* ignore */ }
  }
  bridge.on('update:progress', (p) => {
    upd.progress = p;
    renderNav();
  });
  upd.version = await bridge.version();
  if (!S.seenGuide) {
    S.seenGuide = true;
    ui.view = 'guide';
    save();
  }
  render();
  setTimeout(() => checkUpdate(false), 4000);
  setInterval(() => checkUpdate(false), 6 * 3600000);
  setInterval(tick, 1000);
  setInterval(minuteCheck, 30000);
  tick();
  minuteCheck();
}

init();
