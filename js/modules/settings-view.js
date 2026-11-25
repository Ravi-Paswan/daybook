// Settings (SPEC 4.11) — route 'settings', deep links '#/settings/<section>' (e.g. /settings/data, /settings/trading).
// Layout: one page of section cards. Desktop (≥ 960px): sticky section index on the left with scroll-spy.
// Phone/tablet: a sticky, horizontally scrolling index strip under the top bar. Index links rewrite the URL
// silently (no re-render) and scroll smoothly; a deep link scrolls to (and focuses) its section on render.
// Every edit saves immediately via updateSettings (arrays are sent whole) and flashes an inline "Saved" status
// in the section header. Sections re-draw themselves on 'settings:change' when a key they show changed (a
// section that is the source of a typed/stepped edit is not re-drawn, so focus and caret stay put).
// Choices not fixed by the spec:
// - The 'other' category of each list can't be deleted (it is the fallback every lookup uses).
// - Removing a chip / rule / category offers Undo (toast) — categories additionally ask first, with usage count.
// - Restore → validates the file locally, shows per-store counts, Merge (recommended) or Replace; Replace offers
//   to download a copy of the current data first. Delete everything also offers a backup first and needs "DELETE".
// - Keyboard shortcuts section is hidden on touch-only devices.

import { db, STORES, uid } from '../core/db.js';
import { on } from '../core/bus.js';
import { getSettings, updateSettings, DEFAULT_SETTINGS } from '../core/settings.js';
import { downloadBackup, shareBackup, importBackup, exportCSV, clearAllData, backupCounts, BACKUP_SCHEMA } from '../core/backup.js';
import { CURRENCIES, currencySymbol, fmtMoney, fmtNumber, fmtTradeMoney, plural } from '../core/format.js';
import { fmtDate, toKey } from '../core/dates.js';
import { navigate } from '../core/router.js';
import * as sync from '../core/sync.js';
import {
  h, mount, clear, icon, button, iconChip, badge, toast, openSheet, confirmDialog, promptDialog, field, input,
  select, segmented, stepper, moneyInput, pageHeader, card, debounce, spinner, colorVar, kv,
} from '../core/ui.js';

const ID = 'settings';

// ---------------------------------------------------------------------------------------------- helpers

const PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#94a3b8',
];

const EMOJI_SUGGEST = {
  expenseCategories: ['🍽️', '🛒', '🚕', '⛽', '💡', '🏠', '🛍️', '💊', '🎬', '📚', '🏋️', '✈️', '🎁', '🔁', '📱', '🐶', '👶', '☕', '🍺', '💇', '🧾', '📦'],
  incomeCategories: ['💼', '🧑‍💻', '🏪', '📈', '🏦', '🎁', '🏠', '💸', '🪙', '🧾', '💰'],
  learningCategories: ['💻', '📈', '💰', '🫀', '🚀', '🗣️', '🔬', '🌱', '🛠️', '🎨', '🎵', '📖', '🧠', '✨'],
  workoutTypes: ['🏋️', '🏃', '⚡', '🧘', '⚽', '🚶', '🤸', '🚴', '🏊', '🥊', '🧗', '🎾', '🏸', '💪'],
};

const STORE_LABELS = {
  food: 'Meals', learning: 'Learnings', workouts: 'Workouts', expenses: 'Money entries', trades: 'Trades',
  days: 'Journal days', goals: 'Goals', reviews: 'Reviews', files: 'Photos & screenshots', meta: 'Settings & app data',
};

const CSV_EXPORTS = [
  { store: 'food', label: 'Food', icon: 'food', color: '--food' },
  { store: 'learning', label: 'Learning', icon: 'learning', color: '--learning' },
  { store: 'workouts', label: 'Training', icon: 'training', color: '--training' },
  { store: 'expenses', label: 'Expenses', icon: 'expenses', color: '--expenses' },
  { store: 'trades', label: 'Trades', icon: 'trades', color: '--trades' },
  { store: 'days', label: 'Journal & mood', icon: 'note', color: '--mood' },
  { store: 'goals', label: 'Goals', icon: 'goals', color: '--goals' },
  { store: 'reviews', label: 'Reviews', icon: 'calendar-check', color: '--primary' },
];

const SHORTCUTS = [
  [['N'], 'Quick add'],
  [['/'], 'Search'],
  [['?'], 'Show shortcuts'],
  [['G', 'T'], 'Go to Today'],
  [['G', 'F'], 'Go to Food'],
  [['G', 'L'], 'Go to Learning'],
  [['G', 'W'], 'Go to Training'],
  [['G', 'E'], 'Go to Expenses'],
  [['G', 'R'], 'Go to Trades'],
  [['G', 'P'], 'Trading day plan'],
  [['G', 'O'], 'Go to Goals'],
  [['G', 'C'], 'Go to Calendar'],
  [['G', 'I'], 'Go to Insights'],
  [['G', 'S'], 'Go to Settings'],
];

const REMINDERS = [
  { value: 0, label: 'Off' },
  { value: 3, label: 'Every 3 days' },
  { value: 7, label: 'Every week' },
  { value: 14, label: 'Every 2 weeks' },
  { value: 30, label: 'Every month' },
];

// Deep-link aliases → section id.
const ALIASES = { backup: 'data', restore: 'data', categories: 'expenses', expense: 'expenses', money: 'expenses', units: 'regional', currency: 'regional', theme: 'appearance', goals: 'targets', trades: 'trading', name: 'profile' };

const append = (el, ...kids) => el.append(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const lower = (s) => String(s || '').trim().toLowerCase();
const isTouchOnly = () => {
  try {
    return matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
};
const html = document.documentElement;

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${fmtNumber(n / 1024, { maxDecimals: 1 })} KB`;
  if (n < 1024 ** 3) return `${fmtNumber(n / 1024 / 1024, { maxDecimals: 1 })} MB`;
  return `${fmtNumber(n / 1024 ** 3, { maxDecimals: 1 })} GB`;
}

function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = (t - Date.now()) / 1000;
  const abs = Math.abs(diff);
  let rtf;
  try {
    rtf = new Intl.RelativeTimeFormat(navigator.language || 'en', { numeric: 'auto' });
  } catch {
    return '';
  }
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 45) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / 86400 / 30), 'month');
  return rtf.format(Math.round(diff / 86400 / 365), 'year');
}

function slugId(name, existing) {
  const base = lower(name).normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'item';
  const ids = new Set(existing);
  if (!ids.has(base)) return base;
  for (let i = 2; i < 999; i++) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${uid().slice(0, 6)}`;
}

/** Runs fn with a busy button (spinner + disabled). */
async function withBusy(btn, fn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  const sp = spinner({ size: 16 });
  btn.prepend(sp);
  try {
    return await fn();
  } finally {
    sp.remove();
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

function kbd(keys) {
  return h('span.settings-keys', keys.map((k, i) => [i > 0 ? h('span.settings-keys-then', 'then') : null, h('kbd', k)]));
}

/** Validates a parsed backup object (same rules as core/backup.js readBackup). → error message | null */
function backupProblem(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.app !== 'daybook' || !data.stores || typeof data.stores !== 'object') {
    return "That file isn't a Daybook backup.";
  }
  if (Number(data.schema) > BACKUP_SCHEMA) return 'This backup was made by a newer version of Daybook. Update the app and try again.';
  return null;
}

// ---------------------------------------------------------------------------------------------- render

async function render(root, ctx) {
  let disposed = false;
  let skipBlock = null; // block whose own edit is being saved (not re-drawn)
  const timers = new Set();
  const cleanups = [];
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!disposed) fn();
    }, ms);
    timers.add(t);
    return t;
  };

  const blocks = [];
  /**
   * A settings section. draw(body, b) fills the body; keys = top-level settings keys it displays.
   */
  function block({ id, title, subtitle, icon: iconName, accent = '--primary', keys = [], group, draw, hidden = false }) {
    const status = h('span.settings-saved', { role: 'status', 'aria-live': 'polite' });
    const el = card({ id: `settings-${id}`, title, subtitle, icon: iconName, accent, actions: [status], class: 'settings-section' });
    el.dataset.section = id;
    el.setAttribute('aria-labelledby', `settings-${id}-title`);
    const h2 = el.querySelector('.card-title');
    if (h2) {
      h2.id = `settings-${id}-title`;
      h2.setAttribute('tabindex', '-1');
    }
    let flashTimer = 0;
    const b = {
      id, title, keys, group, el, body: el.body, hidden, icon: iconName,
      flash(msg = 'Saved') {
        status.replaceChildren(icon('check', { size: 14 }), h('span', msg));
        status.classList.add('is-on');
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => status.classList.remove('is-on'), 1800);
        timers.add(flashTimer);
      },
      redraw({ focus } = {}) {
        if (disposed) return;
        const ae = document.activeElement;
        const fk = focus || (ae && b.body.contains(ae) && ae.dataset ? ae.dataset.fk : null);
        clear(b.body);
        draw(b.body, b);
        if (fk) {
          const target = b.body.querySelector(`[data-fk="${CSS.escape(fk)}"]`) || b.body.querySelector('[data-fk^="add"]');
          if (target) requestAnimationFrame(() => target.isConnected && target.focus({ preventScroll: true }));
        }
      },
    };
    draw(b.body, b);
    if (hidden) el.hidden = true;
    blocks.push(b);
    return b;
  }

  /** Persist a patch for block b. redraw → re-draw b afterwards (lists); otherwise b is skipped. */
  async function save(b, patch, { redraw = false, focus, quiet = false } = {}) {
    skipBlock = redraw ? null : b;
    try {
      await updateSettings(patch);
      if (!quiet && b) b.flash();
      if (redraw && b && focus) {
        // the settings:change listener already re-drew b (its keys matched) — restore focus to the right control
        const target = b.body.querySelector(`[data-fk="${CSS.escape(focus)}"]`) || b.body.querySelector('[data-fk^="add"]');
        if (target) requestAnimationFrame(() => target.isConnected && target.focus({ preventScroll: true }));
      }
      return true;
    } catch (err) {
      console.error('[daybook] settings save failed', err);
      toast('Couldn’t save that change. Please try again.', { type: 'error' });
      if (b) b.redraw();
      return false;
    } finally {
      skipBlock = null;
    }
  }

  const S = () => getSettings();

  // ------------------------------------------------------------------ Profile
  function drawProfile(body, b) {
    const queue = debounce((v) => save(b, { name: v }), 500);
    cleanups.push(() => queue.flush());
    const inp = input({
      value: S().name || '', placeholder: 'Your name', autocomplete: 'given-name', maxlength: 60, 'data-fk': 'name',
      onInput: (e) => queue(e.target.value.trim()),
      onBlur: () => queue.flush(),
      onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); queue.flush(); } },
    });
    append(body, field('Name', inp, { hint: 'Used for your greeting on Today.' }));
  }

  // ------------------------------------------------------------------ Appearance
  function drawAppearance(body, b) {
    const s = S();
    append(body, 
      h('div.settings-rows',
        field('Theme', segmented(
          [{ value: 'system', label: 'System', icon: 'monitor' }, { value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'moon' }],
          s.theme || 'system', (v) => save(b, { theme: v }), { ariaLabel: 'Theme', block: true },
        ), { hint: 'System follows your device’s light/dark setting.' }),
        field('Week starts on', segmented(
          [{ value: 1, label: 'Monday' }, { value: 0, label: 'Sunday' }],
          Number(s.weekStart) === 0 ? 0 : 1, (v) => save(b, { weekStart: v }), { ariaLabel: 'Week starts on', block: true },
        ), { hint: 'Used by week views, streaks and weekly reviews.' }),
      ),
    );
  }

  // ------------------------------------------------------------------ Regional
  function drawRegional(body, b) {
    const s = S();
    const codes = new Set(CURRENCIES.map((c) => c.code));
    const opts = CURRENCIES.map((c) => ({ value: c.code, label: `${c.code} · ${c.name} (${currencySymbol(c.code)})` }));
    if (s.currency && !codes.has(s.currency)) opts.unshift({ value: s.currency, label: s.currency });
    const preview = h('span.num');
    const setPreview = (code) => preview.replaceChildren(fmtMoney(1234.5, { currency: code }));
    setPreview(s.currency);
    const cur = select(opts, s.currency, (v) => { setPreview(v); save(b, { currency: v }); }, { 'data-fk': 'currency' });
    append(body, 
      h('div.settings-rows',
        field('Currency', cur, { hint: h('span', 'Example: ', preview, ' — amounts are not converted.') }),
        h('div.form-grid',
          field('Weight', segmented([{ value: 'kg', label: 'kg' }, { value: 'lb', label: 'lb' }], s.units?.weight || 'kg',
            (v) => save(b, { units: { weight: v } }), { ariaLabel: 'Weight unit', block: true })),
          field('Distance', segmented([{ value: 'km', label: 'km' }, { value: 'mi', label: 'mi' }], s.units?.distance || 'km',
            (v) => save(b, { units: { distance: v } }), { ariaLabel: 'Distance unit', block: true })),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ Daily targets
  const TARGETS = [
    { key: 'calories', label: 'Calories', unit: 'kcal', step: 50, max: 10000, hint: 'Daily energy target (Food ring).' },
    { key: 'protein', label: 'Protein', unit: 'g', step: 5, max: 500 },
    { key: 'water', label: 'Water', unit: 'glasses', step: 1, max: 40, hint: (t) => `≈ ${fmtNumber(((t.water || 0) * (t.glassMl || 250)) / 1000, { maxDecimals: 2 })} L a day` },
    { key: 'glassMl', label: 'Glass size', unit: 'ml', step: 50, min: 50, max: 2000 },
    { key: 'trainingMinutes', label: 'Training per day', unit: 'min', step: 5, max: 600 },
    { key: 'weeklyTrainingMinutes', label: 'Training per week', unit: 'min', step: 15, max: 3000 },
    { key: 'sleep', label: 'Sleep', unit: 'h', step: 0.5, max: 14 },
    { key: 'steps', label: 'Steps', unit: 'steps', step: 500, max: 100000 },
  ];
  function drawTargets(body, b) {
    const t = S().targets || {};
    let pending = {};
    const flush = debounce(() => {
      const patch = pending;
      pending = {};
      if (Object.keys(patch).length) save(b, { targets: patch });
    }, 450);
    cleanups.push(() => flush.flush());
    const hints = [];
    const queue = (key, v) => {
      pending[key] = v;
      hints.forEach((fn) => fn({ ...S().targets, ...pending }));
      flush();
    };
    const grid = h('div.form-grid.settings-targets');
    for (const d of TARGETS) {
      const st = stepper(t[d.key] ?? DEFAULT_SETTINGS.targets[d.key], (v) => { if (v !== null && v >= (d.min || 0)) queue(d.key, v); },
        { min: d.min || 0, max: d.max, step: d.step, unit: d.unit, label: d.label, inputProps: { 'data-fk': `t-${d.key}` } });
      const f = field(d.label, st, { hint: typeof d.hint === 'string' ? d.hint : undefined });
      if (typeof d.hint === 'function') {
        const fn = (tt) => f.setHint(d.hint(tt));
        fn(t);
        hints.push(fn);
      }
      grid.append(f);
    }
    for (const [key, label, hint] of [
      ['dailySpend', 'Daily spending limit', 'Leave empty for no limit. Shown on the Expenses chart.'],
      ['monthlyBudget', 'Monthly budget', 'Leave empty for no budget.'],
    ]) {
      const mi = moneyInput(t[key] || null, (v) => queue(key, v && v > 0 ? v : 0), { 'data-fk': `t-${key}`, 'aria-label': label });
      grid.append(field(label, mi, { hint }));
    }
    append(body, grid);
  }

  // ------------------------------------------------------------------ Category lists
  async function usageCount(listKey, id) {
    try {
      if (listKey === 'expenseCategories' || listKey === 'incomeCategories') {
        const type = listKey === 'incomeCategories' ? 'income' : 'expense';
        return (await db.all('expenses')).filter((r) => (r.type === 'income' ? 'income' : 'expense') === type && r.category === id).length;
      }
      if (listKey === 'learningCategories') return (await db.all('learning')).filter((r) => r.category === id).length;
      if (listKey === 'workoutTypes') return (await db.all('workouts')).filter((r) => r.type === id).length;
    } catch {
      /* ignore */
    }
    return 0;
  }

  function colorPicker(value, onChange) {
    const colors = PALETTE.includes(value) || !value ? PALETTE : [value, ...PALETTE];
    let current = value || PALETTE[0];
    const btns = colors.map((c) => h('button.settings-swatch', {
      type: 'button', role: 'radio', 'aria-label': `Colour ${c}`, 'aria-checked': String(c === current), tabindex: c === current ? '0' : '-1',
      style: { '--swatch': c }, dataset: { color: c },
      onClick: () => pick(c, true),
    }));
    function pick(c, focus) {
      current = c;
      btns.forEach((x) => {
        const on = x.dataset.color === c;
        x.setAttribute('aria-checked', String(on));
        x.tabIndex = on ? 0 : -1;
        if (on && focus) x.focus();
      });
      onChange(c);
    }
    const el = h('div.settings-swatches', {
      role: 'radiogroup',
      onKeydown: (e) => {
        const i = colors.indexOf(current);
        const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!delta) return;
        e.preventDefault();
        pick(colors[(i + delta + colors.length) % colors.length], true);
      },
    }, btns);
    return el;
  }

  function openCategoryEditor(listKey, cat, { noun, budget }) {
    const list = S()[listKey] || [];
    const isNew = !cat;
    const draft = { name: '', emoji: (EMOJI_SUGGEST[listKey] || ['✨'])[0], color: PALETTE[(list.length * 5) % PALETTE.length], ...(budget ? { budget: 0 } : {}), ...cat };
    const prevChip = h('span.emoji-chip.icon-chip-lg', { 'aria-hidden': 'true' });
    const prevName = h('span.settings-cat-preview-name');
    const sync = () => {
      prevChip.textContent = draft.emoji || '•';
      prevChip.style.setProperty('--accent', draft.color);
      prevName.textContent = draft.name.trim() || `New ${noun}`;
    };
    const nameIn = input({ value: draft.name, maxlength: 40, autocomplete: 'off', placeholder: 'e.g. Coffee', onInput: (e) => { draft.name = e.target.value; nameF.setError(null); sync(); } });
    const nameF = field('Name', nameIn, { required: true });
    const emojiIn = input({ value: draft.emoji, maxlength: 16, autocomplete: 'off', class: 'settings-emoji-input', onInput: (e) => { draft.emoji = e.target.value.trim(); emojiF.setError(null); sync(); } });
    const emojiF = field('Emoji', emojiIn, { hint: 'Type or paste any emoji, or tap one below.' });
    const suggest = h('div.settings-emoji-suggest', { role: 'group', 'aria-label': 'Suggested emoji' },
      (EMOJI_SUGGEST[listKey] || []).map((em) => h('button.settings-emoji-btn', { type: 'button', 'aria-label': `Use ${em}`, onClick: () => { draft.emoji = em; emojiIn.value = em; sync(); } }, em)));
    const colorF = field('Colour', colorPicker(draft.color, (c) => { draft.color = c; sync(); }));
    let budgetF = null;
    if (budget) {
      budgetF = field('Monthly budget', moneyInput(draft.budget || null, (v) => { draft.budget = v && v > 0 ? v : 0; }, { 'aria-label': 'Monthly budget' }), { hint: 'Optional — shows a budget bar on Expenses.' });
    }
    sync();
    const form = h('form.stack.settings-cat-form',
      h('div.settings-cat-preview', prevChip, prevName),
      nameF, h('div.stack-sm', emojiF, suggest), colorF, budgetF);

    return openSheet({
      title: isNew ? `New ${noun}` : `Edit ${noun}`,
      icon: 'edit',
      content: form,
      className: 'settings-sheet',
      initialFocus: nameIn,
      actions: [
        { label: 'Cancel', variant: 'secondary' },
        {
          label: isNew ? 'Add' : 'Save', variant: 'primary',
          onClick: async () => {
            const name = draft.name.trim();
            if (!name) { nameF.setError('Give it a name'); nameIn.focus(); return false; }
            const cur = S()[listKey] || [];
            if (cur.some((c) => c.id !== (cat && cat.id) && lower(c.name) === lower(name))) { nameF.setError('You already have one with that name'); nameIn.focus(); return false; }
            if (!draft.emoji) { emojiF.setError('Pick an emoji'); emojiIn.focus(); return false; }
            const rec = { ...draft, name };
            let next;
            if (isNew) {
              rec.id = slugId(name, cur.map((c) => c.id));
              const otherIdx = cur.findIndex((c) => c.id === 'other'); // keep 'Other' last
              next = otherIdx >= 0 ? [...cur.slice(0, otherIdx), rec, ...cur.slice(otherIdx)] : [...cur, rec];
            } else {
              next = cur.map((c) => (c.id === cat.id ? rec : c));
            }
            return { next, rec };
          },
        },
      ],
    }).result;
  }

  function drawCategoryList(body, b, { listKey, noun, budget }) {
    const list = S()[listKey] || [];
    const rows = list.map((c) => {
      const meta = [];
      if (budget) meta.push(c.budget > 0 ? `Budget ${fmtMoney(c.budget)}/month` : 'No budget');
      if (c.id === 'other') meta.push('Default for unknown entries');
      return h('div.list-item.settings-item', { dataset: { id: c.id } },
        h('span.emoji-chip', { style: { '--accent': colorVar(c.color) }, 'aria-hidden': 'true' }, c.emoji || '•'),
        h('div.list-item-main', h('div.list-item-title', c.name), meta.length ? h('div.list-item-meta', meta.join(' · ')) : null),
        h('div.settings-item-actions',
          button({ icon: 'edit', variant: 'ghost', size: 'sm', ariaLabel: `Edit ${c.name}`, label: '', 'data-fk': `edit-${c.id}`, onClick: () => edit(c) }),
          c.id === 'other'
            ? h('span.settings-item-lock', { title: 'The fallback category can’t be deleted' }, icon('lock', { size: 16 }), h('span.sr-only', `${c.name} can’t be deleted`))
            : button({ icon: 'trash', variant: 'ghost', size: 'sm', ariaLabel: `Delete ${c.name}`, label: '', class: 'settings-del', 'data-fk': `del-${c.id}`, onClick: () => remove(c) }),
        ),
      );
    });
    append(body, 
      h('div.list.settings-list', rows),
      h('div.settings-list-foot',
        button({ label: `Add ${noun}`, icon: 'plus', variant: 'secondary', size: 'sm', 'data-fk': 'add', onClick: () => edit(null) }),
        h('span.muted.text-sm', plural(list.length, noun.split(' ').pop())),
      ),
    );

    async function edit(c) {
      const res = await openCategoryEditor(listKey, c, { noun, budget });
      if (!res || disposed) return;
      await save(b, { [listKey]: res.next }, { redraw: true, focus: c ? `edit-${c.id}` : `edit-${res.rec.id}` });
      if (!c) toast(`${res.rec.emoji} ${res.rec.name} added`, { type: 'success' });
    }
    async function remove(c) {
      const n = await usageCount(listKey, c.id);
      const ok = await confirmDialog({
        title: `Delete “${c.name}”?`,
        message: n
          ? `${plural(n, 'entry', 'entries')} use${n === 1 ? 's' : ''} this ${noun}. They’ll be kept and shown as “Other”.`
          : `No entries use this ${noun}.`,
        confirmLabel: `Delete ${noun}`,
      });
      if (!ok || disposed) return;
      const before = S()[listKey] || [];
      const next = before.filter((x) => x.id !== c.id);
      if (await save(b, { [listKey]: next }, { redraw: true, focus: 'add' })) {
        toast(`${c.name} deleted`, { action: { label: 'Undo', onClick: () => updateSettings({ [listKey]: before }) } });
      }
    }
  }

  // ------------------------------------------------------------------ String lists (chips)
  /** Editable chip list. get() → current array; set(next) persists. */
  function stringList({ list, fk, noun, placeholder, min = 0, onSave }) {
    const items = list.map((s, i) => h('span.settings-pill', { dataset: { value: s } },
      h('span.settings-pill-text', s),
      h('button.settings-pill-x', {
        type: 'button', 'aria-label': `Remove ${s}`, 'data-fk': `x-${fk}-${i}`,
        disabled: list.length <= min, title: list.length <= min ? `Keep at least ${min}` : null,
        onClick: async () => {
          const next = list.filter((x) => x !== s);
          if (await onSave(next, `x-${fk}-${Math.min(i, next.length - 1)}`)) {
            toast(`Removed “${s}”`, { action: { label: 'Undo', onClick: () => onSave(list, `x-${fk}-${i}`) } });
          }
        },
      }, icon('x', { size: 14 })),
    ));
    const inp = input({ placeholder, maxlength: 40, autocomplete: 'off', 'aria-label': `New ${noun}`, 'data-fk': `add-${fk}`, enterkeyhint: 'done' });
    const err = h('div.field-error', { hidden: true, role: 'alert' });
    const add = async (e) => {
      e.preventDefault();
      const v = inp.value.trim().replace(/\s+/g, ' ');
      if (!v) { inp.focus(); return; }
      if (list.some((x) => lower(x) === lower(v))) {
        err.hidden = false;
        err.textContent = `“${v}” is already on the list`;
        inp.focus();
        return;
      }
      await onSave([...list, v], `add-${fk}`);
    };
    inp.addEventListener('input', () => { err.hidden = true; });
    return h('div.settings-strings',
      items.length ? h('div.settings-pills', { role: 'list', 'aria-label': `${noun}s` }, items.map((x) => { x.setAttribute('role', 'listitem'); return x; }))
        : h('p.muted.text-sm', `No ${noun}s yet.`),
      h('form.settings-add-row', { onSubmit: add }, inp, button({ label: 'Add', icon: 'plus', type: 'submit', variant: 'secondary' })),
      err,
    );
  }

  function drawPayments(body, b) {
    append(body, stringList({
      list: S().paymentMethods || [], fk: 'pay', noun: 'payment method', placeholder: 'e.g. Credit card', min: 1,
      onSave: (next, focus) => save(b, { paymentMethods: next }, { redraw: true, focus }),
    }));
  }

  // ------------------------------------------------------------------ Trading
  function openAccountEditor(acc) {
    const t = S().trading || {};
    const isNew = !acc;
    const draft = { name: '', broker: '', startingBalance: 0, ...acc };
    let makeDefault = !isNew && t.defaultAccountId === acc.id;
    const nameIn = input({ value: draft.name, maxlength: 40, autocomplete: 'off', placeholder: 'e.g. Swing account', onInput: (e) => { draft.name = e.target.value; nameF.setError(null); } });
    const nameF = field('Account name', nameIn, { required: true });
    const brokerIn = input({ value: draft.broker || '', maxlength: 40, autocomplete: 'off', placeholder: 'Optional', onInput: (e) => { draft.broker = e.target.value; } });
    const tcur = t.currency || S().currency;
    const bal = moneyInput(draft.startingBalance || null, (v) => { draft.startingBalance = v && v > 0 ? v : 0; }, { currency: tcur, 'aria-label': 'Starting balance' });
    const def = h('label.settings-check',
      h('input', { type: 'checkbox', checked: makeDefault, onChange: (e) => { makeDefault = e.target.checked; } }),
      h('span', 'Use as default for new trades'));
    return openSheet({
      title: isNew ? 'New trading account' : 'Edit account',
      icon: 'wallet', accent: '--trades', className: 'settings-sheet', initialFocus: nameIn,
      content: h('form.stack', nameF, field('Broker', brokerIn), field('Starting balance', bal, { hint: 'Used as the start of your equity curve.' }), def),
      actions: [
        { label: 'Cancel', variant: 'secondary' },
        {
          label: isNew ? 'Add account' : 'Save', variant: 'primary',
          onClick: () => {
            const name = draft.name.trim();
            if (!name) { nameF.setError('Name the account'); nameIn.focus(); return false; }
            const cur = (S().trading || {}).accounts || [];
            if (cur.some((a) => a.id !== (acc && acc.id) && lower(a.name) === lower(name))) { nameF.setError('You already have an account with that name'); nameIn.focus(); return false; }
            const rec = { ...draft, name, broker: (draft.broker || '').trim(), startingBalance: Number(draft.startingBalance) || 0 };
            if (isNew) rec.id = slugId(name, cur.map((a) => a.id));
            const next = isNew ? [...cur, rec] : cur.map((a) => (a.id === acc.id ? rec : a));
            return { next, rec, makeDefault };
          },
        },
      ],
    }).result;
  }

  function drawTrading(body, b) {
    const s = S();
    const t = s.trading || {};
    const accounts = Array.isArray(t.accounts) && t.accounts.length ? t.accounts : DEFAULT_SETTINGS.trading.accounts;
    const sub = (title, hint, ...kids) => h('div.settings-sub', h('h3.settings-sub-title', title), hint ? h('p.settings-sub-hint', hint) : null, ...kids);
    const tsave = (patch, opts) => save(b, { trading: patch }, opts);

    // Currency + risk
    const curOpts = [{ value: '', label: `Same as app (${s.currency})` }, ...CURRENCIES.map((c) => ({ value: c.code, label: `${c.code} · ${c.name} (${currencySymbol(c.code)})` }))];
    const curSel = select(curOpts, t.currency || '', (v) => tsave({ currency: v || null }, { redraw: true, focus: 'tcur' }), { 'data-fk': 'tcur' });
    const riskQ = debounce((v) => { if (v !== null && v > 0) tsave({ riskPercent: v }); }, 400);
    cleanups.push(() => riskQ.flush());
    const risk = stepper(t.riskPercent ?? 1, riskQ,
      { min: 0.05, max: 100, step: 0.25, decimals: 2, unit: '%', label: 'Risk per trade', inputProps: { 'data-fk': 'risk' } });
    append(body, h('div.form-grid',
      field('Trading currency', curSel, { hint: 'For P&L, fees and balances.' }),
      field('Risk per trade', risk, { hint: '% of account you plan to risk.' }),
    ));

    // Accounts
    const accRows = accounts.map((a) => h('div.list-item.settings-item',
      iconChip('wallet', { accent: '--trades', size: 'sm' }),
      h('div.list-item-main',
        h('div.list-item-title', a.name, a.id === t.defaultAccountId ? badge('Default', 'accent', { size: 'sm' }) : null),
        h('div.list-item-meta', [a.broker, `Starting ${fmtTradeMoney(a.startingBalance || 0)}`].filter(Boolean).join(' · '))),
      h('div.settings-item-actions',
        button({ icon: 'edit', variant: 'ghost', size: 'sm', label: '', ariaLabel: `Edit ${a.name}`, 'data-fk': `acc-edit-${a.id}`, onClick: () => editAcc(a) }),
        button({ icon: 'trash', variant: 'ghost', size: 'sm', label: '', ariaLabel: `Delete ${a.name}`, class: 'settings-del', disabled: accounts.length <= 1, title: accounts.length <= 1 ? 'Keep at least one account' : null, onClick: () => delAcc(a) }),
      )));
    const defSel = accounts.length > 1
      ? field('Default account', select(accounts.map((a) => ({ value: a.id, label: a.name })), t.defaultAccountId || accounts[0].id,
        (v) => tsave({ defaultAccountId: v }, { redraw: true, focus: 'defacc' }), { 'data-fk': 'defacc' }))
      : null;
    append(body, sub('Accounts', 'Each trade belongs to an account.',
      h('div.list.settings-list', accRows),
      h('div.settings-list-foot', button({ label: 'Add account', icon: 'plus', size: 'sm', 'data-fk': 'add-acc', onClick: () => editAcc(null) })),
      defSel));

    async function editAcc(a) {
      const res = await openAccountEditor(a);
      if (!res || disposed) return;
      const patch = { accounts: res.next };
      if (res.makeDefault) patch.defaultAccountId = res.rec.id;
      await tsave(patch, { redraw: true, focus: `acc-edit-${res.rec.id}` });
      if (!a) toast(`${res.rec.name} added`, { type: 'success' });
    }
    async function delAcc(a) {
      let n = 0;
      try { n = (await db.all('trades')).filter((x) => (x.accountId || 'main') === a.id).length; } catch { /* ignore */ }
      const ok = await confirmDialog({
        title: `Delete “${a.name}”?`,
        message: n ? `${plural(n, 'trade')} belong${n === 1 ? 's' : ''} to this account. They stay in your journal.` : 'No trades use this account.',
        confirmLabel: 'Delete account',
      });
      if (!ok || disposed) return;
      const cur = (S().trading || {}).accounts || [];
      const next = cur.filter((x) => x.id !== a.id);
      if (!next.length) return;
      const patch = { accounts: next };
      if ((S().trading || {}).defaultAccountId === a.id) patch.defaultAccountId = next[0].id;
      await tsave(patch, { redraw: true, focus: 'add-acc' });
    }

    // Rules
    const rules = Array.isArray(t.rules) ? t.rules : [];
    const moveRule = (i, d) => {
      const next = rules.slice();
      const [r] = next.splice(i, 1);
      next.splice(i + d, 0, r);
      tsave({ rules: next }, { redraw: true, focus: `rule-${d < 0 ? 'up' : 'down'}-${r.id}` });
    };
    const ruleRows = rules.map((r, i) => h('div.list-item.settings-item.settings-rule',
      h('span.settings-rule-n', { 'aria-hidden': 'true' }, String(i + 1)),
      h('div.list-item-main', h('div.list-item-title.settings-rule-text', r.text)),
      h('div.settings-item-actions',
        button({ icon: 'chevron-up', variant: 'ghost', size: 'sm', label: '', ariaLabel: `Move “${r.text}” up`, disabled: i === 0, 'data-fk': `rule-up-${r.id}`, onClick: () => moveRule(i, -1) }),
        button({ icon: 'chevron-down', variant: 'ghost', size: 'sm', label: '', ariaLabel: `Move “${r.text}” down`, disabled: i === rules.length - 1, 'data-fk': `rule-down-${r.id}`, onClick: () => moveRule(i, 1) }),
        button({ icon: 'edit', variant: 'ghost', size: 'sm', label: '', ariaLabel: `Edit rule “${r.text}”`, 'data-fk': `rule-edit-${r.id}`, onClick: () => editRule(r) }),
        button({ icon: 'trash', variant: 'ghost', size: 'sm', label: '', ariaLabel: `Delete rule “${r.text}”`, class: 'settings-del', onClick: () => delRule(r) }),
      )));
    const ruleIn = input({ placeholder: 'e.g. No trading after a 2R loss', maxlength: 120, autocomplete: 'off', 'aria-label': 'New rule', 'data-fk': 'add-rule', enterkeyhint: 'done' });
    append(body, sub('Trading rules', 'Your checklist on the Daily plan.',
      rules.length ? h('div.list.settings-list', ruleRows) : h('p.muted.text-sm', 'No rules yet — add the ones you want to check every day.'),
      h('form.settings-add-row', {
        onSubmit: (e) => {
          e.preventDefault();
          const text = ruleIn.value.trim();
          if (!text) { ruleIn.focus(); return; }
          tsave({ rules: [...rules, { id: `r-${uid().slice(0, 8)}`, text }] }, { redraw: true, focus: 'add-rule' });
        },
      }, ruleIn, button({ label: 'Add', icon: 'plus', type: 'submit' }))));

    async function editRule(r) {
      const text = await promptDialog({ title: 'Edit rule', label: 'Rule', value: r.text, inputProps: { maxlength: 120 }, validate: (v) => (v ? null : 'Write the rule') });
      if (text === null || disposed || text === r.text) return;
      const cur = (S().trading || {}).rules || [];
      tsave({ rules: cur.map((x) => (x.id === r.id ? { ...x, text } : x)) }, { redraw: true, focus: `rule-edit-${r.id}` });
    }
    async function delRule(r) {
      const before = (S().trading || {}).rules || [];
      if (await tsave({ rules: before.filter((x) => x.id !== r.id) }, { redraw: true, focus: 'add-rule' })) {
        toast('Rule deleted', { action: { label: 'Undo', onClick: () => updateSettings({ trading: { rules: before } }) } });
      }
    }

    // Setups / mistakes / emotions
    for (const [key, title, noun, ph] of [
      ['setups', 'Setups', 'setup', 'e.g. Opening range breakout'],
      ['mistakes', 'Mistakes', 'mistake', 'e.g. Sized up after a win'],
      ['emotions', 'Emotions', 'emotion', 'e.g. Hesitant'],
    ]) {
      append(body, sub(title, null, stringList({
        list: Array.isArray(t[key]) ? t[key] : [], fk: key, noun, placeholder: ph,
        onSave: (next, focus) => tsave({ [key]: next }, { redraw: true, focus }),
      })));
    }
  }

  // ------------------------------------------------------------------ Data & backup
  let lastRestore = null; // {mode, counts, at}
  function drawData(body, b) {
    const s = S();
    const every = Number(s.backupReminderDays ?? 7);
    const last = s.lastBackupAt;
    const lastMs = Date.parse(last);
    const ageDays = Number.isFinite(lastMs) ? (Date.now() - lastMs) / 86400000 : null;
    const due = ageDays === null || (every > 0 && ageDays >= every);
    const tone = ageDays === null ? 'warning' : due ? 'warning' : 'success';

    // Status + main actions
    const status = h('div.settings-backup-status', { class: `is-${tone}` },
      h('span.settings-backup-icon', icon(tone === 'success' ? 'check-circle' : 'alert', { size: 20 })),
      h('div.settings-backup-text',
        h('div.settings-backup-title', ageDays === null ? 'No backup yet' : `Last backup ${relativeTime(last)}`),
        h('div.settings-backup-sub', ageDays === null
          ? 'Your journal lives only on this device. Save a backup file somewhere safe (Drive, email, a computer).'
          : `${fmtDate(toKey(last), 'mediumYear')} · ${due ? 'Time for a fresh one.' : 'You’re covered.'}`)));

    const dl = button({ label: 'Download backup', icon: 'download', variant: 'primary', 'data-fk': 'backup-download', onClick: (e) => withBusy(e.currentTarget, doDownload) });
    const canShare = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
    const sh = canShare ? button({ label: 'Share backup', icon: 'share', 'data-fk': 'backup-share', onClick: (e) => withBusy(e.currentTarget, doShare) }) : null;
    const fileIn = h('input', { type: 'file', accept: '.json,.txt,application/json,text/plain', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', 'data-testid': 'restore-file', onChange: (e) => onFile(e.target) });
    const rs = button({ label: 'Restore from file', icon: 'upload', 'data-fk': 'backup-restore', onClick: () => fileIn.click() });
    const reminder = select(REMINDERS, REMINDERS.some((r) => r.value === every) ? every : 7, (v) => save(b, { backupReminderDays: v }, { redraw: true, focus: 'reminder' }), { 'data-fk': 'reminder' });

    append(body, 
      status,
      h('div.settings-actions', dl, sh, rs, fileIn),
      lastRestore ? h('div.callout.settings-restore-result', { role: 'status' }, icon('check-circle', { size: 18 }),
        h('span', `Restored ${relativeTime(lastRestore.at)} (${lastRestore.mode}): ${restoreSummary(lastRestore.counts)}.`)) : null,
      h('div.form-grid', field('Backup reminder', reminder, { hint: 'A gentle banner on Today when a backup is due.' })),
    );

    // Async parts
    const storageEl = h('div.settings-storage', h('p.muted.text-sm', 'Checking storage…'));
    const countsEl = h('div.settings-counts');
    const csvEl = h('div.settings-csv');
    const sampleEl = h('div.settings-sample');
    const sub = (title, hint, ...kids) => h('div.settings-sub', h('h3.settings-sub-title', title), hint ? h('p.settings-sub-hint', hint) : null, ...kids);
    append(body, 
      sub('Export to CSV', 'Open in Excel, Numbers or Google Sheets.', csvEl),
      sub('Storage', null, storageEl, countsEl),
      sub('Sample data', null, sampleEl),
      h('div.settings-sub.settings-danger',
        h('h3.settings-sub-title', 'Danger zone'),
        h('p.settings-sub-hint', 'Permanently erase every entry, photo and setting on this device.'),
        button({ label: 'Delete everything…', icon: 'trash', variant: 'danger', 'data-fk': 'delete-all', onClick: openDeleteAll })),
    );
    fillData({ storageEl, countsEl, csvEl, sampleEl });
    b.fillCounts = () => fillData({ storageEl, countsEl, csvEl, sampleEl, quick: true });
  }

  function restoreSummary(counts) {
    const parts = Object.entries(counts || {}).filter(([k, n]) => n > 0 && k !== 'meta').map(([k, n]) => `${fmtNumber(n)} ${lower(STORE_LABELS[k] || k)}`);
    return parts.length ? parts.join(', ') : 'nothing new to add';
  }

  async function storeCounts() {
    const out = {};
    await Promise.all(STORES.filter((n) => n !== 'meta').map(async (n) => { try { out[n] = await db.count(n); } catch { out[n] = 0; } }));
    return out;
  }

  let fillSeq = 0;
  async function fillData({ storageEl, countsEl, csvEl, sampleEl, quick = false }) {
    const seq = ++fillSeq;
    const [counts, sample] = await Promise.all([storeCounts(), import('./sample-data.js').then((m) => m.hasSampleData()).catch(() => false)]);
    if (disposed || seq !== fillSeq) return;

    // CSV
    mount(csvEl, h('div.settings-csv-grid', CSV_EXPORTS.map((x) => {
      const n = counts[x.store] || 0;
      return h('button.settings-csv-btn', {
        type: 'button', style: { '--accent': colorVar(x.color) }, 'data-fk': `csv-${x.store}`,
        'aria-label': `Export ${x.label} as CSV (${plural(n, 'row')})`,
        onClick: (e) => withBusy(e.currentTarget, async () => {
          if (!n) { toast(`No ${lower(x.label)} entries to export yet.`); return; }
          try {
            const r = await exportCSV(x.store);
            toast(`Exported ${plural(r.count, 'row')} · ${r.filename}`, { type: 'success' });
          } catch (err) {
            console.error(err);
            toast('Export failed. Please try again.', { type: 'error' });
          }
        }),
      }, iconChip(x.icon, { accent: x.color, size: 'sm' }), h('span.settings-csv-label', x.label), h('span.settings-csv-n.num', fmtNumber(n)), icon('download', { size: 16 }));
    })));

    // Counts
    const total = Object.values(counts).reduce((a, n) => a + n, 0);
    mount(countsEl, h('details.settings-counts-details',
      h('summary', h('span', `${fmtNumber(total)} records on this device`), icon('chevron-down', { size: 16 })),
      kv(Object.entries(counts).map(([k, n]) => [STORE_LABELS[k] || k, fmtNumber(n)]), { grid: true, class: 'settings-kv' })));

    // Sample
    mount(sampleEl, sample
      ? h('div.settings-sample-row',
        h('p.text-sm.subtle', 'Sample entries are loaded. Removing them keeps everything you added yourself.'),
        button({ label: 'Remove sample data', icon: 'trash', variant: 'secondary', 'data-fk': 'sample', onClick: (e) => removeSample(e.currentTarget) }))
      : h('div.settings-sample-row',
        h('p.text-sm.subtle', 'Try Daybook with ~2½ months of realistic demo entries. They’re marked as samples and can be removed anytime.'),
        button({ label: 'Load sample data', icon: 'sparkles', variant: 'secondary', 'data-fk': 'sample', onClick: (e) => loadSample(e.currentTarget) })));

    if (quick) return;
    // Storage estimate + persistence
    const st = navigator.storage;
    let est = null;
    let persisted = null;
    try { if (st && st.estimate) est = await st.estimate(); } catch { /* ignore */ }
    try { if (st && st.persisted) persisted = await st.persisted(); } catch { /* ignore */ }
    if (disposed || seq !== fillSeq) return;
    const usage = est && Number(est.usage);
    const quota = est && Number(est.quota);
    const frac = usage && quota ? Math.min(1, usage / quota) : 0;
    const persistRow = !st || !st.persist
      ? h('p.text-sm.muted', 'This browser doesn’t support persistent storage. Regular backups keep you safe.')
      : persisted
        ? h('div.settings-persist.is-on', icon('shield', { size: 18 }), h('span', h('strong', 'Persistent storage is on. '), 'Your browser won’t clear Daybook to free up space.'))
        : h('div.settings-persist',
          icon('shield', { size: 18 }),
          h('span', h('strong', 'Keep data persistent. '), 'Ask the browser not to clear Daybook when the device runs low on space.'),
          button({ label: 'Turn on', size: 'sm', 'data-fk': 'persist', onClick: (e) => withBusy(e.currentTarget, requestPersist) }));
    mount(storageEl,
      est ? h('div.settings-usage',
        h('div.row-between', h('span.text-sm', h('strong.num', fmtBytes(usage)), ' used'), quota ? h('span.text-sm.muted.num', `of ${fmtBytes(quota)} available`) : null),
        h('div.progress', { role: 'img', 'aria-label': `${fmtBytes(usage)} used` }, h('div.progress-fill', { style: { width: `${Math.max(frac * 100, usage ? 1 : 0)}%` } })))
        : h('p.text-sm.muted', 'Storage usage isn’t available in this browser.'),
      persistRow);
  }

  async function requestPersist() {
    let ok = false;
    try { ok = await navigator.storage.persist(); } catch { ok = false; }
    if (ok) toast('Persistent storage is on', { type: 'success' });
    else toast('Your browser declined for now — installing the app or using it often usually helps. Keep backing up!', { duration: 6000 });
    const d = blocks.find((x) => x.id === 'data');
    if (d && !disposed) d.redraw({ focus: 'backup-download' });
  }

  async function doDownload() {
    try {
      const r = await downloadBackup();
      toast(`Backup saved · ${r.filename} (${fmtBytes(r.bytes)})`, { type: 'success', duration: 5000 });
    } catch (err) {
      console.error(err);
      toast('Backup failed. Please try again.', { type: 'error' });
    }
  }
  async function doShare() {
    try {
      const r = await shareBackup();
      if (r.method === 'share') toast('Backup shared', { type: 'success' });
      else if (r.method === 'download') toast(`Sharing isn’t available — downloaded ${r.filename} instead`, { type: 'success' });
    } catch (err) {
      console.error(err);
      toast('Couldn’t share the backup. Try Download instead.', { type: 'error' });
    }
  }

  async function onFile(inputEl) {
    const file = inputEl.files && inputEl.files[0];
    inputEl.value = '';
    if (!file) return;
    let data;
    try {
      const text = await file.text();
      data = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      toast('That file isn’t a valid Daybook backup (it couldn’t be read).', { type: 'error', duration: 6000 });
      return;
    }
    const problem = backupProblem(data);
    if (problem) { toast(problem, { type: 'error', duration: 6000 }); return; }
    openRestore(file, data);
  }

  function openRestore(file, data) {
    const counts = backupCounts(data);
    const hasSettings = Array.isArray(data.stores.meta) && data.stores.meta.some((r) => r && r.key === 'settings');
    const entries = Object.entries(counts).filter(([k]) => k !== 'meta');
    const total = entries.reduce((a, [, n]) => a + n, 0);
    let mode = 'merge';
    let saveFirst = true;
    const exported = Date.parse(data.exportedAt);

    const option = (value, title, text, iconName, rec) => h('label.settings-mode', { class: { 'is-selected': mode === value } },
      h('input', { type: 'radio', name: 'restore-mode', value, checked: mode === value, onChange: () => setMode(value) }),
      h('span.settings-mode-icon', icon(iconName, { size: 20 })),
      h('span.settings-mode-text', h('span.settings-mode-title', title, rec ? badge('Recommended', 'accent', { size: 'sm' }) : null), h('span.settings-mode-sub', text)));
    const modes = h('div.settings-modes', { role: 'radiogroup', 'aria-label': 'How to restore' },
      option('merge', 'Merge', 'Adds what’s missing and keeps the newer version of each entry. Nothing on this device is deleted.', 'layers', true),
      option('replace', 'Replace', 'Erases everything on this device first, then restores this backup exactly — settings included.', 'refresh', false));
    const saveFirstEl = h('label.settings-check', { hidden: true },
      h('input', { type: 'checkbox', checked: true, onChange: (e) => { saveFirst = e.target.checked; } }),
      h('span', 'Download a backup of my current data first'));
    function setMode(v) {
      mode = v;
      modes.querySelectorAll('.settings-mode').forEach((l) => l.classList.toggle('is-selected', l.querySelector('input').value === v));
      saveFirstEl.hidden = v !== 'replace';
      const btn = api.footer && [...api.footer.querySelectorAll('button')].find((x) => x.dataset.role === 'restore-go' || /Restore|Replace/.test(x.textContent));
      if (btn) {
        btn.dataset.role = 'restore-go';
        const span = btn.querySelector('span');
        if (span) span.textContent = v === 'replace' ? 'Replace & restore' : 'Restore';
        btn.classList.toggle('btn-primary', v !== 'replace');
        btn.classList.toggle('btn-danger-solid', v === 'replace');
      }
    }

    const content = h('div.stack.settings-restore',
      h('div.settings-restore-file', icon('file', { size: 20 }),
        h('div', h('div.text-strong.truncate', file.name),
          h('div.text-sm.muted', [Number.isFinite(exported) ? `Made ${fmtDate(toKey(exported), 'mediumYear')} (${relativeTime(data.exportedAt)})` : null, fmtBytes(file.size)].filter(Boolean).join(' · ')))),
      h('div.settings-sub-title', `This backup contains ${plural(total, 'record')}`),
      kv([...entries.map(([k, n]) => [STORE_LABELS[k] || k, fmtNumber(n)]), ['Settings', hasSettings ? 'Included' : 'Not included']], { grid: true, class: 'settings-kv settings-restore-counts' }),
      modes, saveFirstEl);

    const api = openSheet({
      title: 'Restore backup', subtitle: 'Choose how to bring this backup in.', icon: 'upload', className: 'settings-sheet', content,
      actions: [
        { label: 'Cancel', variant: 'secondary' },
        {
          label: 'Restore', variant: 'primary',
          onClick: async () => {
            if (mode === 'replace') {
              const ok = await confirmDialog({ title: 'Replace all data on this device?', message: 'Everything here will be erased and replaced by the backup. This can’t be undone.', confirmLabel: 'Replace everything' });
              if (!ok) return false;
              if (saveFirst) {
                try { await downloadBackup(); } catch (err) { console.error(err); toast('Couldn’t save a copy of current data — restore cancelled.', { type: 'error' }); return false; }
              }
            }
            try {
              const res = await importBackup(data, { mode });
              return { counts: res, mode };
            } catch (err) {
              console.error(err);
              toast(err && err.message ? err.message : 'Restore failed — nothing was changed.', { type: 'error', duration: 6000 });
              return false;
            }
          },
        },
      ],
    });
    api.result.then((res) => {
      if (!res) return;
      lastRestore = { ...res, at: new Date().toISOString() };
      const n = Object.entries(res.counts).filter(([k]) => k !== 'meta').reduce((a, [, x]) => a + x, 0);
      toast(res.mode === 'replace' ? `Restored ${plural(n, 'record')} from backup` : n ? `Merged ${plural(n, 'record')} from backup` : 'Already up to date — nothing new in that backup', { type: 'success', duration: 5000 });
      const d = blocks.find((x) => x.id === 'data');
      if (d && !disposed) d.redraw({ focus: 'backup-restore' });
    });
  }

  async function loadSample(btn) {
    const ok = await confirmDialog({
      title: 'Load sample data?', icon: 'sparkles', danger: false, confirmLabel: 'Load sample data',
      message: 'Adds about 75 days of demo meals, workouts, learnings, expenses and trades. Your own entries aren’t touched, and you can remove the samples anytime.',
    });
    if (!ok || disposed) return;
    await withBusy(btn, async () => {
      const t = toast('Creating sample data…', { duration: 20000 });
      try {
        const m = await import('./sample-data.js');
        const r = await m.loadSampleData();
        t.close();
        const n = Object.values(r.counts || {}).reduce((a, x) => a + x, 0);
        toast(`Sample data loaded · ${plural(n, 'record')}`, { type: 'success' });
      } catch (err) {
        t.close();
        console.error(err);
        toast('Couldn’t load sample data.', { type: 'error' });
      }
    });
  }
  async function removeSample(btn) {
    const ok = await confirmDialog({ title: 'Remove sample data?', message: 'Deletes the demo entries only. Everything you added yourself stays.', confirmLabel: 'Remove samples' });
    if (!ok || disposed) return;
    await withBusy(btn, async () => {
      try {
        const m = await import('./sample-data.js');
        const r = await m.removeSampleData();
        const n = Object.values(r || {}).reduce((a, x) => a + x, 0);
        toast(`Removed ${plural(n, 'sample record')}`, { type: 'success' });
      } catch (err) {
        console.error(err);
        toast('Couldn’t remove sample data.', { type: 'error' });
      }
    });
  }

  function openDeleteAll() {
    const conf = input({ autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'DELETE', 'data-testid': 'delete-confirm' });
    const confF = field('Type DELETE to confirm', conf);
    const content = h('form.stack.settings-delete',
      h('div.callout.settings-delete-warn', icon('alert', { size: 20 }),
        h('div', h('strong', 'This erases every entry, photo, goal and setting on this device.'), h('div.text-sm', sync.getStatus().signedIn ? 'It also signs this device out. Your synced copy stays safe in your account — sign in again to bring it back.' : 'It can’t be undone. Daybook will start fresh with the welcome screen.'))),
      h('div.settings-delete-backup', h('span.text-sm.subtle', 'Want a copy first?'),
        button({ label: 'Download backup', icon: 'download', size: 'sm', onClick: (e) => withBusy(e.currentTarget, doDownload) })),
      confF);
    let goBtn = null;
    const sync = () => {
      const ok = conf.value.trim() === 'DELETE';
      if (!goBtn && api.footer) goBtn = [...api.footer.querySelectorAll('button')].find((x) => /Delete everything/.test(x.textContent));
      if (goBtn) goBtn.disabled = !ok;
      confF.setError(null);
    };
    conf.addEventListener('input', sync);
    const api = openSheet({
      title: 'Delete everything?', icon: 'trash', accent: '--danger', className: 'settings-sheet', content, initialFocus: conf,
      actions: [
        { label: 'Cancel', variant: 'secondary' },
        {
          label: 'Delete everything', variant: 'danger-solid', icon: 'trash', align: 'end',
          onClick: async () => {
            if (conf.value.trim() !== 'DELETE') { confF.setError('Type DELETE in capital letters'); conf.focus(); return false; }
            try {
              await clearAllData();
            } catch (err) {
              console.error(err);
              toast('Couldn’t delete everything. Please try again.', { type: 'error' });
              return false;
            }
            return true;
          },
        },
      ],
    });
    sync();
    api.result.then((done) => {
      if (!done) return;
      toast('All data deleted. Fresh start!', { type: 'success' });
      navigate('/welcome', { replace: true });
    });
  }

  // ------------------------------------------------------------------ Install
  function drawInstall(body) {
    const standalone = html.classList.contains('is-standalone');
    const ios = html.classList.contains('is-ios');
    const prompt = window.daybook && window.daybook.installPrompt;
    if (standalone) {
      append(body, h('div.settings-install-state.is-on', icon('check-circle', { size: 20 }), h('span', h('strong', 'Installed ✓ '), 'You’re using the Daybook app.')));
    } else if (prompt) {
      append(body, 
        h('p.text-sm.subtle', 'Get Daybook on your home screen or dock. It opens instantly, works offline and feels like a native app.'),
        button({ label: 'Install Daybook', icon: 'install', variant: 'primary', 'data-fk': 'install', onClick: async () => {
          const p = window.daybook.installPrompt;
          if (!p) return;
          window.daybook.installPrompt = null; // a prompt can be used once
          try {
            await p.prompt();
            const choice = p.userChoice ? await p.userChoice : null;
            if (choice && choice.outcome === 'accepted') toast('Installing Daybook…', { type: 'success' });
          } catch (err) {
            console.warn(err);
          }
          const b = blocks.find((x) => x.id === 'install');
          if (b) b.redraw();
        } }),
      );
    } else if (ios) {
      append(body, 
        h('p.text-sm.subtle', 'Add Daybook to your Home Screen to use it like an app — full screen and offline.'),
        h('ol.settings-steps',
          h('li', 'Open this page in ', h('strong', 'Safari'), '.'),
          h('li', 'Tap ', h('strong', 'Share'), ' ', icon('share', { size: 16 }), ' in the toolbar.'),
          h('li', 'Choose ', h('strong', 'Add to Home Screen'), ', then ', h('strong', 'Add'), '.')),
      );
    } else {
      append(body, h('p.text-sm.subtle',
        'Daybook can be installed as an app. In Chrome or Edge, use the install icon in the address bar (or the browser menu → “Install Daybook”). On Android, choose “Add to Home screen”.'));
    }
  }

  // ------------------------------------------------------------------ Account & sync
  let syncEmail = '';
  let syncView = '';
  function syncViewKey(st) {
    return st.recovery ? 'recovery' : st.signedIn ? 'in' : 'out';
  }
  function syncStatusText(st) {
    if (st.phase === 'syncing') return 'Syncing…';
    if (st.phase === 'offline' || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      return st.pending ? `Offline · ${plural(st.pending, 'change')} will upload when you’re back online` : 'Offline · changes will upload when you’re back online';
    }
    if (st.phase === 'error') return st.error || 'Sync failed — retrying soon';
    if (st.lastSyncAt) return `Synced ${relativeTime(st.lastSyncAt)}`;
    return 'Connecting…';
  }
  function drawSync(body, b) {
    const st = sync.getStatus();
    syncView = syncViewKey(st);
    if (syncView === 'recovery') return drawSyncRecovery(body, b);
    if (syncView === 'in') return drawSyncSignedIn(body, b, st);
    return drawSyncSignedOut(body, b, st);
  }

  function drawSyncSignedOut(body, b, st) {
    const msg = h('div.settings-sync-msg', { role: 'status', 'aria-live': 'polite' });
    const say = (text, type = 'info') => {
      msg.replaceChildren();
      if (!text) return;
      msg.className = `settings-sync-msg is-${type}`;
      msg.append(icon(type === 'error' ? 'alert' : type === 'success' ? 'check-circle' : 'mail', { size: 18 }), h('span', text));
    };
    const email = input({ type: 'email', autocomplete: 'username', inputmode: 'email', placeholder: 'you@example.com', 'data-fk': 'sync-email', 'data-testid': 'sync-email', value: syncEmail });
    email.addEventListener('input', () => { syncEmail = email.value; });
    const pass = input({ type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'data-fk': 'sync-pass', 'data-testid': 'sync-pass' });
    const emailF = field('Email', email);
    const passF = field('Password', pass, { hint: 'New here? Pick a password of 8+ characters, then tap Create account.' });
    const check = (creating) => {
      emailF.setError(null);
      passF.setError(null);
      const e = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { emailF.setError('Enter your email address'); email.focus(); return null; }
      if (!pass.value) { passF.setError('Enter your password'); pass.focus(); return null; }
      if (creating && pass.value.length < 8) { passF.setError('Use at least 8 characters'); pass.focus(); return null; }
      return e;
    };
    const wasOnboarded = !!getSettings().onboarded;
    async function afterSignIn() {
      toast('Signed in — syncing your data…', { type: 'success' });
      try { await sync.syncNow(); } catch { /* status shows it */ }
      if (!wasOnboarded && getSettings().onboarded && !disposed) {
        toast('Welcome back! Your data is on this device now.', { type: 'success', duration: 5000 });
        navigate('/', { replace: true });
      }
    }
    const signInBtn = button({ label: 'Sign in', icon: 'arrow-right', variant: 'primary', type: 'submit', 'data-testid': 'sync-signin' });
    const signUpBtn = button({
      label: 'Create account', variant: 'secondary', 'data-testid': 'sync-signup',
      onClick: (ev) => {
        const e = check(true);
        if (!e) return;
        withBusy(ev.currentTarget, async () => {
          try {
            const r = await sync.signUp(e, pass.value);
            if (r.confirmEmail) {
              say(`Almost there — we sent a confirmation link to ${e}. Open it (on any device), then sign in here with your password.`, 'info');
            } else await afterSignIn();
          } catch (err) {
            say(err.offline ? 'You’re offline — connect to the internet to create an account.' : err.message, 'error');
          }
        });
      },
    });
    const forgot = h('button.link-btn', {
      type: 'button',
      onClick: async () => {
        const e = email.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { emailF.setError('Enter your email first'); email.focus(); return; }
        try {
          await sync.sendPasswordReset(e);
          say(`If there’s an account for ${e}, a password-reset link is on its way.`, 'info');
        } catch (err) {
          say(err.offline ? 'You’re offline right now.' : err.message, 'error');
        }
      },
    }, 'Forgot password?');
    const form = h('form.stack.settings-sync-form', {
      novalidate: true,
      onSubmit: (ev) => {
        ev.preventDefault();
        const e = check(false);
        if (!e) return;
        withBusy(signInBtn, async () => {
          try {
            await sync.signIn(e, pass.value);
            await afterSignIn();
          } catch (err) {
            say(err.offline ? 'You’re offline — connect to the internet to sign in.' : err.message, 'error');
          }
        });
      },
    }, emailF, passF, msg, h('div.settings-sync-actions', signInBtn, signUpBtn, forgot));
    append(body,
      h('p.text-sm.subtle', 'Sign in to use the same Daybook on every device — Windows, Android, iPad, iPhone. Entries you log anywhere show up everywhere, and each device still works offline.'),
      form);
    if (st.error) say(st.error, 'error');
    else if (st.notice) say(st.notice, 'success');
  }

  function drawSyncSignedIn(body, b, st) {
    const phaseIcon = st.phase === 'offline' ? 'cloud-off' : st.phase === 'error' ? 'alert' : 'cloud';
    append(body,
      h('div.settings-sync-head', { class: { [`is-${st.phase}`]: true } },
        h('span.settings-sync-icon', icon(phaseIcon, { size: 20 })),
        h('div.settings-sync-who',
          h('div.text-strong.truncate', st.email || 'Signed in'),
          h('div.text-sm.settings-sync-state', { 'data-testid': 'sync-state' }, syncStatusText(st)))),
      st.massDelete ? h('div.callout.settings-sync-warn', icon('alert', { size: 20 }),
        h('div.stack',
          h('div', h('strong', `${plural(st.massDelete.count, 'entry', 'entries')} were removed on this device.`), h('div.text-sm', 'Remove them from your account and all your other devices too?')),
          h('div.settings-sync-actions',
            button({ label: 'Remove everywhere', variant: 'danger-solid', size: 'sm', onClick: (ev) => withBusy(ev.currentTarget, () => sync.resolveMassDelete(true)) }),
            button({ label: 'Keep them — restore here', variant: 'secondary', size: 'sm', onClick: (ev) => withBusy(ev.currentTarget, () => sync.resolveMassDelete(false)) })))) : null,
      st.notice ? h('div.settings-sync-msg.is-success', icon('check-circle', { size: 18 }), h('span', st.notice)) : null,
      h('p.text-sm.subtle', 'Everything you log here uploads automatically and appears on your other devices within seconds. Offline? Changes wait on this device and upload later.'),
      h('div.settings-sync-actions',
        button({ label: 'Sync now', icon: 'refresh', variant: 'secondary', 'data-fk': 'sync-now', 'data-testid': 'sync-now', onClick: (ev) => withBusy(ev.currentTarget, () => sync.syncNow()) }),
        button({
          label: 'Sign out', icon: 'log-out', variant: 'ghost', 'data-testid': 'sync-signout',
          onClick: async () => {
            const ok = await confirmDialog({ title: 'Sign out of sync?', message: 'Your data stays on this device, but it stops syncing until you sign in again.', confirmLabel: 'Sign out', danger: false, icon: 'log-out' });
            if (!ok) return;
            await sync.signOut();
            toast('Signed out. Your data is still on this device.', { type: 'success' });
          },
        }),
        h('button.link-btn', { type: 'button', onClick: async () => { await sync.resyncAll(); toast('Re-downloaded everything from your account', { type: 'success' }); } }, 'Re-download everything')),
    );
  }

  function drawSyncRecovery(body) {
    const pass = input({ type: 'password', autocomplete: 'new-password', placeholder: 'New password', 'data-fk': 'sync-newpass' });
    const f = field('New password', pass, { hint: 'At least 8 characters.' });
    const save = button({ label: 'Save new password', variant: 'primary', type: 'submit' });
    append(body, h('form.stack.settings-sync-form', {
      novalidate: true,
      onSubmit: (ev) => {
        ev.preventDefault();
        f.setError(null);
        if (pass.value.length < 8) { f.setError('Use at least 8 characters'); pass.focus(); return; }
        withBusy(save, async () => {
          try {
            await sync.setNewPassword(pass.value);
            toast('Password updated', { type: 'success' });
          } catch (err) {
            f.setError(err.message);
          }
        });
      },
    }, h('p.text-sm.subtle', 'You opened a password-reset link. Choose a new password for your Daybook account.'), f, h('div.settings-sync-actions', save)));
  }

  // ------------------------------------------------------------------ Shortcuts + About
  function drawShortcuts(body) {
    append(body, h('div.settings-shortcuts', SHORTCUTS.map(([keys, label]) => h('div.settings-shortcut', h('span', label), kbd(keys)))));
  }
  function drawAbout(body) {
    const v = (window.daybook && window.daybook.version) || '—';
    append(body, 
      h('div.settings-about',
        h('div.settings-about-brand', brandMark(), h('div', h('div.text-strong', 'Daybook'), h('div.text-sm.muted', `Version ${v}`))),
        sync.getStatus().signedIn
          ? h('div.settings-privacy', icon('lock', { size: 20 }),
            h('div', h('strong', 'Private to your account.'),
              h('div.text-sm.subtle', 'Your entries live on each of your devices and in your own cloud account, locked so only you can read them. No ads, no tracking.')))
          : h('div.settings-privacy', icon('lock', { size: 20 }),
            h('div', h('strong', 'Your data stays on this device.'),
              h('div.text-sm.subtle', 'Nothing is uploaded unless you sign in to sync. No tracking. Everything works offline — backups are files you control.')))),
    );
  }

  // ------------------------------------------------------------------ build page
  const GROUPS = [
    ['You', ['sync', 'profile', 'appearance', 'regional', 'targets']],
    ['Lists', ['expenses', 'income', 'payments', 'learning', 'workouts']],
    ['Trading', ['trading']],
    ['Data', ['data']],
    ['App', ['install', 'shortcuts', 'about']],
  ];
  const touch = isTouchOnly();
  if (sync.isConfigured()) block({ id: 'sync', title: 'Account & sync', subtitle: 'Your data on every device', icon: 'cloud', accent: '--primary', keys: [], draw: drawSync });
  block({ id: 'profile', title: 'Profile', icon: 'user', accent: '--primary', keys: ['name'], draw: drawProfile });
  block({ id: 'appearance', title: 'Appearance', icon: 'sun', accent: '--goals', keys: ['theme', 'weekStart'], draw: drawAppearance });
  block({ id: 'regional', title: 'Regional', subtitle: 'Currency and units', icon: 'compass', accent: '--water', keys: ['currency', 'units'], draw: drawRegional });
  block({ id: 'targets', title: 'Daily targets', subtitle: 'What a good day looks like', icon: 'target', accent: '--goals', keys: ['targets', 'currency'], draw: drawTargets });
  block({ id: 'expenses', title: 'Expense categories', icon: 'receipt', accent: '--expenses', keys: ['expenseCategories', 'currency'], draw: (body, b) => drawCategoryList(body, b, { listKey: 'expenseCategories', noun: 'category', budget: true }) });
  block({ id: 'income', title: 'Income categories', icon: 'income', accent: '--profit', keys: ['incomeCategories'], draw: (body, b) => drawCategoryList(body, b, { listKey: 'incomeCategories', noun: 'category' }) });
  block({ id: 'payments', title: 'Payment methods', icon: 'wallet', accent: '--expenses', keys: ['paymentMethods'], draw: drawPayments });
  block({ id: 'learning', title: 'Learning categories', icon: 'learning', accent: '--learning', keys: ['learningCategories'], draw: (body, b) => drawCategoryList(body, b, { listKey: 'learningCategories', noun: 'category' }) });
  block({ id: 'workouts', title: 'Workout types', icon: 'training', accent: '--training', keys: ['workoutTypes'], draw: (body, b) => drawCategoryList(body, b, { listKey: 'workoutTypes', noun: 'workout type' }) });
  block({ id: 'trading', title: 'Trading', subtitle: 'Accounts, rules and tags', icon: 'trades', accent: '--trades', keys: ['trading', 'currency'], draw: drawTrading });
  block({ id: 'data', title: 'Data & backup', subtitle: 'Back up, restore, export', icon: 'database', accent: '--primary', keys: ['lastBackupAt', 'backupReminderDays'], draw: drawData });
  block({ id: 'install', title: 'Install app', icon: 'smartphone', accent: '--primary', keys: [], draw: drawInstall });
  block({ id: 'shortcuts', title: 'Keyboard shortcuts', icon: 'keyboard', accent: '--primary', keys: [], draw: drawShortcuts, hidden: touch });
  block({ id: 'about', title: 'About', icon: 'info', accent: '--primary', keys: [], draw: drawAbout });

  const byId = new Map(blocks.map((b) => [b.id, b]));
  const links = new Map();
  const jump = (id, { smooth = true, focus = true } = {}) => {
    const b = byId.get(id);
    if (!b) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    b.el.scrollIntoView({ behavior: smooth && !reduce ? 'smooth' : 'auto', block: 'start' });
    if (focus) {
      const h2 = b.el.querySelector('.card-title');
      if (h2) h2.focus({ preventScroll: true });
    }
    setActive(id);
    spyLock = Date.now() + 1200; // smooth scroll passes other sections — keep the chosen one highlighted
    navigate(`/settings/${id}`, { replace: true, silent: true });
  };
  let activeId = null;
  let spyLock = 0;
  function setActive(id) {
    if (activeId === id) return;
    activeId = id;
    links.forEach((els, key) => els.forEach((a) => (key === id ? a.setAttribute('aria-current', 'location') : a.removeAttribute('aria-current'))));
    const chip = strip.querySelector(`[data-section="${id}"]`);
    if (chip && strip.scrollWidth > strip.clientWidth) {
      const left = chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2;
      strip.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
    }
  }
  const link = (b, cls) => {
    const a = h(`a.${cls}`, {
      href: `#/settings/${b.id}`, dataset: { section: b.id },
      onClick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); jump(b.id); },
    }, cls === 'settings-index-link' ? icon(b.icon, { size: 18 }) : null, h('span', b.title));
    if (!links.has(b.id)) links.set(b.id, []);
    links.get(b.id).push(a);
    return a;
  };
  const visible = (ids) => ids.map((id) => byId.get(id)).filter((b) => b && !b.hidden);
  const index = h('nav.settings-index', { 'aria-label': 'Settings sections' },
    GROUPS.map(([g, ids]) => h('div.settings-index-group', h('div.settings-index-heading', g), visible(ids).map((b) => link(b, 'settings-index-link')))));
  const strip = h('nav.settings-strip', { 'aria-label': 'Jump to section' }, GROUPS.flatMap(([, ids]) => visible(ids).map((b) => link(b, 'settings-strip-link'))));

  mount(root, h('div.page.settings-page',
    pageHeader({
      title: 'Settings', subtitle: sync.getStatus().signedIn ? 'Make Daybook yours. Synced to your account.' : 'Make Daybook yours.',
      actions: [{ label: 'Backup', icon: 'database', variant: 'secondary', onClick: () => jump('data') }],
    }),
    strip,
    h('div.settings-layout', index, h('div.settings-sections', blocks.map((b) => b.el))),
  ));

  // Scroll-spy
  let io = null;
  if ('IntersectionObserver' in window) {
    const seen = new Map();
    io = new IntersectionObserver((entries) => {
      entries.forEach((en) => seen.set(en.target.dataset.section, en.isIntersecting));
      if (Date.now() < spyLock) return;
      const first = blocks.find((b) => !b.hidden && seen.get(b.id));
      if (first) setActive(first.id);
    }, { rootMargin: '-25% 0px -65% 0px' });
    blocks.forEach((b) => !b.hidden && io.observe(b.el));
  }

  // Stay in sync
  const offs = [
    on('settings:change', (e) => {
      const patch = (e && e.patch) || {};
      const keys = Object.keys(patch);
      blocks.forEach((b) => {
        if (b === skipBlock) return;
        if (b.keys.some((k) => keys.includes(k))) b.redraw();
      });
    }),
    on('sync:status', (st) => {
      const b = byId.get('sync');
      if (!b || disposed) return;
      // The sign-in form keeps its typed values: re-draw it only when the view itself changes.
      if (syncViewKey(st) !== syncView || syncView === 'in') b.redraw();
      else if (syncView === 'out' && (st.error || st.notice)) b.redraw();
      const about = byId.get('about');
      if (about) about.redraw();
    }),
    on('db:change', debounce((e) => {
      if (disposed) return;
      const d = byId.get('data');
      if (d && d.fillCounts) d.fillCounts();
    }, 250)),
  ];
  const syncTick = setInterval(() => {
    const sb = byId.get('sync');
    if (sb && syncView === 'in' && !disposed) sb.redraw();
  }, 30000);
  cleanups.push(() => clearInterval(syncTick));
  const onInstallChange = () => later(() => byId.get('install').redraw(), 0);
  window.addEventListener('beforeinstallprompt', onInstallChange);
  window.addEventListener('appinstalled', onInstallChange);

  // Deep link: #/settings/<section>
  const want = ctx.route.params && ctx.route.params[0];
  const target = want && byId.has(ALIASES[want] || want) ? ALIASES[want] || want : null;
  if (target) {
    const b = byId.get(target);
    const h2 = b.el.querySelector('.card-title');
    if (h2) h2.focus({ preventScroll: true }); // the shell then keeps focus here instead of the h1
    requestAnimationFrame(() => { if (!disposed) jump(target, { smooth: false, focus: false }); });
  }

  return () => {
    disposed = true;
    cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    timers.forEach((t) => clearTimeout(t));
    offs.forEach((off) => off());
    if (io) io.disconnect();
    window.removeEventListener('beforeinstallprompt', onInstallChange);
    window.removeEventListener('appinstalled', onInstallChange);
  };
}

function brandMark() {
  const src = document.querySelector('.sidebar .brand-mark, .brand-mark');
  if (src) {
    const el = src.cloneNode(true);
    el.classList.remove('boot-mark');
    el.classList.add('settings-brand');
    return el;
  }
  return iconChip('notebook', { accent: '--primary' });
}

export default {
  id: ID,
  title: 'Settings',
  icon: 'settings',
  color: '--primary',
  render,
};
