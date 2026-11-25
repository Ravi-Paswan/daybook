// js/modules/trades/detail.js — single trade view (SPEC 4.6 "Detail"), route '#/trades/view/<id>'.
//
// Choices beyond the spec:
//   - renderTradeDetail() is async (resolves to the cleanup fn) so the page's <h1> exists when the route settles.
//   - A "trade map" bar shows stop / entry / exit / target on one price axis (risk & reward zones shaded).
//   - Open trades get a "Close trade" action (opens the editor switched to Closed with exit = now).
//   - Prev/next are chronological (calc.sortTrades); ← / → keys also move between trades when no field or
//     sheet has focus. Deleting the trade (here or from any editor) returns to the Journal.

import { db } from '../../core/db.js';
import { on } from '../../core/bus.js';
import { fmtDate, fmtTime, todayKey, diffDays } from '../../core/dates.js';
import { fmtTradeMoney, fmtR, fmtPercent, fmtNumber, fmtPrice, fmtDuration, pnlTone } from '../../core/format.js';
import { h, mount, pageHeader, emptyState, icon, badge, button, debounce } from '../../core/ui.js';
import { thumb } from '../../core/images.js';
import { removeWithUndo } from '../../core/undo.js';
import { navigate } from '../../core/router.js';
import {
  tradeGross,
  tradeNet,
  tradeR,
  tradeRisk,
  plannedRR,
  potentialReward,
  tradeReturnPct,
  notional,
  holdMinutes,
  sortTrades,
  isClosed,
  outcome,
  num,
  TIMEFRAMES,
} from './calc.js';
import { openTradeEditor, sideBadge, marketLabel, accountsList } from './editor.js';

const STORE = 'trades';
const list = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && x !== '') : []);

function when(date, time) {
  if (!date) return '—';
  const sameYear = String(date).slice(0, 4) === todayKey().slice(0, 4);
  const d = fmtDate(date, sameYear ? 'medium' : 'mediumYear');
  return time ? `${d}, ${fmtTime(time)}` : d;
}

function stars(value, label) {
  const v = num(value);
  if (!v) return h('span.muted', 'Not rated');
  return h(
    'span.td-stars',
    { role: 'img', 'aria-label': `${label}: ${v} of 5` },
    Array.from({ length: 5 }, (_, i) => icon(i < v ? 'star-filled' : 'star', { size: 16, class: i < v ? 'is-on' : '' }))
  );
}

function pills(items, variant) {
  return h(
    'div.td-pills',
    items.map((x) => h('span.td-pill', { class: variant ? `td-pill-${variant}` : null }, x))
  );
}

/** Stop · entry · exit · target on one axis. */
function tradeMap(t) {
  const e = num(t.entryPrice);
  const s = num(t.stopLoss);
  const tg = num(t.target);
  const x = isClosed(t) ? num(t.exitPrice) : null;
  if (e === null || (s === null && tg === null && x === null)) return null;
  const pts = [s, e, tg, x].filter((v) => v !== null);
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  if (hi - lo < 1e-12) {
    lo -= Math.abs(lo) * 0.01 || 1;
    hi += Math.abs(hi) * 0.01 || 1;
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const pos = (v) => ((v - lo) / (hi - lo)) * 100;
  const zone = (a, b, cls) => h('span.td-map-zone', { class: cls, style: { left: `${Math.min(pos(a), pos(b))}%`, width: `${Math.abs(pos(b) - pos(a))}%` } });
  const dot = (v, cls, label) => h('span.td-map-dot', { class: cls, style: { left: `${pos(v)}%` }, title: `${label} ${fmtPrice(v)}` });
  const tone = x !== null ? pnlTone(tradeNet(t)) : 'neutral';
  const legend = [
    s !== null && ['is-stop', 'Stop', s],
    ['is-entry', 'Entry', e],
    x !== null && ['is-exit', 'Exit', x],
    tg !== null && ['is-target', 'Target', tg],
  ].filter(Boolean);
  return h(
    'div.td-map',
    { role: 'img', 'aria-label': legend.map(([, l, v]) => `${l} ${fmtPrice(v)}`).join(', ') },
    h(
      'div.td-map-track',
      { 'aria-hidden': 'true' },
      s !== null ? zone(e, s, 'is-risk') : null,
      tg !== null ? zone(e, tg, 'is-reward') : null,
      x !== null ? zone(e, x, `is-move is-${tone}`) : null,
      legend.map(([cls, l, v]) => dot(v, cls, l))
    ),
    h(
      'div.td-map-legend',
      { 'aria-hidden': 'true' },
      legend.map(([cls, l, v]) => h('span.td-map-key', h('span.td-map-swatch', { class: cls }), h('span', l), h('b.num', fmtPrice(v))))
    )
  );
}

function notFound(page) {
  mount(
    page,
    pageHeader({ title: 'Trade not found', back: '/trades' }),
    h(
      'div.card',
      emptyState({
        icon: 'search',
        accent: '--trades',
        title: 'This trade isn’t here anymore',
        message: 'It may have been deleted, or the link is from another device.',
        action: { label: 'Back to journal', icon: 'arrow-left', onClick: () => navigate('/trades') },
      })
    )
  );
}

export async function renderTradeDetail(root, ctx, tradeId) {
  let disposed = false;
  const page = h('div.page.trades-page.td-page', { style: { '--accent': 'var(--trades)' } });
  mount(root, page);
  let neighbours = { prev: null, next: null };
  let current = null;

  async function draw() {
    const [t, all] = await Promise.all([db.get(STORE, tradeId), db.all(STORE)]);
    if (disposed) return;
    // keep keyboard focus on the "same" control across redraws
    const active = document.activeElement;
    const fk = active && page.contains(active) && active.dataset ? active.dataset.fk : null;
    current = t || null;
    if (!t) {
      neighbours = { prev: null, next: null };
      ctx.setTitle('Trade not found');
      notFound(page);
      return;
    }
    const sorted = sortTrades(all, 'asc');
    const i = sorted.findIndex((x) => x.id === t.id);
    neighbours = { prev: i > 0 ? sorted[i - 1] : null, next: i >= 0 && i < sorted.length - 1 ? sorted[i + 1] : null };
    ctx.setTitle(t.symbol || 'Trade');
    mount(page, ...build(t, i, sorted.length));
    if (fk) {
      const el = page.querySelector(`[data-fk="${fk}"]`);
      if (el && !el.disabled) el.focus({ preventScroll: true });
    }
  }

  function build(t, index, total) {
    const closed = isClosed(t);
    const net = tradeNet(t);
    const tone = closed ? pnlTone(net) : 'open';
    const r = tradeR(t);
    const ret = tradeReturnPct(t);
    const risk = tradeRisk(t);
    const rr = plannedRR(t);
    const reward = potentialReward(t);
    const hold = t.entryTime && (t.exitTime || (t.exitDate && t.exitDate !== t.entryDate)) ? holdMinutes(t) : null;
    const mult = num(t.multiplier) || 1;
    const accounts = accountsList();
    const acc = accounts.find((a) => a.id === (t.accountId || 'main'));
    const res = outcome(t);

    const edit = () => openTradeEditor(t);
    const dup = () =>
      openTradeEditor(null, { duplicateFrom: t }).then((saved) => {
        if (saved && !disposed) navigate(`/trades/view/${saved.id}`);
      });
    const del = async () => {
      await removeWithUndo(STORE, t, { label: `${t.symbol || 'Trade'} deleted`, files: list(t.screenshots) });
      // db:change listener navigates back to the journal
    };

    const header = pageHeader({
      title: t.symbol || 'Trade',
      subtitle: [marketLabel(t.market), accounts.length > 1 && acc ? acc.name : null, `Trade ${index + 1} of ${total}`].filter(Boolean).join(' · '),
      back: '/trades',
      actions: [
        button({ label: 'Edit', icon: 'edit', variant: 'secondary', onClick: edit, dataset: { fk: 'edit' } }),
        button({ label: 'Duplicate', icon: 'copy', variant: 'secondary', class: 'td-act-compact', ariaLabel: 'Duplicate trade', onClick: dup, dataset: { fk: 'dup' } }),
        button({ label: 'Delete', icon: 'trash', variant: 'ghost', class: 'td-act-compact td-act-delete', ariaLabel: 'Delete trade', onClick: del, dataset: { fk: 'del' } }),
      ],
      class: 'td-header',
    });

    // ── hero
    const resultBadge = closed
      ? res === 'win'
        ? badge('Win', 'profit', { icon: 'trending-up', size: 'lg' })
        : res === 'loss'
          ? badge('Loss', 'loss', { icon: 'trending-down', size: 'lg' })
          : badge('Breakeven', 'neutral', { size: 'lg' })
      : badge('Open', 'open', { dot: true, size: 'lg' });
    const heroMeta = closed
      ? [
          h('span.td-hero-chip.num', { title: 'R-multiple (net ÷ initial risk)' }, r === null ? 'R —' : fmtR(r, { decimals: 2 })),
          h('span.td-hero-chip.num', { title: 'Return on position value' }, fmtPercent(ret, { decimals: 2, sign: true })),
          hold !== null ? h('span.td-hero-chip', icon('clock', { size: 14 }), fmtDuration(hold)) : null,
        ]
      : [
          reward !== null ? h('span.td-hero-chip.num.text-profit', `${fmtTradeMoney(reward, { sign: true })} at target`) : null,
          rr !== null ? h('span.td-hero-chip.num', `R:R 1 : ${fmtNumber(rr, { maxDecimals: 2 })}`) : null,
          t.entryDate ? h('span.td-hero-chip', icon('clock', { size: 14 }), openFor(t)) : null,
        ];
    const hero = h(
      'section.card.td-hero',
      { dataset: { tone } },
      h('div.td-hero-badges', sideBadge(t, { size: 'lg' }), resultBadge, t.setup ? badge(t.setup, 'accent', { size: 'lg' }) : null, t.timeframe ? badge(t.timeframe, 'neutral', { size: 'lg' }) : null),
      h(
        'div.td-hero-main',
        h(
          'div.td-hero-pnl',
          h('span.td-hero-label', closed ? (num(t.pnlOverride) !== null ? 'Net P&L (manual)' : 'Net P&L') : 'Open position · at stop'),
          h(
            'span.td-hero-value.num',
            { class: { 'text-profit': tone === 'profit', 'text-loss': tone === 'loss' } },
            closed ? fmtTradeMoney(net, { sign: true }) : risk !== null ? fmtTradeMoney(-risk, { sign: true }) : 'No stop'
          ),
          h('div.td-hero-chips', heroMeta)
        ),
        !closed ? button({ label: 'Close trade', icon: 'flag', variant: 'primary', class: 'td-close-btn', onClick: () => openTradeEditor(t, { closeNow: true }), dataset: { fk: 'close' } }) : null
      ),
      tradeMap(t)
    );

    // ── numbers
    const pairs = [
      { label: 'Entry', value: h('span', h('b.num', fmtPrice(t.entryPrice)), h('small', when(t.entryDate, t.entryTime))) },
      { label: 'Exit', value: closed ? h('span', h('b.num', fmtPrice(t.exitPrice)), h('small', when(t.exitDate || t.entryDate, t.exitTime))) : h('span.muted', 'Still open') },
      { label: 'Quantity', value: h('span.num', fmtNumber(t.quantity, { maxDecimals: 8 }), mult !== 1 ? h('small', `× ${fmtNumber(mult, { maxDecimals: 6 })} multiplier`) : null) },
      { label: 'Position value', value: h('span.num', fmtTradeMoney(notional(t))) },
      closed && { label: 'Gross P&L', value: h('span.num', fmtTradeMoney(tradeGross(t), { sign: true })), tone: pnlTone(tradeGross(t)) },
      closed && { label: 'Fees', value: h('span.num', fmtTradeMoney(num(t.fees) || 0)) },
      { label: 'Stop loss', value: h('span.num', fmtPrice(t.stopLoss)) },
      { label: 'Target', value: h('span.num', fmtPrice(t.target)) },
      { label: 'Initial risk', value: h('span.num', risk !== null ? fmtTradeMoney(risk) : '—') },
      { label: 'Planned R:R', value: h('span.num', rr !== null ? `1 : ${fmtNumber(rr, { maxDecimals: 2 })}` : '—') },
      { label: 'Reward at target', value: h('span.num', reward !== null ? fmtTradeMoney(reward) : '—') },
      closed && { label: 'Hold time', value: h('span.num', hold !== null ? fmtDuration(hold) : '—') },
    ].filter(Boolean);
    const numbers = h(
      'section.card.td-numbers',
      h('h2.td-card-title', 'Key numbers'),
      h(
        'dl.td-kv',
        pairs.map((p) => h('div', h('dt', p.label), h('dd', { class: { 'text-profit': p.tone === 'profit', 'text-loss': p.tone === 'loss' } }, p.value)))
      )
    );

    // ── psychology & tags
    const emotions = list(t.emotions);
    const mistakes = list(t.mistakes);
    const tags = list(t.tags);
    const psych = h(
      'section.card.td-psych',
      h('h2.td-card-title', 'Setup & psychology'),
      h(
        'dl.td-facts',
        h('div', h('dt', 'Setup'), h('dd', t.setup ? h('span.td-pill.td-pill-accent', t.setup) : h('span.muted', '—'))),
        h('div', h('dt', 'Timeframe'), h('dd', t.timeframe && TIMEFRAMES.includes(t.timeframe) ? h('span.td-pill', t.timeframe) : t.timeframe || h('span.muted', '—'))),
        h('div', h('dt', 'Confidence'), h('dd', stars(t.confidence, 'Confidence'))),
        h('div', h('dt', 'Execution'), h('dd', stars(t.rating, 'Execution'))),
        h(
          'div',
          h('dt', 'Followed plan'),
          h('dd', t.followedPlan === true ? badge('Yes', 'profit', { icon: 'check' }) : t.followedPlan === false ? badge('No', 'loss', { icon: 'x' }) : h('span.muted', 'Not set'))
        )
      ),
      emotions.length ? h('div.td-group', h('h3.td-sub', 'Emotions'), pills(emotions)) : null,
      mistakes.length ? h('div.td-group', h('h3.td-sub', 'Mistakes'), pills(mistakes, 'loss')) : null,
      tags.length ? h('div.td-group', h('h3.td-sub', 'Tags'), pills(tags.map((x) => `#${x}`), 'tag')) : null
    );

    // ── notes
    const note = (title, text, empty) =>
      h('div.td-note', h('h3.td-sub', title), text ? h('p.td-note-text', text) : h('p.td-note-empty', empty));
    const notes = h(
      'section.card.td-notes',
      h('div.td-card-head', h('h2.td-card-title', 'Notes'), !t.thesis || !t.review ? button({ label: t.thesis || t.review ? 'Edit' : 'Add notes', icon: 'pen', size: 'sm', variant: 'ghost', onClick: edit, dataset: { fk: 'notes' } }) : null),
      note('Thesis', t.thesis, 'No thesis written — why did you take it?'),
      note('Review', t.review, closed ? 'No review yet — what would you repeat or change?' : 'Review it once the trade is closed.')
    );

    // ── screenshots
    const ids = list(t.screenshots);
    const shots = h(
      'section.card.td-shots',
      h('div.td-card-head', h('h2.td-card-title', 'Screenshots', ids.length ? h('span.td-count', String(ids.length)) : null), button({ label: ids.length ? 'Add more' : 'Add', icon: 'image', size: 'sm', variant: 'ghost', onClick: edit, dataset: { fk: 'shots' } })),
      ids.length
        ? h('div.td-gallery', ids.map((id, k) => thumb(id, { size: '100%', ids, index: k, alt: `${t.symbol} screenshot ${k + 1}`, label: `Open screenshot ${k + 1} of ${ids.length}` })))
        : h('p.td-note-empty', 'Charts at entry and exit make reviews far more useful.')
    );

    // ── prev / next
    const navBtn = (tr, dir) =>
      tr
        ? h(
            'a.td-nav-btn',
            { href: `#/trades/view/${tr.id}`, class: `is-${dir}`, dataset: { fk: `nav-${dir}` }, 'aria-label': `${dir === 'prev' ? 'Older' : 'Newer'} trade: ${tr.symbol}, ${when(tr.date)}` },
            dir === 'prev' ? icon('chevron-left', { size: 20 }) : null,
            h(
              'span.td-nav-text',
              h('span.td-nav-dir', dir === 'prev' ? 'Older' : 'Newer'),
              h('span.td-nav-sym', tr.symbol || '—'),
              h('span.td-nav-meta.num', { class: { 'text-profit': pnlTone(tradeNet(tr)) === 'profit', 'text-loss': pnlTone(tradeNet(tr)) === 'loss' } }, isClosed(tr) ? fmtTradeMoney(tradeNet(tr), { sign: true }) : 'Open')
            ),
            dir === 'next' ? icon('chevron-right', { size: 20 }) : null
          )
        : h('span.td-nav-btn.is-empty', { class: `is-${dir}`, 'aria-hidden': 'true' }, dir === 'prev' ? 'Oldest trade' : 'Latest trade');
    const nav = h('nav.td-nav', { 'aria-label': 'Previous and next trade' }, navBtn(neighbours.prev, 'prev'), navBtn(neighbours.next, 'next'));

    return [header, hero, h('div.td-grid', h('div.td-col', numbers, notes), h('div.td-col', psych, shots)), nav];
  }

  function openFor(t) {
    const d = diffDays(t.entryDate, todayKey());
    if (d <= 0) return t.entryTime ? `Since ${fmtTime(t.entryTime)}` : 'Opened today';
    return d === 1 ? 'Open 1 day' : `Open ${d} days`;
  }

  await draw();

  const refresh = debounce(draw, 60);
  const offs = [
    on('db:change', (e) => {
      if (e.store !== STORE && e.store !== '*') return;
      if (e.store === STORE && e.op === 'delete' && e.key === tradeId && !disposed) {
        navigate('/trades', { replace: true });
        return;
      }
      refresh();
    }),
    on('settings:change', refresh),
  ];
  const onKey = (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tg = e.target;
    if (tg && (tg.closest('input, textarea, select, [contenteditable="true"], .segmented, .rating, [role="radiogroup"]') || tg.isContentEditable)) return;
    if (document.querySelector('.sheet-layer, .lightbox, .popover, .menu')) return;
    const n = e.key === 'ArrowLeft' ? neighbours.prev : neighbours.next;
    if (!n || !current) return;
    e.preventDefault();
    navigate(`/trades/view/${n.id}`);
  };
  document.addEventListener('keydown', onKey);

  return () => {
    disposed = true;
    refresh.cancel();
    offs.forEach((off) => off());
    document.removeEventListener('keydown', onKey);
  };
}
