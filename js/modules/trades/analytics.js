// Trades › Analytics tab (SPEC 4.6) — renderAnalytics(root, ctx) → cleanup.
//
// Choices not fixed by the spec (kept simple, documented here):
// - Every number comes from calc.js (computeStats / equitySeries / dailyPnl / groupStats / rDistribution); this file
//   only filters, groups and presents. KPI tiles are computeStats() of exactly the filtered trade list.
// - Period filters on the trade's index `date` (exit day for closed trades, entry day for open ones). Weekday and
//   entry-hour breakdowns use the ENTRY day/time (when the decision was made).
// - Equity curve: "Account balance" (starting balance of the selected account(s) + P&L before the period) when a
//   starting balance is set and no market/setup filter narrows the trades; otherwise "Cumulative P&L" from zero.
// - Daily P&L switches to weekly bars when the view spans more than 60 trading days (keeps bars readable).
// - Insights are only produced from groups with at least 5 closed trades and are ranked by money impact (max 5).
// - No <h1> here: trades/index.js renders the page header. Sections use <h2>, cards <h3>.
import { db } from '../../core/db.js';
import { on } from '../../core/bus.js';
import { getSettings } from '../../core/settings.js';
import { todayKey, addDays, startOfWeek, startOfMonth, weekday, weekdayLabels, fmtDate, fmtRange, fmtTime } from '../../core/dates.js';
import { fmtTradeMoney, fmtPercent, fmtR, fmtNumber, fmtDuration, pnlTone, plural } from '../../core/format.js';
import { h, mount, card, statTile, table, select, segmented, emptyState, icon, debounce, toast, button } from '../../core/ui.js';
import { lineChart, barChart, histogram } from '../../core/charts.js';
import { computeStats, equitySeries, dailyPnl, groupStats, rDistribution, tradeNet, tradeR, outcome, holdMinutes, isClosed, sortTrades, closedWithPnl, MARKET_LABELS } from './calc.js';

const STORE_KEY = 'daybook.trades.analytics.filters';
const DEFAULT_FILTERS = { period: 'all', account: 'all', market: 'all', setup: 'all' };
const MIN_SAMPLE = 5;

export const PERIODS = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'all', label: 'All time' },
];

/* ------------------------------------------------------------------------------------------- helpers */

function loadFilters() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
  } catch {
    /* storage blocked */
  }
  return { ...DEFAULT_FILTERS };
}

function saveFilters(f) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(f));
  } catch {
    /* storage blocked */
  }
}

export function periodRange(period) {
  const t = todayKey();
  switch (period) {
    case 'week':
      return { from: startOfWeek(t), to: t };
    case 'month':
      return { from: startOfMonth(t), to: t };
    case '30d':
      return { from: addDays(t, -29), to: t };
    case '90d':
      return { from: addDays(t, -89), to: t };
    case 'ytd':
      return { from: `${t.slice(0, 4)}-01-01`, to: t };
    default:
      return { from: null, to: null };
  }
}

/** Filter trades like the UI does (exported so tests can compare against computeStats on the same slice). */
export function filterTrades(all, f) {
  const { from, to } = periodRange(f.period);
  return all.filter((t) => {
    if (f.account !== 'all' && (t.accountId || 'main') !== f.account) return false;
    if (f.market !== 'all' && (t.market || 'other') !== f.market) return false;
    if (f.setup !== 'all' && (t.setup || '') !== f.setup) return false;
    const d = t.date || t.entryDate || '';
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

const money = (v, opts = {}) => fmtTradeMoney(v, { sign: true, ...opts });
const moneyAbs = (v) => fmtTradeMoney(Math.abs(v || 0));
const axisMoney = (v) => fmtTradeMoney(v, { compact: true });
const fmtPF = (pf) => (pf === Infinity ? '∞' : pf === null || pf === undefined ? '—' : fmtNumber(pf, { decimals: 2 }));
const toneCls = (v) => ({ 'text-profit': pnlTone(v) === 'profit', 'text-loss': pnlTone(v) === 'loss' });
const pnlSpan = (v) => h('span.num', { class: toneCls(v) }, money(v));
const marketLabel = (m) => MARKET_LABELS[m] || (m ? String(m) : 'Other');
const accountsOf = () => {
  const s = getSettings();
  return (s.trading && Array.isArray(s.trading.accounts) ? s.trading.accounts : []).filter((a) => a && a.id);
};
const weekdayName = (wd) => weekdayLabels(0, 'long')[wd];
const hourLabel = (hh) => fmtTime(`${String(hh).padStart(2, '0')}:00`);
const entryDay = (t) => t.entryDate || t.date;
const entryHour = (t) => (t.entryTime && /^\d{1,2}:/.test(t.entryTime) ? Number(t.entryTime.split(':')[0]) : null);

function groupTooltip(g) {
  return [`${plural(g.count, 'trade')} · ${fmtPercent(g.winRate, { decimals: 0 })} win`, `PF ${fmtPF(g.profitFactor)} · Avg ${fmtR(g.avgR)}`];
}

async function openEditor(date) {
  try {
    const mod = await import('./editor.js');
    return mod.openTradeEditor(null, { date });
  } catch (err) {
    console.warn('[analytics] trade editor unavailable', err);
    toast('The trade editor is not available yet', { type: 'error' });
    return null;
  }
}

async function openDay(date, ctx) {
  try {
    const mod = await import('./calendar.js');
    mod.openTradeDaySheet(date, ctx);
  } catch (err) {
    console.warn('[analytics] day sheet unavailable', err);
  }
}

/* --------------------------------------------------------------------------------------- components */

function sectionBlock(title, ...children) {
  return h('section.section.ta-section', h('h2.section-title', title), ...children);
}

function chartCard({ title, subtitle, children, actions, cls }) {
  return card({ title, subtitle, titleTag: 'h3', actions, children, class: ['ta-card', cls] });
}

/** Chart ↔ table toggle in a card header. The table is the accessible twin of the chart. */
function viewToggle(chartEl, tableEl) {
  const body = h('div.ta-swap', chartEl);
  const seg = segmented(
    [
      { value: 'chart', label: '', icon: 'bar-chart', ariaLabel: 'Show chart' },
      { value: 'table', label: '', icon: 'list', ariaLabel: 'Show table' },
    ],
    'chart',
    (v) => mount(body, v === 'chart' ? chartEl : tableEl),
    { size: 'sm', ariaLabel: 'View' }
  );
  return { body, toggle: seg };
}

function groupTable(rows, { label, caption, limit } = {}) {
  const list = limit ? rows.slice(0, limit) : rows;
  return table({
    caption,
    compact: true,
    columns: [
      { label, render: (r) => h('span.ta-cell-name', { title: r.key }, r.label ?? r.key) },
      { label: 'Trades', num: true, value: (r) => fmtNumber(r.count) },
      { label: 'Win %', num: true, value: (r) => fmtPercent(r.winRate, { decimals: 0 }) },
      { label: 'PF', num: true, value: (r) => fmtPF(r.profitFactor) },
      { label: 'Net P&L', num: true, render: (r) => pnlSpan(r.net) },
      { label: 'Avg R', num: true, value: (r) => fmtR(r.avgR) },
    ],
    rows: list,
    empty: 'No closed trades',
  });
}

/** Two-or-three-way comparison (long vs short, followed plan vs not). */
function compareTable(cols, caption) {
  const metrics = [
    ['Trades', (s) => fmtNumber(s.count)],
    ['Win rate', (s) => fmtPercent(s.winRate)],
    ['Net P&L', (s) => (s.count ? pnlSpan(s.net) : '—')],
    ['Expectancy', (s) => (s.expectancy === null ? '—' : pnlSpan(s.expectancy))],
    ['Profit factor', (s) => fmtPF(s.profitFactor)],
    ['Avg win', (s) => fmtTradeMoney(s.avgWin)],
    ['Avg loss', (s) => (s.avgLoss === null ? '—' : fmtTradeMoney(-s.avgLoss))],
    ['Avg R', (s) => fmtR(s.avgR)],
  ];
  return table({
    caption,
    compact: true,
    columns: [
      { label: '', render: (r) => h('span.ta-metric', r.m) },
      ...cols.map((c, i) => ({ label: c.label, num: true, render: (r) => r.cells[i] })),
    ],
    rows: metrics.map(([m, fn]) => ({ m, cells: cols.map((c) => fn(c.stats)) })),
  });
}

/* ------------------------------------------------------------------------------------------ insights */

function buildInsights(list, stats, groups) {
  const out = [];
  const push = (type, impact, tone, iconName, parts) => out.push({ type, impact: Math.abs(impact || 0), tone, icon: iconName, parts });
  const b = (t) => h('strong', t);

  // Best and worst setup
  const setups = groups.setup.filter((g) => g.count >= MIN_SAMPLE);
  const best = setups.filter((g) => g.net > 0 && (g.profitFactor === Infinity || g.profitFactor > 1)).sort((a, c) => (c.profitFactor === a.profitFactor ? c.net - a.net : (c.profitFactor ?? 0) - (a.profitFactor ?? 0)))[0];
  if (best) {
    push('best-setup', best.net, 'profit', 'trophy', ['Your best setup is ', b(best.key), ': profit factor ', b(fmtPF(best.profitFactor)), ` over ${plural(best.count, 'trade')} (`, b(money(best.net)), ').']);
  }
  const worst = setups.filter((g) => g.net < 0).sort((a, c) => a.net - c.net)[0];
  if (worst && (!best || worst.key !== best.key)) {
    push('worst-setup', worst.net, 'loss', 'trending-down', [b(worst.key), ' is costing you: ', b(money(worst.net)), ` over ${plural(worst.count, 'trade')} at a ${fmtPercent(worst.winRate, { decimals: 0 })} win rate. Size it down until you review it.`]);
  }

  // Costliest mistake
  const mistake = groups.mistakes.filter((g) => g.count >= MIN_SAMPLE && g.net < 0).sort((a, c) => a.net - c.net)[0];
  if (mistake) {
    push('mistake', mistake.net * 1.1, 'loss', 'alert', ['Trades tagged ', b(mistake.key), ' cost you ', b(moneyAbs(mistake.net)), ` across ${plural(mistake.count, 'trade')}.`]);
  }

  // Followed plan vs not
  const yes = groups.plan.find((g) => g.key === 'yes');
  const no = groups.plan.find((g) => g.key === 'no');
  if (yes && no && yes.count >= MIN_SAMPLE && no.count >= MIN_SAMPLE && yes.expectancy !== no.expectancy) {
    const better = yes.expectancy > no.expectancy;
    push('plan', (yes.expectancy - no.expectancy) * no.count, better ? 'profit' : 'loss', better ? 'check-circle' : 'help', [
      'When you followed your plan, expectancy was ',
      b(money(yes.expectancy)),
      ' per trade vs ',
      b(money(no.expectancy)),
      ' when you didn’t.',
      better ? '' : ' Worth checking whether the plan itself needs work.',
    ]);
  }

  // Weekday win-rate spread
  const days = groups.weekday.filter((g) => g.count >= MIN_SAMPLE);
  if (days.length >= 2) {
    const byWr = [...days].sort((a, c) => c.winRate - a.winRate);
    const hi = byWr[0];
    const lo = byWr[byWr.length - 1];
    if (hi.winRate - lo.winRate >= 0.15) {
      push('weekday', (hi.net - lo.net) / 2, lo.net < 0 ? 'loss' : 'neutral', 'calendar', ['You win ', b(fmtPercent(hi.winRate, { decimals: 0 })), ` on ${hi.label}s vs `, b(fmtPercent(lo.winRate, { decimals: 0 })), ` on ${lo.label}s`, lo.net < 0 ? ` (${money(lo.net)} there).` : '.']);
    }
  }

  // Worst entry hour
  const hours = groups.hour.filter((g) => g.count >= MIN_SAMPLE && g.net < 0).sort((a, c) => a.net - c.net);
  if (hours.length && groups.hour.filter((g) => g.count >= MIN_SAMPLE).length >= 2) {
    const g = hours[0];
    push('hour', g.net * 0.8, 'loss', 'clock', ['Entries in the ', b(`${g.label}`), ' hour lose money: ', b(money(g.net)), ` over ${plural(g.count, 'trade')}, ${fmtPercent(g.winRate, { decimals: 0 })} win rate.`]);
  }

  // Long vs short
  const L = groups.direction.find((g) => g.key === 'long');
  const S = groups.direction.find((g) => g.key === 'short');
  if (L && S && L.count >= MIN_SAMPLE && S.count >= MIN_SAMPLE && Math.sign(L.net) !== Math.sign(S.net)) {
    const [good, bad] = L.net > S.net ? [L, S] : [S, L];
    push('direction', bad.net, 'loss', 'layers', [`Your ${bad.key}s are losing (`, b(money(bad.net)), ` over ${bad.count}) while your ${good.key}s make `, b(money(good.net)), '.']);
  }

  // Hold time: losers vs winners
  const closed = closedWithPnl(list);
  const holdOf = (o) => closed.filter((t) => outcome(t) === o).map(holdMinutes).filter((m) => m !== null && m > 0);
  const wh = holdOf('win');
  const lh = holdOf('loss');
  if (wh.length >= MIN_SAMPLE && lh.length >= MIN_SAMPLE) {
    const aw = wh.reduce((a, c) => a + c, 0) / wh.length;
    const al = lh.reduce((a, c) => a + c, 0) / lh.length;
    if (al / aw >= 1.4) {
      push('hold', stats.grossLoss * 0.25, 'loss', 'timer', ['You hold losers ', b(`${fmtNumber(al / aw, { decimals: 1 })}×`), ` longer than winners (${fmtDuration(al)} vs ${fmtDuration(aw)}). Let the stop do its job.`]);
    } else if (aw / al >= 1.4) {
      push('hold', stats.grossProfit * 0.15, 'profit', 'timer', ['You let winners run: ', b(fmtDuration(aw)), ` on average vs ${fmtDuration(al)} for losers. Keep doing that.`]);
    }
  }

  // Tilt: next trade on the same day after a loss
  const afterLoss = [];
  const byDay = new Map();
  for (const t of closed) {
    if (!byDay.has(t.date)) byDay.set(t.date, []);
    byDay.get(t.date).push(t);
  }
  for (const dayList of byDay.values()) {
    for (let i = 1; i < dayList.length; i++) if (outcome(dayList[i - 1]) === 'loss') afterLoss.push(dayList[i]);
  }
  if (afterLoss.length >= MIN_SAMPLE && stats.winRate !== null) {
    const s = computeStats(afterLoss);
    if (stats.winRate - s.winRate >= 0.1) {
      push('tilt', s.net < 0 ? s.net : s.count * (stats.expectancy || 0) * 0.3, 'loss', 'flame', ['After a losing trade, your next trade that day wins only ', b(fmtPercent(s.winRate, { decimals: 0 })), ` (${s.count} trades, ${money(s.net)}) vs ${fmtPercent(stats.winRate, { decimals: 0 })} overall. A short pause after a loss may pay.`]);
    }
  }

  // Emotion with the weakest win rate
  const emo = groups.emotions.filter((g) => g.count >= MIN_SAMPLE && stats.winRate - g.winRate >= 0.15).sort((a, c) => a.winRate - c.winRate)[0];
  if (emo) {
    push('emotion', emo.net < 0 ? emo.net : emo.count * 10, 'loss', 'heart-pulse', ['When you feel ', b(emo.key.toLowerCase()), ', you win only ', b(fmtPercent(emo.winRate, { decimals: 0 })), ` of ${plural(emo.count, 'trade')} (${money(emo.net)}).`]);
  }

  return out.sort((a, c) => c.impact - a.impact).slice(0, 5);
}

function insightCallout(ins) {
  const accent = ins.tone === 'profit' ? 'var(--profit)' : ins.tone === 'loss' ? 'var(--loss)' : 'var(--trades)';
  return h('div.callout.ta-insight', { style: { '--accent': accent }, dataset: { insight: ins.type } }, icon(ins.icon, { size: 18 }), h('p', ins.parts));
}

/* --------------------------------------------------------------------------------------------- render */

export function renderAnalytics(root, ctx = {}) {
  let disposed = false;
  let filters = loadFilters();
  let allTrades = [];
  const nav = (p) => (ctx.navigate ? ctx.navigate(p) : (location.hash = '#' + p));

  const filterBar = h('div.ta-filters', { role: 'group', 'aria-label': 'Analytics filters' });
  const content = h('div.ta-content', { 'aria-live': 'polite', 'aria-busy': 'true' });
  const rootEl = h('div.ta.trades-analytics', filterBar, content);
  mount(root, rootEl);

  function setFilter(k, v) {
    filters = { ...filters, [k]: v };
    saveFilters(filters);
    drawFilters();
    drawContent();
  }

  function drawFilters() {
    const accounts = accountsOf();
    const markets = [...new Set(allTrades.map((t) => t.market || 'other'))].sort((a, c) => Object.keys(MARKET_LABELS).indexOf(a) - Object.keys(MARKET_LABELS).indexOf(c));
    const setups = [...new Set(allTrades.map((t) => t.setup).filter(Boolean))].sort((a, c) => a.localeCompare(c));
    // Stored values that no longer exist fall back to "all".
    if (filters.market !== 'all' && !markets.includes(filters.market)) filters.market = 'all';
    if (filters.setup !== 'all' && !setups.includes(filters.setup)) filters.setup = 'all';
    if (filters.account !== 'all' && !accounts.some((a) => a.id === filters.account) && !allTrades.some((t) => t.accountId === filters.account)) filters.account = 'all';
    if (!PERIODS.some((p) => p.value === filters.period)) filters.period = 'all';

    const ctl = (key, label, options) =>
      h('label.ta-filter', h('span.ta-filter-label', label), select(options, filters[key], (v) => setFilter(key, v), { 'aria-label': label, name: `ta-${key}`, dataset: { filter: key } }));
    const isDefault = Object.keys(DEFAULT_FILTERS).every((k) => filters[k] === DEFAULT_FILTERS[k]);
    mount(
      filterBar,
      h(
        'div.ta-filter-grid',
        ctl('period', 'Period', PERIODS),
        ctl('account', 'Account', [{ value: 'all', label: 'All accounts' }, ...accounts.map((a) => ({ value: a.id, label: a.name || a.id }))]),
        ctl('market', 'Market', [{ value: 'all', label: 'All markets' }, ...markets.map((m) => ({ value: m, label: marketLabel(m) }))]),
        ctl('setup', 'Setup', [{ value: 'all', label: 'All setups' }, ...setups.map((s) => ({ value: s, label: s }))])
      ),
      isDefault
        ? null
        : button({
            label: 'Reset',
            icon: 'rotate-ccw',
            variant: 'ghost',
            size: 'sm',
            class: 'ta-reset',
            onClick: () => {
              filters = { ...DEFAULT_FILTERS };
              saveFilters(filters);
              drawFilters();
              drawContent();
            },
          })
    );
  }

  function startingBalance() {
    const accounts = accountsOf();
    const sel = filters.account === 'all' ? accounts : accounts.filter((a) => a.id === filters.account);
    return sel.reduce((a, c) => a + (Number(c.startingBalance) || 0), 0);
  }

  function drawContent() {
    if (disposed) return;
    content.setAttribute('aria-busy', 'false');
    filterBar.hidden = !allTrades.length;
    if (!allTrades.length) {
      mount(
        content,
        emptyState({
          icon: 'trades',
          accent: '--trades',
          title: 'No trades yet',
          message: 'Log your trades and this page turns them into your edge: win rate, expectancy, best setups and the mistakes that cost you.',
          action: { label: 'Log a trade', icon: 'plus', onClick: () => openEditor() },
        })
      );
      return;
    }
    const list = filterTrades(allTrades, filters);
    const stats = computeStats(list);
    if (!stats.count) {
      mount(
        content,
        emptyState({
          icon: 'filter',
          accent: '--trades',
          compact: true,
          title: list.length ? 'No closed trades here yet' : 'No trades match these filters',
          message: list.length ? `${plural(list.length, 'open position')} in this view — stats appear once trades are closed.` : 'Try a longer period or clear a filter.',
          action: { label: 'Reset filters', icon: 'rotate-ccw', onClick: () => { filters = { ...DEFAULT_FILTERS }; saveFilters(filters); drawFilters(); drawContent(); } },
          actions: [{ label: 'Log a trade', icon: 'plus', onClick: () => openEditor() }],
        })
      );
      return;
    }
    const scrollY = window.scrollY;
    mount(content, buildContent(list, stats));
    if (Math.abs(window.scrollY - scrollY) > 2) window.scrollTo(0, scrollY);
  }

  function buildContent(list, stats) {
    const closed = closedWithPnl(list);
    const wsLabels = weekdayLabels(0, 'long');
    const groups = {
      setup: groupStats(list, (t) => t.setup, { emptyLabel: 'No setup' }),
      symbol: groupStats(list, (t) => t.symbol),
      market: groupStats(list, (t) => t.market || 'other').map((g) => ({ ...g, label: marketLabel(g.key) })),
      direction: groupStats(list, (t) => t.direction || 'long'),
      weekday: groupStats(list, (t) => (entryDay(t) ? String(weekday(entryDay(t))) : null)).map((g) => ({ ...g, label: wsLabels[Number(g.key)] })),
      hour: groupStats(list, (t) => (entryHour(t) === null ? null : String(entryHour(t)))).map((g) => ({ ...g, label: hourLabel(Number(g.key)) })),
      mistakes: groupStats(list, (t) => t.mistakes || []),
      emotions: groupStats(list, (t) => t.emotions || [], { sort: 'count' }),
      plan: groupStats(list, (t) => (t.followedPlan === true ? 'yes' : t.followedPlan === false ? 'no' : null)),
    };
    const { from } = periodRange(filters.period);
    const firstDate = closed[0].date;
    const lastDate = closed[closed.length - 1].date;

    return h(
      'div.ta-body',
      h('p.ta-scope.text-sm.subtle', `${plural(stats.count, 'closed trade')}${stats.open ? ` · ${stats.open} open` : ''} · ${fmtRange(from || firstDate, filters.period === 'all' ? lastDate : todayKey(), 'mediumYear')}`),
      stats.count < 20
        ? h('div.callout.ta-sample', { style: { '--accent': 'var(--warning)' } }, icon('info', { size: 18 }), h('p', `Only ${plural(stats.count, 'closed trade')} in this view. Treat these numbers as early signals — an edge shows up over 30+ trades.`))
        : null,
      kpiSection(stats, list),
      insightsSection(list, stats, groups),
      equitySection(list, stats),
      breakdownSection(list, groups),
      psychologySection(list, stats, groups)
    );
  }

  /* ---------- KPIs */
  function kpiSection(s, list) {
    const best = s.best && tradeNet(s.best) > 0 ? s.best : null;
    const worst = s.worst && tradeNet(s.worst) < 0 ? s.worst : null;
    const tradeSub = (t) => `${t.symbol || '—'} · ${fmtDate(t.date, 'short')}${tradeR(t) !== null ? ` · ${fmtR(tradeR(t))}` : ''}`;
    const streakVal = s.currentStreak.type ? `${s.currentStreak.count} ${s.currentStreak.type === 'win' ? (s.currentStreak.count === 1 ? 'win' : 'wins') : s.currentStreak.count === 1 ? 'loss' : 'losses'}` : '—';
    const bal = startingBalance();
    const ddPct = (() => {
      if (!(bal > 0)) return null;
      const eq = equitySeries(list, { start: bal });
      let m = 0;
      for (const p of eq) if (p.peak > 0) m = Math.max(m, p.drawdown / p.peak);
      return m;
    })();
    const tile = (o, key) => {
      const el = statTile(o);
      el.dataset.kpi = key;
      return el;
    };
    return sectionBlock(
      'Performance',
      h(
        'div.ta-kpi-main',
        tile({ label: 'Net P&L', value: money(s.net), tone: pnlTone(s.net), sub: `${fmtTradeMoney(s.grossProfit, { compact: true })} won · ${fmtTradeMoney(s.grossLoss, { compact: true })} lost`, icon: 'wallet', accent: '--trades' }, 'net'),
        tile({ label: 'Win rate', value: fmtPercent(s.winRate), sub: `${s.wins}W · ${s.losses}L${s.breakeven ? ` · ${s.breakeven} BE` : ''}`, icon: 'target', accent: '--trades' }, 'winRate'),
        tile({ label: 'Profit factor', value: fmtPF(s.profitFactor), tone: s.profitFactor === null ? null : s.profitFactor >= 1 ? 'profit' : 'loss', sub: 'Gross won ÷ gross lost', icon: 'scale', accent: '--trades' }, 'profitFactor'),
        tile({ label: 'Expectancy', value: money(s.expectancy), tone: pnlTone(s.expectancy), sub: 'Average net per trade', icon: 'sparkles', accent: '--trades' }, 'expectancy')
      ),
      h(
        'div.ta-kpi-grid',
        tile({ label: 'Trades', value: fmtNumber(s.count), sub: s.open ? `+ ${s.open} open` : 'closed' }, 'count'),
        tile({ label: 'Avg R', value: fmtR(s.avgR, { decimals: 2 }), tone: s.avgR === null ? null : pnlTone(s.avgR), sub: s.rCount ? `${fmtR(s.totalR)} total · ${s.rCount} with stop` : 'Add stops to track R' }, 'avgR'),
        tile({ label: 'Avg win', value: fmtTradeMoney(s.avgWin), tone: s.avgWin ? 'profit' : null, sub: s.largestWin !== null ? `Largest ${fmtTradeMoney(s.largestWin)}` : 'No wins yet' }, 'avgWin'),
        tile({ label: 'Avg loss', value: s.avgLoss === null ? '—' : fmtTradeMoney(-s.avgLoss), tone: s.avgLoss ? 'loss' : null, sub: s.largestLoss !== null ? `Largest ${fmtTradeMoney(s.largestLoss)}` : 'No losses yet' }, 'avgLoss'),
        tile({ label: 'Payoff ratio', value: s.payoffRatio === null ? '—' : `${fmtNumber(s.payoffRatio, { decimals: 2 })}`, sub: 'Avg win ÷ avg loss' }, 'payoff'),
        tile({ label: 'Max drawdown', value: s.maxDrawdown ? fmtTradeMoney(-s.maxDrawdown) : fmtTradeMoney(0), tone: s.maxDrawdown ? 'loss' : null, sub: ddPct !== null ? `${fmtPercent(ddPct)} from peak` : 'Peak to trough' }, 'maxDrawdown'),
        tile({ label: 'Best trade', value: best ? money(tradeNet(best)) : '—', tone: best ? 'profit' : null, sub: best ? tradeSub(best) : 'No winners yet', onClick: best ? () => nav(`/trades/view/${best.id}`) : null }, 'best'),
        tile({ label: 'Worst trade', value: worst ? money(tradeNet(worst)) : '—', tone: worst ? 'loss' : null, sub: worst ? tradeSub(worst) : 'No losers yet', onClick: worst ? () => nav(`/trades/view/${worst.id}`) : null }, 'worst'),
        tile({ label: 'Current streak', value: streakVal, tone: s.currentStreak.type === 'win' ? 'profit' : s.currentStreak.type === 'loss' ? 'loss' : null, sub: 'Consecutive closed trades' }, 'streak'),
        tile({ label: 'Longest streaks', value: `${s.maxWinStreak}W · ${s.maxLossStreak}L`, sub: 'Wins · losses in a row' }, 'maxStreaks'),
        tile({ label: 'Avg hold', value: s.avgHoldMinutes === null ? '—' : fmtDuration(Math.round(s.avgHoldMinutes)), sub: 'Entry to exit' }, 'hold'),
        tile({ label: 'Fees paid', value: fmtTradeMoney(s.fees), sub: s.grossProfit > 0 ? `${fmtPercent(s.fees / s.grossProfit)} of gross wins` : 'Commissions & taxes' }, 'fees')
      )
    );
  }

  /* ---------- Insights */
  function insightsSection(list, stats, groups) {
    const items = buildInsights(list, stats, groups);
    return sectionBlock(
      'Insights',
      items.length
        ? h('div.ta-insights', items.map(insightCallout))
        : h('div.callout.ta-insight', { style: { '--accent': 'var(--trades)' } }, icon('lightbulb', { size: 18 }), h('p', `Insights appear once a setup, weekday or habit has at least ${MIN_SAMPLE} closed trades. Keep journaling — tag setups, mistakes and emotions to unlock them.`))
    );
  }

  /* ---------- Equity + daily */
  function equitySection(list, stats) {
    const { from } = periodRange(filters.period);
    const bal = startingBalance();
    const balanceMode = bal > 0 && filters.market === 'all' && filters.setup === 'all';
    let start = 0;
    if (balanceMode) {
      const acc = filters.account;
      const prior = from ? allTrades.filter((t) => isClosed(t) && t.date < from && (acc === 'all' || (t.accountId || 'main') === acc)) : [];
      start = bal + computeStats(prior).net;
    }
    const eq = equitySeries(list, { start });
    const perDay = new Map();
    for (const p of eq) perDay.set(p.date, p); // last point of each day wins (end-of-day equity)
    const pts = [{ x: addDays(eq[0].date, -1), y: start }, ...[...perDay.values()].map((p) => ({ x: p.date, y: p.equity }))];
    const ddPts = [{ x: addDays(eq[0].date, -1), y: 0 }, ...[...perDay.values()].map((p) => ({ x: p.date, y: -p.drawdown }))];
    const end = eq[eq.length - 1].equity;
    const change = end - start;

    const equity = lineChart({
      series: [{ name: balanceMode ? 'Balance' : 'Cumulative P&L', color: '--trades', points: pts }],
      area: true,
      height: 240,
      zeroLine: !balanceMode,
      target: balanceMode ? start : undefined,
      targetLabel: balanceMode ? `Start ${fmtTradeMoney(start)}` : undefined,
      yFormat: axisMoney,
      tooltipFormat: balanceMode ? (v) => fmtTradeMoney(v) : (v) => money(v),
      showDots: false,
      ariaLabel: balanceMode ? 'Account balance' : 'Cumulative P&L',
    });
    const dd = lineChart({
      series: [{ name: 'Drawdown', color: '--loss', points: ddPts }],
      area: true,
      height: 120,
      curve: false,
      showDots: false,
      yFormat: axisMoney,
      tooltipFormat: (v) => (v ? fmtTradeMoney(v) : 'At peak'),
      ariaLabel: 'Drawdown from peak',
    });

    // Daily (or weekly) P&L bars
    const daily = dailyPnl(list);
    const dayKeys = Object.keys(daily).sort();
    const weekly = dayKeys.length > 60;
    let bars;
    if (weekly) {
      const wk = new Map();
      for (const d of dayKeys) {
        const k = startOfWeek(d);
        const w = wk.get(k) || { pnl: 0, count: 0, wins: 0, losses: 0 };
        w.pnl += daily[d].pnl;
        w.count += daily[d].count;
        w.wins += daily[d].wins;
        w.losses += daily[d].losses;
        wk.set(k, w);
      }
      bars = [...wk.entries()].map(([k, w]) => ({ label: k, value: Math.round(w.pnl * 100) / 100, tooltip: [`Week of ${fmtDate(k, 'short')}`, `${plural(w.count, 'trade')} · ${w.wins}W ${w.losses}L`] }));
    } else {
      bars = dayKeys.map((d) => ({ label: d, value: daily[d].pnl, date: d, tooltip: `${plural(daily[d].count, 'trade')} · ${daily[d].wins}W ${daily[d].losses}L` }));
    }
    const dailyChart = barChart({
      data: bars,
      signed: true,
      height: 220,
      yFormat: axisMoney,
      tooltipFormat: (v) => money(v),
      ariaLabel: weekly ? 'Weekly P&L' : 'Daily P&L',
      onClick: weekly ? null : (d) => openDay(d.date, ctx),
    });
    const dv = dayKeys.map((d) => daily[d].pnl);
    const green = dv.filter((v) => v > 0);
    const red = dv.filter((v) => v < 0);
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const bestDay = dayKeys.reduce((a, d) => (a === null || daily[d].pnl > daily[a].pnl ? d : a), null);
    const worstDay = dayKeys.reduce((a, d) => (a === null || daily[d].pnl < daily[a].pnl ? d : a), null);
    const dayStat = (label, value, sub, tone) => h('div.ta-daystat', h('span.ta-daystat-label', label), h('span.ta-daystat-value.num', { class: toneCls(tone ?? 0) }, value), sub ? h('span.ta-daystat-sub', sub) : null);

    return sectionBlock(
      'Equity & daily P&L',
      chartCard({
        title: balanceMode ? 'Account balance' : 'Equity curve',
        subtitle: balanceMode ? `Starting balance + closed P&L${from ? ' since the period began' : ''}` : 'Cumulative net P&L of the filtered trades',
        cls: 'ta-equity',
        children: [
          h('div.ta-hero', h('span.ta-hero-value.num', { class: toneCls(balanceMode ? change : end) }, balanceMode ? fmtTradeMoney(end) : money(end)), h('span.ta-hero-sub', balanceMode ? [h('span.num', { class: toneCls(change) }, money(change)), start > 0 ? ` · ${fmtPercent(change / start, { sign: true })} ${filters.period === 'all' ? 'since start' : 'this period'}` : ''] : `${plural(stats.count, 'trade')} · max drawdown ${fmtTradeMoney(stats.maxDrawdown)}`)),
          equity,
          h('div.ta-subchart', h('h4.ta-subchart-title', 'Drawdown from peak'), dd),
        ],
      }),
      chartCard({
        title: weekly ? 'Weekly P&L' : 'Daily P&L',
        subtitle: weekly ? `${plural(bars.length, 'week')} · net per week` : `${plural(dayKeys.length, 'trading day')} · tap a bar for the day`,
        cls: 'ta-daily',
        children: h(
          'div.ta-daily-layout',
          h('div.ta-daily-chart', dailyChart),
          h(
            'div.ta-daystats',
            dayStat('Green days', `${green.length} of ${dv.length}`, dv.length ? fmtPercent(green.length / dv.length, { decimals: 0 }) : null),
            dayStat('Avg green day', avg(green) === null ? '—' : money(avg(green)), null, avg(green)),
            dayStat('Avg red day', avg(red) === null ? '—' : money(avg(red)), `${red.length} red ${red.length === 1 ? 'day' : 'days'}`, avg(red)),
            dayStat('Best day', bestDay ? money(daily[bestDay].pnl) : '—', bestDay ? fmtDate(bestDay, 'medium') : null, bestDay ? daily[bestDay].pnl : 0),
            dayStat('Worst day', worstDay ? money(daily[worstDay].pnl) : '—', worstDay ? fmtDate(worstDay, 'medium') : null, worstDay ? daily[worstDay].pnl : 0)
          )
        ),
      })
    );
  }

  /* ---------- Breakdowns */
  function groupBars(rows, opts = {}) {
    return barChart({
      data: rows.map((g) => ({ label: g.label ?? g.key, value: g.net, tooltip: groupTooltip(g) })),
      signed: true,
      horizontal: opts.horizontal !== false,
      height: opts.height,
      yFormat: axisMoney,
      tooltipFormat: (v) => money(v),
      ariaLabel: opts.ariaLabel,
      valueLabels: opts.valueLabels,
    });
  }

  function breakdownCard({ title, subtitle, rows, label, horizontal = true, cls, limit }) {
    const shown = limit ? rows.slice(0, limit) : rows;
    if (shown.length < 2) {
      const g = shown[0];
      return chartCard({
        title,
        subtitle,
        cls,
        children: g
          ? h('p.ta-single.text-sm.subtle', 'All trades here are ', h('strong', g.label ?? g.key), ': ', pnlSpan(g.net), ` over ${plural(g.count, 'trade')}, ${fmtPercent(g.winRate, { decimals: 0 })} win rate.`)
          : h('p.ta-single.text-sm.muted', 'Not enough data yet.'),
      });
    }
    const chartEl = groupBars(shown, { horizontal, ariaLabel: title, valueLabels: horizontal ? undefined : false });
    const { body, toggle } = viewToggle(chartEl, groupTable(shown, { label, caption: title }));
    return chartCard({ title, subtitle, cls, actions: [toggle], children: body });
  }

  function breakdownSection(list, groups) {
    // Weekdays in the user's week order; hours chronological.
    const ws = Number(getSettings().weekStart ?? 1);
    const wdOrder = (k) => (Number(k) - ws + 7) % 7;
    const weekdays = [...groups.weekday].sort((a, c) => wdOrder(a.key) - wdOrder(c.key)).map((g) => ({ ...g, label: g.label.slice(0, 3) }));
    const hours = [...groups.hour].sort((a, c) => Number(a.key) - Number(c.key));
    const dirs = ['long', 'short'].map((k) => groups.direction.find((g) => g.key === k) || { key: k, ...computeStats([]) });

    const rd = rDistribution(list);
    const rCount = rd.reduce((a, b) => a + b.count, 0);
    const closedCount = closedWithPnl(list).length;
    const hist = histogram({
      data: rd.map((b) => ({ label: b.label, count: b.count, color: b.to <= 0 ? '--loss' : b.from >= 0 ? '--profit' : '--neutral' })),
      height: 200,
      ariaLabel: 'R-multiple distribution',
    });
    const avgR = computeStats(list).avgR;

    const setupChart = groupBars(groups.setup, { ariaLabel: 'Net P&L by setup' });
    return sectionBlock(
      'Breakdown',
      chartCard({
        title: 'P&L by setup',
        subtitle: 'Net P&L per strategy — trades, win rate, profit factor and R',
        cls: 'ta-setup',
        children: h('div.ta-split', h('div.ta-split-chart', setupChart), h('div.ta-split-table', groupTable(groups.setup, { label: 'Setup', caption: 'P&L by setup' }))),
      }),
      h(
        'div.ta-grid-2',
        breakdownCard({ title: 'Top symbols', subtitle: groups.symbol.length > 10 ? `Top 10 of ${groups.symbol.length} by net P&L` : 'Net P&L per symbol', rows: topSymbols(groups.symbol), label: 'Symbol' }),
        breakdownCard({ title: 'By market', subtitle: 'Net P&L per market', rows: groups.market, label: 'Market' }),
        breakdownCard({ title: 'By weekday', subtitle: 'Net P&L by entry day', rows: weekdays, label: 'Day', horizontal: false }),
        breakdownCard({ title: 'By entry hour', subtitle: 'Net P&L by time of entry', rows: hours, label: 'Hour', horizontal: false }),
        chartCard({
          title: 'Long vs short',
          subtitle: 'How each side performs',
          cls: 'ta-direction',
          children: compareTable(dirs.map((g) => ({ label: g.key === 'long' ? 'Long' : 'Short', stats: g })), 'Long vs short'),
        }),
        chartCard({
          title: 'R-multiple distribution',
          subtitle: rCount ? `${plural(rCount, 'trade')} with a stop · avg ${fmtR(avgR, { decimals: 2 })}` : 'Set a stop loss on trades to see R-multiples',
          cls: 'ta-rdist',
          children: [hist, closedCount > rCount ? h('p.text-xs.muted.ta-note', `${plural(closedCount - rCount, 'closed trade')} without a stop ${closedCount - rCount === 1 ? 'is' : 'are'} not counted.`) : null],
        })
      )
    );
  }

  function topSymbols(rows) {
    if (rows.length <= 10) return rows;
    // Top 10 by absolute impact keeps both the biggest winners and the biggest losers, then order by net.
    return [...rows].sort((a, c) => Math.abs(c.net) - Math.abs(a.net)).slice(0, 10).sort((a, c) => c.net - a.net);
  }

  /* ---------- Psychology */
  function psychologySection(list, stats, groups) {
    const withMistakes = list.filter((t) => (t.mistakes || []).length);
    const clean = list.filter((t) => isClosed(t) && !(t.mistakes || []).length);
    const ms = computeStats(withMistakes);
    const cs = computeStats(clean);
    const mistakeRows = [...groups.mistakes].sort((a, c) => a.net - c.net);

    const mistakesCard = chartCard({
      title: 'Mistakes cost',
      subtitle: 'Trades tagged with each mistake — sorted by damage',
      cls: 'ta-mistakes',
      children: mistakeRows.length
        ? [
            h(
              'div.ta-mistake-summary',
              h('div.ta-mistake-big', h('span.ta-daystat-label', 'Trades with mistakes'), h('span.ta-hero-value.num', { class: toneCls(ms.net) }, money(ms.net)), h('span.ta-daystat-sub', `${plural(ms.count, 'trade')} · ${fmtPercent(ms.winRate, { decimals: 0 })} win · ${money(ms.expectancy)} per trade`)),
              h('div.ta-mistake-big', h('span.ta-daystat-label', 'Clean trades'), h('span.ta-hero-value.num', { class: toneCls(cs.net) }, money(cs.net)), h('span.ta-daystat-sub', cs.count ? `${plural(cs.count, 'trade')} · ${fmtPercent(cs.winRate, { decimals: 0 })} win · ${money(cs.expectancy)} per trade` : 'No clean trades yet'))
            ),
            table({
              caption: 'Mistakes cost',
              compact: true,
              columns: [
                { label: 'Mistake', render: (r) => h('span.ta-cell-name', r.key) },
                { label: 'Times', num: true, value: (r) => fmtNumber(r.count) },
                { label: 'Win %', num: true, value: (r) => fmtPercent(r.winRate, { decimals: 0 }) },
                { label: 'Total P&L', num: true, render: (r) => pnlSpan(r.net) },
                { label: 'Avg', num: true, class: 'ta-col-opt', render: (r) => pnlSpan(r.expectancy) },
                { label: 'Impact', class: 'ta-col-opt', render: (r) => (r.net < 0 ? h('span.ta-impact.text-loss', `Cost you ${moneyAbs(r.net)}`) : h('span.ta-impact.muted', 'No net cost')) },
              ],
              rows: mistakeRows,
            }),
          ]
        : h('p.text-sm.muted.ta-note', 'No mistakes tagged in this view. Tag them in the trade editor — this table shows what each one costs.'),
    });

    const overall = stats.winRate;
    const emotionsCard = chartCard({
      title: 'Emotions vs win rate',
      subtitle: `How you felt, and how it went · overall ${fmtPercent(overall, { decimals: 0 })} win`,
      cls: 'ta-emotions',
      children: groups.emotions.length
        ? table({
            caption: 'Emotions vs win rate',
            compact: true,
            columns: [
              { label: 'Emotion', render: (r) => h('span.ta-cell-name', r.key) },
              { label: 'Trades', num: true, render: (r) => h('span', { class: { muted: r.count < MIN_SAMPLE }, title: r.count < MIN_SAMPLE ? 'Small sample' : null }, fmtNumber(r.count)) },
              {
                label: 'Win rate',
                render: (r) =>
                  h(
                    'div.ta-wr',
                    h('div.ta-wr-track', { 'aria-hidden': 'true' }, h('div.ta-wr-fill', { style: { width: `${Math.round((r.winRate || 0) * 100)}%` }, class: { 'is-low': r.winRate < overall } }), h('div.ta-wr-mark', { style: { left: `${Math.round((overall || 0) * 100)}%` } })),
                    h('span.num.ta-wr-val', fmtPercent(r.winRate, { decimals: 0 }))
                  ),
              },
              { label: 'Avg', num: true, class: 'ta-col-opt', render: (r) => pnlSpan(r.expectancy) },
              { label: 'Net', num: true, render: (r) => pnlSpan(r.net) },
            ],
            rows: groups.emotions,
          })
        : h('p.text-sm.muted.ta-note', 'No emotions tagged yet. Tag how you felt before each trade to see which states help or hurt.'),
    });

    const yes = groups.plan.find((g) => g.key === 'yes') || { key: 'yes', ...computeStats([]) };
    const no = groups.plan.find((g) => g.key === 'no') || { key: 'no', ...computeStats([]) };
    const unset = list.filter((t) => isClosed(t) && t.followedPlan !== true && t.followedPlan !== false).length;
    const planCard = chartCard({
      title: 'Followed plan vs not',
      subtitle: unset ? `${plural(unset, 'trade')} not marked either way` : 'Discipline, in numbers',
      cls: 'ta-plan',
      children:
        yes.count || no.count
          ? compareTable([{ label: 'Followed', stats: yes }, { label: 'Broke plan', stats: no }], 'Followed plan vs not')
          : h('p.text-sm.muted.ta-note', 'Mark “Followed plan” on your trades to compare disciplined trades with the rest.'),
    });

    return sectionBlock('Psychology & discipline', h('div.ta-grid-2', planCard, emotionsCard), mistakesCard);
  }

  /* ---------- data */
  async function load() {
    const trades = await db.all('trades');
    if (disposed) return;
    allTrades = sortTrades(trades);
    drawFilters();
    drawContent();
  }

  const refresh = debounce(load, 80);
  const offs = [
    on('db:change', (e) => {
      if (e && (e.store === 'trades' || e.store === '*')) refresh();
    }),
    on('settings:change', () => refresh()),
  ];
  const ready = load();

  const cleanup = () => {
    disposed = true;
    refresh.cancel();
    offs.forEach((off) => off());
  };
  cleanup.ready = ready; // tests can await the first draw
  return cleanup;
}
