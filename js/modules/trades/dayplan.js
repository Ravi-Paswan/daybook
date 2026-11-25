// Trades › Daily plan tab (SPEC 4.6) — renderDayPlan(root, ctx) → cleanup.
//
// Choices not fixed by the spec:
// - Date = ctx.route.params[1] || state.date || today, clamped to today (no future plans). The date nav navigates to
//   '/trades/plan/<date>' with replace; without ctx.navigate (tests) it re-renders in place.
// - Every edit is queued and written with ONE debounced (600 ms) db.patchDay(date, {trading: {...changed}}) call,
//   so only touched fields are written. Pending edits are flushed on cleanup / date change / page hide.
// - Bias and grade are segmented controls with a small "Clear" action (segmented itself can't deselect).
// - Post-market lists trades whose index date is this day (closed that day, or opened that day and still open).
import { db } from '../../core/db.js';
import { on, state } from '../../core/bus.js';
import { getSettings } from '../../core/settings.js';
import { navigate as routerNavigate } from '../../core/router.js';
import { todayKey, isValidKey, clampToToday, weekday, fmtTime, relativeDay } from '../../core/dates.js';
import { fmtTradeMoney, fmtPercent, fmtR, pnlTone, plural, tradeCurrency } from '../../core/format.js';
import { h, mount, card, field, textarea, segmented, moodPicker, moneyInput, checkbox, listItem, badge, icon, button, dateNav, debounce, toast, emptyState } from '../../core/ui.js';
import { tradeNet, tradeR, outcome, isClosed, sortTrades } from './calc.js';

const money = (v) => fmtTradeMoney(v, { sign: true });
const toneCls = (v) => ({ 'text-profit': pnlTone(v) === 'profit', 'text-loss': pnlTone(v) === 'loss' });

async function openEditor(trade, date) {
  try {
    const mod = await import('./editor.js');
    return mod.openTradeEditor(trade, { date });
  } catch (err) {
    console.warn('[day plan] trade editor unavailable', err);
    toast('The trade editor is not available yet', { type: 'error' });
    return null;
  }
}

export function renderDayPlan(root, ctx = {}) {
  const param = ctx.route && ctx.route.params ? ctx.route.params[1] : null;
  let date = clampToToday(isValidKey(param) ? param : isValidKey(state.date) ? state.date : todayKey());
  let disposed = false;
  let pending = {};
  let tr = null; // current trading object (local mirror)
  let dayTrades = [];
  const offs = [];

  const status = h('span.tp-status', { role: 'status', 'aria-live': 'polite' });
  let statusTimer = null;
  function setStatus(kind) {
    clearTimeout(statusTimer);
    status.dataset.state = kind;
    if (kind === 'saving') mount(status, h('span.spinner', { style: { width: '12px', height: '12px' } }), 'Saving…');
    else if (kind === 'saved') {
      mount(status, icon('check', { size: 14 }), 'Saved');
      statusTimer = setTimeout(() => {
        if (!disposed) status.dataset.state = 'idle';
      }, 2400);
    } else if (kind === 'error') mount(status, icon('alert', { size: 14 }), 'Couldn’t save');
    else if (kind === 'pending') mount(status, icon('edit', { size: 14 }), 'Editing…');
  }
  setStatus('idle');

  async function writePending() {
    const patch = pending;
    pending = {};
    if (!Object.keys(patch).length) return;
    setStatus('saving');
    try {
      await db.patchDay(date, { trading: patch });
      if (!disposed) setStatus('saved');
    } catch (err) {
      console.error('[day plan] save failed', err);
      pending = { ...patch, ...pending };
      if (!disposed) {
        setStatus('error');
        toast('Couldn’t save your plan', { type: 'error' });
      }
    }
  }
  const save = debounce(writePending, 600);
  function change(key, value) {
    if (key === 'rulesChecked') {
      pending.rulesChecked = { ...(pending.rulesChecked || {}), ...value };
      tr.rulesChecked = { ...(tr.rulesChecked || {}), ...value };
    } else {
      pending[key] = value;
      tr[key] = value;
    }
    setStatus('pending');
    save();
  }
  const flush = () => {
    save.cancel();
    return writePending();
  };

  const dnav = dateNav(date, (d) => {
    flush();
    if (ctx && typeof ctx.navigate === 'function') ctx.navigate(`/trades/plan/${d}`, { replace: true });
    else {
      date = d;
      load();
    }
  });

  const body = h('div.tp-body');
  mount(root, h('div.tp.trades-dayplan', h('div.tp-head', h('h2.sr-only', 'Daily plan'), dnav, status), body));

  /* ---------- pre-market */
  function rulesBlock() {
    const rules = ((getSettings().trading || {}).rules || []).filter((r) => r && r.id);
    const count = h('span.tp-rules-count.num');
    const syncCount = () => {
      const n = rules.filter((r) => tr.rulesChecked && tr.rulesChecked[r.id]).length;
      count.textContent = rules.length ? `${n}/${rules.length}` : '';
      count.classList.toggle('is-done', rules.length > 0 && n === rules.length);
    };
    syncCount();
    const manage = h('a.section-link.tp-manage', { href: '#/settings' }, rules.length ? 'Manage rules' : 'Add rules', icon('chevron-right', { size: 16 }));
    return h(
      'div.tp-rules',
      { role: 'group', 'aria-labelledby': 'tp-rules-title' },
      h('div.tp-rules-head', h('span.field-label-text', { id: 'tp-rules-title' }, 'Rules checklist'), count, h('span.spacer'), manage),
      rules.length
        ? h(
            'div.tp-rules-list',
            rules.map((r) =>
              checkbox(!!(tr.rulesChecked && tr.rulesChecked[r.id]), (v) => {
                change('rulesChecked', { [r.id]: v });
                syncCount();
              }, { label: r.text, accent: 'var(--trades)' })
            )
          )
        : h('p.text-sm.muted', 'No trading rules yet. Write down the few rules you never break — they show up here every day.')
    );
  }

  function clearable(control, key, label) {
    const clear = h('button.link-btn.tp-clear', { type: 'button', hidden: !tr[key], onClick: () => { control.setValue(null); change(key, ''); clear.hidden = true; } }, 'Clear');
    control.addEventListener('click', () => {
      clear.hidden = !tr[key];
    });
    return field(label, control, { aside: clear });
  }

  function preMarket() {
    const bias = segmented(
      [
        { value: 'bullish', label: 'Bullish', icon: 'trending-up' },
        { value: 'neutral', label: 'Neutral', icon: 'minus' },
        { value: 'bearish', label: 'Bearish', icon: 'trending-down' },
      ],
      tr.bias || null,
      (v) => change('bias', v),
      { block: true, ariaLabel: 'Market bias', class: 'tp-bias' }
    );
    const mood = moodPicker(tr.moodBefore, (v) => change('moodBefore', v), { ariaLabel: 'Mood before the open' });
    const watch = textarea({ value: tr.watchlist || '', rows: 3, placeholder: 'Symbols, key levels, events…', onInput: (e) => change('watchlist', e.target.value) });
    const plan = textarea({ value: tr.plan || '', rows: 3, placeholder: 'What will you trade, and what will you skip?', onInput: (e) => change('plan', e.target.value) });
    const maxLoss = moneyInput(tr.maxLoss, (v) => {
      change('maxLoss', v);
      drawPost();
    }, { currency: tradeCurrency(), placeholder: 'e.g. 5000', 'aria-label': 'Max loss today' });

    return card({
      title: 'Pre-market plan',
      subtitle: 'Before the open',
      icon: 'sunrise',
      accent: '--trades',
      titleTag: 'h3',
      class: 'tp-card tp-pre',
      children: h(
        'div.stack',
        clearable(bias, 'bias', 'Bias'),
        field('Mood before', mood),
        field('Watchlist / key levels', watch),
        field('Game plan', plan),
        field('Max loss today', maxLoss, { hint: 'Stop trading for the day if you lose this much.' }),
        rulesBlock()
      ),
    });
  }

  /* ---------- post-market */
  const postSummary = h('div.tp-post-summary');
  function drawPost() {
    if (disposed || !tr) return;
    const closed = dayTrades.filter((t) => isClosed(t) && tradeNet(t) !== null);
    const net = closed.reduce((a, t) => a + tradeNet(t), 0);
    const wins = closed.filter((t) => outcome(t) === 'win').length;
    const losses = closed.filter((t) => outcome(t) === 'loss').length;
    const maxLoss = Number(tr.maxLoss);
    const hasMax = tr.maxLoss !== null && tr.maxLoss !== undefined && tr.maxLoss !== '' && Number.isFinite(maxLoss) && maxLoss > 0;
    const weekend = [0, 6].includes(weekday(date));
    let warn = null;
    if (hasMax && closed.length && net < -maxLoss) {
      warn = h('div.callout.tp-breach', { style: { '--accent': 'var(--loss)' }, role: 'alert' }, icon('alert', { size: 18 }), h('p', h('strong', 'Max loss broken. '), `Day P&L ${money(net)} vs your limit of ${fmtTradeMoney(maxLoss)} — ${fmtTradeMoney(-net - maxLoss)} over. Note what happened below.`));
    } else if (hasMax && closed.length && net <= -0.8 * maxLoss) {
      warn = h('div.callout.tp-breach', { style: { '--accent': 'var(--warning)' } }, icon('alert', { size: 18 }), h('p', `Close to your max loss: ${fmtTradeMoney(-net)} of ${fmtTradeMoney(maxLoss)} used.`));
    }
    mount(
      postSummary,
      h(
        'div.tp-daypnl',
        h('div.tp-daypnl-main', h('span.tp-daypnl-label', 'Day P&L'), h('span.tp-daypnl-value.num', { class: toneCls(net), dataset: { pnl: String(net) } }, closed.length ? money(net) : '—')),
        h(
          'div.tp-daypnl-meta',
          closed.length ? h('span', `${plural(closed.length, 'closed trade')} · ${wins}W ${losses}L · ${fmtPercent(wins / closed.length, { decimals: 0 })}`) : h('span', dayTrades.length ? 'No closed trades yet' : weekend ? 'Weekend — markets closed' : 'No trades logged'),
          hasMax && closed.length && net < 0 ? h('span.tp-maxloss-meter', { title: 'Share of max loss used' }, h('i', { class: { 'is-over': net < -maxLoss }, style: { width: `${Math.min(100, Math.max(0, Math.round((-net / maxLoss) * 100)))}%` } })) : null
        )
      ),
      warn,
      dayTrades.length
        ? h(
            'div.list.list-boxed.tp-trades',
            sortTrades(dayTrades).map((t) => {
              const c = isClosed(t);
              const n = tradeNet(t);
              const r = tradeR(t);
              return listItem({
                title: h('span.tp-trade-title', h('span', t.symbol || '—'), badge(t.direction === 'short' ? 'Short' : 'Long', t.direction === 'short' ? 'short' : 'long', { size: 'sm' }), c ? null : badge('Open', 'open', { size: 'sm' })),
                meta: [t.setup || null, fmtTime(c ? t.exitTime || t.entryTime : t.entryTime) || null, r !== null ? fmtR(r) : null],
                trail: c ? h('span.num.text-strong', { class: toneCls(n) }, money(n)) : h('span.muted.text-sm', 'Open'),
                chevron: true,
                onClick: () => {
                  flush();
                  if (ctx && typeof ctx.navigate === 'function') ctx.navigate(`/trades/view/${t.id}`);
                  else routerNavigate(`/trades/view/${t.id}`);
                },
              });
            })
          )
        : null,
      h('div.tp-add', button({ label: dayTrades.length ? 'Add trade' : 'Log a trade', icon: 'plus', variant: 'secondary', size: 'sm', onClick: () => openEditor(null, date) }))
    );
  }

  function postMarket() {
    const review = textarea({ value: tr.review || '', rows: 3, placeholder: 'What happened? Did you follow the plan?', onInput: (e) => change('review', e.target.value) });
    const lessons = textarea({ value: tr.lessons || '', rows: 2, placeholder: 'One thing to keep, one thing to change', onInput: (e) => change('lessons', e.target.value) });
    const grade = segmented(['A', 'B', 'C', 'D', 'F'].map((g) => ({ value: g, label: g })), tr.grade || null, (v) => change('grade', v), { block: true, ariaLabel: 'Grade the day', class: 'tp-grade' });
    drawPost();
    return card({
      title: 'Post-market review',
      subtitle: 'After the close',
      icon: 'sunset',
      accent: '--trades',
      titleTag: 'h3',
      class: 'tp-card tp-post',
      children: h('div.stack', postSummary, field('Review', review), field('Lessons', lessons), h('div.tp-grade-field', clearable(grade, 'grade', 'Grade your day'), h('p.field-hint', 'Grade the process, not the P&L.'))),
    });
  }

  async function load() {
    const d = date;
    const [day, trades] = await Promise.all([db.getDay(d), db.byDate('trades', d)]);
    if (disposed || d !== date) return;
    tr = { ...(day.trading || {}) };
    tr.rulesChecked = { ...(tr.rulesChecked || {}) };
    dayTrades = trades;
    dnav.setDate(date);
    if (ctx && typeof ctx.setTitle === 'function') ctx.setTitle(`Plan · ${relativeDay(date)}`);
    mount(body, h('div.tp-grid', preMarket(), postMarket()));
  }

  async function reloadTrades() {
    const d = date;
    const trades = await db.byDate('trades', d);
    if (disposed || d !== date) return;
    dayTrades = trades;
    drawPost();
  }
  const refreshTrades = debounce(reloadTrades, 80);
  const reloadAll = debounce(async () => {
    await flush();
    if (!disposed) load();
  }, 80);

  offs.push(
    on('db:change', (e) => {
      if (!e) return;
      if (e.store === 'trades') refreshTrades();
      else if (e.store === '*') reloadAll();
    }),
    on('settings:change', (e) => {
      // Rules or currency changed: re-render the form (pending edits are flushed first, local values kept).
      const p = e && e.patch;
      if (!p || p.trading || p.currency) reloadAll();
    })
  );
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  const onPageHide = () => flush();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  const ready = load().catch((err) => {
    console.error('[day plan] load failed', err);
    mount(body, emptyState({ icon: 'alert', title: 'Couldn’t load this day', message: 'Try again in a moment.', action: { label: 'Retry', icon: 'refresh', onClick: () => load() } }));
  });

  const cleanup = () => {
    flush();
    disposed = true;
    clearTimeout(statusTimer);
    refreshTrades.cancel();
    reloadAll.cancel();
    offs.forEach((off) => off());
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
  };
  cleanup.ready = ready;
  return cleanup;
}
