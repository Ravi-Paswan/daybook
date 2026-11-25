// Trades › P&L calendar tab (SPEC 4.6) — renderTradeCalendar(root, ctx) → cleanup.
// Also exports openTradeDaySheet(date, ctx) (used by Analytics' daily bars).
//
// Choices not fixed by the spec:
// - A day's P&L/count are closed trades by their index `date` (calc.dailyPnl). Open positions show in the day sheet.
// - Tint intensity = sqrt(|day P&L| / largest |day P&L| in the month) so small days stay visible next to big ones.
// - Weekly totals: an extra grid column from 720px up; below that a list of week rows under the grid.
// - The selected month survives tab switches for the session (module variable); `?month=YYYY-MM` also works.
// - Future days are not tappable. Days outside the month are left blank.
import { db } from '../../core/db.js';
import { on } from '../../core/bus.js';
import { getSettings } from '../../core/settings.js';
import { navigate as routerNavigate } from '../../core/router.js';
import { todayKey, currentMonth, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays, rangeKeys, monthOf, weekdayLabels, fmtDate, fmtTime, fmtMonth, relativeDay, isFuture } from '../../core/dates.js';
import { fmtTradeMoney, fmtPercent, fmtR, fmtNumber, pnlTone, plural } from '../../core/format.js';
import { h, mount, monthNav, statTile, openSheet, listItem, badge, icon, debounce, toast, emptyState } from '../../core/ui.js';
import { dailyPnl, tradeNet, tradeR, outcome, isClosed, sortTrades } from './calc.js';

let lastMonth = null;

const money = (v) => fmtTradeMoney(v, { sign: true });
const toneCls = (v) => ({ 'text-profit': pnlTone(v) === 'profit', 'text-loss': pnlTone(v) === 'loss' });
const MOODS = ['😫', '😕', '😐', '🙂', '😄'];
const MOOD_LABELS = ['Awful', 'Low', 'Okay', 'Good', 'Great'];
const BIAS = { bullish: ['Bullish', 'profit', 'trending-up'], bearish: ['Bearish', 'loss', 'trending-down'], neutral: ['Neutral', 'neutral', 'minus'] };

function hasPlan(tr) {
  if (!tr) return false;
  return !!(tr.bias || tr.watchlist || tr.plan || tr.review || tr.lessons || tr.grade || tr.moodBefore || (tr.maxLoss !== null && tr.maxLoss !== undefined) || Object.values(tr.rulesChecked || {}).some(Boolean));
}

function go(ctx, path) {
  if (ctx && typeof ctx.navigate === 'function') ctx.navigate(path);
  else routerNavigate(path);
}

async function openEditor(date) {
  try {
    const mod = await import('./editor.js');
    return mod.openTradeEditor(null, { date });
  } catch (err) {
    console.warn('[trade calendar] trade editor unavailable', err);
    toast('The trade editor is not available yet', { type: 'error' });
    return null;
  }
}

/** One-line summary row for a trade (shared by the day sheet). */
function tradeRow(t, onOpen) {
  const closed = isClosed(t);
  const net = tradeNet(t);
  const r = tradeR(t);
  const o = outcome(t);
  return listItem({
    lead: h('span.tc-trade-lead', { class: { 'is-win': o === 'win', 'is-loss': o === 'loss' }, 'aria-hidden': 'true' }, icon(t.direction === 'short' ? 'trending-down' : 'trending-up', { size: 18 })),
    title: h('span.tc-trade-title', h('span', t.symbol || '—'), badge(t.direction === 'short' ? 'Short' : 'Long', t.direction === 'short' ? 'short' : 'long', { size: 'sm' }), closed ? null : badge('Open', 'open', { size: 'sm' })),
    meta: [t.setup || null, fmtTime(closed ? t.exitTime || t.entryTime : t.entryTime) || null, r !== null ? fmtR(r) : null],
    trail: closed ? h('span.num.text-strong', { class: toneCls(net) }, money(net)) : h('span.muted.text-sm', 'Open'),
    chevron: true,
    onClick: onOpen,
    ariaLabel: `${t.symbol} ${t.direction}${closed ? `, ${money(net)}` : ', open'}`,
  });
}

/** Sheet with a day's trades + the day's plan/review summary. */
export async function openTradeDaySheet(date, ctx = {}) {
  const [trades, day] = await Promise.all([db.byDate('trades', date), db.getDay(date)]);
  const list = sortTrades(trades);
  const closed = list.filter((t) => isClosed(t) && tradeNet(t) !== null);
  const net = closed.reduce((a, t) => a + tradeNet(t), 0);
  const wins = closed.filter((t) => outcome(t) === 'win').length;
  const losses = closed.filter((t) => outcome(t) === 'loss').length;
  const tr = day.trading || {};
  const rules = ((getSettings().trading || {}).rules || []).filter((r) => r && r.id);
  const checked = rules.filter((r) => tr.rulesChecked && tr.rulesChecked[r.id]).length;
  const planned = hasPlan(tr);

  let api;
  const openTrade = (t) => {
    api.close();
    go(ctx, `/trades/view/${t.id}`);
  };
  const textBlock = (label, text) => (text ? h('div.tc-plan-block', h('div.tc-plan-label', label), h('p.tc-plan-text', text)) : null);
  const maxLoss = Number(tr.maxLoss);
  const breach = closed.length && Number.isFinite(maxLoss) && maxLoss > 0 && net < -maxLoss;

  const content = h(
    'div.tc-sheet.stack',
    closed.length
      ? h(
          'div.tc-sheet-hero',
          h('span.tc-sheet-net.num', { class: toneCls(net) }, money(net)),
          h('span.subtle.text-sm', `${plural(closed.length, 'closed trade')} · ${wins}W ${losses}L${closed.length ? ` · ${fmtPercent(wins / closed.length, { decimals: 0 })} win` : ''}`)
        )
      : null,
    breach ? h('div.callout', { style: { '--accent': 'var(--loss)' } }, icon('alert', { size: 18 }), h('p', `Max loss of ${fmtTradeMoney(maxLoss)} was broken by ${fmtTradeMoney(-net - maxLoss)}.`)) : null,
    list.length
      ? h('div.list.list-boxed.tc-sheet-trades', list.map((t) => tradeRow(t, () => openTrade(t))))
      : h('p.subtle.text-sm.tc-empty-line', isFuture(date) ? 'This day hasn’t happened yet.' : 'No trades on this day.'),
    h(
      'section.tc-plan',
      { 'aria-label': 'Plan and review' },
      h('h3.tc-plan-title', icon('notebook', { size: 16 }), 'Plan & review'),
      planned
        ? [
            h(
              'div.tc-plan-badges',
              tr.bias && BIAS[tr.bias] ? badge(BIAS[tr.bias][0], BIAS[tr.bias][1], { icon: BIAS[tr.bias][2] }) : null,
              tr.grade ? badge(`Grade ${tr.grade}`, 'accent') : null,
              tr.moodBefore ? badge(`Mood ${MOODS[tr.moodBefore - 1] || ''} ${MOOD_LABELS[tr.moodBefore - 1] || ''}`, 'neutral') : null,
              rules.length ? badge(`${checked}/${rules.length} rules`, checked === rules.length ? 'profit' : 'neutral', { icon: 'list-checks' }) : null,
              Number.isFinite(maxLoss) && maxLoss > 0 ? badge(`Max loss ${fmtTradeMoney(maxLoss)}`, 'neutral') : null
            ),
            textBlock('Watchlist', tr.watchlist),
            textBlock('Game plan', tr.plan),
            textBlock('Review', tr.review),
            textBlock('Lessons', tr.lessons),
          ]
        : h('p.subtle.text-sm', 'No plan or review written for this day.')
    )
  );

  api = openSheet({
    title: fmtDate(date, 'mediumYear'),
    subtitle: relativeDay(date) !== fmtDate(date, 'medium') ? relativeDay(date) : null,
    icon: 'calendar',
    accent: '--trades',
    content,
    actions: [
      !isFuture(date) && {
        label: 'Add trade',
        icon: 'plus',
        variant: 'secondary',
        onClick: () => {
          openEditor(date);
          return null;
        },
      },
      {
        label: planned ? 'Open daily plan' : 'Plan this day',
        icon: 'notebook',
        variant: 'primary',
        onClick: () => {
          go(ctx, `/trades/plan/${date}`);
          return null;
        },
      },
    ].filter(Boolean),
  });
  return api;
}

export function renderTradeCalendar(root, ctx = {}) {
  let disposed = false;
  const q = ctx.route && ctx.route.query && ctx.route.query.month;
  let month = (q && /^\d{4}-\d{2}$/.test(q) && q <= currentMonth() ? q : null) || lastMonth || currentMonth();

  const nav = monthNav(month, (m) => {
    month = m;
    lastMonth = m;
    draw();
  });
  const summary = h('div.tc-summary');
  const gridWrap = h('div.tc-grid-wrap');
  const weeksList = h('div.tc-weeks');
  const el = h('div.tc.trades-calendar', h('div.tc-head', h('h2.sr-only', 'P&L calendar'), nav), summary, gridWrap, weeksList);
  mount(root, el);

  async function draw() {
    const ws = Number(getSettings().weekStart ?? 1);
    const mFrom = startOfMonth(month);
    const mTo = endOfMonth(month);
    const gFrom = startOfWeek(mFrom, ws);
    const gTo = endOfWeek(mTo, ws);
    const [trades, days] = await Promise.all([db.byRange('trades', gFrom, gTo), db.getDays(gFrom, gTo)]);
    if (disposed) return;
    const inMonth = trades.filter((t) => monthOf(t.date) === month);
    const daily = dailyPnl(inMonth);
    const today = todayKey();
    const dayKeys = Object.keys(daily);
    const maxAbs = Math.max(1, ...dayKeys.map((d) => Math.abs(daily[d].pnl)));

    // ----- summary
    const net = dayKeys.reduce((a, d) => a + daily[d].pnl, 0);
    const green = dayKeys.filter((d) => daily[d].pnl > 0);
    const red = dayKeys.filter((d) => daily[d].pnl < 0);
    const tradeCount = dayKeys.reduce((a, d) => a + daily[d].count, 0);
    const winsCount = dayKeys.reduce((a, d) => a + daily[d].wins, 0);
    const best = dayKeys.reduce((a, d) => (a === null || daily[d].pnl > daily[a].pnl ? d : a), null);
    const worst = dayKeys.reduce((a, d) => (a === null || daily[d].pnl < daily[a].pnl ? d : a), null);
    const tile = (o, k) => {
      const t = statTile(o);
      t.dataset.kpi = k;
      return t;
    };
    mount(
      summary,
      tile({ label: `${fmtDate(mFrom, 'month')} P&L`, value: dayKeys.length ? money(net) : '—', tone: pnlTone(net), sub: dayKeys.length ? plural(dayKeys.length, 'trading day') : 'No closed trades' }, 'net'),
      tile({ label: 'Win / loss days', value: `${green.length} / ${red.length}`, sub: dayKeys.length ? `${fmtPercent(green.length / dayKeys.length, { decimals: 0 })} green days` : '—' }, 'days'),
      tile({ label: 'Trades', value: fmtNumber(tradeCount), sub: tradeCount ? `${fmtPercent(winsCount / tradeCount, { decimals: 0 })} win rate` : '—' }, 'trades'),
      tile({ label: 'Best / worst day', value: best && daily[best].pnl > 0 ? money(daily[best].pnl) : '—', tone: best && daily[best].pnl > 0 ? 'profit' : null, sub: worst && daily[worst].pnl < 0 ? `Worst ${money(daily[worst].pnl)} · ${fmtDate(worst, 'short')}` : dayKeys.length ? 'No red days' : '—' }, 'best')
    );

    // ----- grid
    const labels = weekdayLabels(ws, 'short');
    const narrow = weekdayLabels(ws, 'narrow');
    const head = h(
      'div.tc-row.tc-row-head',
      { role: 'row' },
      labels.map((l, i) => h('div.tc-dow', { role: 'columnheader', 'aria-label': weekdayLabels(ws, 'long')[i] }, h('span.tc-dow-long', l), h('span.tc-dow-short', { 'aria-hidden': 'true' }, narrow[i]))),
      h('div.tc-dow.tc-week-col', { role: 'columnheader' }, 'Week')
    );
    const rows = [];
    const weeks = [];
    for (let wStart = gFrom; wStart <= gTo; wStart = addDays(wStart, 7)) {
      const keys = rangeKeys(wStart, addDays(wStart, 6));
      const wk = { start: wStart, pnl: 0, count: 0, days: 0, wins: 0 };
      const cells = keys.map((d) => {
        if (monthOf(d) !== month) return h('div.tc-cell.is-outside', { role: 'gridcell', 'aria-hidden': 'true' });
        const info = daily[d];
        const plan = hasPlan(days[d] && days[d].trading);
        const future = d > today;
        if (info) {
          wk.pnl += info.pnl;
          wk.count += info.count;
          wk.wins += info.wins;
          wk.days++;
        }
        const tone = info ? pnlTone(info.pnl) : null;
        const tint = info && info.pnl !== 0 ? Math.round(10 + 34 * Math.sqrt(Math.abs(info.pnl) / maxAbs)) : 0;
        const dayNum = Number(d.slice(8));
        const aria = `${fmtDate(d, 'long')}${info ? `: ${money(info.pnl)}, ${plural(info.count, 'trade')}` : ': no trades'}${plan ? ', plan written' : ''}`;
        return h(
          'div.tc-cell',
          { role: 'gridcell' },
          h(
            'button.tc-day',
            {
              type: 'button',
              class: { 'is-profit': tone === 'profit', 'is-loss': tone === 'loss', 'is-flat': tone === 'neutral', 'is-today': d === today, 'is-future': future, 'has-trades': !!info },
              style: tint ? { '--tint': `${tint}%` } : null,
              disabled: future,
              dataset: { date: d },
              'aria-label': aria,
              onClick: () => openTradeDaySheet(d, ctx),
            },
            h('span.tc-day-top', h('span.tc-day-num', String(dayNum)), plan ? h('span.tc-plan-dot', { title: 'Plan written' }, icon('notebook', { size: 12 })) : null),
            info
              ? [
                  h('span.tc-day-pnl.num', h('span.tc-pnl-full', money(info.pnl)), h('span.tc-pnl-compact', fmtTradeMoney(Math.abs(info.pnl) < 1000 ? Math.round(info.pnl) : info.pnl, { sign: true, compact: true }))),
                  h('span.tc-day-count', h('span.tc-count-full', plural(info.count, 'trade')), h('span.tc-count-dots', { 'aria-hidden': 'true' }, Array.from({ length: Math.min(info.count, 4) }, () => h('i')))),
                ]
              : null
          )
        );
      });
      weeks.push(wk);
      rows.push(
        h(
          'div.tc-row',
          { role: 'row' },
          cells,
          h(
            'div.tc-cell.tc-week-col',
            { role: 'gridcell' },
            h(
              'div.tc-week',
              { 'aria-label': `Week of ${fmtDate(wStart, 'short')}: ${wk.count ? `${money(wk.pnl)}, ${plural(wk.count, 'trade')}` : 'no trades'}` },
              wk.count ? [h('span.tc-week-pnl.num', { class: toneCls(wk.pnl) }, money(wk.pnl)), h('span.tc-week-count', plural(wk.count, 'trade'))] : h('span.tc-week-none', '—')
            )
          )
        )
      );
    }
    mount(
      gridWrap,
      h('div.tc-grid', { role: 'grid', 'aria-label': `P&L calendar, ${fmtMonth(month)}` }, head, rows),
      h(
        'div.tc-legend',
        { 'aria-hidden': 'true' },
        h('span', 'Loss'),
        h('span.tc-legend-scale', [44, 27, 10].map((p) => h('i.is-loss', { style: { '--tint': `${p}%` } })), [10, 27, 44].map((p) => h('i.is-profit', { style: { '--tint': `${p}%` } }))),
        h('span', 'Profit'),
        h('span.tc-legend-plan', icon('notebook', { size: 12 }), 'Plan written')
      ),
      !dayKeys.length
        ? emptyState({
            icon: 'calendar',
            accent: '--trades',
            compact: true,
            title: `No closed trades in ${fmtMonth(month)}`,
            message: 'Tap any day to see its plan, or log a trade.',
            action: { label: 'Log a trade', icon: 'plus', onClick: () => openEditor(month === currentMonth() ? today : endOfMonth(month)) },
          })
        : null
    );

    // ----- weekly summary rows (phones)
    const maxW = Math.max(1, ...weeks.map((w) => Math.abs(w.pnl)));
    mount(
      weeksList,
      dayKeys.length
        ? [
            h('h3.tc-weeks-title', 'Weekly totals'),
            h(
              'div.list.list-boxed',
              weeks.filter((w) => w.start <= today).map((w) => {
                const from = w.start < mFrom ? mFrom : w.start;
                const to = addDays(w.start, 6) > mTo ? mTo : addDays(w.start, 6);
                return h(
                  'div.tc-week-row',
                  h('div.tc-week-row-main', h('span.tc-week-row-label', from === to ? fmtDate(from, 'medium') : `${fmtDate(from, 'short')} – ${fmtDate(to, 'short')}`), h('span.tc-week-row-meta', w.count ? `${plural(w.count, 'trade')} · ${plural(w.days, 'day')}` : 'No trades')),
                  h('div.tc-week-bar', { 'aria-hidden': 'true' }, w.count ? h('i', { class: { 'is-loss': w.pnl < 0 }, style: { width: `${Math.max(4, Math.round((Math.abs(w.pnl) / maxW) * 100))}%` } }) : null),
                  h('span.tc-week-row-pnl.num', { class: toneCls(w.pnl) }, w.count ? money(w.pnl) : '—')
                );
              })
            ),
          ]
        : null
    );
  }

  const ready = draw();
  const refresh = debounce(draw, 80);
  const offs = [
    on('db:change', (e) => {
      if (e && (e.store === 'trades' || e.store === 'days' || e.store === '*')) refresh();
    }),
    on('settings:change', () => refresh()),
  ];
  const cleanup = () => {
    disposed = true;
    refresh.cancel();
    offs.forEach((off) => off());
  };
  cleanup.ready = ready;
  return cleanup;
}
