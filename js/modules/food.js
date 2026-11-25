// js/modules/food.js — Food & nutrition journal (SPEC 4.2).
//
// Choices not fixed by the spec (kept simple, documented here):
// - Route accepts an optional date param (#/food/2026-11-20). The page date follows and sets the working date
//   (state.date via setWorkingDate) so the global quick-add logs to the day being viewed.
// - Frequent-food one tap: on today the meal is guessed from the current time; on a past day (no "now") the food's
//   last-used meal type is reused. Time = now on today, '' on past days (SPEC 4.0 default).
// - Trends cover the last 7 / 30 days ending today. Averages only count days that have data for that metric
//   (calories: days with any kcal logged; protein likewise; water: days with ≥ 1 glass; meals/day: days with meals).
//   The meal-quality donut only counts rated meals (the unrated count is noted under it).
// - Colours: calories = --food, protein = --chart-1, carbs = --chart-4, fat = --chart-5 (always paired with labels).
// - Editor: photos picked in an editor that is cancelled are deleted; replacing/removing the photo of a saved meal
//   deletes the old file on Save; deleting a meal passes its photo to removeWithUndo (deleted after the undo window).
//   Dismissing (Esc / backdrop / ×) a form with unsaved edits asks "Discard?"; the Cancel button discards directly.

import { db } from '../core/db.js';
import { on, state, setWorkingDate } from '../core/bus.js';
import { getSettings } from '../core/settings.js';
import { todayKey, nowTime, fmtTime, fmtDate, relativeDay, addDays, rangeKeys, isValidKey, timeToMinutes } from '../core/dates.js';
import { fmtNumber, fmtPercent, plural, toNumber } from '../core/format.js';
import { h, mount, icon, button, iconChip, pageHeader, emptyState, dateNav, openSheet, field, input, textarea, segmented, chips, toast, confirmDialog, progressRing, debounce } from '../core/ui.js';
import { imagePicker, thumb, deleteImage } from '../core/images.js';
import { lineChart, donutChart } from '../core/charts.js';
import { removeWithUndo } from '../core/undo.js';

const ID = 'food';
const TITLE = 'Food';
const ICON = 'food';
const COLOR = '--food';
const STORE = 'food';

const MEALS = [
  { id: 'breakfast', label: 'Breakfast', short: 'Breakfast', icon: 'coffee' },
  { id: 'lunch', label: 'Lunch', short: 'Lunch', icon: 'salad' },
  { id: 'dinner', label: 'Dinner', short: 'Dinner', icon: 'soup' },
  { id: 'snack', label: 'Snacks', short: 'Snack', icon: 'apple' },
];
const MEAL_BY_ID = Object.fromEntries(MEALS.map((m) => [m.id, m]));

const QUALITY = [
  { value: 'great', label: 'Great', emoji: '🥗', color: '--success' },
  { value: 'ok', label: 'Okay', emoji: '🍝', color: '--warning' },
  { value: 'poor', label: 'Poor', emoji: '🍩', color: '--danger' },
];
const QUALITY_BY_ID = Object.fromEntries(QUALITY.map((q) => [q.value, q]));

const MACRO_COLORS = { protein: '--chart-1', carbs: '--chart-4', fat: '--chart-5' };

let trendDays = 7; // remembered across renders of the page

// ──────────────────────────────────────────────────────────────────────────── helpers

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const lower = (s) => String(s || '').trim().toLowerCase();
const mealLabel = (id) => (MEAL_BY_ID[id] ? MEAL_BY_ID[id].short : 'Meal');

/** Default meal from a 'HH:MM' time: <11 breakfast, <16 lunch, <21 dinner, else snack. */
function guessMeal(time) {
  const m = timeToMinutes(time || nowTime());
  if (m === null || m === undefined || !Number.isFinite(m)) return 'snack';
  if (m < 11 * 60) return 'breakfast';
  if (m < 16 * 60) return 'lunch';
  if (m < 21 * 60) return 'dinner';
  return 'snack';
}

function totals(list) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0, has: { calories: false, protein: false, carbs: false, fat: false } };
  for (const r of list) {
    for (const k of ['calories', 'protein', 'carbs', 'fat']) {
      const v = num(r[k]);
      if (v !== null) {
        t[k] += v;
        t.has[k] = true;
      }
    }
  }
  return t;
}

const kcal = (n) => `${fmtNumber(Math.round(n))} kcal`;
const grams = (n) => `${fmtNumber(Math.round(n))} g`;

/** '420 kcal · 18 g P' (+ carbs / fat when asked). */
function macroParts(r, { full = false } = {}) {
  const out = [];
  if (num(r.calories) !== null) out.push(kcal(r.calories));
  if (num(r.protein) !== null) out.push(`${grams(r.protein)} P`);
  if (full) {
    if (num(r.carbs) !== null) out.push(`${grams(r.carbs)} C`);
    if (num(r.fat) !== null) out.push(`${grams(r.fat)} F`);
  }
  return out;
}

function qualityBadge(q) {
  const def = QUALITY_BY_ID[q];
  if (!def) return null;
  return h('span.food-quality', { class: `is-${def.value}` }, h('span.food-quality-emoji', { 'aria-hidden': 'true' }, def.emoji), h('span', def.label));
}

/** Latest record per lower-cased title (db.all is sorted ascending, so the last one wins). */
function lastByTitle(all) {
  const map = new Map();
  for (const r of all) {
    const k = lower(r.title);
    if (k) map.set(k, r);
  }
  return map;
}

/** Top n titles by count (ties → most recent), each with its latest record. */
function frequentFoods(all, n = 8) {
  const stats = new Map();
  all.forEach((r, i) => {
    const k = lower(r.title);
    if (!k) return;
    const s = stats.get(k) || { key: k, count: 0, last: r, order: i };
    s.count += 1;
    s.last = r;
    s.order = i;
    stats.set(k, s);
  });
  return [...stats.values()].sort((a, b) => b.count - a.count || b.order - a.order).slice(0, n);
}

function litres(glasses, glassMl) {
  const l = (glasses * (Number(glassMl) || 250)) / 1000;
  return `${fmtNumber(l, { maxDecimals: 2 })} L`;
}

function captureFocus(container) {
  const a = document.activeElement;
  return a && container.contains(a) && a.dataset ? a.dataset.focusKey || null : null;
}
function restoreFocus(container, key) {
  if (!key) return;
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"');
  const el = container.querySelector(`[data-focus-key="${esc}"]`);
  if (el && (document.activeElement === document.body || !document.activeElement || !document.activeElement.isConnected)) el.focus({ preventScroll: true });
}

// ──────────────────────────────────────────────────────────────────────────── water

async function addWater(date, delta) {
  const day = await db.getDay(date);
  const n = Math.max(0, (Number(day.water) || 0) + delta);
  await db.patchDay(date, { water: n });
  return n;
}

async function quickWater({ date } = {}) {
  const d = date || state.date || todayKey();
  const n = await addWater(d, 1);
  const target = Number(getSettings().targets?.water) || 0;
  const when = d === todayKey() ? '' : ` · ${fmtDate(d, 'short')}`;
  toast(`💧 ${target ? `${n}/${target}` : n} ${n === 1 && !target ? 'glass' : 'glasses'}${when}`, {
    type: 'success',
    action: { label: 'Undo', onClick: () => addWater(d, -1) },
  });
  return n;
}

/** Glass tracker: tappable glasses up to max(target, count+1), −/+ buttons, litres. Updates in place (keeps focus). */
function waterTracker(onSet) {
  let count = 0;
  let target = 8;
  let glassMl = 250;

  const valueEl = h('span.food-water-value.num');
  const subEl = h('span.food-water-sub');
  const doneEl = h('span.food-water-done', { hidden: true }, icon('check-circle', { size: 16 }), h('span', 'Goal reached'));
  const glasses = h('div.food-glasses', { role: 'group', 'aria-label': 'Water glasses' });
  const minus = button({ icon: 'minus', ariaLabel: 'Remove a glass of water', variant: 'secondary', class: 'food-water-btn', onClick: () => set(count - 1, minus) });
  const plus = button({ icon: 'plus', ariaLabel: 'Add a glass of water', variant: 'secondary', class: 'food-water-btn', onClick: () => set(count + 1, plus) });
  const live = h('span.sr-only', { 'aria-live': 'polite' });

  const el = h(
    'div.food-water',
    { style: { '--accent': 'var(--water)' } },
    h(
      'div.food-water-head',
      iconChip('water', { accent: '--water' }),
      h('div.food-water-text', h('h3.food-water-title', 'Water'), h('div.food-water-line', valueEl, subEl), doneEl),
      h('div.food-water-actions', minus, plus)
    ),
    glasses,
    live
  );

  function makeGlass(i) {
    return h(
      'button.food-glass',
      {
        type: 'button',
        dataset: { focusKey: `glass:${i}` },
        onClick: () => set(i + 1 === count ? i : i + 1),
      },
      icon('glass-water', { size: 22 })
    );
  }

  function paint() {
    const slots = Math.min(40, Math.max(target, count + 1));
    glasses.style.setProperty('--glass-cols', String(Math.min(slots, 10)));
    while (glasses.children.length < slots) glasses.append(makeGlass(glasses.children.length));
    while (glasses.children.length > slots) {
      const last = glasses.lastElementChild;
      if (document.activeElement === last) glasses.children[slots - 1]?.focus({ preventScroll: true });
      last.remove();
    }
    [...glasses.children].forEach((b, i) => {
      const filled = i < count;
      b.classList.toggle('is-filled', filled);
      b.classList.toggle('is-extra', target > 0 && i >= target);
      b.setAttribute('aria-pressed', filled ? 'true' : 'false');
      b.setAttribute('aria-label', `Glass ${i + 1}`);
    });
    valueEl.textContent = target ? `${count} / ${target}` : String(count);
    subEl.textContent = `${count === 1 && !target ? 'glass' : 'glasses'} · ${litres(count, glassMl)}`;
    const done = target > 0 && count >= target;
    doneEl.hidden = !done;
    el.classList.toggle('is-done', done);
    if (count === 0 && document.activeElement === minus) plus.focus({ preventScroll: true });
    minus.disabled = count === 0;
  }

  function set(n) {
    n = Math.max(0, Math.min(40, n));
    if (n === count) return;
    count = n;
    paint();
    live.textContent = `${count} ${count === 1 ? 'glass' : 'glasses'} of water`;
    onSet(n);
  }

  el.update = (opts = {}) => {
    if (opts.count !== undefined) count = Math.max(0, Number(opts.count) || 0);
    if (opts.target !== undefined) target = Math.max(0, Number(opts.target) || 0);
    if (opts.glassMl !== undefined) glassMl = Number(opts.glassMl) || 250;
    paint();
  };
  el.getCount = () => count;
  paint();
  return el;
}

// ──────────────────────────────────────────────────────────────────────────── editor

/** Add/edit sheet. record=null → new (record without id = template). opts={date, meal}. → Promise<saved|null> */
function openEditor(record = null, opts = {}) {
  const isNew = !record || !record.id;
  const today = todayKey();
  const date0 = (record && record.date) || opts.date || state.date || today;
  const time0 = record && record.id ? record.time || '' : (record && record.time) || (date0 === today ? nowTime() : '');
  const draft = {
    date: date0,
    time: time0,
    meal: (record && record.meal) || opts.meal || guessMeal(time0 || nowTime()),
    title: (record && record.title) || '',
    calories: num(record && record.calories),
    protein: num(record && record.protein),
    carbs: num(record && record.carbs),
    fat: num(record && record.fat),
    quality: (record && QUALITY_BY_ID[record.quality] && record.quality) || null,
    photoId: (record && record.photoId) || null,
    note: (record && record.note) || '',
  };
  const originalPhoto = isNew ? null : draft.photoId;
  const added = new Set(); // photo ids picked in this editor session
  let mealTouched = !!(record && record.meal) || !!opts.meal;
  let pastByTitle = new Map();
  const snapshot = () => JSON.stringify(draft);
  const initial = snapshot();

  // ---- meal
  const mealSeg = segmented(
    MEALS.map((m) => ({ value: m.id, label: m.short })),
    draft.meal,
    (v) => {
      draft.meal = v;
      mealTouched = true;
    },
    { ariaLabel: 'Meal', block: true, class: 'food-meal-seg' }
  );

  // ---- title + datalist of past titles
  const listId = `food-titles-${Math.random().toString(36).slice(2, 8)}`;
  const datalist = h('datalist', { id: listId });
  const titleIn = input({
    value: draft.title,
    placeholder: 'e.g. Dal rice, Oats with banana',
    autocomplete: 'off',
    autocapitalize: 'sentences',
    enterkeyhint: 'done',
    maxlength: '140',
    list: listId,
    onInput: (e) => {
      draft.title = e.target.value;
      titleField.setError(null);
      maybePrefill();
    },
  });
  const titleField = field('What did you eat?', titleIn, { required: true });

  // ---- macros
  const macroDefs = [
    { key: 'calories', label: 'Calories', unit: 'kcal' },
    { key: 'protein', label: 'Protein', unit: 'g' },
    { key: 'carbs', label: 'Carbs', unit: 'g' },
    { key: 'fat', label: 'Fat', unit: 'g' },
  ];
  const macro = {};
  for (const d of macroDefs) {
    const inp = input({
      type: 'number',
      min: '0',
      value: draft[d.key] === null ? '' : String(draft[d.key]),
      placeholder: '—',
      onInput: (e) => {
        draft[d.key] = toNumber(e.target.value);
        macro[d.key].field.setError(null);
      },
    });
    const control = h('div.input-affix', { onClick: (e) => { if (e.target !== inp) inp.focus(); } }, inp, h('span.affix', { 'aria-hidden': 'true' }, d.unit));
    macro[d.key] = { inp, field: field(d.label, control) };
  }

  // ---- quality
  const qualityChips = chips(
    QUALITY.map((q) => ({ value: q.value, label: q.label, emoji: q.emoji, color: q.color })),
    draft.quality,
    (v) => {
      draft.quality = v;
    },
    { ariaLabel: 'How healthy was it?', class: 'food-quality-chips' }
  );

  function maybePrefill() {
    const past = pastByTitle.get(lower(draft.title));
    if (!past) return;
    const filled = [];
    for (const d of macroDefs) {
      const v = num(past[d.key]);
      if (v !== null && draft[d.key] === null && !macro[d.key].inp.value) {
        draft[d.key] = v;
        macro[d.key].inp.value = String(v);
        filled.push(d.key);
      }
    }
    if (!draft.quality && QUALITY_BY_ID[past.quality]) {
      draft.quality = past.quality;
      qualityChips.setValue(past.quality);
      filled.push('quality');
    }
    if (filled.length) {
      const parts = macroParts(past);
      titleField.setHint(`Filled in from last time${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
    }
  }

  // ---- photo
  const photoBox = h('div.food-photo');
  function renderPhoto() {
    if (draft.photoId) {
      mount(
        photoBox,
        thumb(draft.photoId, { size: 88, alt: draft.title || 'Meal photo', onRemove: () => removePhoto() }),
        imagePicker({ label: 'Replace', size: 'sm', variant: 'ghost', onAdd: (id) => addPhoto(id) })
      );
    } else {
      mount(photoBox, imagePicker({ label: 'Add photo', onAdd: (id) => addPhoto(id) }));
    }
  }
  function addPhoto(id) {
    const prev = draft.photoId;
    if (prev && added.has(prev)) {
      added.delete(prev);
      deleteImage(prev).catch(() => {});
    }
    added.add(id);
    draft.photoId = id;
    renderPhoto();
  }
  function removePhoto() {
    const prev = draft.photoId;
    if (prev && added.has(prev)) {
      added.delete(prev);
      deleteImage(prev).catch(() => {});
    }
    draft.photoId = null;
    renderPhoto();
    photoBox.querySelector('.image-picker input')?.focus();
  }
  renderPhoto();

  // ---- note, date, time
  const noteIn = textarea({ value: draft.note, rows: 2, placeholder: 'How was it? Where? Anything to remember…', onInput: (e) => { draft.note = e.target.value; } });
  const dateIn = input({
    type: 'date',
    value: draft.date,
    max: today,
    onChange: (e) => {
      draft.date = e.target.value || draft.date;
      dateField.setError(null);
      if (isValidKey(draft.date)) sheet.setSubtitle(relativeDay(draft.date));
    },
  });
  const dateField = field('Date', dateIn);
  const timeIn = input({
    type: 'time',
    value: draft.time,
    onChange: (e) => {
      draft.time = e.target.value;
      if (isNew && !mealTouched && draft.time) {
        draft.meal = guessMeal(draft.time);
        mealSeg.setValue(draft.meal);
      }
    },
  });

  const form = h(
    'form.stack.food-editor',
    { autocomplete: 'off' },
    field('Meal', mealSeg),
    titleField,
    datalist,
    h('div.food-macro-grid', macroDefs.map((d) => macro[d.key].field)),
    field('How healthy was it?', qualityChips),
    field('Photo', photoBox),
    field('Note', noteIn),
    h('div.form-grid', dateField, field('Time', timeIn))
  );

  // Past titles (most recent first) for the datalist + prefill.
  db.all(STORE)
    .then((all) => {
      pastByTitle = lastByTitle(all);
      const seen = new Set();
      const opts2 = [];
      for (let i = all.length - 1; i >= 0 && opts2.length < 300; i--) {
        const k = lower(all[i].title);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        opts2.push(h('option', { value: all[i].title.trim() }));
      }
      mount(datalist, opts2);
    })
    .catch((err) => console.warn('[daybook] food titles', err));

  function validate() {
    let firstBad = null;
    if (!draft.title.trim()) {
      titleField.setError('Add a short name, e.g. “Dal rice”');
      firstBad = firstBad || titleIn;
    }
    for (const d of macroDefs) {
      const { inp, field: f } = macro[d.key];
      if (inp.validity && inp.validity.badInput) {
        f.setError('Numbers only');
        firstBad = firstBad || inp;
      } else if (draft[d.key] !== null && draft[d.key] < 0) {
        f.setError('Can’t be negative');
        firstBad = firstBad || inp;
      } else if (draft[d.key] !== null && draft[d.key] > 20000) {
        f.setError('That looks too big');
        firstBad = firstBad || inp;
      }
    }
    if (!isValidKey(draft.date)) {
      dateField.setError('Pick a date');
      firstBad = firstBad || dateIn;
    } else if (draft.date > todayKey()) {
      dateField.setError('Can’t log meals in the future');
      firstBad = firstBad || dateIn;
    }
    if (firstBad) firstBad.focus();
    return !firstBad;
  }

  const sheet = openSheet({
    title: isNew ? 'Log meal' : 'Edit meal',
    subtitle: relativeDay(draft.date),
    icon: ICON,
    accent: COLOR,
    content: form,
    className: 'food-sheet',
    initialFocus: isNew ? titleIn : null,
    guard: async () => {
      if (snapshot() === initial) return true;
      return confirmDialog({ title: isNew ? 'Discard this meal?' : 'Discard changes?', message: 'What you entered won’t be saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing' });
    },
    onClose: (result) => {
      // Cancelled or deleted: photos picked in this session were never saved with the meal.
      if (!result) for (const id of added) deleteImage(id).catch(() => {});
    },
    actions: [
      !isNew && {
        label: 'Delete',
        variant: 'danger',
        icon: 'trash',
        onClick: async () => {
          await removeWithUndo(STORE, record, { label: 'Meal deleted', files: record.photoId ? [record.photoId] : [] });
          return null;
        },
      },
      { label: 'Cancel', variant: 'secondary' },
      {
        label: 'Save',
        variant: 'primary',
        onClick: async () => {
          if (!validate()) return false;
          const out = {
            ...(isNew ? {} : record),
            date: draft.date,
            time: draft.time || '',
            meal: draft.meal || guessMeal(draft.time),
            title: draft.title.trim().replace(/\s+/g, ' '),
            calories: draft.calories,
            protein: draft.protein,
            carbs: draft.carbs,
            fat: draft.fat,
            quality: draft.quality || null,
            photoId: draft.photoId || null,
            note: draft.note.trim(),
          };
          if (isNew && record) for (const k of Object.keys(record)) if (!(k in out) && k !== 'sample') out[k] = record[k];
          const saved = await db.put(STORE, out);
          added.clear(); // the final photo now belongs to the record
          if (originalPhoto && originalPhoto !== saved.photoId) deleteImage(originalPhoto).catch(() => {});
          toast('Saved', { type: 'success', duration: 1800 });
          return saved;
        },
      },
    ].filter(Boolean),
  });
  return sheet.result;
}

// ──────────────────────────────────────────────────────────────────────────── one-tap re-log

async function relog(food, date) {
  const isToday = date === todayKey();
  const time = isToday ? nowTime() : '';
  const meal = isToday ? guessMeal(time) : food.meal || guessMeal(nowTime());
  const rec = {
    date,
    time,
    meal,
    title: food.title,
    calories: num(food.calories),
    protein: num(food.protein),
    carbs: num(food.carbs),
    fat: num(food.fat),
    quality: QUALITY_BY_ID[food.quality] ? food.quality : null,
    photoId: null,
    note: '',
  };
  const saved = await db.put(STORE, rec);
  toast(`Logged “${food.title}” to ${mealLabel(meal)}${isToday ? '' : ` · ${fmtDate(date, 'short')}`}`, {
    type: 'success',
    action: {
      label: 'Undo',
      onClick: async () => {
        await db.delete(STORE, saved.id);
      },
    },
  });
  return saved;
}

// ──────────────────────────────────────────────────────────────────────────── page

async function render(root, ctx) {
  const today = todayKey();
  const param = ctx.route.params && ctx.route.params[0];
  let date = isValidKey(param) ? param : state.date || today;
  if (!isValidKey(date) || date > today) date = today;
  setWorkingDate(date);
  let disposed = false;
  let dayToken = 0;
  let sideToken = 0;
  let allFood = [];

  const newMeal = (meal) => openEditor(null, { date, meal });

  // ---- persistent shell (header + nav + water stay mounted; only data parts re-draw)
  const nav = dateNav(date, (d) => {
    date = d;
    setWorkingDate(d);
    drawDay();
    drawFrequent();
  });

  const water = waterTracker((n) => {
    db.patchDay(date, { water: n }).catch((err) => {
      console.error('[daybook] water', err);
      toast('Couldn’t save water — try again.', { type: 'error' });
    });
  });

  const ringsEl = h('div.food-rings');
  const macrosEl = h('div.food-macros');
  const summary = h('section.card.food-summary', { 'aria-labelledby': 'food-summary-title' }, h('h2.sr-only#food-summary-title', 'Daily summary'), ringsEl, macrosEl, h('div.food-divider'), water);

  const mealsEl = h('section.card.card-flush.food-meals', { 'aria-labelledby': 'food-meals-title' });
  const freqBody = h('div.food-freq-body');
  const freqSub = h('p.card-subtitle');
  const freqCard = h(
    'section.card.food-freq',
    { 'aria-labelledby': 'food-freq-title' },
    h('div.card-header', iconChip('repeat', { accent: COLOR }), h('div.card-header-text', h('h2.card-title#food-freq-title', 'Frequent foods'), freqSub)),
    freqBody
  );

  const trendsBody = h('div.food-trends-body');
  const rangeSeg = segmented(
    [
      { value: 7, label: '7 days' },
      { value: 30, label: '30 days' },
    ],
    trendDays,
    (v) => {
      trendDays = v;
      drawTrends();
    },
    { size: 'sm', ariaLabel: 'Trend period' }
  );
  const trendsCard = h(
    'section.card.food-trends',
    { 'aria-labelledby': 'food-trends-title' },
    h('div.card-header', iconChip('line-chart', { accent: COLOR }), h('div.card-header-text', h('h2.card-title#food-trends-title', 'Trends')), h('div.card-actions', rangeSeg)),
    trendsBody
  );

  mount(
    root,
    h(
      'div.page.food-page',
      { style: { '--accent': 'var(--food)' } },
      pageHeader({
        title: TITLE,
        subtitle: 'Meals, macros & water',
        actions: [{ label: 'Log meal', icon: 'plus', variant: 'primary', onClick: () => newMeal() }],
      }),
      h('div.food-nav', nav),
      h('div.food-layout', h('div.food-main', summary, mealsEl), h('div.food-side', freqCard, trendsCard))
    )
  );

  // ---- day: rings, macros, water, meals
  async function drawDay() {
    const token = ++dayToken;
    const [items, day] = await Promise.all([db.byDate(STORE, date), db.getDay(date)]);
    if (disposed || token !== dayToken) return;
    const s = getSettings();
    const tg = s.targets || {};
    const t = totals(items);

    // Rings
    const calTarget = Number(tg.calories) || 0;
    const protTarget = Number(tg.protein) || 0;
    const calOver = calTarget > 0 && t.calories > calTarget;
    const calStatus = !calTarget
      ? h('span.muted', 'No target set')
      : calOver
        ? h('span.food-status.text-warning', icon('alert', { size: 14 }), h('span', `${fmtNumber(Math.round(t.calories - calTarget))} over`))
        : h('span.food-status.muted', `${fmtNumber(Math.round(calTarget - t.calories))} left`);
    const protDone = protTarget > 0 && t.protein >= protTarget;
    const protStatus = !protTarget
      ? h('span.muted', 'No target set')
      : protDone
        ? h('span.food-status.food-status-good', icon('check-circle', { size: 14 }), h('span', 'Goal met'))
        : h('span.food-status.muted', `${fmtNumber(Math.round(protTarget - t.protein))} g to go`);

    mount(
      ringsEl,
      h(
        'div.food-ring-block',
        progressRing(calTarget ? t.calories / calTarget : 0, {
          size: 116,
          stroke: 10,
          accent: COLOR,
          over: calOver,
          label: fmtNumber(Math.round(t.calories)),
          sublabel: 'kcal',
          ariaLabel: `Calories ${fmtNumber(Math.round(t.calories))}${calTarget ? ` of ${fmtNumber(calTarget)}` : ''} kcal${calOver ? ', over target' : ''}`,
        }),
        h('div.food-ring-caption', h('span.food-ring-name', 'Calories'), h('span.muted.num', calTarget ? `of ${fmtNumber(calTarget)} kcal` : ''), calStatus)
      ),
      h(
        'div.food-ring-block',
        progressRing(protTarget ? t.protein / protTarget : 0, {
          size: 116,
          stroke: 10,
          accent: MACRO_COLORS.protein,
          label: fmtNumber(Math.round(t.protein)),
          sublabel: 'g protein',
          ariaLabel: `Protein ${fmtNumber(Math.round(t.protein))}${protTarget ? ` of ${fmtNumber(protTarget)}` : ''} g`,
        }),
        h('div.food-ring-caption', h('span.food-ring-name', 'Protein'), h('span.muted.num', protTarget ? `of ${fmtNumber(protTarget)} g` : ''), protStatus)
      )
    );

    // Macro split (energy share) + carbs / fat stats
    const eP = t.protein * 4;
    const eC = t.carbs * 4;
    const eF = t.fat * 9;
    const eSum = eP + eC + eF;
    const macroRows = [
      { key: 'protein', label: 'Protein', g: t.protein, e: eP, has: t.has.protein },
      { key: 'carbs', label: 'Carbs', g: t.carbs, e: eC, has: t.has.carbs },
      { key: 'fat', label: 'Fat', g: t.fat, e: eF, has: t.has.fat },
    ];
    mount(
      macrosEl,
      h(
        'div.food-macro-bar',
        { role: 'img', 'aria-label': eSum ? `Energy split: ${macroRows.map((m) => `${m.label} ${fmtPercent(m.e / eSum, { decimals: 0 })}`).join(', ')}` : 'No macros logged yet', class: { 'is-empty': !eSum } },
        eSum ? macroRows.filter((m) => m.e > 0).map((m) => h('span.food-macro-seg', { style: { flexGrow: String(m.e), '--seg': `var(${MACRO_COLORS[m.key]})` } })) : null
      ),
      h(
        'div.food-macro-stats',
        macroRows.map((m) =>
          h(
            'div.food-macro-stat',
            { style: { '--seg': `var(${MACRO_COLORS[m.key]})` } },
            h('span.food-macro-label', h('span.food-macro-dot', { 'aria-hidden': 'true' }), m.label),
            h('span.food-macro-value.num', m.has ? grams(m.g) : '—'),
            h('span.food-macro-sub.num', eSum && m.has ? `${fmtPercent(m.e / eSum, { decimals: 0 })} of kcal` : ' ')
          )
        )
      )
    );

    // Water (in place)
    water.update({ count: Number(day.water) || 0, target: Number(tg.water) || 0, glassMl: tg.glassMl });

    // Meals grouped
    const focusKey = captureFocus(mealsEl);
    const photoIds = items.filter((r) => r.photoId).map((r) => r.photoId);
    const head = h(
      'div.card-header.food-meals-head',
      h('div.card-header-text', h('h2.card-title#food-meals-title', 'Meals'), h('p.card-subtitle', items.length ? `${plural(items.length, 'entry', 'entries')}${t.has.calories ? ` · ${kcal(t.calories)}` : ''}` : relativeDay(date) === 'Today' ? 'Nothing logged yet today' : `Nothing logged on ${fmtDate(date, 'medium')}`))
    );
    const groups = MEALS.map((m) => {
      const list = items.filter((r) => (MEAL_BY_ID[r.meal] ? r.meal : 'snack') === m.id);
      const sub = totals(list);
      return h(
        'div.food-group',
        { class: { 'is-empty': !list.length } },
        h(
          'div.food-group-head',
          iconChip(m.icon, { accent: COLOR, size: 'sm' }),
          h('h3.food-group-title', m.label),
          list.length && sub.has.calories ? h('span.food-group-total.num', kcal(sub.calories)) : null,
          h('span.spacer'),
          list.length
            ? button({ label: 'Add', icon: 'plus', variant: 'ghost', size: 'sm', class: 'food-group-add', ariaLabel: `Add to ${m.label.toLowerCase()}`, dataset: { focusKey: `add:${m.id}` }, onClick: () => newMeal(m.id) })
            : null
        ),
        list.length
          ? h(
              'div.food-entries',
              list.map((r) =>
                h(
                  'div.food-entry',
                  h(
                    'button.food-entry-main',
                    { type: 'button', dataset: { focusKey: `entry:${r.id}` }, onClick: () => openEditor(r), 'aria-label': `${r.title}${r.time ? `, ${fmtTime(r.time)}` : ''}${macroParts(r).length ? `, ${macroParts(r).join(', ')}` : ''}${QUALITY_BY_ID[r.quality] ? `, ${QUALITY_BY_ID[r.quality].label}` : ''}. Edit` },
                    h(
                      'span.food-entry-text',
                      h('span.food-entry-title', r.title),
                      h(
                        'span.food-entry-meta',
                        r.time ? h('span.num', fmtTime(r.time)) : null,
                        macroParts(r, { full: true }).map((p, i) =>
                          h('span.num', { class: { 'food-meta-strong': i === 0 && num(r.calories) !== null, 'food-meta-extra': i >= macroParts(r).length } }, p)
                        )
                      ),
                      r.note ? h('span.food-entry-note', r.note) : null
                    ),
                    qualityBadge(r.quality)
                  ),
                  r.photoId ? thumb(r.photoId, { size: 52, alt: r.title, label: `Photo of ${r.title}`, ids: photoIds, index: photoIds.indexOf(r.photoId) }) : null
                )
              )
            )
          : h(
              'button.food-group-empty',
              { type: 'button', dataset: { focusKey: `add:${m.id}` }, onClick: () => newMeal(m.id) },
              icon('plus', { size: 16 }),
              h('span', `Log ${m.id === 'snack' ? 'a snack' : m.label.toLowerCase()}`)
            )
      );
    });
    mount(mealsEl, head, h('div.food-groups', groups));
    restoreFocus(mealsEl, focusKey);
  }

  // ---- side: frequent foods + trends
  function drawFrequent() {
    const focusKey = captureFocus(freqBody);
    const top = frequentFoods(allFood);
    freqSub.textContent = top.length ? `One tap logs to ${date === todayKey() ? 'today' : fmtDate(date, 'medium')}` : 'Your go-to foods, one tap away';
    if (!top.length) {
      mount(
        freqBody,
        emptyState({
          icon: 'repeat',
          accent: COLOR,
          compact: true,
          title: 'Nothing here yet',
          message: 'Foods you log often show up here so you can re-log them in one tap.',
          actions: [{ label: 'Log a meal', icon: 'plus', onClick: () => newMeal() }],
        })
      );
      return;
    }
    mount(
      freqBody,
      h(
        'div.food-freq-list',
        top.map((f) => {
          const parts = macroParts(f.last);
          const b = h(
            'button.food-freq-chip',
            {
              type: 'button',
              dataset: { focusKey: `freq:${f.key}` },
              'aria-label': `Log ${f.last.title} again${parts.length ? ` — ${parts.join(', ')}` : ''}`,
              title: `Logged ${plural(f.count, 'time')}`,
              onClick: async () => {
                if (b.disabled) return;
                b.disabled = true;
                try {
                  await relog(f.last, date);
                  b.classList.add('is-done');
                } catch (err) {
                  console.error('[daybook] relog', err);
                  toast('Couldn’t log that — try again.', { type: 'error' });
                } finally {
                  setTimeout(() => {
                    b.disabled = false;
                    b.classList.remove('is-done');
                  }, 700);
                }
              },
            },
            h('span.food-freq-plus', { 'aria-hidden': 'true' }, icon('plus', { size: 14, strokeWidth: 2.25 })),
            h('span.food-freq-text', h('span.food-freq-title', f.last.title), h('span.food-freq-meta.num', parts.length ? parts.join(' · ') : plural(f.count, 'time')))
          );
          return b;
        })
      )
    );
    restoreFocus(freqBody, focusKey);
  }

  async function drawTrends() {
    const token = ++sideToken;
    const end = todayKey();
    const n = trendDays;
    const from = addDays(end, -(n - 1));
    const [food, days] = await Promise.all([db.byRange(STORE, from, end), db.getDays(from, end)]);
    if (disposed || token !== sideToken) return;
    const tg = getSettings().targets || {};
    const keys = rangeKeys(from, end);
    const agg = Object.fromEntries(keys.map((k) => [k, { cal: 0, prot: 0, hasCal: false, hasProt: false, meals: 0 }]));
    const quality = { great: 0, ok: 0, poor: 0 };
    let unrated = 0;
    for (const r of food) {
      const a = agg[r.date];
      if (!a) continue;
      a.meals += 1;
      if (num(r.calories) !== null) (a.cal += r.calories), (a.hasCal = true);
      if (num(r.protein) !== null) (a.prot += r.protein), (a.hasProt = true);
      if (quality[r.quality] !== undefined) quality[r.quality] += 1;
      else unrated += 1;
    }
    const waterDays = keys.map((k) => Number(days[k] && days[k].water) || 0).filter((w) => w > 0);
    const calDays = keys.filter((k) => agg[k].hasCal);
    const protDays = keys.filter((k) => agg[k].hasProt);
    const mealDays = keys.filter((k) => agg[k].meals > 0);
    const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
    const avgCal = avg(calDays.map((k) => agg[k].cal));
    const avgProt = avg(protDays.map((k) => agg[k].prot));
    const avgWater = avg(waterDays);
    const mealsPerDay = mealDays.length ? food.length / mealDays.length : null;

    if (!food.length && !waterDays.length) {
      mount(
        trendsBody,
        emptyState({
          icon: 'line-chart',
          accent: COLOR,
          compact: true,
          title: 'No trends yet',
          message: `Log meals on a few days and your last ${n} days will show up here.`,
          actions: [{ label: 'Log a meal', icon: 'plus', onClick: () => newMeal() }],
        })
      );
      return;
    }

    const avgTile = (label, value, unit, sub, accent) =>
      h(
        'div.food-avg',
        { style: accent ? { '--seg': `var(${accent})` } : null },
        h('span.food-avg-label', label),
        h('span.food-avg-value.num', value === null ? '—' : value, value !== null && unit ? h('span.food-avg-unit', unit) : null),
        h('span.food-avg-sub', sub || ' ')
      );
    const pct = (v, target) => (v !== null && target ? `${fmtPercent(v / target, { decimals: 0 })} of target` : null);

    const calPoints = calDays.map((k) => ({ x: k, y: Math.round(agg[k].cal) }));
    const protPoints = protDays.map((k) => ({ x: k, y: Math.round(agg[k].prot) }));
    const qData = QUALITY.map((q) => ({ label: `${q.label} ${q.emoji}`, value: quality[q.value], color: q.color }));
    const rated = quality.great + quality.ok + quality.poor;

    const chartBlock = (title, sub, chart) => h('div.food-chart', h('div.food-chart-head', h('h3.food-chart-title', title), sub ? h('span.food-chart-sub', sub) : null), chart);

    mount(
      trendsBody,
      h(
        'div.food-avgs',
        avgTile('Avg calories', avgCal === null ? null : fmtNumber(Math.round(avgCal)), 'kcal', pct(avgCal, Number(tg.calories))),
        avgTile('Avg protein', avgProt === null ? null : fmtNumber(Math.round(avgProt)), 'g', pct(avgProt, Number(tg.protein))),
        avgTile('Avg water', avgWater === null ? null : fmtNumber(avgWater, { maxDecimals: 1 }), 'glasses', avgWater !== null ? litres(avgWater, tg.glassMl) : null),
        avgTile('Meals / day', mealsPerDay === null ? null : fmtNumber(mealsPerDay, { maxDecimals: 1 }), '', mealDays.length ? `${mealDays.length} of ${n} days logged` : null)
      ),
      chartBlock(
        'Calories',
        Number(tg.calories) ? `Target ${fmtNumber(Number(tg.calories))} kcal` : 'Daily total',
        lineChart({
          series: [{ name: 'Calories', color: COLOR, points: calPoints }],
          height: 170,
          area: true,
          zeroLine: true,
          target: Number(tg.calories) || undefined,
          targetLabel: 'Target',
          yFormat: (v) => fmtNumber(v, { compact: v >= 10000 }),
          tooltipFormat: (v) => kcal(v),
          emptyText: 'No calories logged',
          ariaLabel: `Calories per day, last ${n} days`,
        })
      ),
      chartBlock(
        'Protein',
        Number(tg.protein) ? `Target ${fmtNumber(Number(tg.protein))} g` : 'Daily total',
        lineChart({
          series: [{ name: 'Protein', color: MACRO_COLORS.protein, points: protPoints }],
          height: 150,
          area: true,
          zeroLine: true,
          target: Number(tg.protein) || undefined,
          targetLabel: 'Target',
          yFormat: (v) => fmtNumber(v),
          tooltipFormat: (v) => grams(v),
          emptyText: 'No protein logged',
          ariaLabel: `Protein per day, last ${n} days`,
        })
      ),
      chartBlock(
        'Meal quality',
        rated ? plural(rated, 'rated meal') : null,
        rated
          ? h(
              'div.food-donut',
              donutChart({
                data: qData,
                size: 148,
                thickness: 18,
                centerValue: fmtPercent(quality.great / rated, { decimals: 0 }),
                centerLabel: 'great',
                valueFormat: (v) => plural(v, 'meal'),
                ariaLabel: 'Meal quality breakdown',
              }),
              unrated ? h('p.food-chart-note', `${plural(unrated, 'meal')} not rated`) : null
            )
          : h('p.food-chart-note', 'Rate meals Great, Okay or Poor to see the balance here.')
      )
    );
  }

  async function drawSide() {
    const all = await db.all(STORE);
    if (disposed) return;
    allFood = all;
    drawFrequent();
  }

  await Promise.all([drawDay(), drawSide(), drawTrends()]);
  if (disposed) return () => {};

  // ---- live updates
  const refreshDay = debounce(drawDay, 60);
  const refreshSide = debounce(drawSide, 120);
  const refreshTrends = debounce(drawTrends, 250);
  const syncWater = debounce(async () => {
    const day = await db.getDay(date);
    if (disposed) return;
    const tg = getSettings().targets || {};
    water.update({ count: Number(day.water) || 0, target: Number(tg.water) || 0, glassMl: tg.glassMl });
  }, 60);

  const offs = [
    on('db:change', (e) => {
      if (!e) return;
      if (e.store === STORE || e.store === '*') {
        refreshDay();
        refreshSide();
        refreshTrends();
      }
      if (e.store === 'days' || e.store === '*') {
        const waterChanged = !e.patch || Object.prototype.hasOwnProperty.call(e.patch, 'water');
        if (waterChanged) {
          if (e.store === '*' || !e.key || e.key === date) syncWater();
          refreshTrends();
        }
      }
    }),
    on('settings:change', () => {
      refreshDay();
      refreshTrends();
    }),
  ];

  // Manifest shortcut / deep link: #/food?new=1 opens the editor, then drops the query.
  if (ctx.route.query && ctx.route.query.new === '1') {
    openEditor(null, { date });
    ctx.navigate(ctx.route.path, { replace: true });
  }

  return () => {
    disposed = true;
    [refreshDay, refreshSide, refreshTrends, syncWater].forEach((f) => f.cancel());
    offs.forEach((off) => off());
  };
}

// ──────────────────────────────────────────────────────────────────────────── module

export default {
  id: ID,
  title: TITLE,
  icon: ICON,
  color: COLOR,
  render,
  openEditor,
  quickActions: [
    { id: 'meal', label: 'Meal', icon: ICON, color: COLOR, run: ({ date } = {}) => openEditor(null, { date }) },
    { id: 'water', label: '+1 Water', icon: 'water', color: '--water', run: quickWater },
  ],

  async summarizeDay(date) {
    const [items, day] = await Promise.all([db.byDate(STORE, date), db.getDay(date)]);
    const t = totals(items);
    const target = Number(getSettings().targets?.water) || 0;
    const w = Number(day.water) || 0;
    const parts = [];
    if (t.has.calories) parts.push(kcal(t.calories));
    if (t.has.protein) parts.push(`${grams(t.protein)} protein`);
    if (w > 0) parts.push(target ? `${w}/${target} water` : `${plural(w, 'glass', 'glasses')} water`);
    return {
      id: ID,
      title: TITLE,
      icon: ICON,
      color: COLOR,
      headline: parts.join(' · '),
      empty: 'No meals yet',
      items: items.map((r) => ({
        id: r.id,
        time: r.time,
        title: r.title,
        meta: [mealLabel(r.meal), ...macroParts(r)].join(' · '),
        onOpen: () => openEditor(r),
      })),
      addLabel: 'Log meal',
      onAdd: () => openEditor(null, { date }),
    };
  },

  async search(query) {
    const q = lower(query);
    if (q.length < 2) return [];
    const all = await db.all(STORE);
    return all
      .filter((r) => [r.title, r.note].some((s) => lower(s).includes(q)))
      .reverse()
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        module: ID,
        icon: ICON,
        color: COLOR,
        title: r.title,
        subtitle: [mealLabel(r.meal), ...macroParts(r), r.note].filter(Boolean).join(' · '),
        date: r.date,
        onOpen: () => openEditor(r),
      }));
  },
};
