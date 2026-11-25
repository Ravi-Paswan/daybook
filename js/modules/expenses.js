// js/modules/expenses.js — Expenses & income (SPEC 4.5).
// Choices not fixed by the spec:
// - The month can be deep-linked as #/expenses/YYYY-MM (the URL follows the month picker silently).
// - Deltas on the current month compare against the same days of the previous month ("so far"), so a
//   half-finished month is never compared with a complete one. Past months compare full months.
// - Phones get a "Transactions | Insights" switch so the list stays the first thing you see; desktop shows both.
// - In the editor, Enter on an already-selected category/method chip saves (fast keyboard flow:
//   amount → pick category → Enter). Ctrl/Cmd+Enter saves from anywhere in the form.
// - Typing a note you've used before fills in its category (and method/amount when still empty).
// - `#/expenses?new=1&type=income` opens the editor preset to income.
// - Filters and the phone view tab persist for the session (sessionStorage).
import { db } from '../core/db.js';
import { on, state } from '../core/bus.js';
import { getSettings, moneyCategory } from '../core/settings.js';
import {
  todayKey, nowTime, fmtTime, relativeDay, currentMonth, addMonths, monthRange, monthOf, daysInMonth, fmtMonth,
  fmtDate, isValidKey, rangeKeys, endOfMonth,
} from '../core/dates.js';
import { fmtMoney, fmtPercent, plural, pnlTone } from '../core/format.js';
import {
  h, mount, pageHeader, emptyState, openSheet, field, input, segmented, chips, tagInput, moneyInput, monthNav,
  statTile, progressBar, iconChip, listItem, listGroupHeader, toast, debounce, confirmDialog, icon, button,
  skeleton, uniqueId,
} from '../core/ui.js';
import { donutChart, barChart } from '../core/charts.js';
import { exportCSV, downloadText } from '../core/backup.js';
import { removeWithUndo } from '../core/undo.js';

const ID = 'expenses';
const TITLE = 'Expenses';
const ICON = 'expenses';
const COLOR = '--expenses';
const STORE = 'expenses';
const PAGE_ROWS = 60; // transactions rendered before "Show more"
const LS_METHOD = 'daybook:expenses:method:'; // + type
const SS_FILTER = 'daybook:expenses:filter';
const SS_VIEW = 'daybook:expenses:view';
const SS_DAILY = 'daybook:expenses:daily';

// ─────────────────────────────────────────────────────────────── helpers

const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v) => Math.round(v * 100) / 100;
const lc = (s) => String(s ?? '').toLowerCase();

function store(kind) {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}
function readJSON(kind, key, fallback) {
  try {
    const raw = store(kind)?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(kind, key, value) {
  try {
    store(kind)?.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — not important */
  }
}

function catOf(r) {
  return moneyCategory(r.type === 'income' ? 'income' : 'expense', r.category);
}

function categoryList(type) {
  const s = getSettings();
  const list = type === 'income' ? s.incomeCategories : s.expenseCategories;
  return Array.isArray(list) ? list.filter((c) => c && c.id) : [];
}

function methodList() {
  const m = getSettings().paymentMethods;
  return Array.isArray(m) ? m.filter((x) => typeof x === 'string' && x.trim()) : [];
}

function lastMethod(type) {
  const methods = methodList();
  const saved = readJSON('local', LS_METHOD + type, null);
  if (saved && methods.includes(saved)) return saved;
  return null;
}

/** Amount as shown in lists: income '+₹1,200' (profit colour), expense '₹250'. */
function amountText(r) {
  return r.type === 'income' ? fmtMoney(r.amount, { sign: true }) : fmtMoney(r.amount);
}

function rowTitle(r) {
  return (r.note && r.note.trim()) || catOf(r).name;
}

/** Ratio change, or undefined when there is no baseline. */
function change(cur, prev) {
  if (!(prev > 0)) return undefined;
  return (cur - prev) / prev;
}

// ─────────────────────────────────────────────────────────────── editor

/** Recent notes (newest first, unique) + tag counts, for the datalist / autofill / tag suggestions. */
async function loadRecent() {
  const all = await db.all(STORE);
  const notes = new Map();
  const tags = new Map();
  for (let i = all.length - 1; i >= 0; i--) {
    const r = all[i];
    const note = (r.note || '').trim();
    if (note) {
      const k = `${r.type === 'income' ? 'income' : 'expense'}|${lc(note)}`;
      if (!notes.has(k)) notes.set(k, { note, type: r.type === 'income' ? 'income' : 'expense', category: r.category, method: r.method, amount: r.amount });
    }
    for (const t of Array.isArray(r.tags) ? r.tags : []) tags.set(t, (tags.get(t) || 0) + 1);
  }
  return {
    notes: [...notes.values()],
    tags: [...tags.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 30),
  };
}

/**
 * Add/edit sheet. record=null → new. opts = {date, type: 'expense'|'income'}.
 * Resolves to the last saved record, or null when cancelled/deleted.
 */
function openEditor(record = null, opts = {}) {
  let original = record && record.id ? record : null;
  let isNew = !original;
  let lastSaved = null;
  let dirty = false;

  const startType = (record && record.type) || (opts && opts.type) || 'expense';
  const startDate = (record && record.date) || (opts && opts.date) || state.date || todayKey();

  const freshDraft = (type, date, method) => ({
    type: type === 'income' ? 'income' : 'expense',
    amount: null,
    category: null,
    method: method !== undefined ? method : lastMethod(type),
    note: '',
    tags: [],
    date,
    time: date === todayKey() ? nowTime() : '',
  });

  let draft = original
    ? { ...original, type: original.type === 'income' ? 'income' : 'expense', amount: original.amount ?? null, tags: [...(original.tags || [])], note: original.note || '', method: original.method || null, time: original.time || '' }
    : { ...freshDraft(startType, startDate), ...(record && !record.id ? record : {}) };

  let recent = { notes: [], tags: [] };
  const datalistId = uniqueId('exp-notes');
  const datalist = h('datalist', { id: datalistId });
  const recentReady = loadRecent()
    .then((r) => {
      recent = r;
      fillDatalist();
      refs && refs.tags && refs.tagsSuggest(r.tags);
    })
    .catch(() => {});

  function fillDatalist() {
    datalist.replaceChildren(...recent.notes.filter((n) => n.type === draft.type).slice(0, 60).map((n) => h('option', { value: n.note })));
  }

  const titleFor = () => (isNew ? (draft.type === 'income' ? 'Add income' : 'Add expense') : draft.type === 'income' ? 'Edit income' : 'Edit expense');

  let refs = null;

  function catOptions(type, selected) {
    const list = categoryList(type).map((c) => ({ value: c.id, label: c.name, emoji: c.emoji, color: c.color }));
    if (selected && !list.some((o) => o.value === selected)) {
      const c = moneyCategory(type, selected);
      list.push({ value: selected, label: c.missing ? `${c.name} (${selected})` : c.name, emoji: c.emoji, color: c.color });
    }
    return list;
  }

  function buildForm() {
    const typeSeg = segmented(
      [
        { value: 'expense', label: 'Expense', icon: 'expenses' },
        { value: 'income', label: 'Income', icon: 'income' },
      ],
      draft.type,
      (t) => {
        draft.type = t;
        dirty = true;
        const keep = categoryList(t).some((c) => c.id === draft.category) ? draft.category : null;
        draft.category = keep;
        catChips.setOptions(catOptions(t, keep), keep);
        if (!methodTouched) {
          draft.method = lastMethod(t) ?? draft.method;
          methodChips && methodChips.setValue(draft.method);
        }
        catField.setError(null);
        fillDatalist();
        sheet.setTitle(titleFor());
        form.classList.toggle('is-income', t === 'income');
      },
      { block: true, ariaLabel: 'Type' }
    );

    const amount = moneyInput(
      draft.amount,
      (v) => {
        draft.amount = v;
        dirty = true;
        amountField.setError(null);
      },
      { size: 'lg', enterkeyhint: 'done', max: '1000000000000' }
    );
    const amountField = field('Amount', amount, { required: true });

    const catChips = chips(
      catOptions(draft.type, draft.category),
      draft.category,
      (v) => {
        draft.category = v;
        dirty = true;
        catField.setError(null);
        if (!(draft.amount > 0)) amount.input.focus();
      },
      { deselect: false, ariaLabel: 'Category', class: 'expenses-cat-grid' }
    );
    const catField = field('Category', catChips, { required: true });

    let methodTouched = !isNew;
    const methods = methodList();
    const methodChips = methods.length
      ? chips(methods, draft.method, (v) => {
          draft.method = v;
          methodTouched = true;
          dirty = true;
        }, { ariaLabel: 'Payment method' })
      : null;

    const noteIn = input({
      value: draft.note,
      placeholder: draft.type === 'income' ? 'e.g. November salary' : 'e.g. Lunch with team',
      list: datalistId,
      autocomplete: 'off',
      enterkeyhint: 'done',
      maxlength: 200,
      onInput: (e) => {
        draft.note = e.target.value;
        dirty = true;
      },
      onChange: (e) => autofill(e.target.value),
    });

    const tags = tagInput(draft.tags, (t) => {
      draft.tags = t;
      dirty = true;
    }, { suggestions: recent.tags, placeholder: 'Add tag' });

    const dateIn = input({
      type: 'date',
      value: draft.date,
      max: todayKey(),
      required: true,
      onChange: (e) => {
        const v = e.target.value;
        draft.date = isValidKey(v) ? v : draft.date;
        if (!isValidKey(v)) e.target.value = draft.date;
        dirty = true;
      },
    });
    const timeIn = input({
      type: 'time',
      value: draft.time,
      onChange: (e) => {
        draft.time = e.target.value;
        dirty = true;
      },
    });

    function autofill(text) {
      const k = lc(String(text || '').trim());
      if (!k) return;
      const hit = recent.notes.find((n) => n.type === draft.type && lc(n.note) === k);
      if (!hit) return;
      if (!draft.category && hit.category) {
        draft.category = hit.category;
        catChips.setOptions(catOptions(draft.type, hit.category), hit.category);
        catField.setError(null);
      }
      if (!methodTouched && hit.method && methodChips && methods.includes(hit.method)) {
        draft.method = hit.method;
        methodChips.setValue(hit.method);
      }
      if (!(draft.amount > 0) && hit.amount > 0) {
        draft.amount = hit.amount;
        amount.setValue(hit.amount);
        amountField.setError(null);
      }
    }

    const form = h(
      'form.stack.expenses-form',
      {
        class: { 'is-income': draft.type === 'income' },
        onKeydown: (e) => {
          if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented) return;
          const t = e.target;
          if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            form.requestSubmit ? form.requestSubmit() : sheet.submit();
            return;
          }
          // Enter on an already-selected category/method chip saves instead of toggling it.
          if (t && t.classList && t.classList.contains('chip') && t.getAttribute('aria-pressed') === 'true' && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            form.requestSubmit ? form.requestSubmit() : sheet.submit();
          }
        },
      },
      typeSeg,
      amountField,
      catField,
      methodChips ? field('Paid with', methodChips) : null,
      field('Note', noteIn, { aside: 'optional' }),
      datalist,
      field('Tags', tags),
      h('div.form-grid', field('Date', dateIn), field('Time', timeIn))
    );
    form.noValidate = true;

    refs = {
      form, amount, amountField, catField, catChips, dateIn, dateField: null,
      tags,
      tagsSuggest: (list) => {
        // tagInput has no setSuggestions(): rebuild it with the same tags when suggestions arrive.
        const fresh = tagInput(draft.tags, (t) => {
          draft.tags = t;
          dirty = true;
        }, { suggestions: list, placeholder: 'Add tag' });
        const had = document.activeElement === refs.tags.input;
        fresh.input.value = refs.tags.input.value;
        refs.tags.replaceWith(fresh);
        refs.tags = fresh;
        if (had) fresh.input.focus();
      },
    };
    return form;
  }

  function validate() {
    let first = null;
    if (!(draft.amount > 0)) {
      refs.amountField.setError(draft.amount === null ? 'Enter an amount' : 'Amount must be more than zero');
      first = first || refs.amount.input;
    } else if (draft.amount > 1e12) {
      refs.amountField.setError('That amount looks too large');
      first = first || refs.amount.input;
    }
    if (!draft.category) {
      refs.catField.setError('Pick a category');
      first = first || refs.catChips.querySelector('.chip');
    }
    if (first) {
      first.focus();
      return false;
    }
    return true;
  }

  async function save() {
    if (!validate()) return null;
    const rec = {
      ...(original || {}),
      type: draft.type,
      amount: round2(draft.amount),
      category: draft.category,
      method: draft.method || '',
      note: (draft.note || '').trim(),
      tags: [...(draft.tags || [])],
      date: isValidKey(draft.date) ? draft.date : todayKey(),
      time: draft.time || '',
    };
    const saved = await db.put(STORE, rec);
    if (rec.method) writeJSON('local', LS_METHOD + rec.type, rec.method);
    const c = catOf(saved);
    toast(`Saved · ${amountText(saved)} ${c.emoji || ''} ${c.name}`.replace(/\s+/g, ' ').trim(), { type: 'success' });
    lastSaved = saved;
    dirty = false;
    return saved;
  }

  function resetForNext() {
    const keepType = draft.type;
    const keepDate = draft.date;
    const keepMethod = draft.method;
    original = null;
    isNew = true;
    draft = freshDraft(keepType, keepDate, keepMethod ?? undefined);
    if (keepDate !== todayKey()) draft.time = '';
    dirty = false;
    sheet.setTitle(titleFor());
    sheet.setActions(actions());
    sheet.body.replaceChildren(buildForm());
    fillDatalist();
    sheet.body.scrollTop = 0;
    requestAnimationFrame(() => refs.amount.input.focus());
  }

  function actions() {
    return [
      !isNew && {
        label: 'Delete',
        variant: 'danger',
        icon: 'trash',
        onClick: async () => {
          await removeWithUndo(STORE, original, { label: original.type === 'income' ? 'Income deleted' : 'Expense deleted' });
          lastSaved = null;
          return null;
        },
      },
      { label: 'Cancel', variant: 'secondary', id: 'cancel' },
      {
        label: 'Save & add another',
        variant: 'secondary',
        id: 'save-another',
        class: 'expenses-save-another',
        onClick: async () => {
          const s = await save();
          if (s) resetForNext();
          return false; // stay open
        },
      },
      {
        label: 'Save',
        variant: 'primary',
        id: 'save',
        onClick: async () => {
          const s = await save();
          return s || false;
        },
      },
    ].filter(Boolean);
  }

  const sheet = openSheet({
    title: titleFor(),
    icon: ICON,
    accent: COLOR,
    className: 'expenses-sheet',
    content: () => buildForm(),
    actions: actions(),
    initialFocus: '.expenses-form input.input-lg',
    guard: async () => {
      if (!dirty) return true;
      return confirmDialog({ title: 'Discard this entry?', message: 'What you typed won’t be saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing' });
    },
  });
  void recentReady;
  return sheet.result.then((r) => r || lastSaved);
}

// ─────────────────────────────────────────────────────────────── page

/** New entries land on the working date when it's in the viewed month, today for the current month, else the month's last day. */
function defaultNewDate(month) {
  const t = todayKey();
  const w = state.date;
  if (w && monthOf(w) === month && w <= t) return w;
  if (month === monthOf(t)) return t;
  return endOfMonth(month);
}

function computeStats(rows, month, prevRows) {
  const today = todayKey();
  const isCurrent = month === currentMonth();
  const dim = daysInMonth(month);
  const dayNum = Number(today.slice(8, 10));
  const daysElapsed = isCurrent ? Math.max(1, Math.min(dim, dayNum)) : dim;

  let spent = 0, income = 0, todaySpent = 0, todayCount = 0, expCount = 0;
  const byCat = new Map();
  const byIncome = new Map();
  const byDay = new Map();
  let biggest = null;
  for (const r of rows) {
    const amt = n0(r.amount);
    const d = byDay.get(r.date) || { spent: 0, income: 0, count: 0, expCount: 0 };
    d.count++;
    if (r.type === 'income') {
      income += amt;
      d.income += amt;
      const c = byIncome.get(r.category) || { amount: 0, count: 0 };
      c.amount += amt;
      c.count++;
      byIncome.set(r.category, c);
    } else {
      spent += amt;
      expCount++;
      d.spent += amt;
      d.expCount++;
      const c = byCat.get(r.category) || { amount: 0, count: 0 };
      c.amount += amt;
      c.count++;
      byCat.set(r.category, c);
      if (r.date === today) {
        todaySpent += amt;
        todayCount++;
      }
      if (!biggest || amt > n0(biggest.amount)) biggest = r;
    }
    byDay.set(r.date, d);
  }

  // Previous month: same days so far for the current month, the whole month otherwise.
  const prevMonth = addMonths(month, -1);
  const prevCut = isCurrent ? Math.min(dayNum, daysInMonth(prevMonth)) : daysInMonth(prevMonth);
  let pSpent = 0, pIncome = 0;
  for (const r of prevRows) {
    if (Number(String(r.date).slice(8, 10)) > prevCut) continue;
    if (r.type === 'income') pIncome += n0(r.amount);
    else pSpent += n0(r.amount);
  }
  const pDays = Math.max(1, prevCut);

  return {
    month, isCurrent, dim, daysElapsed, today,
    spent: round2(spent), income: round2(income), net: round2(income - spent),
    avg: spent / daysElapsed, todaySpent: round2(todaySpent), todayCount, expCount,
    byCat, byIncome, byDay, biggest,
    prev: { month: prevMonth, spent: pSpent, income: pIncome, avg: pSpent / pDays, partial: isCurrent, hasData: prevRows.length > 0 },
  };
}

function loadFilter() {
  const f = readJSON('session', SS_FILTER, null) || {};
  return { type: ['all', 'expense', 'income'].includes(f.type) ? f.type : 'all', cat: typeof f.cat === 'string' ? f.cat : null, q: typeof f.q === 'string' ? f.q : '' };
}

async function render(root, ctx) {
  const now = currentMonth();
  const param = ctx.route.params && ctx.route.params[0];
  let month = /^\d{4}-(0[1-9]|1[0-2])$/.test(param || '') && param <= now ? param : now;
  let disposed = false;
  let stats = null;
  let monthRows = [];
  let hasAny = false;
  let showAll = false;
  const filter = loadFilter();
  let view = readJSON('session', SS_VIEW, 'list') === 'insights' ? 'insights' : 'list';
  let dailyMode = readJSON('session', SS_DAILY, 'everyday') === 'all' ? 'all' : 'everyday';

  // ---- persistent chrome (never re-rendered: keeps focus while data refreshes)
  const nav = monthNav(month, (m) => {
    month = m;
    showAll = false;
    ctx.navigate(m === currentMonth() ? '/expenses' : `/expenses/${m}`, { replace: true, silent: true });
    draw();
  });

  const header = pageHeader({
    title: TITLE,
    subtitle: 'Where your money goes',
    actions: [
      { label: 'Export CSV', icon: 'download', variant: 'secondary', class: 'expenses-export', onClick: () => exportMonth() },
      { label: 'Add', icon: 'plus', variant: 'primary', onClick: () => openEditor(null, { date: defaultNewDate(month) }) },
    ],
  });

  const tilesEl = h('div.expenses-tiles', skeletonTiles());
  const chartsEl = h('div.expenses-charts', h('div.card', skeleton({ height: 220 })));

  // Filters (persistent controls).
  const typeSeg = segmented(
    [
      { value: 'all', label: 'All' },
      { value: 'expense', label: 'Expenses' },
      { value: 'income', label: 'Income' },
    ],
    filter.type,
    (t) => {
      filter.type = t;
      if (filter.cat && !filter.cat.startsWith(t + ':') && t !== 'all') filter.cat = null;
      onFilter();
    },
    { size: 'sm', ariaLabel: 'Show' }
  );
  const searchIn = input({
    type: 'search',
    value: filter.q,
    placeholder: 'Search notes, tags, methods',
    'aria-label': 'Search transactions',
    autocomplete: 'off',
    enterkeyhint: 'search',
    onInput: (e) => {
      filter.q = e.target.value;
      onSearch();
    },
  });
  const searchBox = h('div.input-affix.expenses-search', h('span.affix', icon('search', { size: 18 })), searchIn);
  const catChipsEl = chips([], filter.cat, (v) => {
    filter.cat = v;
    onFilter();
  }, { scroll: true, size: 'sm', ariaLabel: 'Filter by category' });
  const filterSummary = h('div.expenses-filter-summary', { 'aria-live': 'polite' });
  const listEl = h('div.expenses-list');
  const txTitleSub = h('p.card-subtitle');
  const txCard = h(
    'section.card.card-flush.expenses-tx',
    { 'aria-labelledby': 'expenses-tx-title' },
    h('div.card-header', iconChip('receipt', { accent: COLOR }), h('div.card-header-text', h('h2.card-title', { id: 'expenses-tx-title' }, 'Transactions'), txTitleSub)),
    h('div.expenses-filters', h('div.expenses-filter-row', typeSeg, searchBox), catChipsEl, filterSummary),
    listEl
  );

  const viewSeg = segmented(
    [
      { value: 'list', label: 'Transactions', icon: 'list' },
      { value: 'insights', label: 'Insights', icon: 'pie' },
    ],
    view,
    (v) => setView(v),
    { block: true, ariaLabel: 'View' }
  );
  const layout = h('div.expenses-layout', { dataset: { view } }, h('div.expenses-col-charts', chartsEl), h('div.expenses-col-tx', txCard));
  const bodyEl = h('div.expenses-body', tilesEl, h('div.expenses-view-switch.hide-desktop', viewSeg), layout);

  const toolbar = h('div.expenses-toolbar', nav);
  mount(root, h('div.page.expenses-page', { style: { '--accent': `var(${COLOR})` } }, header, toolbar, bodyEl));
  const exportBtn = header.querySelector('.expenses-export');

  function setView(v) {
    view = v;
    layout.dataset.view = v;
    viewSeg.setValue(v);
    writeJSON('session', SS_VIEW, v);
  }

  function saveFilter() {
    writeJSON('session', SS_FILTER, filter);
  }
  function onFilter() {
    saveFilter();
    showAll = false;
    drawCatChips();
    drawList();
  }
  const onSearch = debounce(() => {
    saveFilter();
    showAll = false;
    drawList();
  }, 120);

  function clearFilters() {
    filter.type = 'all';
    filter.cat = null;
    filter.q = '';
    typeSeg.setValue('all');
    searchIn.value = '';
    catChipsEl.setValue(null);
    onFilter();
  }

  function focusCategory(type, id) {
    filter.cat = `${type}:${id}`;
    if (filter.type !== 'all' && filter.type !== type) {
      filter.type = type;
      typeSeg.setValue(type);
    }
    setView('list');
    onFilter();
    requestAnimationFrame(() => txCard.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
  }

  function focusDay(date) {
    const visible = filtered();
    if (!visible.some((r) => r.date === date)) clearFilters();
    setView('list');
    showAll = true;
    drawList();
    requestAnimationFrame(() => {
      const el = listEl.querySelector(`[data-day="${date}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      el.classList.remove('is-flash');
      void el.offsetWidth;
      el.classList.add('is-flash');
    });
  }

  async function exportMonth() {
    const { from, to } = monthRange(month);
    try {
      const r = await exportCSV(STORE, { from, to, download: false });
      if (!r.count) {
        toast(`Nothing to export for ${fmtMonth(month)}`);
        return;
      }
      downloadText(r.filename, '﻿' + r.csv, 'text/csv');
      toast(`Exported ${plural(r.count, 'transaction')}`, { type: 'success' });
    } catch (err) {
      console.error('[daybook] expenses CSV export failed', err);
      toast('Couldn’t export — please try again.', { type: 'error' });
    }
  }

  // ---- data
  let drawSeq = 0;
  async function draw() {
    const seq = ++drawSeq;
    const { from, to } = monthRange(month);
    const prev = monthRange(addMonths(month, -1));
    const rows = await db.byRange(STORE, prev.from, to);
    const total = rows.length ? rows.length : await db.count(STORE);
    if (disposed || seq !== drawSeq) return;
    monthRows = rows.filter((r) => r.date >= from);
    const prevRows = rows.filter((r) => r.date < from);
    hasAny = total > 0;
    stats = computeStats(monthRows, month, prevRows);
    nav.setMonth(month);

    // First run: nothing to navigate or export yet — just the welcome card.
    toolbar.hidden = !hasAny;
    if (exportBtn) exportBtn.hidden = !hasAny;
    if (!hasAny) {
      mount(bodyEl, firstRunEmpty());
      return;
    }
    if (!bodyEl.contains(layout)) mount(bodyEl, tilesEl, h('div.expenses-view-switch.hide-desktop', viewSeg), layout);
    drawTiles();
    drawCharts();
    drawCatChips();
    drawList();
  }

  function firstRunEmpty() {
    return h(
      'div.card.expenses-welcome',
      emptyState({
        icon: 'wallet',
        accent: COLOR,
        title: 'Track where your money goes',
        message: 'Log an expense in seconds — amount, category, done. Add income too and see what you save each month.',
        action: { label: 'Add expense', icon: 'plus', onClick: () => openEditor(null, { date: defaultNewDate(month) }) },
        actions: [{ label: 'Add income', icon: 'income', onClick: () => openEditor(null, { date: defaultNewDate(month), type: 'income' }) }],
      })
    );
  }

  function skeletonTiles() {
    return [0, 1, 2, 3].map(() => h('div.stat', skeleton({ width: '50%', height: 12 }), skeleton({ width: '70%', height: 26 })));
  }

  function drawTiles() {
    const s = stats;
    const budget = n0(getSettings().targets && getSettings().targets.monthlyBudget);
    const dailyTarget = n0(getSettings().targets && getSettings().targets.dailySpend);
    const vsLabel = s.prev.partial ? `vs same days of ${fmtMonth(s.prev.month)}` : `vs ${fmtMonth(s.prev.month)}`;
    const prevOk = s.prev.hasData;

    // Spent (+ budget)
    let spentSub;
    if (budget > 0) {
      const left = budget - s.spent;
      spentSub = left >= 0 ? `${fmtMoney(left, { decimals: 0 })} left of ${fmtMoney(budget, { decimals: 0 })}` : `${fmtMoney(-left, { decimals: 0 })} over ${fmtMoney(budget, { decimals: 0 })} budget`;
    } else spentSub = plural(s.expCount, 'expense');
    const spentTile = statTile({
      label: s.isCurrent ? 'Spent this month' : `Spent in ${fmtDate(`${month}-01`, 'month')}`,
      value: fmtMoney(s.spent, { decimals: 0 }),
      delta: prevOk ? change(s.spent, s.prev.spent) : undefined,
      deltaGood: 'down',
      deltaLabel: vsLabel,
      sub: spentSub,
      icon: 'wallet',
      accent: COLOR,
      class: 'expenses-tile-spent',
    });
    if (budget > 0) {
      const frac = s.spent / budget;
      const over = frac > 1;
      // Pace marker: where spending "should" be by today if spread evenly across the month.
      const pace = s.isCurrent ? s.daysElapsed / s.dim : null;
      const bar = progressBar(frac, { accent: over ? '--loss' : frac > (pace ?? 1) ? '--warning' : COLOR, over, height: 8, label: `Budget used: ${fmtPercent(frac, { decimals: 0 })}` });
      spentTile.append(h('div.expenses-budget', bar, pace !== null ? h('span.expenses-pace', { style: { '--pace': String(Math.min(1, pace)) }, title: 'Where you’d be at an even pace', 'aria-hidden': 'true' }) : null));
      if (frac > (pace ?? 1) && !over) spentTile.classList.add('is-ahead');
    }

    const incomeTile = statTile({
      label: 'Income',
      value: fmtMoney(s.income, { decimals: 0 }),
      delta: prevOk ? change(s.income, s.prev.income) : undefined,
      deltaGood: 'up',
      deltaLabel: vsLabel,
      sub: s.byIncome.size ? plural([...s.byIncome.values()].reduce((a, c) => a + c.count, 0), 'credit') : 'None yet',
      icon: 'income',
      accent: '--profit',
    });

    const rate = s.income > 0 ? s.net / s.income : null;
    const netTile = statTile({
      label: 'Net',
      value: fmtMoney(s.net, { sign: s.net !== 0, decimals: 0 }),
      tone: pnlTone(s.net),
      sub: rate === null ? (s.spent > 0 ? 'No income logged' : '—') : rate >= 0 ? `Saved ${fmtPercent(rate, { decimals: 0 })} of income` : `Overspent by ${fmtPercent(-rate, { decimals: 0 })}`,
      icon: 'scale',
      accent: '--primary',
    });

    const avgTile = statTile({
      label: 'Daily average',
      value: fmtMoney(s.avg, { decimals: 0 }),
      delta: prevOk ? change(s.avg, s.prev.avg) : undefined,
      deltaGood: 'down',
      deltaLabel: vsLabel,
      sub: s.isCurrent ? `On pace for ${fmtMoney(s.avg * s.dim, { decimals: 0 })}` : `${s.dim} days`,
      icon: 'calendar',
      accent: COLOR,
    });

    const tiles = [spentTile, incomeTile, netTile, avgTile];
    if (s.isCurrent) {
      let sub = s.todayCount ? plural(s.todayCount, 'expense') : 'Nothing yet';
      if (dailyTarget > 0) {
        const left = dailyTarget - s.todaySpent;
        sub = left >= 0 ? `${fmtMoney(left, { decimals: 0 })} left of ${fmtMoney(dailyTarget, { decimals: 0 })}` : `${fmtMoney(-left, { decimals: 0 })} over ${fmtMoney(dailyTarget, { decimals: 0 })}`;
      }
      const todayTile = statTile({
        label: 'Today',
        value: fmtMoney(s.todaySpent, { decimals: 0 }),
        sub,
        icon: 'today',
        accent: dailyTarget > 0 && s.todaySpent > dailyTarget ? '--warning' : COLOR,
        onClick: s.byDay.has(s.today) ? () => focusDay(s.today) : null,
        class: { 'is-over': dailyTarget > 0 && s.todaySpent > dailyTarget },
      });
      if (s.byDay.has(s.today)) todayTile.setAttribute('aria-label', `Today: ${fmtMoney(s.todaySpent)} spent. ${sub}. Show today’s transactions`);
      tiles.push(todayTile);
    }
    mount(tilesEl, tiles);
    tilesEl.dataset.count = String(tiles.length);
  }

  function drawCharts() {
    const s = stats;
    const cats = [...s.byCat.entries()].map(([id, v]) => ({ id, ...v, cat: moneyCategory('expense', id) })).sort((a, b) => b.amount - a.amount);
    // Budgeted categories with nothing spent still show (budget untouched).
    for (const c of categoryList('expense')) {
      if (n0(c.budget) > 0 && !s.byCat.has(c.id)) cats.push({ id: c.id, amount: 0, count: 0, cat: c });
    }

    const cards = [];
    if (!monthRows.length) {
      cards.push(
        h('section.card', emptyState({
          icon: 'pie',
          accent: COLOR,
          compact: true,
          title: `Nothing in ${fmtMonth(month)}`,
          message: s.isCurrent ? 'Your breakdown and daily chart appear after the first entry.' : 'No transactions were logged this month.',
          action: { label: 'Add expense', icon: 'plus', onClick: () => openEditor(null, { date: defaultNewDate(month) }) },
        }))
      );
      mount(chartsEl, cards);
      return;
    }

    // Category breakdown: donut + ranked list (the list is the legend and the table view).
    const top = cats[0];
    const breakdown = h('section.card.expenses-breakdown', { 'aria-labelledby': 'expenses-bd-title' });
    const head = h('div.card-header', iconChip('pie', { accent: COLOR }), h('div.card-header-text', h('h2.card-title', { id: 'expenses-bd-title' }, 'Where it went'), h('p.card-subtitle', s.spent > 0 && top && top.amount > 0 ? `${top.cat.name} leads with ${fmtPercent(top.amount / s.spent, { decimals: 0 })}` : 'No spending yet')));
    breakdown.append(head);
    if (s.spent > 0) {
      const donut = donutChart({
        data: cats.filter((c) => c.amount > 0).map((c) => ({ label: c.cat.name, value: c.amount, color: c.cat.color, id: c.id })),
        size: 168,
        thickness: 20,
        centerLabel: 'Spent',
        centerValue: fmtMoney(s.spent, { compact: s.spent >= 100000, decimals: s.spent >= 100000 ? 1 : 0 }),
        valueFormat: (v) => fmtMoney(v, { decimals: 0 }),
        legend: false,
        ariaLabel: 'Spending by category',
        onClick: (d) => {
          if (d && d.id) focusCategory('expense', d.id);
        },
      });
      const facts = h(
        'dl.expenses-facts',
        fact('Transactions', String(monthRows.length)),
        fact('Categories', String(s.byCat.size)),
        s.biggest ? fact('Biggest', fmtMoney(s.biggest.amount, { decimals: 0 }), rowTitle(s.biggest)) : null,
        fact('Busiest day', busiestDay())
      );
      breakdown.append(h('div.expenses-donut-row', h('div.expenses-donut', donut), facts));
    }
    const maxAmt = Math.max(1, ...cats.map((c) => c.amount));
    breakdown.append(
      h(
        'ol.expenses-cats',
        { 'aria-label': 'Categories ranked by spending' },
        cats.map((c) => {
          const budget = n0(c.cat.budget);
          const share = s.spent > 0 ? c.amount / s.spent : 0;
          const over = budget > 0 && c.amount > budget;
          const bar = budget > 0
            ? progressBar(c.amount / budget, { accent: over ? '--loss' : c.cat.color, over, height: 6, label: `${c.cat.name}: ${fmtPercent(c.amount / budget, { decimals: 0 })} of budget` })
            : h('div.expenses-share', { 'aria-hidden': 'true', style: { '--share': String(c.amount / maxAmt), '--c': c.cat.color } });
          const meta = budget > 0
            ? over
              ? h('span.text-loss', `${fmtMoney(c.amount - budget, { decimals: 0 })} over ${fmtMoney(budget, { decimals: 0 })}`)
              : h('span', `${fmtMoney(budget - c.amount, { decimals: 0 })} left of ${fmtMoney(budget, { decimals: 0 })}`)
            : h('span', `${plural(c.count, 'transaction')}`);
          return h(
            'li',
            h(
              'button.expenses-cat',
              {
                type: 'button',
                class: { 'is-over': over },
                onClick: () => focusCategory('expense', c.id),
                'aria-label': `${c.cat.name}: ${fmtMoney(c.amount)}, ${fmtPercent(share, { decimals: 0 })} of spending${budget > 0 ? `, budget ${fmtMoney(budget)}${over ? ', over budget' : ''}` : ''}. Show transactions`,
              },
              iconChip(null, { emoji: c.cat.emoji || '📦', accent: c.cat.color, size: 'sm' }),
              h(
                'span.expenses-cat-main',
                h('span.expenses-cat-top', h('span.expenses-cat-name', c.cat.name), h('span.expenses-cat-amt', fmtMoney(c.amount, { decimals: 0 })), h('span.expenses-cat-pct', s.spent > 0 ? fmtPercent(share, { decimals: 0 }) : '—')),
                bar,
                h('span.expenses-cat-meta', meta, over ? h('span.badge.badge-loss', icon('alert', { size: 12 }), 'Over') : null)
              )
            )
          );
        })
      )
    );
    cards.push(breakdown);

    cards.push(dailyCard());

    // Income sources.
    if (s.byIncome.size) {
      const inc = [...s.byIncome.entries()].map(([id, v]) => ({ id, ...v, cat: moneyCategory('income', id) })).sort((a, b) => b.amount - a.amount);
      cards.push(
        h(
          'section.card.card-flush.expenses-income',
          { 'aria-labelledby': 'expenses-inc-title' },
          h('div.card-header', iconChip('income', { accent: '--profit' }), h('div.card-header-text', h('h2.card-title', { id: 'expenses-inc-title' }, 'Income'), h('p.card-subtitle', `${fmtMoney(s.income, { decimals: 0 })} from ${plural(inc.length, 'source')}`))),
          h('div.list', inc.map((c) => listItem({
            lead: iconChip(null, { emoji: c.cat.emoji || '💰', accent: c.cat.color }),
            title: c.cat.name,
            meta: plural(c.count, 'credit'),
            trail: h('span.text-profit', fmtMoney(c.amount, { sign: true, decimals: 0 })),
            trailMeta: s.income > 0 ? fmtPercent(c.amount / s.income, { decimals: 0 }) : null,
            onClick: () => focusCategory('income', c.id),
          })))
        )
      );
    }
    mount(chartsEl, cards);
  }

  /**
   * Daily spend bars. Rent or one big purchase flattens every other day into nothing, so by default
   * "Everyday" leaves out single items far above a typical day (≥ 5× the median day, ≥ 5 days of data) and
   * says what it left out; "All" shows everything.
   */
  function dailyCard() {
    const s = stats;
    const dailyTarget = n0(getSettings().targets && getSettings().targets.dailySpend);
    const { from, to } = monthRange(month);
    const lastDay = s.isCurrent ? s.today : to;
    const dayVals = [...s.byDay.values()].map((d) => d.spent).filter((v) => v > 0).sort((a, b) => a - b);
    const median = dayVals.length ? dayVals[Math.floor((dayVals.length - 1) / 2)] : 0;
    const threshold = dayVals.length >= 5 && median > 0 ? median * 5 : Infinity;
    const big = monthRows.filter((r) => r.type !== 'income' && n0(r.amount) >= threshold && (!dailyTarget || n0(r.amount) > dailyTarget));
    const bigByDay = new Map();
    for (const r of big) bigByDay.set(r.date, [...(bigByDay.get(r.date) || []), r]);
    const everyday = big.length > 0 && dailyMode === 'everyday';
    const bigTotal = big.reduce((a, r) => a + n0(r.amount), 0);

    const data = rangeKeys(from, to).map((k) => {
      const d = s.byDay.get(k);
      const bigs = everyday ? bigByDay.get(k) || [] : [];
      const bigSum = bigs.reduce((a, r) => a + n0(r.amount), 0);
      const v = k > lastDay ? null : round2(d ? d.spent - bigSum : 0);
      const over = dailyTarget > 0 && v > dailyTarget;
      const notes = d
        ? [
            d.expCount ? plural(d.expCount - bigs.length, 'expense') : null,
            ...bigs.map((r) => `Left out: ${rowTitle(r)} ${fmtMoney(r.amount, { decimals: 0 })}`),
            d.income > 0 ? `Income ${fmtMoney(d.income, { sign: true, decimals: 0 })}` : null,
            over ? 'Over daily target' : null,
          ].filter(Boolean)
        : k > lastDay
          ? null
          : 'No spending';
      return { label: k, value: v, color: over ? '--warning' : COLOR, tooltip: notes };
    });
    const shownTotal = data.reduce((a, d) => a + (d.value || 0), 0);
    const avg = shownTotal / s.daysElapsed;
    const overDays = data.filter((d) => dailyTarget > 0 && d.value > dailyTarget).length;
    const noSpend = data.filter((d) => d.value === 0).length;
    const sub = [
      `Avg ${fmtMoney(avg, { decimals: 0 })}/day`,
      everyday ? ` without ${plural(big.length, 'big item')} (${fmtMoney(bigTotal, { decimals: 0 })})` : '',
      dailyTarget > 0 ? ` · ${plural(overDays, 'day')} over ${fmtMoney(dailyTarget, { decimals: 0 })}` : '',
      !everyday && noSpend > 0 ? ` · ${plural(noSpend, 'no-spend day')}` : '',
    ].join('');
    const modeSeg = big.length
      ? segmented(
          [
            { value: 'everyday', label: 'Everyday' },
            { value: 'all', label: 'All' },
          ],
          dailyMode,
          (v) => {
            dailyMode = v;
            writeJSON('session', SS_DAILY, v);
            const fresh = dailyCard();
            card.replaceWith(fresh);
            fresh.querySelector('.segmented-btn[aria-checked="true"]')?.focus();
          },
          { size: 'sm', ariaLabel: 'Daily spending shows' }
        )
      : null;
    const card = h(
      'section.card.expenses-daily',
      { 'aria-labelledby': 'expenses-daily-title' },
      h(
        'div.card-header',
        iconChip('bar-chart', { accent: COLOR }),
        h('div.card-header-text', h('h2.card-title', { id: 'expenses-daily-title' }, 'Daily spending'), h('p.card-subtitle', sub)),
        modeSeg ? h('div.card-actions', modeSeg) : null
      ),
      barChart({
        data,
        height: 200,
        yFormat: (v) => fmtMoney(v, { compact: true }),
        tooltipFormat: (v) => fmtMoney(v, { decimals: 0 }),
        xFormat: (k) => {
          const d = Number(String(k).slice(8, 10));
          return d === 1 || d % 5 === 0 ? String(d) : '';
        },
        target: dailyTarget > 0 ? dailyTarget : undefined,
        targetLabel: dailyTarget > 0 ? `Daily target ${fmtMoney(dailyTarget, { decimals: 0 })}` : undefined,
        valueLabels: false,
        ariaLabel: `Daily spending, ${fmtMonth(month)}${everyday ? ', big one-off items left out' : ''}`,
        onClick: (d) => d && d.label && s.byDay.has(d.label) && focusDay(d.label),
      })
    );
    return card;
  }

  function fact(label, value, sub) {
    return h('div', h('dt', label), h('dd', h('span.expenses-fact-val', value), sub ? h('span.expenses-fact-sub', sub) : null));
  }

  function busiestDay() {
    let best = null;
    for (const [k, v] of stats.byDay) if (v.spent > 0 && (!best || v.spent > best[1].spent)) best = [k, v];
    return best ? fmtDate(best[0], 'short') : '—';
  }

  function drawCatChips() {
    const seen = new Map();
    for (const r of monthRows) {
      const t = r.type === 'income' ? 'income' : 'expense';
      if (filter.type !== 'all' && filter.type !== t) continue;
      const key = `${t}:${r.category}`;
      const e = seen.get(key) || { key, t, id: r.category, amount: 0 };
      e.amount += n0(r.amount);
      seen.set(key, e);
    }
    if (filter.cat && !seen.has(filter.cat)) {
      const [t, ...rest] = filter.cat.split(':');
      seen.set(filter.cat, { key: filter.cat, t, id: rest.join(':'), amount: 0 });
    }
    const opts = [...seen.values()]
      .sort((a, b) => (a.t === b.t ? b.amount - a.amount : a.t === 'expense' ? -1 : 1))
      .map((e) => {
        const c = moneyCategory(e.t, e.id);
        return { value: e.key, label: filter.type === 'all' && e.t === 'income' ? `${c.name} (income)` : c.name, emoji: c.emoji, color: c.color };
      });
    catChipsEl.setOptions(opts, filter.cat);
    catChipsEl.hidden = opts.length === 0;
  }

  function filtered() {
    const q = lc(filter.q.trim());
    return monthRows.filter((r) => {
      const t = r.type === 'income' ? 'income' : 'expense';
      if (filter.type !== 'all' && filter.type !== t) return false;
      if (filter.cat && filter.cat !== `${t}:${r.category}`) return false;
      if (q) {
        const c = catOf(r);
        const hay = [r.note, c.name, r.method, ...(Array.isArray(r.tags) ? r.tags.map((x) => '#' + x) : []), String(r.amount)].map(lc).join(' \u0001 ');
        if (!hay.includes(q.replace(/^#/, '')) && !hay.includes(q)) return false;
      }
      return true;
    });
  }

  function drawList() {
    if (!stats) return;
    const rows = filtered().slice().reverse(); // newest first (byRange is ascending)
    const active = filter.type !== 'all' || !!filter.cat || !!filter.q.trim();
    const total = monthRows.length;
    txTitleSub.textContent = total ? `${plural(total, 'transaction')} in ${fmtMonth(month)}` : fmtMonth(month);

    // Filter summary
    if (active && total) {
      const sp = rows.reduce((a, r) => a + (r.type === 'income' ? 0 : n0(r.amount)), 0);
      const inc = rows.reduce((a, r) => a + (r.type === 'income' ? n0(r.amount) : 0), 0);
      mount(
        filterSummary,
        h('span', `${plural(rows.length, 'match', 'matches')}`),
        sp > 0 ? h('span.num', ` · ${fmtMoney(sp, { decimals: 0 })} spent`) : null,
        inc > 0 ? h('span.num.text-profit', ` · ${fmtMoney(inc, { sign: true, decimals: 0 })}`) : null,
        h('button.link-btn.expenses-clear', { type: 'button', onClick: () => clearFilters() }, icon('x', { size: 14 }), 'Clear')
      );
      filterSummary.hidden = false;
    } else {
      filterSummary.replaceChildren();
      filterSummary.hidden = true;
    }

    if (!total) {
      mount(
        listEl,
        emptyState({
          icon: 'receipt',
          accent: COLOR,
          compact: true,
          title: stats.isCurrent ? 'No transactions this month yet' : `Nothing logged in ${fmtMonth(month)}`,
          message: stats.isCurrent ? 'Add your first expense — it takes a few seconds.' : 'Add a past expense or pick another month.',
          action: { label: 'Add expense', icon: 'plus', onClick: () => openEditor(null, { date: defaultNewDate(month) }) },
          actions: [{ label: 'Add income', icon: 'income', onClick: () => openEditor(null, { date: defaultNewDate(month), type: 'income' }) }],
        })
      );
      return;
    }
    if (!rows.length) {
      mount(
        listEl,
        emptyState({
          icon: 'search',
          compact: true,
          title: 'No matches',
          message: 'Try a different word or category.',
          action: { label: 'Clear filters', icon: 'x', onClick: () => clearFilters() },
        })
      );
      return;
    }

    const limit = showAll ? rows.length : PAGE_ROWS;
    const shown = rows.slice(0, limit);
    // Day totals use every row of that day matching the filter (not just the shown slice).
    const dayTotals = new Map();
    for (const r of rows) {
      const d = dayTotals.get(r.date) || { spent: 0, income: 0 };
      if (r.type === 'income') d.income += n0(r.amount);
      else d.spent += n0(r.amount);
      dayTotals.set(r.date, d);
    }
    const groups = [];
    let cur = null;
    for (const r of shown) {
      if (!cur || cur.date !== r.date) {
        cur = { date: r.date, rows: [] };
        groups.push(cur);
      }
      cur.rows.push(r);
    }
    const out = groups.map((g) => {
      const t = dayTotals.get(g.date);
      const trail = h(
        'span.expenses-day-total',
        t.spent > 0 ? h('span', { 'aria-label': `Spent ${fmtMoney(t.spent)}` }, fmtMoney(t.spent, { decimals: t.spent % 1 ? 2 : 0 })) : null,
        t.income > 0 ? h('span.text-profit', { 'aria-label': `Earned ${fmtMoney(t.income)}` }, fmtMoney(t.income, { sign: true, decimals: 0 })) : null
      );
      const head = listGroupHeader(relativeDay(g.date), trail);
      head.dataset.day = g.date;
      return h('div.expenses-day', h('div.expenses-day-head', head), h('div.list', g.rows.map(rowEl)));
    });
    const more = rows.length > limit
      ? h('div.expenses-more', button({ label: `Show ${plural(rows.length - limit, 'more transaction')}`, icon: 'chevron-down', variant: 'ghost', block: true, onClick: () => { showAll = true; drawList(); } }))
      : null;
    mount(listEl, out, more);
  }

  function rowEl(r) {
    const c = catOf(r);
    const income = r.type === 'income';
    const title = rowTitle(r);
    const hasNote = !!(r.note && r.note.trim());
    const tags = Array.isArray(r.tags) ? r.tags : [];
    return listItem({
      lead: iconChip(null, { emoji: c.emoji || (income ? '💰' : '📦'), accent: c.color }),
      title,
      meta: [hasNote ? c.name : null, r.method || null, r.time ? fmtTime(r.time) : null, tags.length ? h('span.expenses-row-tags', tags.slice(0, 2).map((t) => '#' + t).join(' ')) : null],
      trail: h('span', { class: income ? 'text-profit' : null }, amountText(r)),
      class: ['expenses-row', income && 'is-income'],
      ariaLabel: `${title}, ${income ? 'income' : c.name}, ${income ? 'plus ' : ''}${fmtMoney(r.amount)}${r.method ? ', ' + r.method : ''}${r.time ? ', ' + fmtTime(r.time) : ''}. Edit`,
      onClick: () => openEditor(r),
    });
  }

  // ---- go
  await draw();

  const refresh = debounce(draw, 60);
  const offs = [
    on('db:change', (e) => {
      if (e && (e.store === STORE || e.store === '*')) refresh();
    }),
    on('settings:change', () => refresh()),
  ];
  // Midnight rollover / returning to a stale tab: refresh "today" figures when the page becomes visible.
  const onVisible = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  document.addEventListener('visibilitychange', onVisible);

  if (ctx.route.query && ctx.route.query.new === '1') {
    openEditor(null, { date: defaultNewDate(month), type: ctx.route.query.type === 'income' ? 'income' : 'expense' });
    ctx.navigate(ctx.route.path, { replace: true });
  }

  return () => {
    disposed = true;
    refresh.cancel();
    onSearch.cancel();
    offs.forEach((off) => off());
    document.removeEventListener('visibilitychange', onVisible);
  };
}

// ─────────────────────────────────────────────────────────────── module

async function summarizeDay(date) {
  const items = await db.byDate(STORE, date);
  let spent = 0, earned = 0;
  for (const r of items) {
    if (r.type === 'income') earned += n0(r.amount);
    else spent += n0(r.amount);
  }
  const parts = [];
  if (spent > 0 || (items.length && !earned)) parts.push(`Spent ${fmtMoney(spent)}`);
  if (earned > 0) parts.push(`Earned ${fmtMoney(earned)}`);
  return {
    id: ID,
    title: TITLE,
    icon: ICON,
    color: COLOR,
    headline: items.length ? parts.join(' · ') : '',
    empty: 'No spending logged',
    items: items.map((r) => {
        const c = catOf(r);
        const amt = amountText(r);
        return {
          id: r.id,
          time: r.time,
          title: `${c.emoji || ''} ${rowTitle(r)}`.trim(),
          meta: [amt, r.note ? c.name : null, r.method || null].filter(Boolean).join(' · '),
          emoji: c.emoji,
          amount: r.amount,
          trail: amt,
          tone: r.type === 'income' ? 'profit' : null,
          onOpen: () => openEditor(r),
        };
      }),
    addLabel: 'Add expense',
    onAdd: () => openEditor(null, { date }),
  };
}

async function search(query) {
  const q = lc(String(query || '').trim()).replace(/^#/, '');
  if (q.length < 2) return [];
  const all = await db.all(STORE);
  const out = [];
  for (let i = all.length - 1; i >= 0 && out.length < 50; i--) {
    const r = all[i];
    const c = catOf(r);
    const fields = [r.note, c.name, r.method, ...(Array.isArray(r.tags) ? r.tags : [])];
    if (!fields.some((s) => lc(s).includes(q))) continue;
    const income = r.type === 'income';
    out.push({
      id: r.id,
      module: ID,
      icon: income ? 'income' : ICON,
      color: income ? '--profit' : COLOR,
      title: rowTitle(r),
      subtitle: [amountText(r), r.note ? c.name : null, r.method || null, Array.isArray(r.tags) && r.tags.length ? r.tags.map((t) => '#' + t).join(' ') : null].filter(Boolean).join(' · '),
      date: r.date,
      onOpen: () => openEditor(r),
    });
  }
  return out;
}

export default {
  id: ID,
  title: TITLE,
  icon: ICON,
  color: COLOR,
  render,
  openEditor,
  quickActions: [
    { id: 'expense', label: 'Expense', icon: ICON, color: COLOR, run: ({ date } = {}) => openEditor(null, { date, type: 'expense' }) },
    { id: 'income', label: 'Income', icon: 'income', color: '--profit', run: ({ date } = {}) => openEditor(null, { date, type: 'income' }) },
  ],
  summarizeDay,
  search,
};
