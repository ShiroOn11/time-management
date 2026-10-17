// Чистая логика планирования: даты, этапы, прогноз, калибровка оценок, загрузка.
// Работает и в окне приложения (window.Logic), и в node-тестах (require).
(function (root) {
  'use strict';

  const STAGES = [
    { id: 'analysis', name: 'Маркетинг-анализ и дебриф', short: 'Анализ', days: 5 },
    { id: 'design', name: 'Подготовка дизайна', short: 'Дизайн', days: 9 },
    { id: 'presentation', name: 'Презентация клиенту', short: 'Презентация', days: 3 },
    { id: 'print', name: 'Подготовка к печати', short: 'Печать', days: 3 },
    { id: 'closing', name: 'Закрытие проекта', short: 'Закрытие', days: 1 },
  ];

  const TEMPLATES = {
    analysis: [
      ['Получить и разобрать бриф', 60, 'docs'],
      ['Поставить задачу маркетологу', 30, 'comm'],
      ['Проверить маркетинг-анализ', 60, 'control'],
      ['Провести дебриф с клиентом', 60, 'comm'],
    ],
    design: [
      ['ТЗ дизайнеру', 45, 'docs'],
      ['Промежуточная проверка макетов', 45, 'control'],
      ['Проверка текстов в макетах (с Claude)', 45, 'texts'],
      ['Внутренняя приёмка дизайна', 30, 'control'],
    ],
    presentation: [
      ['Собрать презентацию', 60, 'docs'],
      ['Презентовать / отправить клиенту', 45, 'comm'],
      ['Собрать фидбек и передать дизайнеру', 30, 'comm'],
    ],
    print: [
      ['Запросить у клиента недостающую информацию', 15, 'comm'],
      ['Финальная проверка текстов (с Claude)', 60, 'texts'],
      ['Проверить файлы к печати', 45, 'control'],
      ['Согласовать финальный макет с клиентом', 30, 'comm'],
      ['Сдать файлы в типографию', 20, 'comm'],
    ],
    closing: [
      ['Отправить финальные файлы клиенту', 15, 'comm'],
      ['Архивировать исходники', 15, 'other'],
      ['Обновить статус в Airtable', 5, 'other'],
    ],
  };

  const TYPES = {
    comm: 'Общение',
    texts: 'Проверка текстов',
    control: 'Проверка работ',
    docs: 'Документы / ТЗ',
    other: 'Прочее',
  };

  // Категории личных задач
  const PERSONAL = {
    health: 'Здоровье и спорт',
    family: 'Семья и друзья',
    growth: 'Учёба и развитие',
    home: 'Быт и дела',
    money: 'Финансы',
    rest: 'Отдых',
  };

  const PEOPLE = ['Клиент', 'Дизайнер', 'Фрилансер', 'Маркетолог', 'Типография', 'Руководитель', 'Я сам'];

  // ---------- даты (локальные, формат YYYY-MM-DD) ----------
  const pad = (n) => String(n).padStart(2, '0');
  function toISO(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parseISO(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function todayISO(now) {
    return toISO(now || new Date());
  }
  function addDays(iso, n) {
    const d = parseISO(iso);
    d.setDate(d.getDate() + n);
    return toISO(d);
  }
  function isWorkday(iso, workdays) {
    return (workdays || [1, 2, 3, 4, 5]).includes(parseISO(iso).getDay());
  }
  // Сдвиг на n рабочих дней (n может быть отрицательным). n = 0 → тот же день.
  function addWorkdays(iso, n, workdays) {
    let cur = iso;
    const step = n < 0 ? -1 : 1;
    let left = Math.abs(n);
    while (left > 0) {
      cur = addDays(cur, step);
      if (isWorkday(cur, workdays)) left--;
    }
    return cur;
  }
  // Ближайший рабочий день, начиная с iso (включительно), в заданную сторону.
  function snapWorkday(iso, dir, workdays) {
    let cur = iso;
    while (!isWorkday(cur, workdays)) cur = addDays(cur, dir < 0 ? -1 : 1);
    return cur;
  }
  // Количество рабочих дней в интервале (a, b]. Отрицательное, если b < a.
  function workdaysBetween(a, b, workdays) {
    if (a === b) return 0;
    const sign = b > a ? 1 : -1;
    let [from, to] = sign > 0 ? [a, b] : [b, a];
    let count = 0;
    let cur = from;
    while (cur < to) {
      cur = addDays(cur, 1);
      if (isWorkday(cur, workdays)) count++;
    }
    return sign * count;
  }
  function weekStart(iso) {
    const d = parseISO(iso);
    const shift = (d.getDay() + 6) % 7; // понедельник = 0
    d.setDate(d.getDate() - shift);
    return toISO(d);
  }

  // ---------- этапы проекта ----------
  function stageDays(settings) {
    const map = {};
    STAGES.forEach((s) => {
      const v = settings && settings.stageDays && settings.stageDays[s.id];
      map[s.id] = v > 0 ? v : s.days;
    });
    return map;
  }

  // План от дедлайна назад. Дедлайн = сдача в печать (конец этапа «Подготовка к печати»).
  // Закрытие идёт после дедлайна.
  function planBackward(deadline, settings) {
    const wd = settings && settings.workdays;
    const days = stageDays(settings);
    const end = snapWorkday(deadline, -1, wd);
    const plan = {};
    let cursorEnd = end;
    const order = STAGES.map((s) => s.id).filter((id) => id !== 'closing');
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      const start = addWorkdays(cursorEnd, -(days[id] - 1), wd);
      plan[id] = { start, end: cursorEnd };
      cursorEnd = addWorkdays(start, -1, wd);
    }
    const cStart = addWorkdays(end, 1, wd);
    plan.closing = { start: cStart, end: addWorkdays(cStart, days.closing - 1, wd) };
    return plan;
  }

  function stageIndex(id) {
    return STAGES.findIndex((s) => s.id === id);
  }

  // Прогноз: когда реально закончится «Подготовка к печати» при текущем темпе.
  function forecast(project, settings, today) {
    const wd = settings && settings.workdays;
    const days = stageDays(settings);
    const roundDays = (settings && settings.roundDays) || 2;
    today = today || todayISO();
    if (project.closed) return { status: 'closed' };
    const idx = stageIndex(project.stage);
    const printIdx = stageIndex('print');
    if (!project.deadline) return { status: 'nodeadline' };
    const deadline = snapWorkday(project.deadline, -1, wd);

    if (idx > printIdx) {
      return { status: 'ok', end: project.stageStartedAt || today, slack: null, lateStage: 0 };
    }
    const started = project.stageStartedAt || today;
    const elapsed = Math.max(0, workdaysBetween(started, today, wd));
    const rounds = (project.rounds && project.rounds[project.stage]) || 0;
    const extra = Math.max(0, rounds - 1) * roundDays;
    let remaining = Math.max(1, days[project.stage] + extra - elapsed);
    for (let i = idx + 1; i <= printIdx; i++) remaining += days[STAGES[i].id];
    const startFrom = snapWorkday(today, 1, wd);
    const end = addWorkdays(startFrom, remaining - 1, wd);
    const slack = workdaysBetween(end, deadline, wd);

    const plan = planBackward(project.deadline, settings);
    const planned = plan[project.stage];
    const lateStage = planned && today > planned.end ? workdaysBetween(planned.end, today, wd) : 0;

    let status = 'ok';
    if (slack < 0) status = 'late';
    else if (slack <= 2 || lateStage > 0) status = 'risk';
    return { status, end, slack, lateStage, plannedStage: planned };
  }

  // ---------- задачи и время ----------
  function sessionMinutes(task, now) {
    let ms = 0;
    (task.sessions || []).forEach((s) => {
      const end = s.end || (now || Date.now());
      ms += Math.max(0, end - s.start);
    });
    return ms / 60000;
  }
  function actualMinutes(task, now) {
    return Math.round(sessionMinutes(task, now) + (task.manualMinutes || 0));
  }

  // Во сколько раз реальность больше оценки. Работа и личное считаются раздельно;
  // внутри работы — по типу задачи, если данных достаточно.
  function calibration(tasks, type, area) {
    area = area || 'work';
    tasks = tasks.filter((t) => areaOf(t) === area);
    if (area === 'personal') type = null;
    const sample = (list) => {
      let est = 0;
      let act = 0;
      let n = 0;
      list.forEach((t) => {
        const a = actualMinutes(t);
        if (t.status === 'done' && t.estimate > 0 && a > 0) {
          est += t.estimate;
          act += a;
          n++;
        }
      });
      return { ratio: n ? act / est : 1, n };
    };
    const clamp = (r) => Math.min(3, Math.max(0.5, r));
    if (type) {
      const byType = sample(tasks.filter((t) => t.type === type));
      if (byType.n >= 3) return { ratio: clamp(byType.ratio), n: byType.n, scope: 'type' };
    }
    const all = sample(tasks);
    if (all.n >= 3) return { ratio: clamp(all.ratio), n: all.n, scope: 'all' };
    return { ratio: 1, n: all.n, scope: 'none' };
  }

  // Реалистичная оценка задачи с поправкой на личный коэффициент.
  function realisticMinutes(task, tasks) {
    if (!task.estimate) return 0;
    return Math.round(task.estimate * calibration(tasks, task.type, areaOf(task)).ratio);
  }

  // Ёмкость дня. Работа: часы минус буфер на внезапное. Личное: отдельный запас часов.
  function dayCapacity(iso, settings, area) {
    if (area === 'personal') {
      const h = isWorkday(iso, settings.workdays) ? settings.personalWeekday : settings.personalWeekend;
      const total = Math.round((h != null ? h : 2) * 60);
      return { total, focus: total, buffer: 0 };
    }
    if (!isWorkday(iso, settings.workdays)) return { total: 0, focus: 0, buffer: 0 };
    const total = Math.round((settings.hoursPerDay || 8) * 60);
    const buffer = Math.round(total * (settings.reactiveShare != null ? settings.reactiveShare : 0.4));
    return { total, focus: total - buffer, buffer };
  }

  function areaOf(task) {
    return task.area === 'personal' ? 'personal' : 'work';
  }

  // Плановая загрузка дня: открытые задачи по реалистичной оценке, выполненные — по факту.
  // Внезапные рабочие задачи сюда не входят: они покрываются буфером.
  function dayLoad(iso, tasks, area) {
    let minutes = 0;
    tasks.forEach((t) => {
      if (t.plannedFor !== iso) return;
      if (area && areaOf(t) !== area) return;
      if (t.unplanned && areaOf(t) === 'work') return;
      if (t.status === 'done') minutes += actualMinutes(t) || realisticMinutes(t, tasks);
      else minutes += realisticMinutes(t, tasks) || 30;
    });
    return minutes;
  }

  // Время, которое съели внезапные задачи в этот день (по факту таймера/ручного ввода).
  function unplannedOn(iso, tasks) {
    let minutes = 0;
    let count = 0;
    tasks.forEach((t) => {
      if (!t.unplanned || areaOf(t) !== 'work') return;
      if (toISO(new Date(t.createdAt)) !== iso) return;
      count++;
      minutes += actualMinutes(t);
    });
    return { minutes, count };
  }

  // Оценка «лягушки»: приоритет, близость срока, риск проекта.
  function frogScore(task, projectsById, settings, today) {
    if (task.status === 'done' || task.status === 'waiting') return -Infinity;
    let score = { A: 100, B: 40, C: 10 }[task.priority || 'B'];
    if (task.due) {
      const d = workdaysBetween(today, task.due, settings.workdays);
      if (d < 0) score += 80;
      else score += Math.max(0, 50 - d * 10);
    }
    const p = task.projectId && projectsById[task.projectId];
    if (p) {
      const f = forecast(p, settings, today);
      if (f.status === 'late') score += 40;
      else if (f.status === 'risk') score += 20;
    }
    if (task.type === 'comm') score -= 15; // лягушка — обычно не переписка
    if (task.estimate >= 45) score += 10;
    return score;
  }

  function fmtMin(m) {
    m = Math.round(m || 0);
    const sign = m < 0 ? '−' : '';
    m = Math.abs(m);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (!h) return sign + mm + ' мин';
    return sign + h + ' ч' + (mm ? ' ' + mm + ' мин' : '');
  }

  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  const api = {
    STAGES, TEMPLATES, TYPES, PERSONAL, PEOPLE, areaOf,
    toISO, parseISO, todayISO, addDays, isWorkday, addWorkdays, snapWorkday, workdaysBetween, weekStart,
    stageDays, planBackward, stageIndex, forecast,
    sessionMinutes, actualMinutes, calibration, realisticMinutes,
    dayCapacity, dayLoad, unplannedOn, frogScore, fmtMin, plural,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(this);
