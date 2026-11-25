// Per-day metrics, goal evaluation, day scores and streaks (SPEC 3.9).
// Notes / choices:
// - loadRangeData() runs ONE byRange per store (+ days) in parallel; metricsForDay() indexes that data by
//   date once (cached per data object) so computing hundreds of days is O(records).
// - DayMetrics also carries `checks` (the day's manual check map) so evaluateGoal() can handle check goals.
// - `tradesOpened` counts loaded trades whose entryDate is that day (trades are loaded by their index
//   `date`, so a swing trade closed after the loaded range is not seen).
// - Goal `weekdays`: null / [] = every day, else array of 0..6 (0 = Sunday).
// - getDayScores(): future dates get score null (nothing to judge yet) but still report `total`.
// - Streaks look back at most 400 days. A goal streak skips non-applicable weekdays, and today only
//   extends (never breaks) a streak.
// Extras beyond the spec: formatMetricValue(), getGoalHistory(), sortGoals(), goalApplies().

import { db } from './db.js';
import { getSettings } from './settings.js';
import { addDays, todayKey, weekday, rangeKeys } from './dates.js';
import { fmtMoney, fmtNumber, fmtDuration } from './format.js';
import { tradeNet, isClosed, outcome } from '../modules/trades/calc.js';

export const METRICS = {
  water: { label: 'Water', unit: 'glasses', icon: 'water', color: '--water', comparator: 'gte' },
  calories: { label: 'Calories', unit: 'kcal', icon: 'flame', color: '--food', comparator: 'lte', requiresData: true },
  protein: { label: 'Protein', unit: 'g', icon: 'food', color: '--food', comparator: 'gte' },
  meals: { label: 'Meals logged', unit: 'meals', icon: 'food', color: '--food', comparator: 'gte' },
  trainingMinutes: { label: 'Training', unit: 'min', icon: 'training', color: '--training', comparator: 'gte' },
  workouts: { label: 'Workouts', unit: '', icon: 'training', color: '--training', comparator: 'gte' },
  steps: { label: 'Steps', unit: 'steps', icon: 'footprints', color: '--training', comparator: 'gte' },
  learnings: { label: 'Things learned', unit: '', icon: 'learning', color: '--learning', comparator: 'gte' },
  learningMinutes: { label: 'Learning time', unit: 'min', icon: 'clock', color: '--learning', comparator: 'gte' },
  spend: { label: 'Spending', unit: 'money', icon: 'expenses', color: '--expenses', comparator: 'lte' },
  sleep: { label: 'Sleep', unit: 'h', icon: 'moon', color: '--mood', comparator: 'gte' },
  reflection: { label: 'Daily reflection', unit: 'bool', icon: 'note', color: '--mood', comparator: 'gte' },
  trades: { label: 'Trades journaled', unit: '', icon: 'trades', color: '--trades', comparator: 'gte' },
};

// Which DayMetrics field proves "there is data" for requiresData metrics.
const DATA_PRESENCE = {
  calories: (m) => m.meals > 0,
};

const STREAK_LOOKBACK = 400;

const n0 = (v) => {
  const n = typeof v === 'number' ? v : v === null || v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const nOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const hasText = (s) => typeof s === 'string' && s.trim().length > 0;
const round2 = (v) => Math.round(v * 100) / 100;
const round8 = (v) => Math.round(v * 1e8) / 1e8;

// ---------------------------------------------------------------------------------------------------
// Data loading

export async function loadRangeData(from, to) {
  const [food, learning, workouts, expenses, trades, days] = await Promise.all([
    db.byRange('food', from, to),
    db.byRange('learning', from, to),
    db.byRange('workouts', from, to),
    db.byRange('expenses', from, to),
    db.byRange('trades', from, to),
    db.getDays(from, to),
  ]);
  return { from, to, food, learning, workouts, expenses, trades, days };
}

const indexCache = new WeakMap();

function groupByDate(list, key = 'date') {
  const map = new Map();
  for (const r of Array.isArray(list) ? list : []) {
    const d = r && r[key];
    if (!d) continue;
    let arr = map.get(d);
    if (!arr) map.set(d, (arr = []));
    arr.push(r);
  }
  return map;
}

function indexOf(data) {
  let idx = indexCache.get(data);
  if (!idx) {
    idx = {
      food: groupByDate(data.food),
      learning: groupByDate(data.learning),
      workouts: groupByDate(data.workouts),
      expenses: groupByDate(data.expenses),
      trades: groupByDate(data.trades),
      tradesEntered: groupByDate(data.trades, 'entryDate'),
    };
    indexCache.set(data, idx);
  }
  return idx;
}

function tradingHasContent(t) {
  if (!t || typeof t !== 'object') return false;
  return (
    hasText(t.bias) ||
    hasText(t.watchlist) ||
    hasText(t.plan) ||
    hasText(t.review) ||
    hasText(t.lessons) ||
    hasText(t.grade) ||
    (t.maxLoss !== null && t.maxLoss !== undefined && t.maxLoss !== '') ||
    (t.moodBefore !== null && t.moodBefore !== undefined) ||
    Object.values(t.rulesChecked || {}).some((v) => v === true)
  );
}

/** DayMetrics for `date` computed from loadRangeData() output (pure, sync). */
export function metricsForDay(date, data) {
  const d = data && typeof data === 'object' ? data : {};
  const idx = indexOf(d);
  const day = (d.days && d.days[date]) || {};
  const food = idx.food.get(date) || [];
  const learning = idx.learning.get(date) || [];
  const workouts = idx.workouts.get(date) || [];
  const expenses = idx.expenses.get(date) || [];
  const trades = idx.trades.get(date) || [];
  const entered = idx.tradesEntered.get(date) || [];

  let calories = 0, protein = 0, carbs = 0, fat = 0;
  for (const f of food) {
    calories += n0(f.calories);
    protein += n0(f.protein);
    carbs += n0(f.carbs);
    fat += n0(f.fat);
  }

  let trainingMinutes = 0, distance = 0, caloriesBurned = 0;
  for (const w of workouts) {
    trainingMinutes += n0(w.duration);
    distance += n0(w.distance);
    caloriesBurned += n0(w.calories);
  }

  let learningMinutes = 0;
  for (const l of learning) learningMinutes += n0(l.minutes);

  let spend = 0, income = 0, expenseCount = 0;
  for (const e of expenses) {
    if (e.type === 'income') income += n0(e.amount);
    else {
      spend += n0(e.amount);
      expenseCount++;
    }
  }

  let tradePnl = 0, tradeWins = 0, tradeLosses = 0;
  for (const t of trades) {
    if (!isClosed(t)) continue;
    const net = tradeNet(t);
    if (net === null) continue;
    tradePnl += net;
    const o = outcome(t);
    if (o === 'win') tradeWins++;
    else if (o === 'loss') tradeLosses++;
  }

  const water = n0(day.water);
  const steps = nOrNull(day.steps) ?? 0;
  const mood = nOrNull(day.mood);
  const energy = nOrNull(day.energy);
  const sleep = nOrNull(day.sleep);
  const weight = nOrNull(day.weight);
  const reflection =
    hasText(day.intention) || hasText(day.wins) || hasText(day.reflection) || hasText(day.gratitude) ? 1 : 0;
  const checks = day.checks && typeof day.checks === 'object' ? day.checks : {};

  const hasAny =
    food.length > 0 ||
    learning.length > 0 ||
    workouts.length > 0 ||
    expenses.length > 0 ||
    trades.length > 0 ||
    water > 0 ||
    steps > 0 ||
    mood !== null ||
    energy !== null ||
    sleep !== null ||
    weight !== null ||
    reflection === 1 ||
    Object.values(checks).some((v) => v === true) ||
    tradingHasContent(day.trading);

  return {
    date,
    calories: round2(calories),
    protein: round2(protein),
    carbs: round2(carbs),
    fat: round2(fat),
    meals: food.length,
    water,
    trainingMinutes: round2(trainingMinutes),
    workouts: workouts.length,
    steps,
    distance: round2(distance),
    caloriesBurned: round2(caloriesBurned),
    learnings: learning.length,
    learningMinutes: round2(learningMinutes),
    spend: round8(spend),
    income: round8(income),
    expenseCount,
    trades: trades.length,
    tradesOpened: entered.length,
    tradePnl: round8(tradePnl),
    tradeWins,
    tradeLosses,
    mood,
    energy,
    sleep,
    weight,
    reflection,
    checks,
    hasAny,
  };
}

export async function getDayMetrics(date) {
  const data = await loadRangeData(date, date);
  return metricsForDay(date, data);
}

/** → {[date]: DayMetrics} for every date in [from, to]. */
export async function getRangeMetrics(from, to) {
  const data = await loadRangeData(from, to);
  const out = {};
  for (const k of rangeKeys(from, to)) out[k] = metricsForDay(k, data);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Goals

export function goalApplies(goal, date) {
  if (!goal) return false;
  const wd = goal.weekdays;
  if (!Array.isArray(wd) || wd.length === 0) return true;
  const w = weekday(date);
  return w === null ? true : wd.map(Number).includes(w);
}

export function sortGoals(goals) {
  return [...(goals || [])].sort((a, b) => {
    const oa = n0(a.order);
    const ob = n0(b.order);
    if (oa !== ob) return oa - ob;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
}

const isActive = (g) => g && g.active !== false;

/** → {goal, value, target, done, progress (0..1), over, applicable, comparator, noData} */
export function evaluateGoal(goal, m) {
  const metrics = m || {};
  const applicable = goalApplies(goal, metrics.date);
  if (!goal) return { goal, value: null, target: null, done: false, progress: 0, over: false, applicable: false };

  if (goal.kind === 'check') {
    const done = !!(metrics.checks && metrics.checks[goal.id] === true);
    return { goal, value: done ? 1 : 0, target: 1, done, progress: done ? 1 : 0, over: false, applicable, comparator: 'gte', noData: false };
  }

  const def = METRICS[goal.metric] || {};
  const comparator = goal.comparator === 'lte' || goal.comparator === 'gte' ? goal.comparator : def.comparator || 'gte';
  const target = nOrNull(goal.target) ?? (def.unit === 'bool' ? 1 : 0);
  const raw = goal.metric in metrics ? metrics[goal.metric] : null;
  const value = raw === null || raw === undefined ? null : n0(raw);
  const presence = DATA_PRESENCE[goal.metric];
  const noData = value === null || (def.requiresData && presence ? !presence(metrics) : false);

  let done = false;
  let progress = 0;
  let over = false;
  if (comparator === 'lte') {
    const used = value ?? 0;
    over = used > target + 1e-9;
    done = !over && !(def.requiresData && noData) && value !== null;
    progress = target > 0 ? Math.min(1, Math.max(0, used / target)) : used > 0 ? 1 : 0;
  } else {
    done = value !== null && value >= target - 1e-9;
    progress = target > 0 ? Math.min(1, Math.max(0, (value ?? 0) / target)) : done ? 1 : 0;
  }
  return { goal, value, target, done, progress, over, applicable, comparator, noData };
}

/** Active goals applicable to the date's weekday, evaluated, in display order. */
export async function getGoalsForDay(date) {
  const [goals, m] = await Promise.all([db.all('goals'), getDayMetrics(date)]);
  return sortGoals(goals.filter(isActive))
    .filter((g) => goalApplies(g, date))
    .map((g) => evaluateGoal(g, m));
}

/** → {[date]: {score (0..1 | null), done, total}} */
export async function getDayScores(from, to) {
  const [goals, metrics] = await Promise.all([db.all('goals'), getRangeMetrics(from, to)]);
  const active = sortGoals(goals.filter(isActive));
  const today = todayKey();
  const out = {};
  for (const [date, m] of Object.entries(metrics)) {
    const list = active.filter((g) => goalApplies(g, date));
    const total = list.length;
    if (date > today) {
      out[date] = { score: null, done: 0, total, future: true };
      continue;
    }
    let done = 0;
    for (const g of list) if (evaluateGoal(g, m).done) done++;
    out[date] = { score: total ? done / total : null, done, total };
  }
  return out;
}

/** Consecutive days with any log. Today counts if logged; otherwise the streak continues from yesterday. */
export async function getLoggingStreak() {
  const today = todayKey();
  const from = addDays(today, -STREAK_LOOKBACK);
  const metrics = await getRangeMetrics(from, today);
  const keys = rangeKeys(from, today);
  let best = 0;
  let run = 0;
  for (const k of keys) {
    if (metrics[k] && metrics[k].hasAny) {
      run++;
      if (run > best) best = run;
    } else run = 0;
  }
  let current = 0;
  const todayLogged = !!(metrics[today] && metrics[today].hasAny);
  for (let i = keys.length - (todayLogged ? 1 : 2); i >= 0; i--) {
    if (metrics[keys[i]] && metrics[keys[i]].hasAny) current++;
    else break;
  }
  return { current, best: Math.max(best, current), todayLogged };
}

/** Per-date evaluation of one goal (goal record or id) → {[date]: evaluation}. */
export async function getGoalHistory(goalOrId, from, to) {
  const goal = typeof goalOrId === 'string' ? await db.get('goals', goalOrId) : goalOrId;
  if (!goal) return {};
  const metrics = await getRangeMetrics(from, to);
  const out = {};
  for (const [date, m] of Object.entries(metrics)) out[date] = evaluateGoal(goal, m);
  return out;
}

/** {current, best} for one goal; non-applicable weekdays are skipped; today never breaks the streak. */
export async function getGoalStreak(goalId) {
  const goal = goalId && typeof goalId === 'object' ? goalId : await db.get('goals', goalId);
  if (!goal) return { current: 0, best: 0 };
  const today = todayKey();
  const from = addDays(today, -STREAK_LOOKBACK);
  const metrics = await getRangeMetrics(from, today);
  const keys = rangeKeys(from, today);
  const status = keys.map((k) => {
    if (!goalApplies(goal, k)) return 'skip';
    return evaluateGoal(goal, metrics[k]).done ? 'done' : 'miss';
  });
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
  return { current, best: Math.max(best, current) };
}

/** Goal records used by onboarding (stable ids, so re-running never duplicates). */
export function defaultGoals(settings = getSettings()) {
  const t = (settings && settings.targets) || {};
  const water = n0(t.water) || 8;
  const protein = n0(t.protein) || 100;
  const training = n0(t.trainingMinutes) || 30;
  const sleep = n0(t.sleep) || 8;
  const dailySpend = n0(t.dailySpend);
  const g = (id, title, metric, comparator, target, icon, color) => ({
    id: `goal-${id}`,
    title,
    kind: 'metric',
    metric,
    comparator,
    target,
    icon,
    color,
    weekdays: null,
    active: true,
    order: 0,
  });
  const list = [
    g('water', `Drink ${fmtNumber(water)} glasses of water`, 'water', 'gte', water, 'water', '--water'),
    g('protein', `Eat ${fmtNumber(protein)} g protein`, 'protein', 'gte', protein, 'food', '--food'),
    g('training', `Train for ${fmtDuration(training)}`, 'trainingMinutes', 'gte', training, 'training', '--training'),
    g('learn', 'Learn one new thing', 'learnings', 'gte', 1, 'lightbulb', '--learning'),
    g('reflect', 'Write a reflection', 'reflection', 'gte', 1, 'note', '--mood'),
    g('sleep', `Sleep ${fmtNumber(sleep)} hours`, 'sleep', 'gte', sleep, 'moon', '--mood'),
  ];
  if (dailySpend > 0) {
    list.push(
      g('spend', `Spend at most ${fmtMoney(dailySpend, { currency: settings && settings.currency })}`, 'spend', 'lte', dailySpend, 'wallet', '--expenses'),
    );
  }
  list.forEach((goal, i) => (goal.order = i));
  return list;
}

/** Human value for a metric: formatMetricValue('water', 6) → '6 glasses', ('spend', 1200) → '₹1,200'. */
export function formatMetricValue(metric, value) {
  const def = METRICS[metric] || {};
  if (value === null || value === undefined) return '—';
  switch (def.unit) {
    case 'money':
      return fmtMoney(value);
    case 'bool':
      return value ? 'Done' : 'Not yet';
    case 'min':
      return fmtDuration(value);
    case 'h':
      return `${fmtNumber(value, { maxDecimals: 1 })} h`;
    case 'glasses':
      return `${fmtNumber(value)} ${value === 1 ? 'glass' : 'glasses'}`;
    case 'meals':
      return `${fmtNumber(value)} ${value === 1 ? 'meal' : 'meals'}`;
    case '':
    case undefined:
      return fmtNumber(value);
    default:
      return `${fmtNumber(value)} ${def.unit}`;
  }
}
