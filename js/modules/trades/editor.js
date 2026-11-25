// js/modules/trades/editor.js — trade add / edit / duplicate sheet (SPEC 4.6 "Editor").
//
// Choices beyond the spec (noted per SPEC preamble):
//   - New trades default to status 'closed' (journaling is mostly done after the fact) with a big Closed/Open
//     toggle. Switching to Open on today's date fills the entry time with "now".
//   - The last used market and account are remembered in localStorage. Typing a symbol you traded before fills
//     its market and multiplier (lot size) from your most recent trade of it (only fields you haven't touched).
//   - The live P&L preview is a sticky card at the bottom of the form, so it stays visible while you type.
//   - Risk shows money at risk, planned R:R, reward at target, % of account (when the account has a starting
//     balance) and a position-size suggestion for settings.trading.riskPercent.
//   - Optional sections (Advanced, Strategy, Psychology, Notes, Screenshots) are <details>; they open
//     automatically when they hold data (and Strategy is open by default) so long forms stay short on phones.
//   - opts.closeNow (used by "Close trade" on the detail page) switches an open trade to Closed with exit = now.
//   - Exports small shared helpers (sideBadge, marketLabel, accountsList, tradeTitle) used by index/detail.

import { db } from '../../core/db.js';
import { state } from '../../core/bus.js';
import { getSettings, updateSettings } from '../../core/settings.js';
import { todayKey, nowTime, fmtDate } from '../../core/dates.js';
import { fmtTradeMoney, fmtR, fmtPercent, fmtNumber, pnlTone, tradeCurrency } from '../../core/format.js';
import { h, openSheet, field, input, textarea, select, segmented, chips, tagInput, ratingInput, moneyInput, toast, confirmDialog, icon, badge, uniqueId, button } from '../../core/ui.js';
import { imagePicker, thumb, deleteImage } from '../../core/images.js';
import { removeWithUndo } from '../../core/undo.js';
import { navigate } from '../../core/router.js';
import {
  prepareTrade,
  tradeGross,
  tradeNet,
  tradeR,
  tradeRisk,
  plannedRR,
  potentialReward,
  tradeReturnPct,
  num,
  isClosed,
  MARKET_LABELS,
  TIMEFRAMES,
} from './calc.js';

const STORE = 'trades';
const LS_MARKET = 'daybook.trades.lastMarket';
const LS_ACCOUNT = 'daybook.trades.lastAccount';
const EPS = 1e-9;

// ───────────────────────────────────────────────────────────── shared helpers (also used by index/detail)

function lsGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k, v) {
  try {
    if (v) localStorage.setItem(k, v);
  } catch {
    /* private mode — ignore */
  }
}

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');

export function tradingSettings() {
  return getSettings().trading || {};
}

export function accountsList() {
  const a = tradingSettings().accounts;
  return Array.isArray(a) && a.length ? a : [{ id: 'main', name: 'Main account', startingBalance: 0 }];
}

export function marketLabel(m) {
  return MARKET_LABELS[m] || cap(m || '');
}

export function marketOptions() {
  const m = tradingSettings().markets;
  const list = Array.isArray(m) && m.length ? m : Object.keys(MARKET_LABELS);
  return list.map((v) => ({ value: v, label: marketLabel(v) }));
}

/** Long / Short badge (colour + arrow + word — never colour alone). */
export function sideBadge(t, { size } = {}) {
  const s = t && t.direction === 'short';
  return badge(s ? 'Short' : 'Long', s ? 'short' : 'long', { icon: s ? 'arrow-down-right' : 'arrow-up-right', size });
}

export function tradeTitle(t) {
  return `${t.symbol || '—'} · ${t.direction === 'short' ? 'Short' : 'Long'}`;
}

function listFrom(v) {
  return Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && x !== '') : [];
}

function numStr(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '' : String(v);
}

function blankTrade(date) {
  const today = todayKey();
  const accounts = accountsList();
  const lastAcc = lsGet(LS_ACCOUNT);
  const accountId = accounts.some((a) => a.id === lastAcc) ? lastAcc : tradingSettings().defaultAccountId || accounts[0].id;
  const markets = marketOptions().map((o) => o.value);
  const lastMarket = lsGet(LS_MARKET);
  return {
    accountId,
    symbol: '',
    market: markets.includes(lastMarket) ? lastMarket : markets.includes('stocks') ? 'stocks' : markets[0] || 'stocks',
    direction: 'long',
    status: 'closed',
    entryDate: date,
    entryTime: '',
    exitDate: date,
    exitTime: date === today ? nowTime() : '',
    entryPrice: null,
    exitPrice: null,
    quantity: null,
    multiplier: 1,
    fees: null,
    stopLoss: null,
    target: null,
    pnlOverride: null,
    setup: '',
    timeframe: '',
    confidence: null,
    rating: null,
    followedPlan: null,
    emotions: [],
    mistakes: [],
    tags: [],
    thesis: '',
    review: '',
    screenshots: [],
  };
}

// ───────────────────────────────────────────────────────────── the editor

/**
 * openTradeEditor(trade, { date, duplicateFrom, closeNow }) → Promise<saved trade | null>
 * trade = null → new. duplicateFrom = a trade to copy the instrument/setup/size from (new record, new date).
 */
export function openTradeEditor(trade = null, opts = {}) {
  const { date: optDate, duplicateFrom = null, closeNow = false } = opts || {};
  const isEdit = !!(trade && trade.id);
  const today = todayKey();
  const baseDate = optDate || state.date || today;

  let draft;
  if (isEdit) {
    draft = { ...blankTrade(trade.entryDate || baseDate), ...trade };
    for (const k of ['emotions', 'mistakes', 'tags', 'screenshots']) draft[k] = listFrom(trade[k]).slice();
    if (draft.fees === 0) draft.fees = null;
  } else if (duplicateFrom) {
    const src = duplicateFrom;
    draft = blankTrade(baseDate);
    for (const k of ['accountId', 'symbol', 'market', 'direction', 'setup', 'timeframe', 'quantity', 'multiplier']) {
      if (src[k] !== undefined && src[k] !== null && src[k] !== '') draft[k] = src[k];
    }
    draft.tags = listFrom(src.tags).slice();
  } else {
    draft = blankTrade(baseDate);
    if (trade && typeof trade === 'object') Object.assign(draft, trade); // optional prefill (no id)
  }
  if (closeNow && isEdit && draft.status !== 'closed') {
    draft.status = 'closed';
    draft.exitDate = today >= (draft.entryDate || today) ? today : draft.entryDate;
    draft.exitTime = nowTime();
  }
  if (!draft.exitDate) draft.exitDate = draft.entryDate;

  const originalShots = isEdit ? listFrom(trade.screenshots) : [];
  const addedShots = new Set(); // saved to the files store during this session
  const removedOriginals = new Set();
  const touched = { market: isEdit, multiplier: isEdit, exitDate: isEdit && !!trade.exitDate };
  const snapshot = () =>
    JSON.stringify({ ...draft, symbol: String(draft.symbol || '').trim().toUpperCase(), entryPrice: num(draft.entryPrice), exitPrice: num(draft.exitPrice), quantity: num(draft.quantity), stopLoss: num(draft.stopLoss), target: num(draft.target), fees: num(draft.fees) || 0, multiplier: num(draft.multiplier) || 1, pnlOverride: num(draft.pnlOverride) });
  const initial = snapshot();
  const isDirty = () => snapshot() !== initial;

  // History (loaded async): symbols datalist, last trade per symbol, account equity, past tags.
  const history = { bySymbol: new Map(), trades: [], loaded: false };
  const ts = tradingSettings();

  // ── Instrument ───────────────────────────────────────────────
  const dlId = uniqueId('symbols');
  const datalist = h('datalist', { id: dlId });
  const symIn = input({
    value: draft.symbol,
    placeholder: 'NIFTY, RELIANCE, AAPL…',
    autocomplete: 'off',
    autocapitalize: 'characters',
    autocorrect: 'off',
    spellcheck: false,
    enterkeyhint: 'next',
    list: dlId,
    class: 'te-symbol',
    onInput: (e) => {
      const el = e.target;
      const up = el.value.toUpperCase();
      if (up !== el.value) {
        const a = el.selectionStart;
        const b = el.selectionEnd;
        el.value = up;
        try {
          el.setSelectionRange(a, b);
        } catch {
          /* ignore */
        }
      }
      draft.symbol = up;
      symField.setError(null);
      if (history.bySymbol.has(up.trim())) applyHistory();
      else symField.setHint(null);
      update();
    },
    onChange: () => applyHistory(),
    onKeydown: (e) => {
      // Enter in the symbol field moves on (picking from the datalist must not submit a half-filled form).
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        entryIn.focus();
      }
    },
  });
  const symField = field('Symbol', symIn, { required: true });

  const dirSeg = segmented(
    [
      { value: 'long', label: 'Long', icon: 'arrow-up-right' },
      { value: 'short', label: 'Short', icon: 'arrow-down-right' },
    ],
    draft.direction,
    (v) => {
      draft.direction = v;
      dirSeg.dataset.dir = v;
      update();
    },
    { size: 'lg', block: true, ariaLabel: 'Direction', class: 'te-dir' }
  );
  dirSeg.dataset.dir = draft.direction;

  const marketChips = chips(
    marketOptions(),
    draft.market,
    (v) => {
      draft.market = v;
      touched.market = true;
      update();
    },
    { deselect: false, ariaLabel: 'Market', size: 'sm' }
  );

  const accounts = accountsList();
  const accountSel =
    accounts.length > 1 || (isEdit && !accounts.some((a) => a.id === draft.accountId))
      ? select(
          [...accounts.map((a) => ({ value: a.id, label: a.name || a.id })), ...(accounts.some((a) => a.id === draft.accountId) ? [] : [{ value: draft.accountId, label: draft.accountId }])],
          draft.accountId,
          (v) => {
            draft.accountId = v;
            update();
          }
        )
      : null;

  // ── Entry ────────────────────────────────────────────────────
  const entryDateIn = input({
    type: 'date',
    value: draft.entryDate || '',
    max: today,
    onChange: (e) => {
      draft.entryDate = e.target.value || draft.entryDate;
      if (!e.target.value) e.target.value = draft.entryDate;
      if (!touched.exitDate) {
        draft.exitDate = draft.entryDate;
        exitDateIn.value = draft.exitDate;
      }
      entryDateField.setError(null);
      exitDateField.setError(null);
      update();
    },
  });
  const entryDateField = field('Entry date', entryDateIn);
  const entryTimeIn = input({ type: 'time', value: draft.entryTime || '', onChange: (e) => { draft.entryTime = e.target.value; exitTimeField.setError(null); update(); } });
  const entryTimeField = field('Entry time', entryTimeIn);
  const entryIn = input({ type: 'number', min: '0', value: numStr(draft.entryPrice), placeholder: '0.00', autocomplete: 'off', onInput: (e) => { draft.entryPrice = num(e.target.value); entryField.setError(null); update(); } });
  const entryField = field('Entry price', entryIn, { required: true });
  const qtyIn = input({ type: 'number', min: '0', value: numStr(draft.quantity), placeholder: 'Shares, lots or units', autocomplete: 'off', onInput: (e) => { draft.quantity = num(e.target.value); qtyField.setError(null); update(); } });
  const qtyField = field('Quantity', qtyIn, { required: true });

  // ── Risk ─────────────────────────────────────────────────────
  const stopIn = input({ type: 'number', min: '0', value: numStr(draft.stopLoss), placeholder: 'Optional', autocomplete: 'off', onInput: (e) => { draft.stopLoss = num(e.target.value); stopField.setError(null); update(); } });
  const stopField = field('Stop loss', stopIn);
  const targetIn = input({ type: 'number', min: '0', value: numStr(draft.target), placeholder: 'Optional', autocomplete: 'off', onInput: (e) => { draft.target = num(e.target.value); targetField.setError(null); update(); } });
  const targetField = field('Target', targetIn);
  const riskInfo = h('div.te-risk', { 'aria-live': 'polite' });

  // ── Exit ─────────────────────────────────────────────────────
  const statusSeg = segmented(
    [
      { value: 'closed', label: 'Closed', icon: 'check-circle' },
      { value: 'open', label: 'Still open', icon: 'clock' },
    ],
    draft.status,
    (v) => {
      draft.status = v;
      if (v === 'open' && !draft.entryTime && draft.entryDate === today && !isEdit) {
        draft.entryTime = nowTime();
        entryTimeIn.value = draft.entryTime;
      }
      if (v === 'closed' && !draft.exitDate) {
        draft.exitDate = draft.entryDate && draft.entryDate > today ? draft.entryDate : isEdit ? today : draft.entryDate;
        exitDateIn.value = draft.exitDate;
      }
      if (v === 'closed' && isEdit && !draft.exitTime && draft.exitDate === today) {
        draft.exitTime = nowTime(); // closing an open position now, like "Close trade"
        exitTimeIn.value = draft.exitTime;
      }
      exitPriceField.setError(null);
      update();
    },
    { block: true, ariaLabel: 'Trade status', class: 'te-status' }
  );
  const exitDateIn = input({
    type: 'date',
    value: draft.exitDate || '',
    max: today,
    onChange: (e) => {
      draft.exitDate = e.target.value || draft.entryDate;
      if (!e.target.value) e.target.value = draft.exitDate;
      touched.exitDate = true;
      exitDateField.setError(null);
      update();
    },
  });
  const exitDateField = field('Exit date', exitDateIn);
  const exitTimeIn = input({ type: 'time', value: draft.exitTime || '', onChange: (e) => { draft.exitTime = e.target.value; exitTimeField.setError(null); update(); } });
  const exitTimeField = field('Exit time', exitTimeIn);
  const exitIn = input({ type: 'number', min: '0', value: numStr(draft.exitPrice), placeholder: '0.00', autocomplete: 'off', onInput: (e) => { draft.exitPrice = num(e.target.value); exitPriceField.setError(null); update(); } });
  const exitPriceField = field('Exit price', exitIn, { required: true });
  const feesIn = moneyInput(draft.fees, (v) => { draft.fees = v; feesField.setError(null); update(); }, { currency: tradeCurrency(), placeholder: '0' });
  const feesField = field('Fees & taxes', feesIn, { hint: 'Brokerage, taxes, exchange charges — total for the round trip' });
  const exitGrid = h('div.form-grid.te-pair.te-exit-grid', exitDateField, exitTimeField, exitPriceField, feesField);
  const openNote = h('p.te-note', icon('info', { size: 16 }), h('span', 'P&L is calculated when you close the trade. Open positions show on the Journal until then.'));

  // ── Advanced ─────────────────────────────────────────────────
  const multIn = input({
    type: 'number',
    min: '0',
    value: numStr(draft.multiplier === 1 ? null : draft.multiplier),
    placeholder: '1',
    autocomplete: 'off',
    onInput: (e) => {
      draft.multiplier = num(e.target.value) ?? 1;
      touched.multiplier = true;
      multField.setError(null);
      update();
    },
  });
  const multField = field('Multiplier', multIn, { hint: 'Lot size, contract size or point value. P&L = price move × qty × multiplier.' });
  const overrideIn = moneyInput(draft.pnlOverride, (v) => { draft.pnlOverride = v; exitPriceField.setError(null); update(); }, { currency: tradeCurrency(), min: null, placeholder: 'Calculated' });
  const overrideField = field('Net P&L override', overrideIn, { hint: 'For spreads or multi-leg options — replaces the calculated net P&L. Use a minus sign for a loss.' });

  // ── Strategy ─────────────────────────────────────────────────
  const setupChips = chips(
    listFrom(ts.setups),
    draft.setup || null,
    (v) => {
      draft.setup = v || '';
      update();
    },
    { allowAdd: true, addLabel: 'New setup', ariaLabel: 'Setup', onAdd: (text) => addToSettings('setups', text) }
  );
  const tfChips = chips(TIMEFRAMES, draft.timeframe || null, (v) => { draft.timeframe = v || ''; update(); }, { ariaLabel: 'Timeframe', size: 'sm' });
  const confRating = ratingInput(draft.confidence, (v) => { draft.confidence = v; update(); }, { ariaLabel: 'Confidence', labels: ['Unsure', 'Low', 'Moderate', 'High', 'Very high'] });
  const tagsIn = tagInput(draft.tags, (t) => { draft.tags = t; update(); }, { suggestions: listFrom(ts.tags), placeholder: 'Add tag (e.g. expiry, earnings)' });

  // ── Psychology ───────────────────────────────────────────────
  const emoChips = chips(listFrom(ts.emotions), draft.emotions, (v) => { draft.emotions = v; update(); }, { multiple: true, allowAdd: true, addLabel: 'Add', ariaLabel: 'Emotions', onAdd: (text) => addToSettings('emotions', text) });
  const mistakeChips = chips(listFrom(ts.mistakes), draft.mistakes, (v) => { draft.mistakes = v; update(); }, { multiple: true, allowAdd: true, addLabel: 'Add', ariaLabel: 'Mistakes', onAdd: (text) => addToSettings('mistakes', text), class: 'te-mistakes' });
  const planChips = chips(
    [
      { value: 'yes', label: 'Followed my plan', icon: 'check' },
      { value: 'no', label: 'Broke my plan', icon: 'x' },
    ],
    draft.followedPlan === true ? 'yes' : draft.followedPlan === false ? 'no' : null,
    (v) => {
      draft.followedPlan = v === 'yes' ? true : v === 'no' ? false : null;
      update();
    },
    { ariaLabel: 'Followed plan', class: 'te-plan' }
  );
  const execRating = ratingInput(draft.rating, (v) => { draft.rating = v; update(); }, { ariaLabel: 'Execution', labels: ['Poor', 'Sloppy', 'Okay', 'Good', 'Flawless'] });

  // ── Notes ────────────────────────────────────────────────────
  const thesisIn = textarea({ value: draft.thesis || '', rows: 3, placeholder: 'Why this trade? Setup, levels, catalyst, invalidation…', onInput: (e) => { draft.thesis = e.target.value; update(); } });
  const reviewIn = textarea({ value: draft.review || '', rows: 3, placeholder: 'What happened? What would you repeat or change?', onInput: (e) => { draft.review = e.target.value; update(); } });

  // ── Screenshots ──────────────────────────────────────────────
  const thumbsEl = h('div.thumbs.te-thumbs');
  function renderThumbs() {
    const ids = draft.screenshots;
    thumbsEl.replaceChildren(
      ...ids.map((id, i) =>
        thumb(id, {
          size: 88,
          ids,
          index: i,
          alt: `Screenshot ${i + 1}`,
          label: `Open screenshot ${i + 1}`,
          onRemove: (rid) => {
            draft.screenshots = draft.screenshots.filter((x) => x !== rid);
            if (addedShots.has(rid)) {
              addedShots.delete(rid);
              deleteImage(rid).catch(() => {});
            } else {
              removedOriginals.add(rid);
            }
            renderThumbs();
            update();
          },
        })
      )
    );
    thumbsEl.hidden = ids.length === 0;
  }
  const picker = imagePicker({
    label: 'Add screenshots',
    icon: 'image',
    multiple: true,
    onAdd: (id) => {
      addedShots.add(id);
      draft.screenshots = [...draft.screenshots, id];
      renderThumbs();
      update();
    },
  });
  renderThumbs();

  // ── Sections ─────────────────────────────────────────────────
  const sumEls = {};
  function details(key, title, iconName, open, ...kids) {
    const sum = h('span.te-sum');
    sumEls[key] = sum;
    return h(
      'details.te-section.te-collapsible',
      { open, dataset: { sec: key } },
      h('summary.te-summary', h('span.te-sec-icon', icon(iconName, { size: 18 })), h('span.te-sec-title', title), sum, icon('chevron-down', { size: 18, class: 'te-chev' })),
      h('div.te-sec-body', kids)
    );
  }
  function sectionBlock(title, iconName, ...kids) {
    return h('section.te-section', h('h3.te-sec-head', h('span.te-sec-icon', icon(iconName, { size: 18 })), h('span.te-sec-title', title)), h('div.te-sec-body', kids));
  }

  const hasAdvanced = (num(draft.multiplier) || 1) !== 1 || num(draft.pnlOverride) !== null || ['options', 'futures', 'commodities'].includes(draft.market) && isEdit;
  const hasPsych = draft.emotions.length || draft.mistakes.length || draft.followedPlan !== null || draft.rating;
  const hasNotes = !!(draft.thesis || draft.review);

  const advanced = details('advanced', 'Advanced', 'sliders', !!hasAdvanced, h('div.form-grid', multField, overrideField));
  const psych = details(
    'psych',
    'Psychology',
    'brain',
    !!hasPsych,
    field('Emotions', emoChips),
    field('Mistakes', mistakeChips),
    h('div.form-grid', field('Plan', planChips), field('Execution', execRating))
  );
  const notes = details('notes', 'Notes', 'note', hasNotes || isEdit, field('Thesis', thesisIn), field('Review', reviewIn));
  const shots = details('shots', 'Screenshots', 'image', draft.screenshots.length > 0, h('div.te-shots', thumbsEl, picker));
  const strategy = details('strategy', 'Strategy', 'target', true, field('Setup', setupChips), h('div.form-grid', field('Timeframe', tfChips), field('Confidence', confRating)), field('Tags', tagsIn));

  // ── Live P&L preview (sticky) ────────────────────────────────
  const live = h('div.te-live', { 'aria-live': 'polite', 'aria-atomic': 'true', role: 'status' });

  const qtyHint = (mult) => (mult !== 1 ? `× ${fmtNumber(mult, { maxDecimals: 6 })} multiplier` : null);

  const form = h(
    'form.te-form',
    { autocomplete: 'off' },
    datalist,
    sectionBlock(
      'Instrument',
      'candlestick',
      h('div.form-grid.te-inst-grid', symField, field('Direction', dirSeg)),
      field('Market', marketChips),
      accountSel ? field('Account', accountSel) : null
    ),
    sectionBlock('Entry', 'arrow-right', h('div.form-grid.te-pair', entryDateField, entryTimeField, entryField, qtyField)),
    sectionBlock('Risk', 'shield', h('div.form-grid.te-pair', stopField, targetField), riskInfo),
    sectionBlock('Exit', 'flag', statusSeg, exitGrid, openNote),
    advanced,
    strategy,
    psych,
    notes,
    shots,
    live
  );

  // ── live updates ─────────────────────────────────────────────
  function accountEquity() {
    const acc = accounts.find((a) => a.id === draft.accountId);
    const start = num(acc && acc.startingBalance) || 0;
    if (start <= 0) return null;
    let net = 0;
    for (const t of history.trades) {
      if ((t.accountId || 'main') !== draft.accountId || (isEdit && t.id === trade.id)) continue;
      net += tradeNet(t) || 0;
    }
    return start + net;
  }

  function stat(label, value, tone, sub) {
    return h('div.te-mini', h('span.te-mini-label', label), h('span.te-mini-value.num', { class: { 'text-profit': tone === 'profit', 'text-loss': tone === 'loss' } }, value), sub ? h('span.te-mini-sub', sub) : null);
  }
  function warn(text) {
    return h('p.te-warn', icon('alert', { size: 15 }), h('span', text));
  }

  function renderRisk(p) {
    const e = num(p.entryPrice);
    const s = num(p.stopLoss);
    const tg = num(p.target);
    const dir = p.direction === 'short' ? -1 : 1;
    const side = p.direction === 'short' ? 'short' : 'long';
    const kids = [];
    const warnings = [];
    if (e !== null && s !== null && (e - s) * dir <= EPS) warnings.push(`For a ${side}, the stop goes ${dir > 0 ? 'below' : 'above'} the entry.`);
    if (e !== null && tg !== null && (tg - e) * dir <= EPS) warnings.push(`For a ${side}, the target goes ${dir > 0 ? 'above' : 'below'} the entry.`);
    const risk = tradeRisk(p);
    const rr = plannedRR(p);
    const reward = potentialReward(p);
    if (risk !== null || rr !== null || reward !== null) {
      const eq = accountEquity();
      const pct = risk !== null && eq ? risk / eq : null;
      kids.push(
        h(
          'div.te-minis',
          stat('At risk', risk !== null ? fmtTradeMoney(risk) : '—', risk !== null ? 'loss' : null, pct !== null ? `${fmtPercent(pct, { decimals: 2 })} of account` : null),
          stat('Planned R:R', rr !== null ? `1 : ${fmtNumber(rr, { maxDecimals: 2 })}` : '—'),
          stat('Reward at target', reward !== null ? fmtTradeMoney(reward, { sign: true }) : '—', reward !== null ? 'profit' : null)
        )
      );
      const rp = num(tradingSettings().riskPercent);
      if (pct !== null && rp && pct > rp / 100 + 1e-6) warnings.push(`That’s above your ${fmtNumber(rp, { maxDecimals: 2 })}% risk-per-trade rule.`);
      // Position-size suggestion for the risk rule
      if (eq && rp && e !== null && s !== null && (e - s) * dir > EPS) {
        const mult = num(p.multiplier) || 1;
        const size = Math.floor((eq * rp) / 100 / ((e - s) * dir * mult));
        const q = num(p.quantity);
        if (size > 0 && size !== q) {
          kids.push(
            h(
              'p.te-size',
              icon('scale', { size: 15 }),
              h('span', `${fmtNumber(rp, { maxDecimals: 2 })}% risk ≈ ${fmtNumber(size)} qty`),
              button({
                label: 'Use',
                size: 'sm',
                variant: 'ghost',
                class: 'te-size-btn',
                ariaLabel: `Use quantity ${size}`,
                onClick: () => {
                  draft.quantity = size;
                  qtyIn.value = String(size);
                  qtyField.setError(null);
                  update();
                },
              })
            )
          );
        }
      }
    } else if (e !== null && num(p.quantity) !== null && s === null) {
      kids.push(h('p.te-hint', 'Add a stop to see your risk and R-multiple.'));
    }
    kids.push(...warnings.map(warn));
    riskInfo.replaceChildren(...kids);
    riskInfo.hidden = kids.length === 0;
  }

  function renderLive(p) {
    const closed = isClosed(p);
    if (!closed) {
      const risk = tradeRisk(p);
      const reward = potentialReward(p);
      const rr = plannedRR(p);
      live.dataset.tone = 'open';
      live.replaceChildren(
        h('div.te-live-main', h('span.te-live-label', badge('Open', 'open', { dot: true }), 'position'), h('span.te-live-value.num', risk !== null ? `${fmtTradeMoney(-risk, { sign: true })} at stop` : 'No stop set')),
        h('div.te-live-chips', reward !== null ? h('span.te-live-chip.text-profit', `${fmtTradeMoney(reward, { sign: true })} at target`) : null, rr !== null ? h('span.te-live-chip', `R:R 1 : ${fmtNumber(rr, { maxDecimals: 2 })}`) : null)
      );
      return;
    }
    const net = tradeNet(p);
    if (net === null) {
      live.dataset.tone = 'empty';
      live.replaceChildren(h('div.te-live-main', h('span.te-live-label', icon('activity', { size: 16 }), 'Live P&L'), h('span.te-live-empty', 'Enter entry, quantity and exit to see your P&L')));
      return;
    }
    const tone = pnlTone(net);
    const gross = tradeGross(p);
    const r = tradeR(p);
    const ret = tradeReturnPct(p);
    const overridden = num(p.pnlOverride) !== null;
    live.dataset.tone = tone;
    live.replaceChildren(
      h(
        'div.te-live-main',
        h('span.te-live-label', icon(tone === 'loss' ? 'trending-down' : 'trending-up', { size: 16 }), overridden ? 'Net P&L (override)' : 'Net P&L'),
        h('span.te-live-value.num', { class: { 'text-profit': tone === 'profit', 'text-loss': tone === 'loss' }, dataset: { testid: 'live-net' } }, fmtTradeMoney(net, { sign: true }))
      ),
      h(
        'div.te-live-chips',
        h('span.te-live-chip.num', { dataset: { testid: 'live-r' }, title: r === null ? 'Add a stop loss to get R' : 'R-multiple (net ÷ initial risk)' }, r === null ? 'R —' : fmtR(r, { decimals: 2 })),
        h('span.te-live-chip.num', { dataset: { testid: 'live-ret' }, title: 'Return on position value' }, fmtPercent(ret, { decimals: 2, sign: true }))
      ),
      h(
        'div.te-live-break.num',
        h('span', 'Gross ', h('b', { dataset: { testid: 'live-gross' } }, overridden && gross === null ? '—' : fmtTradeMoney(gross, { sign: true }))),
        h('span', 'Fees ', h('b', { dataset: { testid: 'live-fees' } }, overridden ? 'incl.' : fmtTradeMoney(num(p.fees) || 0)))
      )
    );
  }

  function updateSummaries() {
    const n = (arr) => (arr && arr.length ? arr.length : 0);
    const mult = num(draft.multiplier) || 1;
    sumEls.advanced.textContent = [mult !== 1 ? `× ${fmtNumber(mult, { maxDecimals: 6 })}` : null, num(draft.pnlOverride) !== null ? 'P&L override' : null].filter(Boolean).join(' · ') || 'Multiplier, P&L override';
    sumEls.strategy.textContent = [draft.setup, draft.timeframe, draft.confidence ? `${draft.confidence}★` : null, n(draft.tags) ? `${n(draft.tags)} tag${n(draft.tags) > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ') || 'Setup, timeframe, confidence';
    sumEls.psych.textContent =
      [n(draft.emotions) ? draft.emotions.slice(0, 2).join(', ') + (n(draft.emotions) > 2 ? '…' : '') : null, n(draft.mistakes) ? `${n(draft.mistakes)} mistake${n(draft.mistakes) > 1 ? 's' : ''}` : null, draft.followedPlan === true ? 'Plan ✓' : draft.followedPlan === false ? 'Plan ✗' : null]
        .filter(Boolean)
        .join(' · ') || 'Emotions, mistakes, execution';
    sumEls.notes.textContent = [draft.thesis ? 'Thesis' : null, draft.review ? 'Review' : null].filter(Boolean).join(' · ') || 'Thesis & review';
    sumEls.shots.textContent = draft.screenshots.length ? `${draft.screenshots.length} attached` : 'Charts before & after';
  }

  function update() {
    const p = prepareTrade(draft);
    const closed = draft.status === 'closed';
    exitGrid.hidden = !closed;
    openNote.hidden = closed;
    statusSeg.dataset.status = draft.status;
    qtyField.setHint(qtyHint(num(draft.multiplier) || 1));
    renderRisk(p);
    renderLive(p);
    updateSummaries();
  }

  // ── history (async) ──────────────────────────────────────────
  function applyHistory() {
    if (isEdit) return;
    const sym = String(draft.symbol || '').trim();
    const last = history.bySymbol.get(sym);
    if (!last) {
      symField.setHint(null);
      return;
    }
    const filled = [];
    if (!touched.market && last.market && last.market !== draft.market) {
      draft.market = last.market;
      marketChips.setValue(last.market);
      filled.push('market');
    }
    const lm = num(last.multiplier) || 1;
    if (!touched.multiplier && lm !== (num(draft.multiplier) || 1)) {
      draft.multiplier = lm;
      multIn.value = lm === 1 ? '' : String(lm);
      filled.push('multiplier');
    }
    symField.setHint(filled.length ? `Filled ${filled.join(' & ')} from your last ${sym} trade` : null);
    update();
  }

  db.all(STORE)
    .then((all) => {
      history.trades = all;
      history.loaded = true;
      const latest = [...all].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      for (const t of latest) {
        const s = String(t.symbol || '').trim();
        if (s && !history.bySymbol.has(s)) history.bySymbol.set(s, t);
      }
      datalist.replaceChildren(...[...history.bySymbol.keys()].slice(0, 300).map((s) => h('option', { value: s })));
      const tagPool = new Set(listFrom(tradingSettings().tags));
      for (const t of latest) for (const g of listFrom(t.tags)) tagPool.add(g);
      // tagInput has no setSuggestions(); rebuild it in place with the richer pool (keeps current tags).
      const fresh = tagInput(draft.tags, (tg) => { draft.tags = tg; update(); }, { suggestions: [...tagPool], placeholder: 'Add tag (e.g. expiry, earnings)' });
      const focused = tagsIn.contains(document.activeElement);
      if (!focused && tagsIn.isConnected) {
        tagsIn.replaceWith(fresh);
      }
      update();
    })
    .catch((err) => console.warn('[daybook] trade history unavailable', err));

  // ── validation ───────────────────────────────────────────────
  function validate() {
    const all = [symField, entryField, qtyField, entryDateField, stopField, targetField, exitPriceField, exitDateField, exitTimeField, feesField, multField];
    all.forEach((f) => f.setError(null));
    const errors = [];
    const fail = (f, msg, el) => {
      f.setError(msg);
      errors.push(el || f.input);
    };
    if (!String(draft.symbol || '').trim()) fail(symField, 'Add a symbol — e.g. NIFTY or AAPL', symIn);
    if (!draft.entryDate) fail(entryDateField, 'Pick the entry date', entryDateIn);
    else if (draft.entryDate > today) fail(entryDateField, 'Entry can’t be in the future', entryDateIn);
    const e = num(draft.entryPrice);
    if (e === null) fail(entryField, 'Entry price is required', entryIn);
    else if (e <= 0) fail(entryField, 'Must be more than 0', entryIn);
    const q = num(draft.quantity);
    if (q === null) fail(qtyField, 'How many shares, lots or units?', qtyIn);
    else if (q <= 0) fail(qtyField, 'Must be more than 0', qtyIn);
    if (num(draft.stopLoss) !== null && num(draft.stopLoss) < 0) fail(stopField, 'Can’t be negative', stopIn);
    if (num(draft.target) !== null && num(draft.target) < 0) fail(targetField, 'Can’t be negative', targetIn);
    const m = num(multIn.value);
    if (multIn.value !== '' && (m === null || m <= 0)) fail(multField, 'Must be more than 0', multIn);
    if (draft.status === 'closed') {
      const x = num(draft.exitPrice);
      const ov = num(draft.pnlOverride);
      if (x === null && ov === null) fail(exitPriceField, 'Add the exit price — or switch to “Still open”', exitIn);
      else if (x !== null && x < 0) fail(exitPriceField, 'Can’t be negative', exitIn);
      if (draft.exitDate && draft.entryDate && draft.exitDate < draft.entryDate) fail(exitDateField, 'Exit can’t be before entry', exitDateIn);
      else if (draft.exitDate && draft.exitDate > today) fail(exitDateField, 'Exit can’t be in the future', exitDateIn);
      else if ((draft.exitDate || draft.entryDate) === draft.entryDate && draft.entryTime && draft.exitTime && draft.exitTime < draft.entryTime) fail(exitTimeField, 'Exit is before the entry time', exitTimeIn);
      const f = num(draft.fees);
      if (f !== null && f < 0) fail(feesField, 'Fees can’t be negative', feesIn.input);
    }
    if (errors.length) {
      const first = errors[0];
      const d = first.closest('details');
      if (d) d.open = true;
      try {
        first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch {
        first.scrollIntoView();
      }
      first.focus({ preventScroll: true });
      return false;
    }
    return true;
  }

  async function confirmDiscard() {
    if (!isDirty()) return true;
    return confirmDialog({ title: 'Discard changes?', message: isEdit ? 'Your edits to this trade won’t be saved.' : 'This trade hasn’t been saved yet.', confirmLabel: 'Discard', cancelLabel: 'Keep editing' });
  }

  async function save() {
    if (!validate()) return false;
    const base = isEdit ? { ...trade } : {};
    const rec = prepareTrade({ ...base, ...draft, multiplier: num(draft.multiplier) || 1, symbol: String(draft.symbol).trim().toUpperCase() });
    if (!isEdit) delete rec.id;
    const saved = await db.put(STORE, rec);
    lsSet(LS_MARKET, saved.market);
    lsSet(LS_ACCOUNT, saved.accountId);
    addedShots.clear(); // now owned by the record
    for (const id of removedOriginals) deleteImage(id).catch(() => {});
    const net = tradeNet(saved);
    const msg = isEdit ? 'Trade updated' : saved.status === 'open' ? `${saved.symbol} logged as open` : `${saved.symbol} saved · ${fmtTradeMoney(net, { sign: true })}`;
    const onDetail = (location.hash || '').includes(`/trades/view/${saved.id}`);
    toast(msg, { type: 'success', action: onDetail || duplicateFrom ? null : { label: 'View', onClick: () => navigate(`/trades/view/${saved.id}`) } });
    return saved;
  }

  const title = isEdit ? 'Edit trade' : duplicateFrom ? 'Duplicate trade' : 'Log a trade';
  const subtitle = isEdit
    ? `${trade.symbol || ''} · ${fmtDate(trade.entryDate, 'medium')}`
    : duplicateFrom
      ? `Copy of ${duplicateFrom.symbol || 'trade'} — new prices & date`
      : 'Entry, risk and exit — the math is automatic';

  const sheet = openSheet({
    title,
    subtitle,
    icon: 'trades',
    accent: '--trades',
    size: 'lg',
    className: 'trade-editor',
    content: form,
    guard: () => confirmDiscard(),
    initialFocus: closeNow ? exitIn : isEdit ? null : duplicateFrom ? entryIn : symIn,
    onClose: () => {
      // Screenshots picked in a cancelled (or deleted) session are orphans — remove them.
      for (const id of addedShots) deleteImage(id).catch(() => {});
      addedShots.clear();
    },
    actions: [
      isEdit && {
        label: 'Delete',
        variant: 'danger',
        icon: 'trash',
        onClick: async () => {
          await removeWithUndo(STORE, trade, { label: `${trade.symbol || 'Trade'} deleted`, files: listFrom(trade.screenshots) });
          return null;
        },
      },
      {
        label: 'Cancel',
        variant: 'secondary',
        onClick: async () => ((await confirmDiscard()) ? null : false),
      },
      { label: isEdit ? 'Save changes' : 'Save trade', variant: 'primary', icon: 'check', onClick: () => save() },
    ].filter(Boolean),
  });

  update();
  if (closeNow) {
    requestAnimationFrame(() => {
      try {
        exitIn.scrollIntoView({ block: 'center' });
      } catch {
        /* ignore */
      }
    });
  }
  return sheet.result;
}

/** Adds a value to settings.trading[key] (arrays replace, so send the whole list). → the value, or false. */
async function addToSettings(key, text) {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  if (!value) return false;
  const list = listFrom(tradingSettings()[key]);
  if (list.some((x) => String(x).toLowerCase() === value.toLowerCase())) return value;
  await updateSettings({ trading: { [key]: [...list, value] } });
  return value;
}
