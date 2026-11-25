// js/modules/trades/index.js — Trades module entry (SPEC 4.0 + 4.6): page header, tab bar bound to sub-routes,
// the Journal, and delegation to Analytics / Calendar / Daily plan / Detail.
//
// Choices beyond the spec:
//   - Tabs are links (<nav> + aria-current) so every tab is a real, shareable route; keyboard focus stays on the
//     tab you activated across the route re-render.
//   - Sub-tabs (analytics.js, calendar.js, dayplan.js) are loaded with dynamic import() inside try/catch, so a
//     missing or broken file shows a friendly card and never breaks the Journal.
//   - Journal filters (incl. a Side filter, cheap and useful) persist in sessionStorage. The default period is
//     "Last 30 days" (robust at the start of a month). Open positions ignore the period & outcome filters
//     (they are current by definition) but respect account / market / side / setup / search.
//   - Long histories render 20 trading days at a time with a "Show more" button.
//   - summarizeDay(): headline = day net P&L · closed count (+ open positions when the day is today);
//     items = that day's trades. search() matches symbol, setup, thesis, review and tags.

import { db } from '../../core/db.js';
import { on, state } from '../../core/bus.js';
import { todayKey, addDays, startOfWeek, startOfMonth, fmtDate, fmtTime, relativeDay, diffDays } from '../../core/dates.js';
import { fmtTradeMoney, fmtR, fmtPercent, fmtNumber, fmtPrice, fmtDuration, pnlTone, plural } from '../../core/format.js';
import { h, mount, pageHeader, emptyState, statTile, icon, badge, button, select, segmented, chips, openSheet, debounce, input } from '../../core/ui.js';
import { navigate } from '../../core/router.js';
import { computeStats, sortTrades, tradeNet, tradeR, tradeRisk, plannedRR, isClosed, isOpen, outcome } from './calc.js';
import { openTradeEditor, sideBadge, marketLabel, marketOptions, accountsList, tradingSettings, tradeTitle } from './editor.js';
import { renderTradeDetail } from './detail.js';

const ID = 'trades';
const TITLE = 'Trades';
const ICON = 'trades';
const COLOR = '--trades';
const STORE = 'trades';
const FILTER_KEY = 'daybook.trades.filters';
const DAYS_PER_PAGE = 20;

const TABS = [
  { id: 'journal', label: 'Journal', icon: 'list', path: '/trades' },
  { id: 'analytics', label: 'Analytics', icon: 'bar-chart', path: '/trades/analytics' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', path: '/trades/calendar' },
  { id: 'plan', label: 'Daily plan', icon: 'notebook', path: '/trades/plan' },
];

const SUBVIEWS = {
  analytics: { load: () => import('./analytics.js'), fn: 'renderAnalytics', icon: 'bar-chart', name: 'Analytics' },
  calendar: { load: () => import('./calendar.js'), fn: 'renderTradeCalendar', icon: 'calendar', name: 'The P&L calendar' },
  plan: { load: () => import('./dayplan.js'), fn: 'renderDayPlan', icon: 'notebook', name: 'The daily plan' },
};

const PERIODS = [
  { value: 'week', label: 'Week', ariaLabel: 'This week', title: 'This week' },
  { value: 'month', label: 'Month', ariaLabel: 'This month', title: 'This month' },
  { value: '30d', label: '30 days', ariaLabel: 'Last 30 days', title: 'Last 30 days' },
  { value: 'ytd', label: 'YTD', ariaLabel: 'Year to date', title: 'Year to date' },
  { value: 'all', label: 'All', ariaLabel: 'All time', title: 'All time' },
];
const PERIOD_NAMES = { week: 'This week', month: 'This month', '30d': 'Last 30 days', ytd: 'Year to date', all: 'All time' };
const DEFAULT_FILTERS = { period: '30d', account: 'all', market: 'all', side: 'all', status: 'all', setup: 'all', outcome: 'all', q: '' };
const OUTCOMES = [
  { value: 'win', label: 'Wins' },
  { value: 'loss', label: 'Losses' },
  { value: 'breakeven', label: 'Breakeven' },
];

let focusTabOnRender = null; // tab id whose link should get focus after the route re-renders

// ───────────────────────────────────────────────────────────── helpers

function loadFilters() {
  try {
    const raw = sessionStorage.getItem(FILTER_KEY);
    const f = raw ? JSON.parse(raw) : null;
    if (f && typeof f === 'object') {
      const out = { ...DEFAULT_FILTERS };
      for (const k of Object.keys(DEFAULT_FILTERS)) if (typeof f[k] === 'string') out[k] = f[k];
      if (!PERIOD_NAMES[out.period]) out.period = DEFAULT_FILTERS.period;
      return out;
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_FILTERS };
}

function saveFilters(f) {
  try {
    sessionStorage.setItem(FILTER_KEY, JSON.stringify(f));
  } catch {
    /* ignore */
  }
}

function periodFrom(p) {
  const t = todayKey();
  if (p === 'week') return startOfWeek(t);
  if (p === 'month') return startOfMonth(t);
  if (p === '30d') return addDays(t, -29);
  if (p === 'ytd') return `${t.slice(0, 4)}-01-01`;
  return null;
}

const acctOf = (t) => t.accountId || 'main';

function matchesBase(t, f) {
  if (f.account !== 'all' && acctOf(t) !== f.account) return false;
  if (f.market !== 'all' && t.market !== f.market) return false;
  if (f.side !== 'all' && (t.direction === 'short' ? 'short' : 'long') !== f.side) return false;
  if (f.setup !== 'all' && (f.setup === '__none' ? !!t.setup : t.setup !== f.setup)) return false;
  const q = f.q.trim().toLowerCase().replace(/^#/, '');
  if (q) {
    const hay = [t.symbol, t.setup, ...(Array.isArray(t.tags) ? t.tags : [])].map((x) => String(x || '').toLowerCase());
    if (!hay.some((x) => x.includes(q))) return false;
  }
  return true;
}

function filterTrades(all, f) {
  const from = periodFrom(f.period);
  const closed = all.filter((t) => isClosed(t) && matchesBase(t, f) && (!from || (t.date || '') >= from) && (f.outcome === 'all' || outcome(t) === f.outcome));
  const open = f.status === 'closed' || f.outcome !== 'all' ? [] : all.filter((t) => isOpen(t) && matchesBase(t, f));
  return { closed: f.status === 'open' ? [] : closed, open };
}

function activeCount(f) {
  return ['account', 'market', 'side', 'status', 'setup', 'outcome'].filter((k) => f[k] !== 'all').length;
}

function dayLabel(date) {
  const t = todayKey();
  const rel = relativeDay(date);
  if (rel === 'Today' || rel === 'Yesterday') return `${rel} · ${fmtDate(date, 'medium')}`;
  return fmtDate(date, date.slice(0, 4) === t.slice(0, 4) ? 'medium' : 'mediumYear');
}

function moneyTone(n) {
  const tone = pnlTone(n);
  return { 'text-profit': tone === 'profit', 'text-loss': tone === 'loss' };
}

function snippet(text, q) {
  const s = String(text || '');
  const i = s.toLowerCase().indexOf(q);
  if (i < 0) return '';
  const start = Math.max(0, i - 30);
  const end = Math.min(s.length, i + q.length + 50);
  return (start > 0 ? '…' : '') + s.slice(start, end).replace(/\s+/g, ' ').trim() + (end < s.length ? '…' : '');
}

// ───────────────────────────────────────────────────────────── rows

function closedRow(t) {
  const net = tradeNet(t);
  const r = tradeR(t);
  const res = outcome(t);
  const time = t.exitTime || t.entryTime;
  const meta = [t.setup || null, time ? fmtTime(time) : null].filter(Boolean).join(' · ');
  return h(
    'a.tj-row',
    {
      href: `#/trades/view/${t.id}`,
      dataset: { outcome: res, id: t.id },
      'aria-label': `${t.symbol}, ${t.direction === 'short' ? 'short' : 'long'}${t.setup ? ', ' + t.setup : ''}, net ${fmtTradeMoney(net, { sign: true })}${r !== null ? ', ' + fmtR(r) : ''}`,
    },
    h('span.tj-c-time.num', time ? fmtTime(time) : '—'),
    h('span.tj-c-sym', h('span.tj-sym', t.symbol || '—'), sideBadge(t)),
    h('span.tj-c-setup', t.setup || h('span.muted', '—')),
    h('span.tj-c-px.num', fmtPrice(t.entryPrice), h('span.tj-arrow', { 'aria-hidden': 'true' }, '→'), fmtPrice(t.exitPrice)),
    h('span.tj-c-qty.num', fmtNumber(t.quantity, { maxDecimals: 4 })),
    h('span.tj-c-meta', meta || marketLabel(t.market)),
    h('span.tj-c-r.num', { class: moneyTone(r) }, r === null ? '—' : fmtR(r)),
    h('span.tj-c-pnl.num', { class: moneyTone(net) }, fmtTradeMoney(net, { sign: true })),
    icon('chevron-right', { size: 18, class: 'tj-chev' })
  );
}

function openRow(t) {
  const risk = tradeRisk(t);
  const rr = plannedRR(t);
  const days = t.entryDate ? diffDays(t.entryDate, todayKey()) : 0;
  const entered = t.entryDate ? (days === 0 ? (t.entryTime ? `Today ${fmtTime(t.entryTime)}` : 'Today') : days === 1 ? 'Yesterday' : fmtDate(t.entryDate, 'short')) : '—';
  return h(
    'a.tj-row.tj-row-open',
    { href: `#/trades/view/${t.id}`, dataset: { outcome: 'open', id: t.id }, 'aria-label': `${t.symbol}, open ${t.direction === 'short' ? 'short' : 'long'}, entered ${entered}${risk !== null ? ', risk ' + fmtTradeMoney(risk) : ''}` },
    h('span.tj-c-time.num', { title: entered }, days === 0 && t.entryTime ? fmtTime(t.entryTime) : entered),
    h('span.tj-c-sym', h('span.tj-sym', t.symbol || '—'), sideBadge(t)),
    h('span.tj-c-setup', t.setup || h('span.muted', '—')),
    h('span.tj-c-px.num', h('span.muted', 'Entry '), fmtPrice(t.entryPrice)),
    h('span.tj-c-qty.num', fmtNumber(t.quantity, { maxDecimals: 4 })),
    h('span.tj-c-meta', [entered, t.setup, `@ ${fmtPrice(t.entryPrice)}`].filter(Boolean).join(' · ')),
    h('span.tj-c-r.num', { title: 'Planned reward : risk' }, rr !== null ? `1:${fmtNumber(rr, { maxDecimals: 1 })}` : '—'),
    h('span.tj-c-pnl.num', risk !== null ? h('span.tj-risk', { title: 'Money at risk to the stop' }, `${fmtTradeMoney(risk)} risk`) : badge('Open', 'open', { dot: true })),
    icon('chevron-right', { size: 18, class: 'tj-chev' })
  );
}

function colHeader(kind) {
  return h(
    'div.tj-head',
    { 'aria-hidden': 'true' },
    h('span.tj-c-time', kind === 'open' ? 'Entered' : 'Time'),
    h('span.tj-c-sym', 'Symbol'),
    h('span.tj-c-setup', 'Setup'),
    h('span.tj-c-px', kind === 'open' ? 'Price' : 'Entry → Exit'),
    h('span.tj-c-qty', 'Qty'),
    h('span.tj-c-r', kind === 'open' ? 'R:R' : 'R'),
    h('span.tj-c-pnl', kind === 'open' ? 'Risk' : 'Net P&L'),
    h('span.tj-chev')
  );
}

// ───────────────────────────────────────────────────────────── journal

function renderJournal(root, ctx) {
  let disposed = false;
  let filters = loadFilters();
  let all = [];
  let loaded = false;
  let dayLimit = DAYS_PER_PAGE;

  const filterBar = h('div.tj-filters');
  const body = h('div.tj-body', h('div.tj-loading', { 'aria-hidden': 'true' }, h('div.skeleton', { style: { height: '96px' } }), h('div.skeleton', { style: { height: '240px' } })));
  const wrap = h('div.tj', filterBar, body);
  mount(root, wrap);

  // search input (kept across filter-bar rebuilds so typing never loses focus)
  const searchIn = input({
    type: 'search',
    value: filters.q,
    placeholder: 'Search symbol, setup, #tag',
    'aria-label': 'Search trades',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: false,
    enterkeyhint: 'search',
    onInput: (e) => setQ(e.target.value),
    onKeydown: (e) => {
      if (e.key === 'Escape' && e.target.value) {
        e.preventDefault();
        e.target.value = '';
        setQ('');
      }
    },
  });
  const searchBox = h('label.input-affix.tj-search', icon('search', { size: 18 }), searchIn);
  const setQ = debounce((v) => update({ q: v }), 160);

  let bar = null; // persistent filter-bar controls (rebuilt only when the option lists change)
  let barSig = '';

  function update(patch) {
    filters = { ...filters, ...patch };
    saveFilters(filters);
    dayLimit = DAYS_PER_PAGE;
    syncFilterBar();
    draw();
  }

  function setupOptions() {
    const set = new Set((tradingSettings().setups || []).filter(Boolean));
    for (const t of all) if (t.setup) set.add(t.setup);
    if (filters.setup !== 'all' && filters.setup !== '__none') set.add(filters.setup);
    return [...set];
  }

  function filterDefs() {
    const accounts = accountsList();
    const defs = [];
    if (accounts.length > 1) defs.push({ key: 'account', label: 'Account', all: 'All accounts', options: accounts.map((a) => ({ value: a.id, label: a.name || a.id })) });
    defs.push({ key: 'market', label: 'Market', all: 'All markets', options: marketOptions() });
    defs.push({ key: 'side', label: 'Side', all: 'Long & short', options: [{ value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }] });
    defs.push({ key: 'status', label: 'Status', all: 'Open & closed', options: [{ value: 'closed', label: 'Closed' }, { value: 'open', label: 'Open' }] });
    defs.push({ key: 'setup', label: 'Setup', all: 'All setups', options: [...setupOptions().map((s) => ({ value: s, label: s })), { value: '__none', label: 'No setup' }] });
    defs.push({ key: 'outcome', label: 'Outcome', all: 'Any outcome', options: OUTCOMES });
    return defs;
  }

  function labelFor(def, v) {
    const o = def.options.find((x) => x.value === v);
    return o ? o.label : v;
  }

  /** Builds the bar when the option lists changed (or force); otherwise only syncs it (focus never jumps). */
  function buildFilterBar(force = false) {
    const defs = filterDefs();
    const sig = JSON.stringify(defs);
    if (bar && !force && sig === barSig) {
      syncFilterBar();
      return;
    }
    barSig = sig;
    const period = segmented(PERIODS, filters.period, (v) => update({ period: v }), { size: 'sm', ariaLabel: 'Period', class: 'tj-period' });
    const countEl = h('span.tj-filter-count', { 'aria-hidden': 'true' });
    const filtersBtn = h('button.btn.btn-secondary.tj-filters-btn.hide-desktop', { type: 'button', 'aria-haspopup': 'dialog', onClick: openFilterSheet }, icon('filter', { size: 18 }), h('span', 'Filters'), countEl);
    const selEls = {};
    for (const d of defs) {
      selEls[d.key] = select([{ value: 'all', label: d.all }, ...d.options], filters[d.key], (v) => update({ [d.key]: v }), { 'aria-label': d.label, class: 'tj-select' });
    }
    const resetBtn = button({ label: 'Reset', icon: 'rotate-ccw', variant: 'ghost', size: 'sm', class: 'tj-reset', onClick: resetFilters });
    const activeWrap = h('div.tj-active.hide-desktop', { role: 'group', 'aria-label': 'Active filters' });
    bar = { defs, period, countEl, filtersBtn, selEls, resetBtn, activeWrap };
    mount(filterBar, h('div.tj-filter-top', period, searchBox, filtersBtn), h('div.tj-selects.hide-mobile', Object.values(selEls), resetBtn), activeWrap);
    syncFilterBar();
  }

  function syncFilterBar() {
    if (!bar) return;
    const n = activeCount(filters);
    bar.period.setValue(filters.period);
    bar.countEl.textContent = n ? String(n) : '';
    bar.countEl.hidden = !n;
    bar.filtersBtn.classList.toggle('is-active', n > 0);
    bar.filtersBtn.setAttribute('aria-label', n ? `Filters, ${n} active` : 'Filters');
    for (const d of bar.defs) {
      const el = bar.selEls[d.key];
      if (el.getValue() !== filters[d.key]) el.setValue(filters[d.key]);
      el.classList.toggle('is-active', filters[d.key] !== 'all');
    }
    bar.resetBtn.hidden = !(n || filters.period !== DEFAULT_FILTERS.period || filters.q.trim());
    if (document.activeElement !== searchIn && searchIn.value !== filters.q) searchIn.value = filters.q;
    const chipsList = bar.defs
      .filter((d) => filters[d.key] !== 'all')
      .map((d) =>
        h(
          'button.chip.chip-sm.is-selected.tj-active-chip',
          {
            type: 'button',
            'aria-label': `Remove filter ${d.label}: ${labelFor(d, filters[d.key])}`,
            onClick: () => {
              update({ [d.key]: 'all' });
              if (!filterBar.contains(document.activeElement)) bar.filtersBtn.focus();
            },
          },
          h('span.chip-label', labelFor(d, filters[d.key])),
          icon('x', { size: 14 })
        )
      );
    mount(
      bar.activeWrap,
      chipsList,
      chipsList.length
        ? h('button.link-btn.tj-clear', { type: 'button', onClick: () => { resetFilters(); bar.filtersBtn.focus(); } }, 'Clear all')
        : null
    );
    bar.activeWrap.hidden = chipsList.length === 0;
  }

  function resetFilters() {
    searchIn.value = '';
    setQ.cancel();
    update({ ...DEFAULT_FILTERS });
  }

  function openFilterSheet() {
    const defs = filterDefs();
    const count = () => {
      const r = filterTrades(all, filters);
      return r.closed.length + r.open.length;
    };
    const actions = (api) => [
      { label: 'Reset', variant: 'ghost', icon: 'rotate-ccw', align: 'start', onClick: () => { resetFilters(); rebuild(api); return false; } },
      { label: `Show ${plural(count(), 'trade')}`, variant: 'primary', onClick: () => null },
    ];
    const content = h('div.stack.tj-sheet');
    function rebuild(api) {
      mount(
        content,
        h(
          'div.field',
          h('div.field-label', 'Period'),
          segmented(PERIODS, filters.period, (v) => { update({ period: v }); api.setActions(actions(api)); }, { block: true, ariaLabel: 'Period' })
        ),
        defs.map((d) =>
          h(
            'div.field',
            h('div.field-label', { 'aria-hidden': 'true' }, d.label),
            chips([{ value: 'all', label: d.all }, ...d.options], filters[d.key], (v) => {
              update({ [d.key]: v === null ? 'all' : v });
              api.setActions(actions(api));
            }, { deselect: false, ariaLabel: d.label })
          )
        )
      );
      api.setActions(actions(api));
    }
    const api = openSheet({ title: 'Filter trades', subtitle: 'Changes apply as you tap', icon: 'filter', accent: COLOR, content, className: 'tj-filter-sheet' });
    rebuild(api);
  }

  // ── drawing ───────────────────────────────────────────────────
  function summary(closed, open) {
    const s = computeStats(closed);
    const has = s.count > 0;
    const pf = s.profitFactor;
    return h(
      'div.stat-grid.tj-summary',
      statTile({
        label: `Net P&L · ${PERIOD_NAMES[filters.period].toLowerCase()}`,
        value: has ? fmtTradeMoney(s.net, { sign: true }) : '—',
        tone: has ? pnlTone(s.net) : null,
        sub: has ? (s.fees ? `after ${fmtTradeMoney(s.fees)} fees` : `${s.wins} won · ${s.losses} lost`) : 'No closed trades',
        icon: 'trending-up',
        accent: COLOR,
        class: 'tj-stat-net',
      }),
      statTile({ label: 'Win rate', value: has ? fmtPercent(s.winRate) : '—', sub: has ? `${s.wins} of ${s.count} won` : null }),
      statTile({
        label: 'Profit factor',
        value: pf === null ? '—' : pf === Infinity ? '∞' : fmtNumber(pf, { decimals: 2 }),
        tone: pf === null ? null : pf >= 1 ? 'profit' : 'loss',
        sub: s.payoffRatio !== null ? `Payoff ${fmtNumber(s.payoffRatio, { decimals: 2 })}` : has ? 'Gross won ÷ lost' : null,
      }),
      statTile({ label: 'Trades', value: s.count, sub: open.length ? `+ ${open.length} open` : s.avgHoldMinutes !== null ? `${fmtDuration(s.avgHoldMinutes)} avg hold` : null }),
      statTile({
        label: 'Avg R',
        value: s.avgR === null ? '—' : fmtR(s.avgR, { decimals: 2 }),
        tone: s.avgR === null ? null : pnlTone(s.avgR),
        sub: s.expectancy !== null ? `${fmtTradeMoney(s.expectancy, { sign: true })} / trade` : null,
      })
    );
  }

  function openSection(open) {
    if (!open.length) return null;
    const totalRisk = open.reduce((a, t) => a + (tradeRisk(t) || 0), 0);
    const sorted = sortTrades(open, 'desc');
    return h(
      'section.section.tj-open',
      h('h2.section-title', 'Open positions', h('span.tj-count', String(open.length)), totalRisk > 0 ? h('span.tj-title-meta.num', `${fmtTradeMoney(totalRisk)} at risk`) : null),
      h('div.card.card-flush.tj-list', colHeader('open'), h('div.tj-rows', sorted.map(openRow)))
    );
  }

  function closedSection(closed) {
    if (!closed.length) return null;
    const byDay = new Map();
    for (const t of sortTrades(closed, 'desc')) {
      const d = t.date || t.exitDate || t.entryDate || '';
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(t);
    }
    const days = [...byDay.entries()];
    const shown = days.slice(0, dayLimit);
    const more = days.length - shown.length;
    return h(
      'section.section.tj-closed',
      h('h2.section-title', 'Closed trades', h('span.tj-count', String(closed.length))),
      h(
        'div.card.card-flush.tj-list',
        colHeader('closed'),
        shown.map(([d, list]) => {
          const st = computeStats(list);
          return h(
            'div.tj-day',
            { role: 'group', 'aria-label': `${dayLabel(d)}: ${plural(list.length, 'trade')}, net ${fmtTradeMoney(st.net, { sign: true })}` },
            h(
              'div.tj-day-head',
              h('span.tj-day-date', dayLabel(d)),
              h('span.tj-day-meta', plural(list.length, 'trade'), st.wins || st.losses ? h('span.tj-day-wl', ` · ${st.wins}W ${st.losses}L`) : null),
              h('span.tj-day-pnl.num', { class: moneyTone(st.net) }, fmtTradeMoney(st.net, { sign: true }))
            ),
            h('div.tj-rows', list.map(closedRow))
          );
        }),
        more > 0
          ? h(
              'div.tj-more',
              button({
                label: `Show ${Math.min(more, DAYS_PER_PAGE)} more ${Math.min(more, DAYS_PER_PAGE) === 1 ? 'day' : 'days'}`,
                icon: 'chevron-down',
                variant: 'secondary',
                onClick: (e) => {
                  dayLimit += DAYS_PER_PAGE;
                  const y = window.scrollY;
                  draw();
                  window.scrollTo(0, y);
                  e.currentTarget && e.currentTarget.blur && e.currentTarget.blur();
                },
              }),
              h('span.muted.text-sm', `${plural(more, 'more day')} in this period`)
            )
          : null
      )
    );
  }

  function draw() {
    if (disposed || !loaded) return;
    if (!all.length) {
      filterBar.hidden = true;
      mount(
        body,
        h(
          'div.card.tj-welcome',
          emptyState({
            icon: 'candlestick',
            accent: COLOR,
            title: 'Your trade journal starts here',
            message: 'Log a trade with its entry, stop and exit — Daybook does the math: net P&L after fees, R-multiples, win rate and profit factor.',
            action: { label: 'Log your first trade', icon: 'plus', onClick: () => openTradeEditor(null, { date: state.date }) },
            actions: [{ label: 'Plan today', icon: 'notebook', onClick: () => navigate('/trades/plan') }],
          }),
          h(
            'ul.tj-tips',
            h('li', icon('shield', { size: 18 }), h('span', h('b', 'Set a stop'), ' — every trade gets an R-multiple, so wins and losses compare fairly.')),
            h('li', icon('brain', { size: 18 }), h('span', h('b', 'Tag emotions & mistakes'), ' — Analytics shows what they cost you.')),
            h('li', icon('image', { size: 18 }), h('span', h('b', 'Add chart screenshots'), ' — reviews are ten times more useful.'))
          )
        )
      );
      return;
    }
    filterBar.hidden = false;
    const { closed, open } = filterTrades(all, filters);
    if (!closed.length && !open.length) {
      const widen = filters.period !== 'all' && filterTrades(all, { ...filters, period: 'all' }).closed.length > 0;
      const anyFilter = activeCount(filters) > 0 || filters.q.trim();
      mount(
        body,
        summary(closed, open),
        h(
          'div.card',
          emptyState({
            icon: 'filter',
            accent: COLOR,
            title: anyFilter ? 'No trades match these filters' : `No trades ${PERIOD_NAMES[filters.period].toLowerCase()}`,
            message: anyFilter ? 'Try a wider period or clear a filter.' : 'Log today’s trades, or look further back.',
            action: anyFilter ? { label: 'Clear filters', icon: 'rotate-ccw', onClick: resetFilters } : { label: 'Log a trade', icon: 'plus', onClick: () => openTradeEditor(null, { date: state.date }) },
            actions: widen ? [{ label: 'Show all time', icon: 'history', onClick: () => update({ period: 'all' }) }] : [],
          })
        )
      );
      return;
    }
    mount(body, summary(closed, open), openSection(open), closedSection(closed));
  }

  async function load() {
    const list = await db.all(STORE);
    if (disposed) return;
    all = list;
    loaded = true;
    buildFilterBar();
    draw();
  }

  const refresh = debounce(load, 60);
  const offs = [
    on('db:change', (e) => {
      if (e.store === STORE || e.store === '*') refresh();
    }),
    on('settings:change', () => {
      if (!loaded) return;
      buildFilterBar(true);
      draw();
    }),
  ];

  const ready = load();
  const cleanup = () => {
    disposed = true;
    refresh.cancel();
    setQ.cancel();
    offs.forEach((off) => off());
  };
  return { cleanup, ready };
}

// ───────────────────────────────────────────────────────────── sub views

async function renderSubview(key, root, ctx) {
  const def = SUBVIEWS[key];
  let fn = null;
  try {
    const mod = await def.load();
    fn = mod && mod[def.fn];
  } catch (err) {
    console.warn(`[daybook] trades/${key} is not available yet`, err);
  }
  if (typeof fn !== 'function') {
    placeholder(root, def);
    return null;
  }
  try {
    const r = await fn(root, ctx);
    return typeof r === 'function' ? r : null;
  } catch (err) {
    console.warn(`[daybook] trades/${key} failed to render`, err);
    placeholder(root, def, true);
    return null;
  }
}

function placeholder(root, def, broken = false) {
  mount(
    root,
    h(
      'div.card.tr-placeholder',
      emptyState({
        icon: def.icon,
        accent: COLOR,
        title: broken ? `${def.name} hit a snag` : `${def.name} is almost here`,
        message: broken ? 'Something went wrong showing this tab. Your trades are safe — the Journal works as usual.' : 'This tab is still being built. Your trades are safe — keep journaling and it will light up with your data.',
        action: { label: 'Open the journal', icon: 'list', onClick: () => navigate('/trades') },
        actions: [{ label: 'Log a trade', icon: 'plus', onClick: () => openTradeEditor(null, { date: state.date }) }],
      })
    )
  );
}

function tabBar(active) {
  return h(
    'nav.tr-tabs',
    { 'aria-label': 'Trades sections' },
    TABS.map((t) =>
      h(
        'a.tr-tab',
        {
          href: `#${t.path}`,
          'aria-current': t.id === active ? 'page' : null,
          dataset: { tab: t.id },
          onClick: (e) => {
            if (t.id === active && t.id !== 'plan') e.preventDefault();
            else focusTabOnRender = t.id;
          },
        },
        icon(t.icon, { size: 17 }),
        h('span', t.label)
      )
    )
  );
}

// ───────────────────────────────────────────────────────────── render

async function render(root, ctx) {
  const params = ctx.route.params || [];
  const sub = params[0] || 'journal';

  // Manifest shortcut / deep link: #/trades?new=1 opens the editor, then drop the query.
  if (ctx.route.query && ctx.route.query.new === '1') {
    openTradeEditor(null, { date: state.date || todayKey() });
    ctx.navigate(ctx.route.path, { replace: true });
  }

  if (sub === 'view') {
    if (!params[1]) {
      ctx.navigate('/trades', { replace: true });
      return null;
    }
    return renderTradeDetail(root, ctx, params[1]);
  }

  if (sub !== 'journal' && !SUBVIEWS[sub]) {
    ctx.navigate('/trades', { replace: true }); // unknown sub-route → Journal
    return null;
  }
  const active = sub;
  ctx.setTitle(active === 'journal' ? TITLE : `${TABS.find((t) => t.id === active).label} · ${TITLE}`);

  const content = h('div.tr-content');
  const tabs = tabBar(active);
  mount(
    root,
    h(
      'div.page.trades-page',
      { style: { '--accent': 'var(--trades)' } },
      pageHeader({
        title: TITLE,
        subtitle: 'Journal every trade. Learn from the patterns.',
        actions: [{ label: 'Log trade', icon: 'plus', variant: 'primary', class: 'tr-new', onClick: () => openTradeEditor(null, { date: state.date || todayKey() }) }],
      }),
      tabs,
      content
    )
  );
  if (focusTabOnRender) {
    const link = tabs.querySelector(`[data-tab="${focusTabOnRender}"]`);
    focusTabOnRender = null;
    if (link) link.focus({ preventScroll: true });
  }

  let subCleanup = null;
  let disposed = false;
  if (active === 'journal') {
    const j = renderJournal(content, ctx);
    subCleanup = j.cleanup;
    await j.ready;
  } else {
    subCleanup = await renderSubview(active, content, ctx);
    if (disposed && subCleanup) subCleanup();
  }
  return () => {
    disposed = true;
    if (typeof subCleanup === 'function') {
      try {
        subCleanup();
      } catch (err) {
        console.warn('[daybook] trades cleanup failed', err);
      }
    }
  };
}

// ───────────────────────────────────────────────────────────── module

export default {
  id: ID,
  title: TITLE,
  icon: ICON,
  color: COLOR,
  render,
  openEditor: (record, opts) => openTradeEditor(record || null, opts || {}),
  quickActions: [{ id: 'trade', label: 'Trade', icon: ICON, color: COLOR, run: ({ date } = {}) => openTradeEditor(null, { date }) }],

  async summarizeDay(date) {
    const [dayTrades, openAll] = await Promise.all([db.byDate(STORE, date), db.byIndex(STORE, 'status', 'open')]);
    const closed = dayTrades.filter(isClosed);
    const st = computeStats(closed);
    const isTodayDate = date === todayKey();
    const openCount = isTodayDate ? openAll.length : dayTrades.filter(isOpen).length;
    const parts = [];
    if (closed.length) parts.push(`${fmtTradeMoney(st.net, { sign: true })} · ${plural(closed.length, 'trade')}`);
    if (openCount) parts.push(`${openCount} open`);
    return {
      id: ID,
      title: 'Trading',
      icon: ICON,
      color: COLOR,
      headline: parts.join(' · '),
      tone: closed.length ? pnlTone(st.net) : null,
      empty: isTodayDate ? 'No trades today' : 'No trades this day',
      items: sortTrades(dayTrades, 'asc').map((t) => {
        const net = tradeNet(t);
        const r = tradeR(t);
        return {
          id: t.id,
          time: isClosed(t) ? t.exitTime || t.entryTime || '' : t.entryTime || '',
          title: tradeTitle(t),
          meta: isClosed(t) ? [fmtTradeMoney(net, { sign: true }), r !== null ? fmtR(r) : null, t.setup || null].filter(Boolean).join(' · ') : ['Open', t.setup || null].filter(Boolean).join(' · '),
          onOpen: () => navigate(`/trades/view/${t.id}`),
        };
      }),
      addLabel: 'Log trade',
      onAdd: () => openTradeEditor(null, { date }),
    };
  },

  async search(query) {
    const q = String(query || '').trim().toLowerCase();
    if (q.length < 2) return [];
    const qq = q.replace(/^#/, '');
    const all = await db.all(STORE);
    const hits = all.filter((t) => [t.symbol, t.setup, t.thesis, t.review, ...(Array.isArray(t.tags) ? t.tags : [])].some((s) => String(s || '').toLowerCase().includes(qq)));
    return sortTrades(hits, 'desc')
      .slice(0, 50)
      .map((t) => {
        const closed = isClosed(t);
        const head = closed ? fmtTradeMoney(tradeNet(t), { sign: true }) : 'Open';
        const inText = !String(t.symbol || '').toLowerCase().includes(qq) && !String(t.setup || '').toLowerCase().includes(qq);
        const snip = inText ? snippet(t.thesis, qq) || snippet(t.review, qq) || (Array.isArray(t.tags) ? t.tags.filter((g) => String(g).toLowerCase().includes(qq)).map((g) => '#' + g).join(' ') : '') : '';
        return {
          id: t.id,
          module: ID,
          icon: ICON,
          color: COLOR,
          title: tradeTitle(t),
          subtitle: [head, t.setup || null, snip || null].filter(Boolean).join(' · '),
          date: t.date || t.entryDate,
          onOpen: () => navigate(`/trades/view/${t.id}`),
        };
      });
  },
};
