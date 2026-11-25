// Daybook charts + icons demo (dev page: tools/charts-demo.html). Not part of the app bundle.
// Deterministic data (seeded PRNG) relative to today, so screenshots are stable day to day in shape.

import { openDB } from '../js/core/db.js';
import { loadSettings } from '../js/core/settings.js';
import { fmtMoney, fmtNumber, fmtDuration, fmtR } from '../js/core/format.js';
import { todayKey, addDays, weekday } from '../js/core/dates.js';
import { ICONS, ICON_NAMES, iconSVG } from '../js/core/icons.js';
import { lineChart, barChart, stackedBarChart, donutChart, heatmap, sparkline, histogram, legend } from '../js/core/charts.js';

const SPEC_ICONS = `today home food water learning book brain training footprints activity heart-pulse bike expenses income
coins receipt wallet trades trending-up trending-down candlestick chart bar-chart line-chart pie insights
sparkles goals target calendar calendar-check search settings sliders more grid list menu plus minus x
check check-circle circle chevron-left chevron-right chevron-up chevron-down arrow-left arrow-right
arrow-up arrow-down arrow-up-right arrow-down-right edit trash copy star star-filled heart flame trophy
medal award clock timer camera image link external-link tag filter sort download upload share moon sun
monitor sunrise sunset info alert help smile meh frown zap bed repeat refresh rotate-ccw history eye
eye-off bookmark note pen file list-checks user lock shield cloud-off wifi-off archive database
smartphone install rocket leaf apple coffee salad pizza scale percent hash dollar crosshair flag
compass map-pin bell play pause layers keyboard notebook graduation-cap lightbulb mountain`
  .split(/\s+/)
  .filter(Boolean);

/* ------------------------------------------------------------------------------------------ helpers */

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
function iconEl(name, size = 18) {
  const t = document.createElement('template');
  t.innerHTML = iconSVG(name, { size }); // trusted static SVG from icons.js
  return t.content.firstElementChild;
}
function card(title, sub, ...content) {
  return el('section', { class: 'demo-card' }, el('h3', {}, title), sub ? el('p', { class: 'sub' }, sub) : null, ...content);
}
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const INR = (v, o = {}) => fmtMoney(v, { currency: 'INR', ...o });
const inrAxis = (v, ctx) => INR(v, { compact: !!(ctx && ctx.compact) }); // ctx.compact: one style per axis
const inrSigned = (v) => INR(v, { sign: true });
const today = todayKey();
const days = (n) => Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
const isTradingDay = (k) => weekday(k) !== 0 && weekday(k) !== 6;

/* --------------------------------------------------------------------------------------------- data */

function calorieSeries() {
  const r = rng(11);
  return days(30).map((x, i) => ({ x, y: i === 12 ? null : Math.round(1850 + r() * 650 + (weekday(x) === 6 ? 300 : 0)) }));
}
function proteinSeries() {
  const r = rng(12);
  return days(30).map((x) => ({ x, y: Math.round(72 + r() * 50) }));
}
function dailyPnl() {
  const r = rng(21);
  return days(40)
    .filter(isTradingDay)
    .slice(-22)
    .map((label) => {
      const win = r() < 0.56;
      const v = Math.round((win ? 1 : -1) * (600 + r() * 5200) * (r() < 0.12 ? 2.2 : 1));
      return { label, value: v };
    });
}
function equity(pnl) {
  let acc = -3800;
  return [{ x: addDays(pnl[0].label, -1), y: acc }, ...pnl.map((d) => ({ x: d.label, y: (acc += d.value) }))];
}
function learningHeat() {
  const r = rng(31);
  const out = {};
  days(26 * 7).forEach((k, i) => {
    const p = r();
    if (p < 0.3) return;
    out[k] = p < 0.62 ? 1 : p < 0.86 ? 2 : p < 0.97 ? 3 : 5;
    if (i > 26 * 7 - 4 && k !== today) out[k] = 2;
  });
  return out;
}
function pnlHeat() {
  const r = rng(41);
  const out = {};
  days(120).forEach((k) => {
    if (!isTradingDay(k) || r() < 0.15) return;
    out[k] = Math.round((r() < 0.55 ? 1 : -1) * (200 + r() * 6400));
  });
  return out;
}
function weeklyTraining() {
  const r = rng(51);
  const labels = [];
  for (let w = 11; w >= 0; w--) labels.push(addDays(today, -7 * w - ((weekday(today) + 6) % 7)));
  const mk = (base, spread, skip) => labels.map(() => (r() < skip ? 0 : Math.round(base + r() * spread)));
  return {
    labels,
    series: [
      { name: 'Strength', color: '--chart-1', values: mk(80, 70, 0.08) },
      { name: 'Cardio', color: '--chart-2', values: mk(40, 60, 0.15) },
      { name: 'Yoga', color: '--chart-3', values: mk(20, 30, 0.35) },
    ],
  };
}
function rHistogram() {
  const bins = ['−3R', '−2R', '−1R', '0R', '+1R', '+2R', '+3R', '+4R+'];
  const counts = [1, 4, 17, 9, 14, 8, 4, 2];
  return bins.map((label, i) => ({
    label,
    count: counts[i],
    color: i < 3 ? '--loss' : i === 3 ? '--neutral' : '--profit',
    tooltip: i < 3 ? 'Losing trades' : i === 3 ? 'Scratch trades' : 'Winning trades',
  }));
}

/* ------------------------------------------------------------------------------------------- render */

function themeSwitcher() {
  const wrap = document.getElementById('theme');
  const opts = [
    { v: 'system', label: 'System', icon: 'monitor' },
    { v: 'light', label: 'Light', icon: 'sun' },
    { v: 'dark', label: 'Dark', icon: 'moon' },
  ];
  let cur = document.documentElement.dataset.theme || 'system';
  const btns = opts.map((o) =>
    el('button', { type: 'button', 'aria-pressed': String(o.v === cur), onClick: () => set(o.v) }, iconEl(o.icon, 16), o.label),
  );
  function set(v) {
    cur = v;
    if (v === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
    btns.forEach((b, i) => b.setAttribute('aria-pressed', String(opts[i].v === v)));
  }
  wrap.append(...btns);
  window.__setTheme = set;
}

function render(root) {
  document.getElementById('mark').append(iconEl('bar-chart', 22));
  themeSwitcher();

  const status = (id) => el('div', { class: 'demo-status', id, 'aria-live': 'polite' });
  const say = (id, text) => (document.getElementById(id).textContent = text);

  const cal = calorieSeries();
  const pnl = dailyPnl();
  const eq = equity(pnl);
  const net = pnl.reduce((a, d) => a + d.value, 0);
  const lastEq = eq[eq.length - 1].y;

  /* Food + trading */
  root.append(el('h2', { class: 'demo-h2' }, 'Trends'));
  root.append(
    el(
      'div',
      { class: 'demo-grid' },
      card(
        'Calories',
        'Last 30 days · daily target 2,200 kcal (one day missing → gap skipped)',
        lineChart({
          series: [{ name: 'Calories', color: '--food', points: cal }],
          target: 2200,
          targetLabel: 'Target 2,200 kcal',
          yFormat: (v) => fmtNumber(v),
          tooltipFormat: (v) => `${fmtNumber(v)} kcal`,
          ariaLabel: 'Calories, last 30 days',
        }),
      ),
      card(
        'Protein',
        'Last 30 days · target 100 g',
        lineChart({
          series: [{ name: 'Protein', color: '--food', points: proteinSeries() }],
          area: true,
          target: 100,
          yFormat: (v) => `${fmtNumber(v)} g`,
          ariaLabel: 'Protein, last 30 days',
        }),
      ),
      card(
        'Daily P&L',
        `${pnl.length} trading days · bars colored by sign`,
        el('div', { class: 'demo-kpi' }, el('b', { class: net >= 0 ? 'tone-profit' : 'tone-loss' }, inrSigned(net)), el('span', {}, 'net')),
        barChart({
          data: pnl.map((d) => ({ ...d, tooltip: d.value > 0 ? 'Green day' : 'Red day' })),
          signed: true,
          yFormat: inrAxis,
          tooltipFormat: inrSigned,
          ariaLabel: 'Daily profit and loss',
          onClick: (d) => say('pnl-status', `Clicked ${d.label}: ${inrSigned(d.value)}`),
        }),
        status('pnl-status'),
      ),
      card(
        'Equity curve',
        'Cumulative net P&L, starting below zero',
        el('div', { class: 'demo-kpi' }, el('b', { class: lastEq >= 0 ? 'tone-profit' : 'tone-loss' }, inrSigned(lastEq)), el('span', {}, 'balance vs start')),
        lineChart({
          series: [{ name: 'Equity', color: '--trades', points: eq }],
          area: true,
          zeroLine: true,
          yFormat: inrAxis,
          tooltipFormat: inrSigned,
          ariaLabel: 'Equity curve',
        }),
      ),
      card(
        'Mood & energy',
        'Two series on one shared 1–5 scale (legend + line keys)',
        lineChart({
          series: [
            { name: 'Mood', color: '--mood', points: days(14).map((x, i) => ({ x, y: [4, 3, 4, 5, 3, 2, 3, 4, 4, 5, 4, 3, 4, 5][i] })) },
            { name: 'Energy', color: '--chart-1', points: days(14).map((x, i) => ({ x, y: [3, 3, 4, 4, 2, 2, 3, 3, 4, 4, 5, 3, 3, 4][i] })) },
          ],
          integer: true,
          curve: false,
          ariaLabel: 'Mood and energy, last 14 days',
        }),
      ),
      card(
        'Daily spend',
        'This week vs daily budget ₹1,500',
        barChart({
          data: days(7).map((label, i) => ({ label, value: [820, 1340, 2150, 640, 1190, 3020, 980][i] })),
          color: '--expenses',
          target: 1500,
          yFormat: inrAxis,
          tooltipFormat: (v) => INR(v),
          xFormat: (k) => new Intl.DateTimeFormat(navigator.language, { weekday: 'short' }).format(new Date(k + 'T00:00')),
          ariaLabel: 'Daily spend this week',
        }),
      ),
    ),
  );

  /* Breakdown */
  root.append(el('h2', { class: 'demo-h2' }, 'Breakdowns'));
  const exp = [
    { label: 'Food & dining', value: 9420 },
    { label: 'Groceries', value: 6210 },
    { label: 'Transport', value: 3180 },
    { label: 'Bills & utilities', value: 4870 },
    { label: 'Shopping', value: 2650 },
    { label: 'Entertainment', value: 1290 },
  ];
  root.append(
    el(
      'div',
      { class: 'demo-grid' },
      card(
        'Spending by category',
        'November · tap a slice or row',
        donutChart({
          data: exp,
          centerLabel: 'Spent',
          valueFormat: (v) => INR(v),
          ariaLabel: 'Spending by category',
          onClick: (d) => say('donut-status', `Open ${d.label}`),
        }),
        status('donut-status'),
      ),
      card(
        'P&L by setup',
        'Horizontal signed bars · top setups',
        barChart({
          horizontal: true,
          signed: true,
          data: [
            { label: 'Breakout', value: 18450 },
            { label: 'Pullback', value: 9320 },
            { label: 'Trend follow', value: 4110 },
            { label: 'Range', value: -2380 },
            { label: 'Gap & go', value: -5640 },
            { label: 'News', value: -9870 },
          ],
          yFormat: inrSigned,
          ariaLabel: 'Net P&L by setup',
        }),
      ),
      card(
        'Training minutes per week',
        'Last 12 weeks, stacked by type',
        stackedBarChart({ ...weeklyTraining(), yFormat: (v) => fmtNumber(v), tooltipFormat: (v) => fmtDuration(v), ariaLabel: 'Training minutes per week' }),
      ),
      card(
        'R-multiple distribution',
        '59 closed trades · histogram',
        histogram({ data: rHistogram(), ariaLabel: 'R-multiple distribution' }),
      ),
    ),
  );

  /* Heatmaps */
  root.append(el('h2', { class: 'demo-h2' }, 'Heatmaps'));
  root.append(
    el(
      'div',
      { class: 'demo-grid' },
      el(
        'div',
        { class: 'demo-cell' },
        card(
          'Learning activity',
          'Last 26 weeks · things learned per day · click a day',
          heatmap({
            values: learningHeat(),
            from: addDays(today, -26 * 7 + 1),
            to: today,
            accent: '--learning',
            valueFormat: (v) => `${v} thing${v === 1 ? '' : 's'} learned`,
            onClick: (k) => say('heat-status', `Open ${k}`),
            ariaLabel: 'Learning activity',
          }),
          status('heat-status'),
        ),
      ),
      el(
        'div',
        { class: 'demo-cell' },
        card(
          'Trading P&L calendar',
          'Last 120 days · signed intensity (green profit / red loss)',
          heatmap({ values: pnlHeat(), from: addDays(today, -119), to: today, signed: true, valueFormat: inrSigned, ariaLabel: 'Daily P&L heatmap' }),
        ),
      ),
    ),
  );

  /* Sparklines */
  root.append(el('h2', { class: 'demo-h2' }, 'Sparklines in stat tiles'));
  const tile = (label, value, sub, values, color, valueFormat) =>
    el(
      'div',
      { class: 'tile' },
      el('div', { class: 'tile-label' }, label),
      el('div', { class: 'tile-value' }, value),
      sparkline(values, { color, width: 96, height: 30, ariaLabel: `${label} trend`, valueFormat }),
      el('div', { class: 'tile-sub' }, sub),
    );
  root.append(
    el(
      'div',
      { class: 'tiles' },
      tile('Avg calories', '2,140', 'kcal · last 14 days', cal.slice(-14).map((p) => p.y), '--food'),
      tile('Water', '6.4', 'glasses / day', [5, 6, 8, 7, 4, 6, 7, 8, 6, 5, 7, 8], '--water'),
      tile('Net P&L', inrSigned(net), 'last 22 sessions', eq.map((p) => p.y), '--trades', inrSigned),
      tile('Sleep', '7.2 h', 'avg this week', [6.5, 7, 7.5, 8, 6, 7.5, 8], '--mood'),
      tile('Spend', INR(10140), 'this week', [820, 1340, 2150, 640, 1190, 3020, 980], '--expenses', INR),
      tile('No data', '—', 'empty sparkline', [], '--goals'),
    ),
  );

  /* Edge cases */
  root.append(el('h2', { class: 'demo-h2' }, 'Edge cases (must never throw)'));
  const ec = (t, s, c) => card(t, s, c);
  root.append(
    el(
      'div',
      { class: 'edge-grid' },
      ec('Empty line', 'series: []', lineChart({ series: [], height: 160 })),
      ec('Single point', '1 point, showDots false', lineChart({ series: [{ name: 'Weight', color: '--training', points: [{ x: today, y: 72.4 }] }], height: 160, showDots: false, tooltipFormat: (v) => `${v} kg` })),
      ec('All negative', 'signed bars, all losses', barChart({ data: days(6).map((label, i) => ({ label, value: -[400, 1250, 300, 2200, 900, 150][i] })), signed: true, height: 160, yFormat: inrAxis, tooltipFormat: inrSigned })),
      ec('All negative line', 'area to zero', lineChart({ series: [{ name: 'Drawdown', color: '--loss', points: days(10).map((x, i) => ({ x, y: -[0.5, 1, 2.5, 2, 3.5, 4, 3, 5, 4.5, 6][i] })) }], area: true, height: 160, yFormat: (v) => fmtR(v) })),
      ec('All zeros', 'bars with value 0', barChart({ data: days(5).map((label) => ({ label, value: 0 })), height: 160 })),
      ec('Odd input', 'NaN, null, "12", Infinity, missing x', lineChart({ series: [{ name: 'Odd', points: [{ x: 'Mon', y: NaN }, { x: 'Tue', y: null }, { x: 'Wed', y: '12' }, { x: 'Thu', y: Infinity }, { y: 3 }, { x: 'Fri', y: 7 }, null, { x: 'Sat', y: 9 }] }, null, 'junk'], height: 160 })),
      ec('Empty bars', 'data: undefined', barChart({ height: 160 })),
      ec('Empty donut', 'all values 0', donutChart({ data: [{ label: 'A', value: 0 }, { label: 'B', value: -3 }], size: 140 })),
      ec('One slice', 'single category', donutChart({ data: [{ label: 'Rent', value: 18000 }], size: 140, valueFormat: (v) => INR(v), legend: true })),
      ec('Empty heatmap', 'no values', heatmap({ values: {}, height: 120 })),
      ec('Zero-only heatmap', 'every day 0', heatmap({ values: Object.fromEntries(days(28).map((k) => [k, 0])), from: addDays(today, -27), to: today })),
      ec('Empty stacked + histogram', 'no rows', el('div', { class: 'stack' }, stackedBarChart({ labels: [], series: [], height: 120 }), histogram({ data: [], height: 120 }))),
      ec('Many series', '10 series → slots 1–8, then gray', lineChart({ series: Array.from({ length: 10 }, (_, s) => ({ name: `S${s + 1}`, points: days(8).map((x, i) => ({ x, y: 10 + s * 3 + Math.sin(i + s) * 2 })) })), height: 180, showDots: false })),
      ec('Standalone legend', 'legend(items)', legend([{ label: 'Profit', color: '--profit', value: inrSigned(42000) }, { label: 'Loss', color: '--loss', value: inrSigned(-18000) }, { label: 'Raw hex', color: '#e64595', value: '12' }])),
    ),
  );

  /* Icons */
  root.append(el('h2', { class: 'demo-h2' }, 'Icons'));
  const missing = SPEC_ICONS.filter((n) => !Object.prototype.hasOwnProperty.call(ICONS, n));
  const extras = ICON_NAMES.filter((n) => !SPEC_ICONS.includes(n));
  const check = el(
    'div',
    { class: `demo-icon-check ${missing.length ? 'bad' : 'ok'}`, id: 'icon-check' },
    iconEl(missing.length ? 'alert' : 'check-circle', 18),
    missing.length
      ? `Missing ${missing.length} spec icon${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`
      : `All ${SPEC_ICONS.length} spec icons present · ${extras.length} extras`,
  );
  if (missing.length) console.error('[charts-demo] missing spec icons:', missing);
  const grid = el('div', { class: 'icons' });
  for (const n of [...SPEC_ICONS, ...extras]) {
    grid.append(el('div', { class: 'icon-cell', title: n }, iconEl(n, 24), el('span', {}, n)));
  }
  root.append(card(`${ICON_NAMES.length} icons`, 'Lucide-style 24×24, stroke 1.75 · spec names first, then extras', check, grid));
}

async function main() {
  try {
    await openDB();
    await loadSettings();
  } catch (err) {
    console.warn('[charts-demo] settings unavailable, using defaults:', err);
  }
  render(document.getElementById('root'));
  requestAnimationFrame(() => {
    window.__chartsReady = true;
  });
}

main();
