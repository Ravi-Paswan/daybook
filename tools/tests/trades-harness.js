// Test harness for trades/analytics.js, calendar.js and dayplan.js (works without trades/index.js).
// URL: tools/tests/trades-harness.html?view=analytics|calendar|plan&date=YYYY-MM-DD&sample=1|0&theme=light|dark&empty=1
//   sample=1 (default) loads the deterministic demo data once; empty=1 clears trades + days first (empty states).
// window.harness = { ready: Promise, show(view, params), cleanup, ctx, navs: [...paths navigated], db, calc, analytics }
import { openDB, db } from '../../js/core/db.js';
import { loadSettings, updateSettings, getSettings } from '../../js/core/settings.js';
import { h, mount, segmented } from '../../js/core/ui.js';
import * as calc from '../../js/modules/trades/calc.js';

const qs = new URLSearchParams(location.search);
const view = document.getElementById('hx-view');
const log = document.getElementById('hx-log');
const navs = [];
let cleanup = null;
let current = qs.get('view') || 'analytics';

const LOADERS = {
  analytics: async () => (await import('../../js/modules/trades/analytics.js')).renderAnalytics,
  calendar: async () => (await import('../../js/modules/trades/calendar.js')).renderTradeCalendar,
  plan: async () => (await import('../../js/modules/trades/dayplan.js')).renderDayPlan,
};

function makeCtx(id, params) {
  const path = '/' + ['trades', ...params].filter(Boolean).join('/');
  return {
    route: { id: 'trades', params, query: {}, path },
    navigate(p, opts = {}) {
      const clean = String(p).replace(/^#/, '');
      navs.push(clean);
      log.textContent = `navigate ${clean}${opts.replace ? ' (replace)' : ''}`;
      const parts = clean.split('/').filter(Boolean); // ['trades', 'plan', '2026-11-20']
      if (parts[0] === 'trades' && ['analytics', 'calendar', 'plan'].includes(parts[1])) show(parts[1], parts.slice(1));
    },
    setTitle(t) {
      document.title = `${t} · harness`;
    },
  };
}

async function show(name, params) {
  if (cleanup) {
    try { cleanup(); } catch (e) { console.error(e); }
    cleanup = null;
  }
  current = name;
  tabs.setValue(name);
  const p = params || [name === 'plan' ? 'plan' : name, ...(name === 'plan' && qs.get('date') ? [qs.get('date')] : [])];
  const ctx = makeCtx(name, p);
  const container = h('div.page');
  mount(view, container);
  const render = await LOADERS[name]();
  cleanup = render(container, ctx);
  window.harness.cleanup = cleanup;
  window.harness.ctx = ctx;
  if (cleanup && cleanup.ready) await cleanup.ready;
  document.documentElement.dataset.view = name;
  return cleanup;
}

const tabs = segmented(
  [{ value: 'analytics', label: 'Analytics' }, { value: 'calendar', label: 'Calendar' }, { value: 'plan', label: 'Daily plan' }],
  current,
  (v) => show(v),
  { size: 'sm', ariaLabel: 'Harness view' }
);
document.getElementById('hx-tabs').append(tabs);

async function boot() {
  await openDB();
  await loadSettings();
  if (!getSettings().onboarded) await updateSettings({ currency: 'INR', onboarded: true, name: 'Alex' });
  if (qs.get('empty') === '1') {
    await db.clear('trades');
    await db.clear('days');
  } else if (qs.get('sample') !== '0') {
    const sd = await import('../../js/modules/sample-data.js');
    if (!(await sd.hasSampleData())) await sd.loadSampleData();
  }
  await show(current);
  window.__harnessReady = true;
}

window.harness = { show, navs, db, calc, getSettings, updateSettings, ready: null, cleanup: null, ctx: null };
window.harness.ready = boot().catch((err) => {
  console.error('[harness] boot failed', err);
  mount(view, h('pre', String(err && err.stack || err)));
});
