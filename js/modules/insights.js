// js/modules/insights.js — weekly / monthly / yearly review across every area (SPEC 4.9).
// Choices not fixed by the spec:
// - Routes: #/insights (this week) · #/insights/week/2026-W48 · #/insights/month/2026-11 · #/insights/year/2026.
//   Weeks are ISO weeks (Mon–Sun) so they match the review ids ('week:<isoWeek>'). The URL follows silently.
// - Deltas on an unfinished period compare with the SAME number of days of the previous period ("so far").
// - Averages use only the days that have data for that metric (calories/protein: days with meals, mood: rated days…).
// - Connections use the selected period, but never less than the last 30 days (so a week still has enough days).
// - Year view buckets the trend charts by ISO week.
// - Review autosaves 700 ms after typing; flushed on period change and on leaving the page.
import { db } from '../core/db.js';
import { on } from '../core/bus.js';
import { getSettings, learningCategory, moneyCategory } from '../core/settings.js';
import {
  todayKey, isoWeek, weekRange, monthRange, monthOf, addMonths, addDays, diffDays, rangeKeys, fmtDate, fmtMonth, fmtRange,
} from '../core/dates.js';
import { fmtMoney, fmtTradeMoney, fmtNumber, fmtPercent, fmtDuration, plural, pnlTone } from '../core/format.js';
import {
  h, mount, pageHeader, segmented, statTile, iconChip, icon, listItem, ratingInput, textarea, field, emptyState, skeleton,
  debounce, colorVar,
} from '../core/ui.js';
import { lineChart, barChart } from '../core/charts.js';
import { loadRangeData, metricsForDay, getDayScores } from '../core/metrics.js';
import { computeStats, dailyPnl, closedWithPnl } from './trades/calc.js';
import { getModule } from './registry.js';

const ID = 'insights';
const TITLE = 'Insights';
const ICON = 'insights';
const COLOR = '--primary';
const MIN_GROUP = 5;
const TYPES = ['week', 'month', 'year'];
const NOUN = { week: 'week', month: 'month', year: 'year' };

// ─────────────────────────────────────────────── period helpers
const yearOf = (k) => k.slice(0, 4);
function currentKey(type) {
  const t = todayKey();
  return type === 'week' ? isoWeek(t) : type === 'month' ? monthOf(t) : yearOf(t);
}
function rangeOf(type, key) {
  if (type === 'week') return weekRange(key);
  if (type === 'month') return monthRange(key);
  return { from: `${key}-01-01`, to: `${key}-12-31` };
}
function shiftKey(type, key, n) {
  if (type === 'week') return isoWeek(addDays(weekRange(key).from, 7 * n));
  if (type === 'month') return addMonths(key, n);
  return String(Number(key) + n);
}
function validKey(type, key) {
  const re = type === 'week' ? /^\d{4}-W\d{2}$/ : type === 'month' ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}$/;
  return re.test(key || '') && key <= currentKey(type);
}
function periodTitle(type, key) {
  if (type === 'week') {
    const { from, to } = weekRange(key);
    return `Week ${Number(key.slice(6))} · ${fmtRange(from, to)}`;
  }
  return type === 'month' ? fmtMonth(key) : key;
}
function relName(type, key) {
  const cur = currentKey(type);
  if (key === cur) return `This ${NOUN[type]}`;
  if (key === shiftKey(type, cur, -1)) return `Last ${NOUN[type]}`;
  return null;
}

// ─────────────────────────────────────────────── math helpers
const sum = (a) => a.reduce((s, v) => s + v, 0);
const avg = (a) => (a.length ? sum(a) / a.length : null);
const minKey = (a, b) => (a < b ? a : b);
function change(cur, prev) {
  if (cur === null || prev === null || prev === undefined || !(prev > 0)) return undefined;
  return (cur - prev) / prev;
}

function summarize(keys, M, S, trades) {
  const set = new Set(keys);
  const ms = keys.map((k) => M[k]).filter(Boolean);
  const fed = ms.filter((m) => m.meals > 0);
  const watered = ms.filter((m) => m.water > 0);
  const scores = keys.map((k) => S[k] && S[k].score).filter((v) => v !== null && v !== undefined);
  const pick = (f) => ms.map((m) => m[f]).filter((v) => v !== null && v !== undefined);
  const tr = trades.filter((t) => set.has(t.date));
  return {
    days: keys.length,
    logged: ms.filter((m) => m.hasAny).length,
    score: avg(scores),
    perfect: scores.filter((s) => s >= 0.999).length,
    calories: fed.length ? avg(fed.map((m) => m.calories)) : null,
    protein: fed.length ? avg(fed.map((m) => m.protein)) : null,
    fedDays: fed.length,
    water: watered.length ? avg(watered.map((m) => m.water)) : null,
    trainingMinutes: sum(ms.map((m) => m.trainingMinutes)),
    workouts: sum(ms.map((m) => m.workouts)),
    trainDays: ms.filter((m) => m.workouts > 0).length,
    learnings: sum(ms.map((m) => m.learnings)),
    learningMinutes: sum(ms.map((m) => m.learningMinutes)),
    spend: sum(ms.map((m) => m.spend)),
    income: sum(ms.map((m) => m.income)),
    moneyRows: sum(ms.map((m) => m.expenseCount)) + ms.filter((m) => m.income > 0).length,
    mood: avg(pick('mood')),
    moodDays: pick('mood').length,
    energy: avg(pick('energy')),
    sleep: avg(pick('sleep')),
    sleepDays: pick('sleep').length,
    stats: computeStats(tr),
    trades: tr,
  };
}

// ─────────────────────────────────────────────── connections
function compare({ id, title, icon: ic, accent, days, inA, inB, value, labelA, labelB, fmt, minDays = MIN_GROUP, agg, verdict, signed }) {
  const A = days.filter(inA);
  const B = days.filter(inB);
  const ok = A.length >= minDays && B.length >= minDays;
  const res = { id, title, icon: ic, accent, ok, nA: A.length, nB: B.length, labelA, labelB, fmt, signed };
  if (!ok) return res;
  res.a = agg ? agg(A) : avg(A.map(value));
  res.b = agg ? agg(B) : avg(B.map(value));
  if (res.a === null || res.b === null) return { ...res, ok: false };
  res.text = verdict(res.a, res.b);
  return res;
}

function buildConnections(keys, M, trades) {
  const ms = keys.map((k) => M[k]).filter(Boolean);
  const pnl = dailyPnl(trades.filter((t) => t.date >= keys[0] && t.date <= keys[keys.length - 1]));
  const tradeDays = ms.filter((m) => pnl[m.date]).map((m) => ({ ...m, pnl: pnl[m.date].pnl, wins: pnl[m.date].wins, losses: pnl[m.date].losses }));
  const n1 = (v) => fmtNumber(v, { decimals: 1 });
  const money = (v) => fmtTradeMoney(v, { sign: true, decimals: 0 });
  const close = (a, b, rel = 0.08) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * rel;
  const pnlVerdict = (good, bad) => (a, b) => {
    if (close(a, b, 0.1)) return `Your average trading day is about the same either way (${money(a)} vs ${money(b)}).`;
    return a > b
      ? `You make ${fmtTradeMoney(a - b, { decimals: 0 })} more per trading day ${good} (${money(a)} vs ${money(b)}).`
      : `Your trading days ${good} average ${money(a)}, vs ${money(b)} on ${bad} — ${fmtTradeMoney(b - a, { decimals: 0 })} less.`;
  };
  const sleepOk = (m) => m.sleep !== null && m.sleep >= 7;
  const sleepLow = (m) => m.sleep !== null && m.sleep < 7;
  const trained = (m) => m.trainingMinutes > 0;
  const rested = (m) => m.trainingMinutes <= 0;
  const winRate = (list) => {
    const w = sum(list.map((m) => m.wins));
    const l = sum(list.map((m) => m.losses));
    return w + l ? w / (w + l) : null;
  };

  return [
    compare({
      id: 'mood-training', title: 'Mood · training vs rest days', icon: 'smile', accent: '--mood',
      days: ms.filter((m) => m.mood !== null), inA: trained, inB: rested, value: (m) => m.mood,
      labelA: 'Training days', labelB: 'Rest days', fmt: (v) => `${n1(v)} / 5`,
      verdict: (a, b) => (Math.abs(a - b) < 0.15
        ? 'Your mood is about the same whether you train or rest.'
        : `Your mood is ${n1(Math.abs(a - b))} points ${a > b ? 'higher' : 'lower'} on days you train.`),
    }),
    compare({
      id: 'pnl-sleep', title: 'Trading P&L · sleep 7h+ vs less', icon: 'bed', accent: '--trades', signed: true,
      days: tradeDays, inA: sleepOk, inB: sleepLow, value: (m) => m.pnl,
      labelA: 'Slept 7h+', labelB: 'Under 7h', fmt: money,
      verdict: pnlVerdict('after 7+ hours of sleep', 'short-sleep days'),
    }),
    compare({
      id: 'spend-mood', title: 'Spending · good vs low mood', icon: 'wallet', accent: '--expenses',
      days: ms.filter((m) => m.mood !== null), inA: (m) => m.mood >= 4, inB: (m) => m.mood <= 2, value: (m) => m.spend,
      labelA: 'Mood 4–5', labelB: 'Mood 1–2', fmt: (v) => fmtMoney(v, { decimals: 0 }),
      verdict: (a, b) => (close(a, b, 0.1)
        ? 'Your spending doesn’t change much with your mood.'
        : a > b
          ? `You spend ${fmtMoney(a - b, { decimals: 0 })} more a day when you feel good.`
          : `On low-mood days you spend ${fmtMoney(b - a, { decimals: 0 })} more — worth noticing.`),
    }),
    compare({
      id: 'pnl-training', title: 'Trading P&L · training vs rest days', icon: 'training', accent: '--training', signed: true,
      days: tradeDays, inA: trained, inB: rested, value: (m) => m.pnl,
      labelA: 'Training days', labelB: 'Rest days', fmt: money,
      verdict: pnlVerdict('when you train', 'rest days'),
    }),
    compare({
      id: 'winrate-sleep', title: 'Win rate · after good sleep', icon: 'moon', accent: '--trades',
      days: tradeDays, inA: sleepOk, inB: sleepLow, agg: winRate,
      labelA: 'Slept 7h+', labelB: 'Under 7h', fmt: (v) => fmtPercent(v, { decimals: 0 }),
      verdict: (a, b) => (Math.abs(a - b) < 0.03
        ? 'Sleep doesn’t seem to move your win rate.'
        : `Your win rate is ${Math.round(Math.abs(a - b) * 100)} points ${a > b ? 'higher' : 'lower'} after 7+ hours of sleep.`),
    }),
    compare({
      id: 'protein-training', title: 'Protein · training vs rest days', icon: 'food', accent: '--food',
      days: ms.filter((m) => m.meals > 0), inA: trained, inB: rested, value: (m) => m.protein,
      labelA: 'Training days', labelB: 'Rest days', fmt: (v) => `${fmtNumber(v, { decimals: 0 })} g`,
      verdict: (a, b) => {
        const target = Number(getSettings().targets?.protein) || 0;
        if (close(a, b, 0.06)) return `You eat about the same protein either way${target ? ` (target ${target} g)` : ''}.`;
        return a > b
          ? `You eat ${fmtNumber(a - b, { decimals: 0 })} g more protein on training days — good for recovery.`
          : `You eat ${fmtNumber(b - a, { decimals: 0 })} g less protein on training days, when you need it most.`;
      },
    }),
  ];
}

// ─────────────────────────────────────────────── view
async function render(root, ctx) {
  const p0 = ctx.route.params || [];
  let type = TYPES.includes(p0[0]) ? p0[0] : 'week';
  let key = validKey(type, p0[1]) ? p0[1] : currentKey(type);
  let disposed = false;
  let seq = 0;

  // ---- persistent chrome
  const typeSeg = segmented(
    [{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }],
    type,
    (t) => setPeriod(t, currentKey(t)),
    { ariaLabel: 'Period', class: 'insights-type' }
  );
  const prevBtn = h('button.btn.btn-ghost.btn-icon', { type: 'button', onClick: () => setPeriod(type, shiftKey(type, key, -1)) }, icon('chevron-left'));
  const nextBtn = h('button.btn.btn-ghost.btn-icon', { type: 'button', onClick: () => setPeriod(type, shiftKey(type, key, 1)) }, icon('chevron-right'));
  const labelMain = h('span.insights-period-main');
  const labelRel = h('span.insights-period-rel');
  const nowBtn = h('button.btn.btn-sm.btn-pill.insights-now', { type: 'button', onClick: () => setPeriod(type, currentKey(type)) }, icon('rotate-ccw', { size: 14 }), h('span.insights-now-label'));
  const navEl = h('div.insights-nav', { role: 'group', 'aria-label': 'Period' }, prevBtn, h('div.insights-period', { 'aria-live': 'polite' }, labelMain, labelRel), nextBtn);
  const toolbar = h('div.insights-toolbar', typeSeg, h('div.insights-nav-wrap', navEl, nowBtn));

  const body = h('div.insights-body', loadingSkeleton());
  const reviewSlot = h('div.insights-review-slot');
  mount(
    root,
    h('div.page.insights-page', { style: { '--accent': colorVar(COLOR) } },
      pageHeader({ title: TITLE, subtitle: 'How your days add up — and what moves them' }),
      toolbar, body, reviewSlot)
  );

  let review = null;
  function setPeriod(t, k) {
    if (!validKey(t, k)) k = currentKey(t);
    if (t === type && k === key) return;
    type = t;
    key = k;
    typeSeg.setValue(t);
    const isDefault = t === 'week' && k === currentKey('week');
    ctx.navigate(isDefault ? '/insights' : `/insights/${t}/${k}`, { replace: true, silent: true });
    syncNav();
    review && review.dispose();
    review = buildReview();
    draw();
  }

  function syncNav() {
    labelMain.textContent = periodTitle(type, key);
    const rel = relName(type, key);
    labelRel.textContent = rel || '';
    labelRel.hidden = !rel;
    const atEnd = key >= currentKey(type);
    if (atEnd && document.activeElement === nextBtn) prevBtn.focus();
    nextBtn.disabled = atEnd;
    prevBtn.setAttribute('aria-label', `Previous ${NOUN[type]}`);
    nextBtn.setAttribute('aria-label', `Next ${NOUN[type]}`);
    prevBtn.title = `Previous ${NOUN[type]}`;
    nextBtn.title = `Next ${NOUN[type]}`;
    nowBtn.hidden = key === currentKey(type);
    nowBtn.querySelector('.insights-now-label').textContent = `This ${NOUN[type]}`;
  }

  // ---- data + drawing
  async function draw() {
    const my = ++seq;
    const today = todayKey();
    const { from, to } = rangeOf(type, key);
    const effTo = minKey(to, today);
    const partial = to > today;
    const elapsed = diffDays(from, effTo) + 1;
    const prevKey = shiftKey(type, key, -1);
    const pr = rangeOf(type, prevKey);
    const pTo = partial ? minKey(addDays(pr.from, elapsed - 1), pr.to) : pr.to;
    const connFrom = minKey(from, addDays(effTo, -29));
    const loadFrom = minKey(pr.from, connFrom);

    const [data, S] = await Promise.all([loadRangeData(loadFrom, effTo), getDayScores(loadFrom, effTo)]);
    if (disposed || my !== seq) return;
    const M = {};
    for (const k of rangeKeys(loadFrom, effTo)) M[k] = metricsForDay(k, data);
    // Days before your first log (in the loaded window) would read as "missed" — start the period there instead.
    const loaded = rangeKeys(loadFrom, effTo);
    const tradeDates = new Set(data.trades.map((t) => t.date));
    const first = loaded.find((k) => M[k].hasAny || tradeDates.has(k)) || effTo;
    const keys = rangeKeys(first > from ? first : from, effTo).filter((k) => k >= first || first > effTo);
    const cur = summarize(keys, M, S, data.trades);
    const prev = summarize(rangeKeys(pr.from, pTo).filter((k) => k >= first), M, S, data.trades);
    const vsLabel = partial ? `vs same days last ${NOUN[type]}` : `vs last ${NOUN[type]}`;
    const periodData = { from, to: effTo, keys, data };

    const hasData = cur.logged > 0 || cur.trades.length > 0;
    if (!hasData) {
      const prevHas = prev.logged > 0;
      mount(body, h('div.card.insights-empty', emptyState({
        icon: ICON,
        accent: COLOR,
        title: `Nothing logged ${relName(type, key) ? relName(type, key).toLowerCase() : `in ${periodTitle(type, key)}`}`,
        message: key === currentKey(type)
          ? 'Log a meal, a workout, your mood or a trade — your trends and connections will build up here.'
          : `No entries in this ${NOUN[type]}.`,
        action: { label: 'Log something today', icon: 'plus', onClick: () => ctx.navigate('/today') },
        actions: prevHas ? [{ label: `Previous ${NOUN[type]}`, icon: 'chevron-left', onClick: () => setPeriod(type, prevKey) }] : [],
      })));
      return;
    }

    const connKeys = rangeKeys(connFrom, effTo);
    const conns = buildConnections(connKeys, M, data.trades);
    mount(
      body,
      kpiSection(cur, prev, vsLabel, partial),
      trendsSection(type, periodData, M, S, cur),
      connectionsSection(conns, connFrom, effTo, type),
      highlightsSection(keys, M, S, data, cur)
    );
  }

  function loadingSkeleton() {
    return h('div.insights-groups', [0, 1, 2].map(() => h('div.card', skeleton({ width: '40%', height: 14 }), h('div.insights-tiles', skeleton({ height: 48 }), skeleton({ height: 48 })))));
  }

  // ---- KPIs
  function kpiSection(c, p, vsLabel, partial) {
    const s = getSettings();
    const t = s.targets || {};
    const prevOk = p.logged > 0 || p.trades.length > 0;
    const d = (a, b) => (prevOk ? change(a, b) : undefined);
    const tile = (o) => {
      const empty = o.value === null || o.value === undefined || o.value === '—';
      const el = statTile({ ...o, value: empty ? '—' : o.value, delta: empty ? undefined : o.delta, deltaLabel: vsLabel, sub: empty ? o.emptySub || 'No data' : o.sub, class: { 'is-empty': empty } });
      return el;
    };
    const st = c.stats;
    const ps = p.stats;
    const hasTrades = st.count > 0;
    const pnlSub = hasTrades
      ? [plural(st.count, 'trade'), ps.count ? `${fmtTradeMoney(ps.net, { sign: true, decimals: 0 })} before` : null].filter(Boolean).join(' · ')
      : null;
    const wrPts = hasTrades && ps.count ? Math.round((st.winRate - ps.winRate) * 100) : null;
    const per = (n) => (type === 'week' ? null : `${fmtNumber(n / Math.max(1, c.days / 7), { maxDecimals: 1 })} / week`);

    const groups = [
      {
        name: 'Overall', icon: 'target', accent: '--goals', tiles: [
          tile({ label: 'Day score', value: c.score === null ? null : fmtPercent(c.score, { decimals: 0 }), delta: d(c.score, p.score), sub: c.perfect ? plural(c.perfect, 'perfect day') : `${c.logged} of ${c.days} logged`, emptySub: 'No goals set' }),
          tile({ label: 'Avg mood', value: c.mood === null ? null : fmtNumber(c.mood, { decimals: 1 }), unit: '/5', delta: d(c.mood, p.mood), sub: plural(c.moodDays, 'day') + ' rated', accent: '--mood' }),
          tile({ label: 'Avg sleep', value: c.sleep === null ? null : fmtNumber(c.sleep, { decimals: 1 }), unit: 'h', delta: d(c.sleep, p.sleep), sub: t.sleep ? `Target ${t.sleep} h` : null, accent: '--mood' }),
        ],
      },
      {
        name: 'Food', icon: 'food', accent: '--food', tiles: [
          tile({ label: 'Avg calories', value: c.calories === null ? null : fmtNumber(c.calories, { decimals: 0 }), unit: 'kcal', delta: d(c.calories, p.calories), deltaGood: 'down', sub: t.calories ? `Target ${fmtNumber(t.calories)}` : null }),
          tile({ label: 'Avg protein', value: c.protein === null ? null : fmtNumber(c.protein, { decimals: 0 }), unit: 'g', delta: d(c.protein, p.protein), sub: t.protein ? `Target ${fmtNumber(t.protein)} g` : null }),
          tile({ label: 'Avg glasses', value: c.water === null ? null : fmtNumber(c.water, { decimals: 1 }), delta: d(c.water, p.water), sub: t.water ? `Target ${t.water}` : 'Water per day', accent: '--water' }),
        ],
      },
      {
        name: 'Training', icon: 'training', accent: '--training', tiles: [
          tile({ label: 'Training time', value: c.workouts ? fmtDuration(c.trainingMinutes) : null, delta: d(c.trainingMinutes, p.trainingMinutes), sub: plural(c.trainDays, 'active day') }),
          tile({ label: 'Workouts', value: c.workouts ? fmtNumber(c.workouts) : null, delta: d(c.workouts, p.workouts), sub: per(c.workouts) }),
        ],
      },
      {
        name: 'Learning', icon: 'learning', accent: '--learning', tiles: [
          tile({ label: 'Things learned', value: c.learnings ? fmtNumber(c.learnings) : null, delta: d(c.learnings, p.learnings), sub: per(c.learnings) }),
          tile({ label: 'Learning time', value: c.learningMinutes ? fmtDuration(c.learningMinutes) : null, delta: d(c.learningMinutes, p.learningMinutes), sub: c.learnings && c.learningMinutes ? `${fmtDuration(c.learningMinutes / c.learnings)} each` : null, emptySub: c.learnings ? 'No minutes logged' : 'No data' }),
        ],
      },
      {
        name: 'Money', icon: 'wallet', accent: '--expenses', tiles: [
          tile({ label: 'Spent', value: c.moneyRows ? fmtMoney(c.spend, { decimals: 0 }) : null, delta: d(c.spend, p.spend), deltaGood: 'down', sub: `${fmtMoney(c.spend / Math.max(1, c.days), { decimals: 0 })} / day` }),
          tile({ label: 'Income', value: c.moneyRows ? fmtMoney(c.income, { decimals: 0 }) : null, delta: d(c.income, p.income), sub: c.income ? `Net ${fmtMoney(c.income - c.spend, { sign: true, decimals: 0 })}` : 'None logged', accent: '--profit' }),
        ],
      },
      {
        name: 'Trading', icon: 'trades', accent: '--trades', tiles: [
          tile({ label: 'Net P&L', value: hasTrades ? fmtTradeMoney(st.net, { sign: st.net !== 0 }) : null, tone: hasTrades ? pnlTone(st.net) : null, sub: pnlSub, emptySub: st.open ? `${plural(st.open, 'open trade')}` : 'No closed trades' }),
          tile({ label: 'Win rate', value: hasTrades ? fmtPercent(st.winRate, { decimals: 0 }) : null, sub: hasTrades ? [`${st.wins}W · ${st.losses}L`, wrPts !== null ? `${wrPts > 0 ? '+' : wrPts < 0 ? '−' : '±'}${Math.abs(wrPts)} pts` : null].filter(Boolean).join(' · ') : null }),
        ],
      },
    ];
    return h('section.section.insights-kpis', { 'aria-labelledby': 'ins-kpi-title' },
      h('div.insights-section-head',
        h('h2.section-title', { id: 'ins-kpi-title' }, 'At a glance'),
        h('span.insights-note', partial ? `Arrows compare with the same days last ${NOUN[type]}` : `Arrows compare with last ${NOUN[type]}`)),
      h('div.insights-groups', groups.map((g) => {
        const allEmpty = g.tiles.every((x) => x.classList.contains('is-empty'));
        return h('div.card.insights-group', { class: { 'is-empty': allEmpty }, style: { '--accent': colorVar(g.accent) } },
          h('div.insights-group-head', iconChip(g.icon, { accent: g.accent, size: 'sm' }), h('h3.insights-group-title', g.name)),
          h('div.insights-tiles', { dataset: { count: String(g.tiles.length) } }, g.tiles));
      }))
    );
  }

  // ---- trends
  function trendsSection(tp, pd, M, S, cur) {
    const { keys } = pd;
    // Buckets: days (week/month) or ISO weeks (year).
    let buckets;
    if (tp === 'year') {
      const map = new Map();
      for (const k of keys) {
        const w = isoWeek(k);
        if (!map.has(w)) map.set(w, []);
        map.get(w).push(k);
      }
      buckets = [...map.entries()].map(([label, ks]) => ({ label, ks }));
    } else buckets = keys.map((k) => ({ label: k, ks: [k] }));
    const xFormat = tp === 'week' ? (k) => fmtDate(k, 'weekday') : undefined;
    const perDay = tp !== 'year';
    const bAvg = (ks, f) => avg(ks.map(f).filter((v) => v !== null && v !== undefined));
    const bSum = (ks, f) => sum(ks.map(f));
    const tipTitle = tp === 'year' ? (w) => { const r = weekRange(w); return `Week ${Number(w.slice(6))} · ${fmtRange(r.from, r.to)}`; } : undefined;

    const cards = [];
    const chartCard = (title, sub, ic, accent, chart, cls) =>
      h('section.card.insights-chart', { class: cls, style: { '--accent': colorVar(accent) } },
        h('div.card-header', iconChip(ic, { accent, size: 'sm' }), h('div.card-header-text', h('h3.card-title', title), sub ? h('p.card-subtitle', sub) : null)),
        h('div.card-body', chart));

    if (cur.score !== null) {
      cards.push(chartCard('Day score', perDay ? 'Share of goals hit each day' : 'Weekly average of goals hit', 'target', '--goals', barChart({
        data: buckets.map((b) => ({ label: b.label, value: bAvg(b.ks, (k) => S[k] && S[k].score) })),
        color: '--goals', height: 200, xFormat, yFormat: (v) => fmtPercent(v, { decimals: 0 }), tooltipTitle: tipTitle, ariaLabel: 'Day score',
      })));
    }
    if (cur.mood !== null || cur.energy !== null) {
      cards.push(chartCard('Mood & energy', `1 = awful · 5 = great${perDay ? '' : ' · weekly average'}`, 'smile', '--mood', lineChart({
        series: [
          { name: 'Mood', color: '--mood', points: buckets.map((b) => ({ x: b.label, y: bAvg(b.ks, (k) => M[k].mood) })) },
          { name: 'Energy', color: '--goals', points: buckets.map((b) => ({ x: b.label, y: bAvg(b.ks, (k) => M[k].energy) })) },
        ],
        height: 200, xFormat, yFormat: (v) => fmtNumber(v, { maxDecimals: 1 }), tooltipTitle: tipTitle, ariaLabel: 'Mood and energy',
      })));
    }
    if (cur.workouts) {
      cards.push(chartCard('Training minutes', perDay ? `${fmtDuration(cur.trainingMinutes)} total` : `Per week · ${fmtDuration(cur.trainingMinutes)} total`, 'training', '--training', barChart({
        data: buckets.map((b) => ({ label: b.label, value: bSum(b.ks, (k) => M[k].trainingMinutes) })),
        color: '--training', height: 200, xFormat, target: perDay ? Number(getSettings().targets?.trainingMinutes) || undefined : Number(getSettings().targets?.weeklyTrainingMinutes) || undefined,
        yFormat: (v) => fmtNumber(v), tooltipFormat: (v) => fmtDuration(v), tooltipTitle: tipTitle, ariaLabel: 'Training minutes', targetLabel: 'Target',
      })));
    }
    if (cur.spend > 0) {
      const daily = Number(getSettings().targets?.dailySpend) || 0;
      cards.push(chartCard('Spending', perDay ? `${fmtMoney(cur.spend, { decimals: 0 })} total` : `Per week · ${fmtMoney(cur.spend, { decimals: 0 })} total`, 'expenses', '--expenses', barChart({
        data: buckets.map((b) => ({ label: b.label, value: bSum(b.ks, (k) => M[k].spend) })),
        color: '--expenses', height: 200, xFormat, target: perDay && daily ? daily : undefined,
        yFormat: fmtMoney, tooltipFormat: (v) => fmtMoney(v), tooltipTitle: tipTitle, ariaLabel: 'Spending',
      })));
    }
    if (cur.stats.count) {
      const closed = closedWithPnl(cur.trades);
      const byDay = dailyPnl(closed);
      let eq = 0;
      const pts = Object.keys(byDay).sort().map((d) => ({ x: d, y: (eq = Math.round((eq + byDay[d].pnl) * 100) / 100) }));
      const dd = cur.stats.maxDrawdown;
      cards.push(chartCard('Trading equity', `Cumulative net P&L · max drawdown ${fmtTradeMoney(dd, { decimals: 0 })}`, 'line-chart', '--trades', lineChart({
        series: [{ name: 'Equity', color: '--trades', points: pts }],
        height: 200, area: true, zeroLine: true, yFormat: fmtTradeMoney, tooltipFormat: (v) => fmtTradeMoney(v, { sign: true }), ariaLabel: 'Trading equity',
      }), 'insights-chart-wide'));
    }
    if (!cards.length) return null;
    return h('section.section', h('h2.section-title', 'Trends'), h('div.insights-charts', cards));
  }

  // ---- connections
  function connectionsSection(conns, from, to, tp) {
    const ready = conns.filter((c) => c.ok);
    const waiting = conns.filter((c) => !c.ok);
    const scope = tp === 'week' ? `Based on the last 30 days (${fmtRange(from, to)})` : `Based on ${fmtRange(from, to)}`;
    const bar = (c, label, v, n, which) => {
      const max = Math.max(Math.abs(c.a), Math.abs(c.b)) || 1;
      const frac = Math.max(0.02, Math.abs(v) / max);
      const tone = c.signed ? (v < 0 ? 'loss' : 'profit') : null;
      return h('div.insights-cmp-row', { class: which },
        h('span.insights-cmp-label', label, h('span.insights-cmp-n', ` · ${plural(n, 'day')}`)),
        h('span.insights-cmp-track', h('span.insights-cmp-fill', { class: tone && `is-${tone}`, style: { width: `${(frac * 100).toFixed(1)}%` } })),
        h('span.insights-cmp-val.num', { class: tone && `text-${tone}` }, c.fmt(v)));
    };
    return h('section.section.insights-connections', { 'aria-labelledby': 'ins-conn-title' },
      h('div.insights-section-head', h('h2.section-title', { id: 'ins-conn-title' }, 'Connections'), h('span.insights-note', scope)),
      ready.length
        ? h('div.insights-conn-grid', ready.map((c) =>
            h('article.card.insights-conn', { style: { '--accent': colorVar(c.accent) } },
              h('div.insights-conn-head', iconChip(c.icon, { accent: c.accent, size: 'sm' }), h('h3.insights-conn-title', c.title)),
              h('p.insights-conn-text', c.text),
              h('div.insights-cmp', bar(c, c.labelA, c.a, c.nA, 'is-a'), bar(c, c.labelB, c.b, c.nB, 'is-b')))))
        : h('div.card', emptyState({ icon: 'sparkles', accent: COLOR, compact: true, title: 'Connections need a few more days', message: `Each comparison needs at least ${MIN_GROUP} days in both groups. Keep logging mood, sleep, workouts and trades — patterns show up within a couple of weeks.` })),
      waiting.length && ready.length
        ? h('details.insights-waiting',
            h('summary', `${plural(waiting.length, 'more comparison')} waiting for data`),
            h('ul', waiting.map((c) => h('li', h('span', c.title), h('span.muted.num', `${c.nA} / ${c.nB} days (needs ${MIN_GROUP} each)`)))))
        : null,
      ready.length ? h('p.insights-caveat', 'Patterns from your own logs — they show what tends to go together, not what causes what.') : null
    );
  }

  // ---- highlights
  function highlightsSection(keys, M, S, data, cur) {
    const set = new Set(keys);
    const items = [];
    // Best day
    let best = null;
    for (const k of keys) {
      const s = S[k];
      if (!s || s.score === null || s.score === undefined) continue;
      if (!best || s.score > best.s.score || (s.score === best.s.score && s.done > best.s.done) || (s.score === best.s.score && s.done === best.s.done)) best = { k, s };
    }
    if (best && best.s.done > 0) {
      items.push(listItem({ icon: 'trophy', accent: '--goals', title: `Best day · ${fmtDate(best.k, 'medium')}`, meta: [`${best.s.done} of ${best.s.total} goals`, fmtPercent(best.s.score, { decimals: 0 })], chevron: true, onClick: () => ctx.navigate(`/today/${best.k}`) }));
    }
    // Longest logging run inside the period
    let run = 0, bestRun = 0, runEnd = null;
    for (const k of keys) {
      if (M[k] && M[k].hasAny) { run++; if (run > bestRun) { bestRun = run; runEnd = k; } } else run = 0;
    }
    if (bestRun > 1) items.push(listItem({ icon: 'flame', accent: '--food', title: `Longest streak · ${plural(bestRun, 'day')}`, meta: fmtRange(addDays(runEnd, -(bestRun - 1)), runEnd), trailMeta: bestRun === keys.length ? 'Every day!' : null }));
    // Top learning category
    const learn = data.learning.filter((l) => set.has(l.date));
    if (learn.length) {
      const counts = new Map();
      for (const l of learn) counts.set(l.category || 'other', (counts.get(l.category || 'other') || 0) + 1);
      const [catId, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const cat = learningCategory(catId);
      items.push(listItem({ emoji: cat.emoji, accent: '--learning', title: `Top learning · ${cat.name}`, meta: [plural(n, 'thing') + ' learned', `${Math.round((n / learn.length) * 100)}% of ${learn.length}`], chevron: true, onClick: () => ctx.navigate('/learning') }));
    }
    // Biggest expense
    const exps = data.expenses.filter((e) => set.has(e.date) && e.type !== 'income');
    if (exps.length) {
      const big = exps.reduce((a, b) => (Number(b.amount) > Number(a.amount) ? b : a));
      const cat = moneyCategory('expense', big.category);
      const mod = getModule('expenses');
      items.push(listItem({ emoji: cat.emoji, accent: '--expenses', title: `Biggest expense · ${(big.note || '').trim() || cat.name}`, meta: [fmtDate(big.date, 'medium'), cat.name], trail: h('span.num.text-strong', fmtMoney(big.amount, { decimals: 0 })), chevron: !!mod, onClick: mod && mod.openEditor ? () => mod.openEditor(big) : () => ctx.navigate('/expenses') }));
    }
    // Best trade
    const bt = cur.stats.best;
    if (bt && cur.stats.largestWin) {
      items.push(listItem({ icon: 'trending-up', accent: '--trades', title: `Best trade · ${bt.symbol || 'Trade'}`, meta: [fmtDate(bt.date, 'medium'), bt.setup || null, bt.direction === 'short' ? 'Short' : 'Long'], trail: h('span.num.text-profit.text-strong', fmtTradeMoney(cur.stats.largestWin, { sign: true, decimals: 0 })), chevron: true, onClick: () => ctx.navigate(`/trades/view/${bt.id}`) }));
    }
    if (!items.length) return null;
    return h('section.section', h('h2.section-title', 'Highlights'), h('div.card.card-flush.insights-highlights', h('div.list', items)));
  }

  // ---- period review (autosave)
  function buildReview() {
    const rType = type;
    const rKey = key;
    const id = `${rType}:${rKey}`;
    let rec = null;
    let alive = true;
    const status = h('span.insights-saved', { 'aria-live': 'polite' });
    const setStatus = (s) => { status.textContent = s; status.dataset.state = s ? (s === 'Saved' ? 'saved' : 'saving') : ''; };
    const draft = { rating: null, wentWell: '', improve: '', focus: '' };
    const save = debounce(async () => {
      try {
        const saved = await db.put('reviews', { ...(rec || {}), id, type: rType, period: rKey, rating: draft.rating, wentWell: draft.wentWell, improve: draft.improve, focus: draft.focus });
        rec = saved;
        if (alive) setStatus('Saved');
      } catch (err) {
        console.error('[daybook] review save failed', err);
        if (alive) setStatus('Couldn’t save');
      }
    }, 700);
    const touch = () => { setStatus('Saving…'); save(); };
    const rating = ratingInput(null, (v) => { draft.rating = v; touch(); }, { ariaLabel: `Rate this ${NOUN[rType]}`, labels: ['Rough', 'Meh', 'Okay', 'Good', 'Great'] });
    const ta = (k, ph) => textarea({ rows: 3, placeholder: ph, value: '', onInput: (e) => { draft[k] = e.target.value; touch(); } });
    const well = ta('wentWell', 'Wins, good habits, moments you’re proud of');
    const improve = ta('improve', 'What got in the way? What would you change?');
    const focus = ta('focus', `One or two things to focus on next ${NOUN[rType]}`);
    const el = h('section.card.insights-review', { 'aria-labelledby': 'ins-review-title', style: { '--accent': colorVar(COLOR) } },
      h('div.card-header', iconChip('notebook', { accent: COLOR }),
        h('div.card-header-text', h('h2.card-title', { id: 'ins-review-title' }, `${NOUN[rType][0].toUpperCase()}${NOUN[rType].slice(1)} review`), h('p.card-subtitle', periodTitle(rType, rKey))),
        h('div.card-actions', status)),
      h('div.card-body.stack',
        field(`How was this ${NOUN[rType]}?`, rating),
        h('div.insights-review-grid', field('What went well', well), field('What to improve', improve), field(`Focus next ${NOUN[rType]}`, focus))));
    mount(reviewSlot, el);
    db.get('reviews', id).then((r) => {
      if (!alive || !r) return;
      if (save.pending && save.pending()) return; // user already typing
      rec = r;
      Object.assign(draft, { rating: r.rating ?? null, wentWell: r.wentWell || '', improve: r.improve || '', focus: r.focus || '' });
      rating.setValue ? rating.setValue(draft.rating) : null;
      for (const [node, k] of [[well, 'wentWell'], [improve, 'improve'], [focus, 'focus']]) {
        node.value = draft[k];
        node.autogrow && node.autogrow();
      }
    }).catch(() => {});
    return {
      dispose() { save.flush(); alive = false; },
      reload() { if (!(save.pending && save.pending())) { alive = false; review = buildReview(); } },
    };
  }

  syncNav();
  review = buildReview();
  await draw();

  const refresh = debounce(draw, 80);
  const offs = [
    on('db:change', (e) => {
      if (e.store === 'reviews') return; // our own autosave
      if (e.store === '*') review && review.reload();
      refresh();
    }),
    on('settings:change', refresh),
  ];
  return () => {
    disposed = true;
    refresh.cancel();
    offs.forEach((off) => off());
    review && review.dispose();
  };
}

export default { id: ID, title: TITLE, icon: ICON, color: COLOR, render };
