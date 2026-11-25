// Goals — define the daily goals that make up the day score (SPEC 4.7).
//
// Notes / choices:
// - Stats (30-day strip, hit rate, current/best streak) for ALL goals come from ONE getRangeMetrics() load of the
//   last 400 days, evaluated with metrics.evaluateGoal(). The streak rule mirrors metrics.getGoalStreak() exactly
//   (non-applicable weekdays are skipped; today only extends a streak) — calling getGoalStreak() per goal would
//   reload 400 days of every store once per goal.
// - 30-day hit rate = done ÷ applicable days in the last 30 days; today only counts once it's done.
// - Order: active goals first, then paused; ↑/↓ move a goal within its group and rewrite every goal's `order`
//   (0..n-1) in one bulkPut. Keyboard focus stays on the moved goal's button.
// - Suggested goals add instantly (toast with Undo). A metric suggestion is hidden when a goal with the same metric
//   and comparator exists; a manual one when a goal with the same title exists.
// - Editor: a new goal's title follows the metric/target ("Drink 8 glasses of water") until the user types their
//   own; an empty title falls back to that automatic title. Icon/colour follow the metric until picked by hand.
// - `#/goals?new=1` opens the editor (then the query is dropped).

import { db } from '../core/db.js';
import { on } from '../core/bus.js';
import { getSettings } from '../core/settings.js';
import { todayKey, addDays, rangeKeys, fmtDate, weekdayLabels } from '../core/dates.js';
import { fmtNumber, fmtMoney, fmtDuration, fmtPercent, plural, toNumber, currencySymbol } from '../core/format.js';
import { METRICS, getRangeMetrics, evaluateGoal, goalApplies, sortGoals, formatMetricValue } from '../core/metrics.js';
import {
  h, mount, icon, iconChip, button, pageHeader, section, card, statTile, badge, emptyState, skeleton, openSheet, field,
  input, segmented, select, chips, toggle, toast, debounce, colorVar,
} from '../core/ui.js';
import { removeWithUndo } from '../core/undo.js';

const ID = 'goals';
const LOOKBACK = 400;
const STRIP_DAYS = 30;

const ICON_CHOICES = [
  'water', 'glass-water', 'food', 'salad', 'apple', 'beef', 'coffee', 'flame',
  'training', 'activity', 'footprints', 'bike', 'heart-pulse', 'mountain', 'moon', 'bed',
  'lightbulb', 'book', 'brain', 'graduation-cap', 'note', 'notebook', 'pen', 'wallet',
  'piggy-bank', 'coins', 'receipt', 'trades', 'trending-up', 'target', 'check-square', 'calendar-check',
  'leaf', 'sun', 'smile', 'heart', 'star', 'trophy', 'zap', 'clock',
];
// Names that draw the same glyph as one in the grid (METRICS / default goals use these).
const ICON_ALIAS = { learning: 'lightbulb', expenses: 'wallet', candlestick: 'trades' };
const COLOR_CHOICES = [
  ['--water', 'Cyan'], ['--food', 'Orange'], ['--training', 'Green'], ['--learning', 'Violet'], ['--mood', 'Pink'],
  ['--expenses', 'Teal'], ['--trades', 'Blue'], ['--goals', 'Amber'], ['--primary', 'Indigo'],
];

// ─────────────────────────────────────────────────────────────────────────────────────────── helpers

function targets() {
  return (getSettings() && getSettings().targets) || {};
}

function defaultTarget(metric) {
  const t = targets();
  const pos = (v, d) => (Number(v) > 0 ? Number(v) : d);
  switch (metric) {
    case 'water': return pos(t.water, 8);
    case 'calories': return pos(t.calories, 2200);
    case 'protein': return pos(t.protein, 100);
    case 'meals': return 3;
    case 'trainingMinutes': return pos(t.trainingMinutes, 30);
    case 'steps': return pos(t.steps, 8000);
    case 'learningMinutes': return 20;
    case 'spend': return Number(t.dailySpend) > 0 ? Number(t.dailySpend) : 500;
    case 'sleep': return pos(t.sleep, 8);
    default: return 1;
  }
}

function autoTitle(d) {
  if (d.kind === 'check') return '';
  const n = Number(d.target);
  const lte = d.comparator === 'lte';
  const num = (v) => fmtNumber(v, { maxDecimals: 2 });
  switch (d.metric) {
    case 'water': return lte ? `At most ${plural(n, 'glass', 'glasses')} of water` : `Drink ${plural(n, 'glass', 'glasses')} of water`;
    case 'protein': return `${lte ? 'At most' : 'Eat'} ${num(n)} g protein`;
    case 'calories': return lte ? `Stay under ${num(n)} kcal` : `Eat at least ${num(n)} kcal`;
    case 'meals': return `Log ${plural(n, 'meal')}`;
    case 'trainingMinutes': return lte ? `Train at most ${fmtDuration(n)}` : `Train for ${fmtDuration(n)}`;
    case 'workouts': return n === 1 ? 'Work out' : `${num(n)} workouts`;
    case 'steps': return `Walk ${num(n)} steps`;
    case 'learnings': return n === 1 ? 'Learn one new thing' : `Learn ${num(n)} new things`;
    case 'learningMinutes': return n === 20 ? 'Read 20 min' : `Learn for ${fmtDuration(n)}`;
    case 'spend': return lte ? (n === 0 ? 'No-spend day' : `Spend at most ${fmtMoney(n)}`) : `Spend ${fmtMoney(n)}`;
    case 'sleep': return `Sleep ${num(n)} hours`;
    case 'reflection': return 'Write a reflection';
    case 'trades': return n === 1 ? 'Journal a trade' : `Journal ${num(n)} trades`;
    default: {
      const def = METRICS[d.metric] || {};
      return `${def.label || 'Goal'} ${lte ? '≤' : '≥'} ${formatMetricValue(d.metric, n)}`;
    }
  }
}

function ruleText(g) {
  if (g.kind === 'check') return 'Manual check';
  const def = METRICS[g.metric] || {};
  if (def.unit === 'bool') return 'Any reflection written';
  if (g.metric === 'spend' && g.comparator === 'lte' && Number(g.target) === 0) return 'No spending';
  return `${g.comparator === 'lte' ? 'At most' : 'At least'} ${formatMetricValue(g.metric, Number(g.target) || 0)}`;
}

function scheduleText(g) {
  const wd = Array.isArray(g.weekdays) ? [...new Set(g.weekdays.map(Number))].sort() : [];
  if (!wd.length || wd.length === 7) return 'Every day';
  const key = wd.join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  const ws = Number(getSettings().weekStart ?? 1);
  const names = weekdayLabels(ws, 'short');
  const order = Array.from({ length: 7 }, (_, i) => (ws + i) % 7);
  return order.filter((d) => wd.includes(d)).map((d) => names[order.indexOf(d)]).join(', ');
}

function suggestions() {
  const t = targets();
  const m = (key, title, metric, comparator, target, ic, color) => ({ key, title, kind: 'metric', metric, comparator, target, icon: ic, color });
  const c = (key, title, ic, color) => ({ key, title, kind: 'check', icon: ic, color });
  return [
    m('steps', '10k steps', 'steps', 'gte', 10000, 'footprints', '--training'),
    m('sleep', `Sleep ${fmtNumber(Number(t.sleep) || 8)} hours`, 'sleep', 'gte', Number(t.sleep) || 8, 'moon', '--mood'),
    m('protein', `Eat ${fmtNumber(Number(t.protein) || 100)} g protein`, 'protein', 'gte', Number(t.protein) || 100, 'beef', '--food'),
    m('water', `Drink ${fmtNumber(Number(t.water) || 8)} glasses of water`, 'water', 'gte', Number(t.water) || 8, 'water', '--water'),
    m('nospend', 'No-spend day', 'spend', 'lte', 0, 'piggy-bank', '--expenses'),
    m('read', 'Read 20 min', 'learningMinutes', 'gte', 20, 'book', '--learning'),
    m('trades', 'Journal trades', 'trades', 'gte', 1, 'trades', '--trades'),
    m('train', `Train for ${fmtDuration(Number(t.trainingMinutes) || 30)}`, 'trainingMinutes', 'gte', Number(t.trainingMinutes) || 30, 'training', '--training'),
    m('learn', 'Learn one new thing', 'learnings', 'gte', 1, 'lightbulb', '--learning'),
    m('reflect', 'Write a reflection', 'reflection', 'gte', 1, 'note', '--mood'),
    m('calories', `Stay under ${fmtNumber(Number(t.calories) || 2200)} kcal`, 'calories', 'lte', Number(t.calories) || 2200, 'flame', '--food'),
    c('meditate', 'Meditate 10 min', 'leaf', '--mood'),
    c('nosugar', 'No added sugar', 'apple', '--food'),
    c('stretch', 'Stretch', 'activity', '--training'),
  ];
}

function suggestionExists(s, goals) {
  if (s.kind === 'check') return goals.some((g) => String(g.title || '').trim().toLowerCase() === s.title.toLowerCase());
  return goals.some((g) => g.kind !== 'check' && g.metric === s.metric && (g.comparator || (METRICS[g.metric] || {}).comparator) === s.comparator);
}

/** Per-goal stats from one metrics load. Streak logic = metrics.getGoalStreak(). */
function goalStats(goal, keys, metrics) {
  const today = keys[keys.length - 1];
  const status = keys.map((k) => (!goalApplies(goal, k) ? 'skip' : evaluateGoal(goal, metrics[k]).done ? 'done' : 'miss'));
  let best = 0;
  let run = 0;
  status.forEach((s, i) => {
    if (s === 'done') {
      run++;
      if (run > best) best = run;
    } else if (s === 'miss' && i !== status.length - 1) run = 0;
  });
  let current = 0;
  for (let i = status.length - 1; i >= 0; i--) {
    const s = status[i];
    if (s === 'done') current++;
    else if (s === 'skip' || (s === 'miss' && i === status.length - 1)) continue;
    else break;
  }
  const strip = keys.slice(-STRIP_DAYS).map((k, i, arr) => {
    const s = status[status.length - arr.length + i];
    return { date: k, status: s === 'miss' && k === today ? 'pending' : s };
  });
  const counted = strip.filter((c) => c.status === 'done' || c.status === 'miss');
  const done = counted.filter((c) => c.status === 'done').length;
  return {
    current,
    best: Math.max(best, current),
    strip,
    done,
    applicable: counted.length,
    rate: counted.length ? done / counted.length : null,
    today: evaluateGoal(goal, metrics[today]),
    appliesToday: goalApplies(goal, today),
  };
}

function remount(container, ...kids) {
  const active = document.activeElement;
  const key = active && container.contains(active) && active.dataset ? active.dataset.fk : null;
  mount(container, ...kids);
  if (!key) return;
  const all = Array.from(container.querySelectorAll('[data-fk]'));
  let el = all.find((n) => n.dataset.fk === key);
  if (el && el.disabled) {
    // A goal moved to the top/bottom: its ↑/↓ became disabled — keep focus on the other arrow.
    const [kind, ...rest] = key.split('-');
    const other = `${kind === 'up' ? 'down' : 'up'}-${rest.join('-')}`;
    el = all.find((n) => n.dataset.fk === other) || el;
  }
  if (el) {
    try {
      el.focus({ preventScroll: false });
    } catch {
      /* ignore */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────── editor

function openGoalEditor(goal = null, opts = {}) {
  const isNew = !goal || !goal.id;
  const base = goal || opts.preset || {};
  const metric0 = base.metric && METRICS[base.metric] ? base.metric : 'water';
  const draft = {
    title: base.title || '',
    kind: base.kind === 'check' ? 'check' : 'metric',
    metric: metric0,
    comparator: base.comparator === 'lte' || base.comparator === 'gte' ? base.comparator : METRICS[metric0].comparator,
    target: base.target ?? defaultTarget(metric0),
    icon: base.icon || METRICS[metric0].icon,
    color: base.color || METRICS[metric0].color,
    weekdays: Array.isArray(base.weekdays) && base.weekdays.length && base.weekdays.length < 7 ? base.weekdays.map(Number) : null,
    active: base.active !== false,
  };
  let titleTouched = !!draft.title && draft.title !== autoTitle(draft);
  let lastAuto = autoTitle(draft);
  let iconTouched = !isNew || !!base.icon;
  let colorTouched = !isNew || !!base.color;

  // Title
  const titleIn = input({
    value: draft.title,
    placeholder: draft.kind === 'check' ? 'e.g. Meditate 10 min' : autoTitle(draft),
    autocomplete: 'off',
    maxlength: '80',
    onInput: (e) => {
      draft.title = e.target.value;
      titleTouched = draft.title.trim() !== '';
      titleField.setError(null);
    },
  });
  const titleField = field('Title', titleIn, { required: true });

  // Kind
  const kindSeg = segmented(
    [
      { value: 'metric', label: 'Auto from my logs', icon: 'sparkles' },
      { value: 'check', label: 'Manual checkbox', icon: 'check-square' },
    ],
    draft.kind,
    (v) => {
      draft.kind = v;
      sync();
    },
    { block: true, ariaLabel: 'Goal type' }
  );
  const kindHint = h('p.goals-kind-hint');

  // Metric + comparator + target
  const metricSel = select(
    Object.entries(METRICS).map(([value, d]) => ({ value, label: d.label })),
    draft.metric,
    (v) => {
      draft.metric = v;
      const def = METRICS[v];
      draft.comparator = def.comparator;
      draft.target = defaultTarget(v);
      if (!iconTouched) draft.icon = def.icon;
      if (!colorTouched) draft.color = def.color;
      cmpSeg.setValue(draft.comparator);
      targetIn.value = String(draft.target);
      sync();
    }
  );
  const cmpSeg = segmented(
    [
      { value: 'gte', label: 'At least' },
      { value: 'lte', label: 'At most' },
    ],
    draft.comparator,
    (v) => {
      draft.comparator = v;
      sync();
    },
    { ariaLabel: 'Comparator', block: true }
  );
  const targetIn = input({
    type: 'number',
    min: '0',
    value: String(draft.target ?? ''),
    onInput: (e) => {
      draft.target = toNumber(e.target.value);
      targetField.setError(null);
      sync();
    },
  });
  const prefix = h('span.affix', { 'aria-hidden': 'true' });
  const suffix = h('span.affix', { 'aria-hidden': 'true' });
  const targetWrap = h('div.input-affix', prefix, targetIn, suffix);
  const targetField = field('Target', targetWrap);
  const cmpField = field('Done when the day is…', cmpSeg);
  const ruleHint = h('p.goals-rule', { 'aria-live': 'polite' });
  const metricBox = h(
    'div.goals-metric-box.stack',
    field('Track', metricSel),
    h('div.goals-cmp-row', cmpField, targetField),
    ruleHint
  );

  // Icon picker
  const iconBtns = ICON_CHOICES.map((name) =>
    h(
      'button.goals-icon-opt',
      {
        type: 'button',
        'aria-label': name.replace(/-/g, ' '),
        title: name.replace(/-/g, ' '),
        dataset: { icon: name },
        onClick: () => {
          draft.icon = name;
          iconTouched = true;
          sync();
        },
      },
      icon(name, { size: 20 })
    )
  );
  const iconGrid = h('div.goals-icon-grid', { role: 'group' }, iconBtns);

  // Colour picker
  const colorBtns = COLOR_CHOICES.map(([c, name]) =>
    h(
      'button.goals-swatch',
      {
        type: 'button',
        'aria-label': name,
        title: name,
        style: { '--accent': colorVar(c) },
        dataset: { color: c },
        onClick: () => {
          draft.color = c;
          colorTouched = true;
          sync();
        },
      },
      icon('check', { size: 16, strokeWidth: 3 })
    )
  );
  const colorRow = h('div.goals-swatches', { role: 'group' }, colorBtns);

  // Weekdays
  const ws = Number(getSettings().weekStart ?? 1);
  const dayOrder = Array.from({ length: 7 }, (_, i) => (ws + i) % 7);
  const shortNames = weekdayLabels(ws, 'short');
  const longNames = weekdayLabels(ws, 'long');
  const dayChips = chips(
    dayOrder.map((d, i) => ({ value: d, label: shortNames[i], title: longNames[i] })),
    draft.weekdays || [],
    (vals) => {
      draft.weekdays = vals.map(Number);
      daysField.setError(null);
      sync();
    },
    { multiple: true, ariaLabel: 'Days', size: 'sm' }
  );
  const schedSeg = segmented(
    [
      { value: 'all', label: 'Every day' },
      { value: 'some', label: 'Some days' },
    ],
    draft.weekdays ? 'some' : 'all',
    (v) => {
      if (v === 'all') draft.weekdays = null;
      else {
        draft.weekdays = dayChips.getValue().map(Number);
        if (!draft.weekdays.length) {
          draft.weekdays = [1, 2, 3, 4, 5];
          dayChips.setValue(draft.weekdays);
        }
      }
      sync();
    },
    { ariaLabel: 'Schedule' }
  );
  const daysField = field('Repeats', h('div.stack-sm', schedSeg, dayChips));

  const activeToggle = toggle(draft.active, (v) => (draft.active = v), { label: 'Active', hint: 'Paused goals don’t count toward your day score' });

  // Live preview row
  const preview = h('div.goals-preview', { 'aria-hidden': 'true' });

  function sync() {
    const isMetric = draft.kind === 'metric';
    const def = METRICS[draft.metric] || {};
    metricBox.hidden = !isMetric;
    kindHint.textContent = isMetric
      ? 'Checked automatically from what you log — no extra taps.'
      : 'A checkbox you tick on Today when it’s done.';
    const isBool = def.unit === 'bool';
    cmpField.hidden = isBool;
    targetField.hidden = isBool;
    if (isBool) draft.target = 1;
    // Unit affixes
    const money = def.unit === 'money';
    prefix.textContent = money ? currencySymbol() : '';
    prefix.hidden = !money;
    const unit = money ? '' : def.unit === 'min' ? 'min' : def.unit === 'h' ? 'hours' : def.unit || '';
    suffix.textContent = unit;
    suffix.hidden = !unit;
    targetIn.step = def.unit === 'h' ? '0.5' : 'any';
    // Auto title
    const auto = autoTitle(draft);
    titleIn.placeholder = isMetric ? auto : 'e.g. Meditate 10 min';
    if (!titleTouched && isMetric) {
      titleIn.value = auto;
      draft.title = auto;
    } else if (!titleTouched && !isMetric && titleIn.value === lastAuto) {
      titleIn.value = '';
      draft.title = '';
    }
    lastAuto = auto;
    ruleHint.textContent = isMetric
      ? isBool
        ? 'Done when you write anything in the day’s reflection.'
        : `Done when ${def.label || 'it'} is ${draft.comparator === 'lte' ? 'at most' : 'at least'} ${formatMetricValue(draft.metric, Number(draft.target) || 0)}${def.requiresData ? ' (and something is logged)' : ''}.`
      : '';
    ruleHint.hidden = !isMetric;
    // Pickers
    const shown = ICON_ALIAS[draft.icon] || draft.icon;
    iconBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.icon === shown)));
    colorBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === draft.color)));
    iconGrid.style.setProperty('--accent', colorVar(draft.color));
    dayChips.hidden = !draft.weekdays;
    // Preview
    mount(
      preview,
      iconChip(draft.icon, { accent: draft.color }),
      h('div.goals-preview-text', h('strong', (titleIn.value || '').trim() || (isMetric ? auto : 'New goal')), h('span', `${ruleText(draft)} · ${scheduleText(draft)}`))
    );
  }

  const form = h(
    'form.stack.goals-form',
    preview,
    titleField,
    h('div.stack-sm', field('Type', kindSeg), kindHint),
    metricBox,
    field('Icon', iconGrid),
    field('Colour', colorRow),
    daysField,
    activeToggle
  );
  titleIn.addEventListener('input', () => sync());
  sync();

  const sheet = openSheet({
    title: isNew ? 'New goal' : 'Edit goal',
    icon: 'target',
    accent: '--goals',
    size: 'md',
    content: form,
    initialFocus: isNew ? titleIn : null,
    actions: [
      !isNew && {
        label: 'Delete',
        variant: 'danger',
        icon: 'trash',
        onClick: async () => {
          await removeWithUndo('goals', goal, { label: 'Goal deleted' });
          return null;
        },
      },
      { label: 'Cancel', variant: 'secondary' },
      {
        label: isNew ? 'Add goal' : 'Save',
        variant: 'primary',
        onClick: async () => {
          const isMetric = draft.kind === 'metric';
          const def = METRICS[draft.metric] || {};
          let ok = true;
          if (isMetric && def.unit !== 'bool') {
            const n = Number(draft.target);
            if (draft.target === null || draft.target === '' || !Number.isFinite(n) || n < 0) {
              targetField.setError('Enter a number (0 or more)');
              ok = false;
            } else if (draft.comparator === 'gte' && n === 0) {
              targetField.setError('“At least 0” is always done — pick a bigger target');
              ok = false;
            }
          }
          if (draft.weekdays && !draft.weekdays.length) {
            daysField.setError('Pick at least one day');
            ok = false;
          }
          const title = (titleIn.value || '').trim() || (isMetric ? autoTitle(draft) : '');
          if (!title) {
            titleField.setError('Give your goal a short name');
            titleIn.focus();
            ok = false;
          }
          if (!ok) return false;
          let order = goal && Number.isFinite(Number(goal.order)) ? Number(goal.order) : null;
          if (order === null) {
            const all = await db.all('goals');
            order = all.reduce((mx, g) => Math.max(mx, Number(g.order) || 0), -1) + 1;
          }
          const record = {
            ...(goal || {}),
            title,
            kind: draft.kind,
            metric: isMetric ? draft.metric : null,
            comparator: isMetric ? (def.unit === 'bool' ? 'gte' : draft.comparator) : null,
            target: isMetric ? (def.unit === 'bool' ? 1 : Number(draft.target)) : null,
            icon: draft.icon,
            color: draft.color,
            weekdays: draft.weekdays && draft.weekdays.length && draft.weekdays.length < 7 ? [...draft.weekdays].sort() : null,
            active: draft.active,
            order,
          };
          const saved = await db.put('goals', record);
          toast(isNew ? 'Goal added' : 'Saved', { type: 'success' });
          return saved;
        },
      },
    ].filter(Boolean),
  });
  return sheet.result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────── page

async function render(root, ctx) {
  let disposed = false;
  const summary = h('div.goals-summary');
  const suggestBox = h('div.goals-suggest-slot');
  const listBox = h('div.goals-list-slot');

  mount(
    root,
    h(
      'div.page.goals-page',
      pageHeader({
        title: 'Goals',
        subtitle: 'Small daily targets that add up to your day score.',
        actions: [{ label: 'New goal', icon: 'plus', variant: 'primary', onClick: () => openGoalEditor(null) }],
      }),
      summary,
      listBox,
      suggestBox
    )
  );

  mount(listBox, card({ flush: true, class: 'goals-card', children: h('div.goals-list', Array.from({ length: 3 }, () => h('div.goals-item.is-skeleton', h('div.goals-item-head', skeleton({ width: 40, height: 40, radius: '12px' }), h('div.goals-item-text', skeleton({ width: '50%', height: 16 }), skeleton({ width: '35%', height: 12 }))), skeleton({ height: 14 })))) }));

  async function move(goal, dir, goals) {
    const active = goals.filter((g) => g.active !== false);
    const paused = goals.filter((g) => g.active === false);
    const group = goal.active === false ? paused : active;
    const i = group.findIndex((g) => g.id === goal.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= group.length) return;
    [group[i], group[j]] = [group[j], group[i]];
    const ordered = [...active, ...paused].map((g, idx) => ({ ...g, order: idx }));
    try {
      await db.bulkPut('goals', ordered);
    } catch (err) {
      console.error('[goals] reorder failed', err);
      toast('Couldn’t reorder. Try again.', { type: 'error' });
    }
  }

  async function setActive(goal, v) {
    try {
      await db.put('goals', { ...goal, active: v });
      toast(v ? `“${goal.title}” is back on` : `“${goal.title}” paused`, { type: 'success', duration: 2200 });
    } catch (err) {
      console.error('[goals] toggle failed', err);
      toast('Couldn’t save that. Try again.', { type: 'error' });
    }
  }

  async function addSuggestion(s) {
    const all = await db.all('goals');
    const order = all.reduce((mx, g) => Math.max(mx, Number(g.order) || 0), -1) + 1;
    const { key, ...rest } = s;
    const rec = { ...rest, metric: s.kind === 'check' ? null : s.metric, comparator: s.kind === 'check' ? null : s.comparator, target: s.kind === 'check' ? null : s.target, weekdays: null, active: true, order };
    const saved = await db.put('goals', rec);
    toast(`Added “${saved.title}”`, {
      type: 'success',
      action: {
        label: 'Undo',
        onClick: async () => {
          await db.delete('goals', saved.id);
        },
      },
    });
  }

  function todayBadge(g, st) {
    if (g.active === false) return badge('Paused', 'neutral', { icon: 'pause' });
    if (!st.appliesToday) return badge('Rest day', 'neutral', { icon: 'moon' });
    const ev = st.today;
    if (ev.over) return badge('Over', 'warning', { icon: 'alert' });
    if (ev.done) return badge('Done today', 'profit', { icon: 'check' });
    if (g.kind === 'check') return badge('To do', 'neutral', { icon: 'circle' });
    const def = METRICS[g.metric] || {};
    if (def.unit === 'bool') return badge('Not yet', 'neutral', { icon: 'circle' });
    if (ev.comparator === 'lte') return badge(ev.noData && def.requiresData ? 'No data yet' : `${formatMetricValue(g.metric, ev.value ?? 0)} used`, 'neutral');
    return badge(`${Math.round((ev.progress || 0) * 100)}% today`, 'accent', { accent: g.color || def.color });
  }

  function strip(g, st) {
    const label = st.applicable ? `Done ${st.done} of ${st.applicable} days in the last 30 days` : 'No scheduled days in the last 30 days';
    return h(
      'div.goals-strip',
      { role: 'img', 'aria-label': label },
      st.strip.map((c) => h('span.goals-cell', { class: `is-${c.status}`, title: `${fmtDate(c.date, 'medium')} — ${c.status === 'done' ? 'done' : c.status === 'miss' ? 'missed' : c.status === 'pending' ? 'today' : 'not scheduled'}` }))
    );
  }

  function goalItem(g, st, idx, group, goals) {
    const accent = g.color || (METRICS[g.metric] || {}).color || '--goals';
    const ic = g.icon || (METRICS[g.metric] || {}).icon || 'target';
    const first = idx === 0;
    const last = idx === group.length - 1;
    const tg = toggle(g.active !== false, (v) => setActive(g, v), { ariaLabel: `${g.title} active` });
    tg.input.dataset.fk = `active-${g.id}`;
    return h(
      'li.goals-item',
      { class: { 'is-paused': g.active === false }, style: { '--accent': colorVar(accent) } },
      h(
        'div.goals-item-head',
        iconChip(ic, { accent, size: 'lg' }),
        h('div.goals-item-text', h('h3.goals-item-title', g.title), h('p.goals-item-rule', `${ruleText(g)} · ${scheduleText(g)}`)),
        h(
          'div.goals-item-today',
          todayBadge(g, st),
          h('span.goals-streak-mini', { class: { 'is-cold': !st.current }, title: `Best streak: ${plural(st.best, 'day')}` }, icon('flame', { size: 14 }), h('strong.num', fmtNumber(st.current)), ` day streak · best ${fmtNumber(st.best)}`)
        )
      ),
      h(
        'div.goals-item-stats',
        h('div.goals-strip-wrap', strip(g, st), h('div.goals-strip-legend', h('span', '30 days ago'), h('span.goals-rate.num', st.rate === null ? '—' : `${fmtPercent(st.rate, { decimals: 0 })} hit rate`), h('span', 'Today'))),
        h(
          'div.goals-streak',
          { class: { 'is-cold': !st.current } },
          icon('flame', { size: 18 }),
          h('span.goals-streak-num.num', fmtNumber(st.current)),
          h('span.goals-streak-text', h('span', 'day streak'), h('span.goals-streak-best', `Best ${fmtNumber(st.best)}`))
        )
      ),
      h(
        'div.goals-item-actions',
        h(
          'div.goals-order',
          button({ label: `Move ${g.title} up`, icon: 'arrow-up', iconOnly: true, variant: 'ghost', size: 'sm', disabled: first, onClick: () => move(g, -1, goals), 'data-fk': `up-${g.id}` }),
          button({ label: `Move ${g.title} down`, icon: 'arrow-down', iconOnly: true, variant: 'ghost', size: 'sm', disabled: last, onClick: () => move(g, 1, goals), 'data-fk': `down-${g.id}` })
        ),
        h('div.goals-active', tg, h('span.goals-active-label', { 'aria-hidden': 'true' }, g.active === false ? 'Paused' : 'Active')),
        h(
          'div.goals-edit',
          button({ label: `Edit ${g.title}`, icon: 'edit', iconOnly: true, variant: 'ghost', size: 'sm', onClick: () => openGoalEditor(g), 'data-fk': `edit-${g.id}` }),
          button({ label: `Delete ${g.title}`, icon: 'trash', iconOnly: true, variant: 'ghost', size: 'sm', class: 'goals-del', onClick: () => removeWithUndo('goals', g, { label: `Deleted “${g.title}”` }), 'data-fk': `del-${g.id}` })
        )
      )
    );
  }

  async function draw() {
    const t = todayKey();
    let goals;
    let metrics;
    try {
      [goals, metrics] = await Promise.all([db.all('goals'), getRangeMetrics(addDays(t, -LOOKBACK), t)]);
    } catch (err) {
      console.error('[goals] load failed', err);
      if (!disposed) mount(listBox, emptyState({ icon: 'alert', title: 'Couldn’t load your goals', message: 'Your data is safe. Try again in a moment.', action: { label: 'Try again', icon: 'refresh', onClick: () => draw() } }));
      return;
    }
    if (disposed) return;
    goals = sortGoals(goals);
    const keys = rangeKeys(addDays(t, -LOOKBACK), t);
    const stats = new Map(goals.map((g) => [g.id, goalStats(g, keys, metrics)]));
    const active = goals.filter((g) => g.active !== false);
    const paused = goals.filter((g) => g.active === false);
    const all = [...active, ...paused];

    // Summary tiles
    const todayList = active.filter((g) => stats.get(g.id).appliesToday);
    const doneToday = todayList.filter((g) => stats.get(g.id).today.done).length;
    let hit = 0;
    let app = 0;
    active.forEach((g) => {
      hit += stats.get(g.id).done;
      app += stats.get(g.id).applicable;
    });
    let perfect = 0;
    for (const k of keys.slice(-STRIP_DAYS)) {
      const list = active.filter((g) => goalApplies(g, k));
      if (list.length && list.every((g) => evaluateGoal(g, metrics[k]).done)) perfect++;
    }
    const bestStreak = active.reduce((mx, g) => Math.max(mx, stats.get(g.id).current), 0);
    remount(
      summary,
      goals.length
        ? h(
            'div.stat-grid.goals-stats',
            statTile({ label: 'Today', value: todayList.length ? `${doneToday}/${todayList.length}` : '—', sub: todayList.length ? (doneToday === todayList.length ? 'All done' : `${todayList.length - doneToday} to go`) : 'Nothing scheduled', icon: 'check-circle', accent: '--success' }),
            statTile({ label: 'Hit rate', value: app ? fmtPercent(hit / app, { decimals: 0 }) : '—', sub: 'Last 30 days', icon: 'target', accent: '--goals' }),
            statTile({ label: 'Perfect days', value: fmtNumber(perfect), sub: 'Last 30 days', icon: 'trophy', accent: '--primary' }),
            statTile({ label: 'Top streak', value: fmtNumber(bestStreak), sub: bestStreak === 1 ? 'day, still going' : 'days, still going', icon: 'flame', accent: '--food' })
          )
        : null
    );

    // List
    const groups = [];
    if (active.length) {
      groups.push(card({ title: 'Active', subtitle: `${plural(active.length, 'goal')} · counted in your day score`, flush: true, class: 'goals-card', children: h('ul.goals-list', active.map((g, i) => goalItem(g, stats.get(g.id), i, active, all))) }));
    }
    if (paused.length) {
      groups.push(card({ title: 'Paused', subtitle: 'Not counted until you switch them back on', flush: true, class: 'goals-card is-paused-group', children: h('ul.goals-list', paused.map((g, i) => goalItem(g, stats.get(g.id), i, paused, all))) }));
    }
    remount(
      listBox,
      groups.length
        ? h('div.stack', groups)
        : emptyState({
            icon: 'target',
            accent: '--goals',
            title: 'No goals yet',
            message: 'Goals turn your logs into a daily score. Start with one of the suggestions below, or make your own.',
            action: { label: 'Create a goal', icon: 'plus', onClick: () => openGoalEditor(null) },
          })
    );

    // Suggestions
    const sugg = suggestions().filter((s) => !suggestionExists(s, goals));
    remount(
      suggestBox,
      sugg.length
        ? section({
            title: 'Suggested goals',
            class: 'goals-suggest',
            children: [
              h('p.goals-suggest-hint', 'Tap to add — you can fine-tune any goal later.'),
              h(
                'div.goals-suggest-list',
                sugg.map((s) =>
                  h(
                    'button.goals-suggestion',
                    { type: 'button', style: { '--accent': colorVar(s.color) }, dataset: { fk: `sugg-${s.key}` }, onClick: () => addSuggestion(s).catch((err) => { console.error('[goals] add failed', err); toast('Couldn’t add that goal.', { type: 'error' }); }) },
                    h('span.goals-suggestion-icon', { 'aria-hidden': 'true' }, icon(s.icon, { size: 18 })),
                    h('span.goals-suggestion-text', h('span.goals-suggestion-title', s.title), h('span.goals-suggestion-rule', s.kind === 'check' ? 'Manual check' : ruleText(s))),
                    h('span.goals-suggestion-add', { 'aria-hidden': 'true' }, icon('plus', { size: 16, strokeWidth: 2.25 }))
                  )
                )
              ),
            ],
          })
        : null
    );
  }

  await draw();
  if (disposed) return () => {};

  const refresh = debounce(draw, 80);
  const offs = [
    on('db:change', (e) => {
      if (!e || e.store === 'meta' || e.store === 'files') return;
      refresh();
    }),
    on('settings:change', refresh),
  ];

  if (ctx.route.query && ctx.route.query.new === '1') {
    openGoalEditor(null);
    ctx.navigate(ctx.route.path, { replace: true });
  }

  return () => {
    disposed = true;
    refresh.cancel();
    offs.forEach((off) => off());
  };
}

export default {
  id: ID,
  title: 'Goals',
  icon: 'goals',
  color: '--goals',
  render,
  openEditor: (record, opts) => openGoalEditor(record, opts),
};
