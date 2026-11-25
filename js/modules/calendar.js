// js/modules/calendar.js — global calendar (SPEC 4.8).
// Choices not fixed by the spec:
// - Route #/calendar/<YYYY-MM> (the URL follows the month picker silently). The colour mode persists (localStorage).
// - Colour intensity: Goals = share of goals hit, Mood = 1..5, Spending / Training = relative to the month's
//   busiest day (training: at least the daily target), Trading P&L = signed (green/red) relative to the largest |P&L|.
// - The year heatmap shows the year of the displayed month (the current year by default), in the chosen mode.
// - Day cells use a roving tabindex: Tab enters the grid once, arrow keys / Home / End move, Enter opens the day.
import { on } from '../core/bus.js';
import { getSettings } from '../core/settings.js';
import {
  todayKey, currentMonth, monthRange, daysInMonth, weekday, weekdayLabels, fmtDate, fmtMonth, addDays,
} from '../core/dates.js';
import { fmtMoney, fmtTradeMoney, fmtPercent, fmtDuration, fmtNumber, plural, pnlTone } from '../core/format.js';
import { h, mount, pageHeader, segmented, monthNav, skeleton, emptyState, debounce, colorVar, icon } from '../core/ui.js';
import { heatmap } from '../core/charts.js';
import { loadRangeData, metricsForDay, getDayScores } from '../core/metrics.js';

const ID = 'calendar';
const TITLE = 'Calendar';
const ICON = 'calendar';
const COLOR = '--goals';
const LS_MODE = 'daybook:calendar:mode';
const MOOD_EMOJI = ['😫', '😕', '😐', '🙂', '😄'];
const MOOD_LABEL = ['Awful', 'Low', 'Okay', 'Good', 'Great'];

const DOTS = [
  { id: 'food', label: 'Food', color: '--food', has: (m) => m.meals > 0 },
  { id: 'learning', label: 'Learning', color: '--learning', has: (m) => m.learnings > 0 },
  { id: 'training', label: 'Training', color: '--training', has: (m) => m.workouts > 0 },
  { id: 'expenses', label: 'Money', color: '--expenses', has: (m) => m.expenseCount > 0 || m.income > 0 },
  { id: 'trades', label: 'Trades', color: '--trades', has: (m) => m.trades > 0 },
];

const MODES = {
  goals: {
    label: 'Goals', icon: 'target', accent: '--goals',
    value: (k, m, s) => (s && s.score !== null && s.score !== undefined ? s.score : null),
    short: (v) => fmtPercent(v, { decimals: 0 }),
    long: (v, k, m, s) => `${s.done} of ${s.total} goals (${fmtPercent(v, { decimals: 0 })})`,
    max: () => 1,
    lo: '0%', hi: 'All goals',
  },
  mood: {
    label: 'Mood', icon: 'smile', accent: '--mood',
    value: (k, m) => m.mood,
    short: (v) => MOOD_EMOJI[Math.round(v) - 1] || '',
    long: (v) => `Mood ${MOOD_LABEL[Math.round(v) - 1] || v} (${v} of 5)`,
    level: (v) => [1, 1, 2, 3, 4][Math.round(v) - 1] || 0,
    max: () => 5,
    lo: 'Awful', hi: 'Great',
  },
  spend: {
    label: 'Spend', icon: 'wallet', accent: '--expenses',
    value: (k, m) => (m.spend > 0 ? m.spend : null),
    short: (v) => fmtMoney(v, { compact: true, decimals: v >= 1000 ? undefined : 0 }),
    long: (v) => `Spent ${fmtMoney(v)}`,
    lo: 'Less', hi: 'More',
  },
  pnl: {
    label: 'P&L', icon: 'trades', accent: '--trades', signed: true,
    value: (k, m) => (m.tradeWins + m.tradeLosses > 0 || m.tradePnl !== 0 ? m.tradePnl : null),
    short: (v) => fmtTradeMoney(v, { sign: true, compact: true, decimals: Math.abs(v) >= 1000 ? undefined : 0 }),
    long: (v) => `Trading ${fmtTradeMoney(v, { sign: true })}`,
    lo: 'Loss', hi: 'Profit',
  },
  training: {
    label: 'Training', icon: 'training', accent: '--training',
    value: (k, m) => (m.trainingMinutes > 0 ? m.trainingMinutes : null),
    short: (v) => `${Math.round(v)}m`,
    long: (v) => `Trained ${fmtDuration(v)}`,
    floor: () => Number(getSettings().targets?.trainingMinutes) || 0,
    lo: 'Less', hi: 'More',
  },
};

function readMode() {
  try {
    const m = localStorage.getItem(LS_MODE);
    return MODES[m] ? m : 'goals';
  } catch {
    return 'goals';
  }
}
function writeMode(m) {
  try { localStorage.setItem(LS_MODE, m); } catch { /* ignore */ }
}

async function render(root, ctx) {
  const now = currentMonth();
  const param = ctx.route.params && ctx.route.params[0];
  let month = /^\d{4}-(0[1-9]|1[0-2])$/.test(param || '') && param <= now ? param : now;
  let mode = readMode();
  let disposed = false;
  let seq = 0;
  let cache = null; // { year, M, S, any }
  let focusKey = null;

  const nav = monthNav(month, (m) => {
    month = m;
    focusKey = null;
    ctx.navigate(m === currentMonth() ? '/calendar' : `/calendar/${m}`, { replace: true, silent: true });
    draw();
  });
  const modeSeg = segmented(
    Object.entries(MODES).map(([value, m]) => ({ value, label: m.label })),
    mode,
    (v) => {
      mode = v;
      writeMode(v);
      paint();
    },
    { ariaLabel: 'Colour days by', size: 'sm', class: 'cal-modes' }
  );
  const monthEl = h('div.cal-month', h('div.card', skeleton({ height: 320 })));
  const yearEl = h('div.cal-year');
  mount(
    root,
    h('div.page.calendar-page', { style: { '--accent': colorVar(COLOR) } },
      pageHeader({ title: TITLE, subtitle: 'Every day at a glance — tap one to open it' }),
      h('div.cal-toolbar', nav, modeSeg),
      monthEl,
      yearEl)
  );

  async function load(year, force) {
    if (!force && cache && cache.year === year) return cache;
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const [data, S] = await Promise.all([loadRangeData(from, to), getDayScores(from, to)]);
    const M = {};
    let any = false;
    const end = todayKey() < to ? todayKey() : to;
    for (let k = from; k <= end; k = addDays(k, 1)) {
      M[k] = metricsForDay(k, data);
      if (M[k].hasAny) any = true;
    }
    return { year, M, S, any };
  }

  async function draw(force = false) {
    const my = ++seq;
    const c = await load(month.slice(0, 4), force);
    if (disposed || my !== seq) return;
    cache = c;
    nav.setMonth(month);
    paint();
  }

  function paint() {
    if (!cache) return;
    const cfg = MODES[mode];
    const { M, S } = cache;
    const today = todayKey();
    const { from, to } = monthRange(month);
    const keys = [];
    for (let k = from; k <= to; k = addDays(k, 1)) keys.push(k);

    // Scale
    const vals = keys.map((k) => (M[k] ? cfg.value(k, M[k], S[k]) : null));
    const maxAbs = Math.max(0, ...vals.filter((v) => v !== null).map(Math.abs));
    const max = cfg.max ? cfg.max() : Math.max(maxAbs, cfg.floor ? cfg.floor() : 0) || 1;
    const levelOf = (v) => {
      if (v === null) return 0;
      if (cfg.level) return cfg.level(v);
      if (v === 0) return 0;
      return Math.max(1, Math.min(4, Math.ceil((Math.abs(v) / max) * 4 - 1e-9)));
    };

    const ws = Number(getSettings().weekStart) === 0 ? 0 : 1;
    const lead = (weekday(from) - ws + 7) % 7;
    const heads = weekdayLabels(ws, 'short').map((l, i) => h('div.cal-wd', { 'aria-hidden': 'true' }, h('span.cal-wd-long', l), h('span.cal-wd-short', weekdayLabels(ws, 'narrow')[i])));

    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(h('div.cal-cell.is-pad', { 'aria-hidden': 'true' }));
    const interactive = [];
    keys.forEach((k, i) => {
      const m = M[k];
      const future = k > today;
      const num = String(Number(k.slice(8)));
      if (future || !m) {
        cells.push(h('div.cal-cell.is-future', { 'aria-hidden': 'true' }, h('span.cal-num', num)));
        return;
      }
      const v = vals[i];
      const lv = levelOf(v);
      const dots = DOTS.filter((d) => d.has(m));
      const tone = cfg.signed && v !== null ? pnlTone(v) : null;
      const desc = [fmtDate(k, 'long'), v !== null ? cfg.long(v, k, m, S[k]) : null, dots.length ? `Logged: ${dots.map((d) => d.label).join(', ')}` : 'Nothing logged'].filter(Boolean).join('. ');
      const btn = h(
        'button.cal-cell',
        {
          type: 'button',
          class: [`lv-${lv}`, k === today && 'is-today', tone && `is-${tone}`, v !== null && 'has-value'],
          dataset: { date: k },
          tabindex: '-1',
          'aria-label': desc,
          'aria-current': k === today ? 'date' : null,
          onClick: () => ctx.navigate(`/today/${k}`),
        },
        h('span.cal-num', num),
        h('span.cal-val.num', v !== null ? cfg.short(v) : ''),
        h('span.cal-dots', { 'aria-hidden': 'true' }, dots.map((d) => h('span.cal-dot', { style: { '--dot': colorVar(d.color) } })))
      );
      cells.push(btn);
      interactive.push(btn);
    });

    // Roving tabindex
    const start = interactive.find((b) => b.dataset.date === focusKey) || interactive.find((b) => b.dataset.date === today) || interactive[interactive.length - 1];
    if (start) start.tabIndex = 0;
    const grid = h('div.cal-grid', {
      role: 'group',
      'aria-label': `${fmtMonth(month)} — days`,
      onKeydown: (e) => {
        const cur = e.target.closest && e.target.closest('button.cal-cell');
        if (!cur) return;
        const idx = interactive.indexOf(cur);
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
        let next = null;
        if (step) next = interactive[Math.max(0, Math.min(interactive.length - 1, idx + step))];
        else if (e.key === 'Home') next = interactive[0];
        else if (e.key === 'End') next = interactive[interactive.length - 1];
        if (!next) return;
        e.preventDefault();
        interactive.forEach((b) => (b.tabIndex = -1));
        next.tabIndex = 0;
        focusKey = next.dataset.date;
        next.focus();
      },
    }, heads, cells);

    // Summary for the month
    const past = keys.filter((k) => k <= today && M[k]);
    const got = past.map((k) => ({ k, v: cfg.value(k, M[k], S[k]) })).filter((x) => x.v !== null);
    const summary = monthSummary(mode, got, past.length);

    const legend = h('div.cal-legend',
      h('div.cal-scale', { 'aria-hidden': 'true' },
        h('span.cal-scale-label', cfg.lo),
        cfg.signed
          ? [4, 3, 2, 1].map((l) => h('span.cal-swatch', { class: [`lv-${l}`, 'is-loss'] })).concat([0].map(() => h('span.cal-swatch.lv-0')), [1, 2, 3, 4].map((l) => h('span.cal-swatch', { class: [`lv-${l}`, 'is-profit'] })))
          : [0, 1, 2, 3, 4].map((l) => h('span.cal-swatch', { class: `lv-${l}` })),
        h('span.cal-scale-label', cfg.hi)),
      h('div.cal-dot-legend', DOTS.map((d) => h('span.cal-dot-item', h('span.cal-dot', { style: { '--dot': colorVar(d.color) } }), d.label))));

    const monthCard = h('section.card.cal-card', { style: { '--cell': colorVar(cfg.accent) }, 'aria-labelledby': 'cal-month-title' },
      h('div.cal-card-head',
        h('h2.cal-title', { id: 'cal-month-title' }, fmtMonth(month)),
        summary ? h('p.cal-summary', summary) : null),
      !cache.any && month === currentMonth()
        ? emptyState({ icon: ICON, accent: COLOR, compact: true, title: 'Your calendar fills in as you log', message: 'Each day gets a colour from your goals, mood, spending, trades or training.', action: { label: 'Log today', icon: 'plus', onClick: () => ctx.navigate('/today') } })
        : null,
      grid,
      legend);
    const hadFocus = monthEl.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.date : null;
    mount(monthEl, monthCard);
    if (hadFocus) {
      const b = interactive.find((x) => x.dataset.date === hadFocus);
      if (b) { interactive.forEach((x) => (x.tabIndex = -1)); b.tabIndex = 0; b.focus(); }
    }

    // Year heatmap
    const year = month.slice(0, 4);
    const yFrom = `${year}-01-01`;
    const yTo = `${year}-12-31` < today ? `${year}-12-31` : today;
    const values = {};
    for (let k = yFrom; k <= yTo; k = addDays(k, 1)) {
      if (!M[k]) continue;
      const v = cfg.value(k, M[k], S[k]);
      if (v !== null) values[k] = cfg.signed ? v : Math.max(v, 0);
    }
    const hm = heatmap({
      values,
      from: yFrom,
      to: yTo,
      accent: cfg.accent,
      signed: !!cfg.signed,
      max: cfg.max ? cfg.max() : undefined,
      weekStart: ws,
      valueFormat: (v) => (mode === 'goals' ? fmtPercent(v, { decimals: 0 }) : mode === 'mood' ? `${MOOD_LABEL[Math.round(v) - 1] || ''} (${v}/5)` : cfg.long(v)),
      onClick: (k) => { if (k <= today) ctx.navigate(`/today/${k}`); },
      emptyText: `No ${cfg.label.toLowerCase()} data in ${year} yet`,
      ariaLabel: `${year} ${cfg.label} heatmap`,
    });
    mount(yearEl, h('section.card.cal-year-card', { 'aria-labelledby': 'cal-year-title' },
      h('div.card-header', h('div.card-header-text', h('h2.card-title', { id: 'cal-year-title' }, `${year} · ${cfg.label === 'P&L' ? 'Trading P&L' : cfg.label === 'Spend' ? 'Spending' : cfg.label}`), h('p.card-subtitle', 'Tap a day to open it'))),
      h('div.card-body', hm)));
  }

  function monthSummary(m, got, pastDays) {
    if (!pastDays) return '';
    if (!got.length) return 'No data this month';
    const vs = got.map((x) => x.v);
    const total = vs.reduce((a, b) => a + b, 0);
    switch (m) {
      case 'goals': {
        const perfect = vs.filter((v) => v >= 0.999).length;
        return `Average ${fmtPercent(total / vs.length, { decimals: 0 })} of goals${perfect ? ` · ${plural(perfect, 'perfect day')}` : ''}`;
      }
      case 'mood':
        return `Average mood ${fmtNumber(total / vs.length, { decimals: 1 })} / 5 · ${plural(vs.length, 'day')} rated`;
      case 'spend':
        return `${fmtMoney(total, { decimals: 0 })} spent · ${fmtMoney(total / pastDays, { decimals: 0 })} a day`;
      case 'pnl': {
        const green = vs.filter((v) => v > 0).length;
        return `${fmtTradeMoney(total, { sign: true, decimals: 0 })} · ${green} of ${plural(vs.length, 'trading day')} green`;
      }
      case 'training':
        return `${fmtDuration(total)} · ${plural(vs.length, 'active day')}`;
      default:
        return '';
    }
  }

  await draw();
  const refresh = debounce(() => draw(true), 80);
  const offs = [
    on('db:change', (e) => { if (e.store !== 'reviews') refresh(); }),
    on('settings:change', refresh),
  ];
  return () => {
    disposed = true;
    refresh.cancel();
    offs.forEach((off) => off());
  };
}

export default { id: ID, title: TITLE, icon: ICON, color: COLOR, render };
