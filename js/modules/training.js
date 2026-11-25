// js/modules/training.js — Training log (SPEC 4.4).
//
// Choices not fixed by the spec (kept simple, documented here):
// - Route accepts an optional date param (#/training/2026-11-20). The selected day follows and sets the working date
//   (setWorkingDate) so the global quick-add logs to the day being viewed. Future days can't be selected.
// - Which editor sections show: distance for cardio / walk / sports, the exercise builder for strength / hiit / other,
//   both for custom (user-added) types, neither for yoga / mobility — but a section that already holds data always
//   stays visible, so switching type never hides (and silently drops) what was entered.
// - Est. 1RM uses the spec formula w × (1 + reps/30) for every set (also 1-rep sets). Bodyweight exercises (all sets
//   at 0 weight) show their best reps instead of a weight PR. A PR's date is the first day it was achieved; "NEW" =
//   achieved within the last 7 days. Saving a workout that beats an earlier best toasts the new PR.
// - "Repeat a past workout" lists the 10 most recent *distinct* workouts (by type + title) and copies everything but
//   date / time. Typing a past title in a new workout offers the same one-tap copy.
// - Exercise builder: Enter in a reps / weight box moves to the next box instead of saving the sheet (fast set entry);
//   Enter elsewhere saves. A new exercise whose name matches a past one is pre-filled with last session's sets.
// - Steps / body weight autosave (debounced 600 ms, flushed on blur and when the day changes) via db.patchDay.
// - Weekly summary compares minutes with the whole previous week. Heatmap / bar clicks select that day / week.

import { db } from '../core/db.js';
import { on, state, setWorkingDate } from '../core/bus.js';
import { getSettings, workoutType } from '../core/settings.js';
import { todayKey, nowTime, fmtTime, fmtDate, fmtRange, relativeDay, addDays, diffDays, isValidKey, startOfWeek, weekKeys } from '../core/dates.js';
import { fmtNumber, fmtDuration, fmtWeight, fmtDistance, plural, toNumber } from '../core/format.js';
import { h, mount, icon, button, iconChip, badge, pageHeader, emptyState, openSheet, field, input, textarea, select, chips, range, stepper, moodPicker, toast, confirmDialog, progressRing, progressBar, debounce } from '../core/ui.js';
import { lineChart, barChart, heatmap } from '../core/charts.js';
import { removeWithUndo } from '../core/undo.js';

const ID = 'training';
const TITLE = 'Training';
const ICON = 'training';
const COLOR = '--training';
const STORE = 'workouts';

const DIST_TYPES = new Set(['cardio', 'walk', 'sports']);
const EX_TYPES = new Set(['strength', 'hiit', 'other']);
const BUILTIN = new Set([...DIST_TYPES, ...EX_TYPES, 'yoga', 'mobility']);
const PACE_TYPES = new Set(['cardio', 'walk']);
const FEEL_LABELS = ['Rough', 'Meh', 'Okay', 'Good', 'Great'];
const DURATION_PRESETS = [20, 30, 45, 60, 90];
const PR_LIMIT = 6;

let progressExercise = null; // remembered across renders
let showAllPRs = false;

// ──────────────────────────────────────────────────────────────────────────── helpers

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const lower = (s) => String(s || '').trim().toLowerCase();
const wUnit = () => (getSettings().units && getSettings().units.weight) || 'kg';
const dUnit = () => (getSettings().units && getSettings().units.distance) || 'km';
const fmtW = (n) => fmtNumber(n, { maxDecimals: 1 });
const typeOf = (id) => workoutType(id);
const titleOf = (w) => (w && w.title && String(w.title).trim()) || typeOf(w && w.type).name || 'Workout';
const showsDistance = (t) => DIST_TYPES.has(t) || !BUILTIN.has(t);
const showsExercises = (t) => EX_TYPES.has(t) || !BUILTIN.has(t);
const e1rm = (w, reps) => w * (1 + reps / 30);
const validSet = (s) => !!s && ((num(s.reps) || 0) > 0 || (num(s.weight) || 0) > 0);
const minLabel = (m) => (m < 60 ? `${Math.round(m)} min` : fmtDuration(m));

function intensityLabel(n) {
  if (!n) return '';
  if (n <= 2) return 'Very easy';
  if (n <= 4) return 'Easy';
  if (n <= 6) return 'Moderate';
  if (n <= 8) return 'Hard';
  if (n === 9) return 'Very hard';
  return 'Max effort';
}
const intensityText = (n) => (num(n) ? `${n} · ${intensityLabel(n)}` : '');

/** '5:42 /km' or null. */
function paceOf(w) {
  const d = num(w.distance);
  const m = num(w.duration);
  if (!d || !m || d <= 0) return null;
  const per = m / d;
  if (!Number.isFinite(per) || per > 60) return null;
  let mm = Math.floor(per);
  let ss = Math.round((per - mm) * 60);
  if (ss === 60) (mm += 1), (ss = 0);
  return `${mm}:${String(ss).padStart(2, '0')} /${dUnit()}`;
}

/** 'Bench press 3×8 @ 60 kg' (reps range when they differ, top weight). */
function exerciseSummary(ex) {
  const name = String(ex.name || '').trim() || 'Exercise';
  const sets = (ex.sets || []).filter(validSet);
  if (!sets.length) return name;
  const reps = sets.map((s) => num(s.reps) || 0);
  const lo = Math.min(...reps);
  const hi = Math.max(...reps);
  const maxW = Math.max(...sets.map((s) => num(s.weight) || 0));
  let s = hi === 0 ? plural(sets.length, 'set') : lo === hi ? `${sets.length}×${hi}` : `${sets.length}×${lo}–${hi}`;
  if (maxW > 0) s += ` @ ${fmtW(maxW)} ${wUnit()}`;
  return `${name} ${s}`;
}

function setsText(sets) {
  const ok = (sets || []).filter(validSet);
  if (!ok.length) return '';
  return exerciseSummary({ name: '', sets: ok }).replace(/^Exercise /, '');
}

function namedExercises(w) {
  return (Array.isArray(w.exercises) ? w.exercises : []).filter((e) => e && String(e.name || '').trim());
}

/** Per-exercise history + records from all workouts (ascending). */
function exerciseIndex(all, { excludeId } = {}) {
  const map = new Map();
  for (const w of all) {
    if (!w || w.id === excludeId) continue;
    for (const ex of namedExercises(w)) {
      const key = lower(ex.name);
      let e = map.get(key);
      if (!e) {
        e = { key, name: String(ex.name).trim(), count: 0, sessions: new Map(), bestW: null, best1: null, bestReps: null, last: null, lastDate: null };
        map.set(key, e);
      }
      e.name = String(ex.name).trim();
      e.count += 1;
      const sets = (ex.sets || []).filter(validSet);
      if (sets.length) {
        e.last = sets.map((s) => ({ reps: num(s.reps), weight: num(s.weight) }));
        e.lastDate = w.date;
      }
      for (const s of sets) {
        const wt = num(s.weight) || 0;
        const r = num(s.reps) || 0;
        let sess = e.sessions.get(w.date);
        if (!sess) e.sessions.set(w.date, (sess = { date: w.date, top: 0, best1: 0, reps: 0 }));
        if (wt > sess.top) sess.top = wt;
        if (r > sess.reps) sess.reps = r;
        if (wt > 0 && r > 0) {
          const est = e1rm(wt, r);
          if (est > sess.best1) sess.best1 = est;
          if (!e.best1 || est > e.best1.v + 1e-9) e.best1 = { v: est, w: wt, reps: r, date: w.date };
        }
        if (wt > 0 && (!e.bestW || wt > e.bestW.w || (wt === e.bestW.w && r > e.bestW.reps))) {
          e.bestW = { w: wt, reps: r, date: wt === (e.bestW && e.bestW.w) ? e.bestW.date : w.date };
        }
        if (r > 0 && (!e.bestReps || r > e.bestReps.reps)) e.bestReps = { reps: r, date: w.date };
      }
    }
  }
  return map;
}

function prDate(e) {
  if (e.bestW) return [e.bestW.date, e.best1 && e.best1.date].filter(Boolean).sort().pop();
  return e.bestReps ? e.bestReps.date : null;
}

function captureFocus(container) {
  const a = document.activeElement;
  return a && container.contains(a) && a.dataset ? a.dataset.focusKey || null : null;
}
function restoreFocus(container, key) {
  if (!key) return;
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"');
  const el = container.querySelector(`[data-focus-key="${esc}"]`);
  if (el && !el.disabled && (document.activeElement === document.body || !document.activeElement || !document.activeElement.isConnected)) el.focus({ preventScroll: true });
}
/** mount() that keeps keyboard focus on the "same" element (data-focus-key) across re-draws. */
function remount(container, ...kids) {
  const key = captureFocus(container);
  mount(container, ...kids);
  restoreFocus(container, key);
}

function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function workoutMeta(w) {
  const parts = [];
  if (w.time) parts.push(fmtTime(w.time));
  parts.push(fmtDuration(w.duration));
  if (num(w.intensity)) parts.push(`RPE ${intensityText(w.intensity)}`);
  return parts;
}

// ──────────────────────────────────────────────────────────────────────────── editor

let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

function draftFrom(r, base) {
  const types = getSettings().workoutTypes || [];
  const t = r && r.type && types.some((x) => x.id === r.type) ? r.type : r && r.type ? r.type : base.type;
  return {
    date: base.date,
    time: base.time,
    type: t,
    title: (r && r.title) || '',
    duration: r ? num(r.duration) : base.duration,
    intensity: r ? num(r.intensity) : null,
    calories: r ? num(r.calories) : null,
    distance: r ? num(r.distance) : null,
    exercises: (r && Array.isArray(r.exercises) ? r.exercises : [])
      .filter((e) => e && (String(e.name || '').trim() || (e.sets || []).some(validSet)))
      .map((e) => ({ _k: nextKey(), name: String(e.name || ''), sets: (e.sets || []).map((s) => ({ _k: nextKey(), reps: num(s && s.reps), weight: num(s && s.weight) })) })),
    feeling: r ? num(r.feeling) : null,
    notes: (r && r.notes) || '',
  };
}

/** Add/edit sheet. record=null → new (a record without id = template). opts={date, type, repeat}. → Promise<saved|null> */
function openEditor(record = null, opts = {}) {
  const isNew = !record || !record.id;
  const today = todayKey();
  const s0 = getSettings();
  const types = (s0.workoutTypes || []).length ? s0.workoutTypes : [{ id: 'strength', name: 'Strength', emoji: '🏋️' }];
  const date0 = (record && record.id && record.date) || opts.date || state.date || today;
  const time0 = record && record.id ? record.time || '' : date0 === today ? nowTime() : '';
  const defType = types.some((t) => t.id === opts.type) ? opts.type : types[0].id;
  let draft = draftFrom(record, { date: date0, time: time0, type: defType, duration: 45 });
  if (isNew && record) draft.date = date0;
  // empty exercise rows (auto-added for strength types) don't count as changes
  const snapshot = () => JSON.stringify({ ...draft, exercises: draft.exercises.filter((e) => String(e.name).trim() || e.sets.some(validSet)) });
  const initial = snapshot();

  let all = []; // past workouts, ascending
  let index = new Map(); // exercise index (excluding this record)
  let repeatOpen = !!opts.repeat;
  let copiedFrom = null;

  const uid = Math.random().toString(36).slice(2, 8);
  const titleListId = `tr-titles-${uid}`;
  const exListId = `tr-ex-${uid}`;
  const titleList = h('datalist', { id: titleListId });
  const exList = h('datalist', { id: exListId });

  const repeatBox = h('div.tr-repeat');
  const body = h('div.stack.tr-editor-body');
  const form = h('form.stack.tr-editor', { autocomplete: 'off', noValidate: true }, repeatBox, body, titleList, exList);

  // controls (re-created by renderForm)
  let f = {};

  function renderRepeat() {
    if (!isNew) return mount(repeatBox);
    const recent = recentDistinct(all, 10);
    if (!recent.length) return mount(repeatBox);
    const toggleBtn = button({
      label: copiedFrom ? `Copied from ${copiedFrom}` : 'Repeat a past workout',
      icon: copiedFrom ? 'check' : 'repeat',
      iconEnd: repeatOpen ? 'chevron-up' : 'chevron-down',
      variant: 'secondary',
      block: true,
      class: 'tr-repeat-toggle',
      'aria-expanded': repeatOpen ? 'true' : 'false',
      onClick: () => {
        repeatOpen = !repeatOpen;
        renderRepeat();
        repeatBox.querySelector('.tr-repeat-toggle')?.focus();
      },
    });
    mount(
      repeatBox,
      toggleBtn,
      repeatOpen
        ? h(
            'div.tr-repeat-list',
            { role: 'list', 'aria-label': 'Recent workouts' },
            recent.map((w) => {
              const t = typeOf(w.type);
              const exN = namedExercises(w).length;
              const meta = [relativeDay(w.date), fmtDuration(w.duration), exN ? plural(exN, 'exercise') : num(w.distance) ? fmtDistance(w.distance) : null].filter(Boolean).join(' · ');
              return h(
                'div',
                { role: 'listitem' },
                h(
                  'button.tr-repeat-item',
                  { type: 'button', onClick: () => applyTemplate(w), 'aria-label': `Repeat ${titleOf(w)}, ${meta}` },
                  h('span.tr-emoji', { 'aria-hidden': 'true', style: { '--tc': t.color || 'var(--training)' } }, t.emoji || '💪'),
                  h('span.tr-repeat-text', h('span.tr-repeat-title', titleOf(w)), h('span.tr-repeat-meta', meta)),
                  icon('chevron-right', { size: 18 })
                )
              );
            })
          )
        : null
    );
  }

  function applyTemplate(w) {
    const keep = { date: draft.date, time: draft.time };
    draft = draftFrom(w, { ...keep, type: defType, duration: 45 });
    Object.assign(draft, keep);
    copiedFrom = titleOf(w);
    repeatOpen = false;
    renderForm();
    renderRepeat();
    sheet.body && sheet.body.scrollTo && sheet.body.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    toast(`Copied “${titleOf(w)}” — adjust and save`, { duration: 2200 });
    (f.durStepper && f.durStepper.input ? f.durStepper.input : body).focus?.({ preventScroll: true });
  }

  function renderForm() {
    f = {};
    // ---- type
    f.typeChips = chips(
      types.map((t) => ({ value: t.id, label: t.name, emoji: t.emoji, color: t.color })),
      draft.type,
      (v) => {
        draft.type = v || draft.type;
        f.titleIn.placeholder = placeholderFor(draft.type);
        syncSections();
      },
      { ariaLabel: 'Workout type', deselect: false, class: 'tr-type-chips' }
    );

    // ---- title
    f.titleIn = input({
      value: draft.title,
      placeholder: placeholderFor(draft.type),
      autocomplete: 'off',
      autocapitalize: 'sentences',
      enterkeyhint: 'done',
      maxlength: '80',
      list: titleListId,
      onInput: (e) => {
        draft.title = e.target.value;
        suggestFromTitle();
      },
    });
    f.titleSuggest = h('div.tr-title-suggest', { hidden: true });
    f.titleField = field('Title', h('div.stack-sm', f.titleIn, f.titleSuggest), { hint: null });

    // ---- duration + presets
    f.durStepper = stepper(draft.duration, (v) => {
      draft.duration = v;
      f.durField.setError(null);
      paintPresets();
      paintPace();
    }, { min: 0, max: 1440, step: 5, label: 'Duration', unit: 'min', decimals: 0, inputProps: { inputmode: 'numeric' } });
    f.presets = h(
      'div.tr-presets',
      { role: 'group', 'aria-label': 'Quick durations' },
      DURATION_PRESETS.map((m) =>
        h('button.tr-preset', { type: 'button', dataset: { min: String(m) }, 'aria-label': `${m} minutes`, onClick: () => { draft.duration = m; f.durStepper.setValue(m); f.durField.setError(null); paintPresets(); paintPace(); } }, fmtDuration(m))
      )
    );
    f.durField = field('Duration', h('div.tr-duration', f.durStepper, f.presets), { required: true });

    // ---- intensity
    f.intOut = h('span.tr-int-out');
    f.intRange = range(draft.intensity ?? 6, (v) => {
      draft.intensity = v;
      paintIntensity();
    }, { min: 1, max: 10, step: 1, label: 'Intensity', accent: COLOR, class: 'range tr-int-range' });
    f.intClear = h('button.link-btn.tr-int-clear', { type: 'button', onClick: () => { draft.intensity = null; f.intRange.setValue(6); paintIntensity(); f.intRange.focus(); } }, 'Clear');
    f.intScale = h('div.tr-int-scale', { 'aria-hidden': 'true' }, h('span', 'Easy'), h('span', 'Moderate'), h('span', 'Max'));
    f.intField = field('Intensity (RPE)', h('div.tr-int', f.intRange, f.intScale), { aside: h('span.tr-int-aside', f.intOut, f.intClear) });

    // ---- calories + distance
    const numBox = (key, unit, props = {}) => {
      const inp = input({
        type: 'number',
        min: '0',
        value: draft[key] === null ? '' : String(draft[key]),
        placeholder: '—',
        ...props,
        onInput: (e) => {
          draft[key] = toNumber(e.target.value);
          f[`${key}Field`] && f[`${key}Field`].setError(null);
          if (key === 'distance') paintPace();
        },
      });
      return { inp, el: h('div.input-affix', { onClick: (e) => { if (e.target !== inp) inp.focus(); } }, inp, h('span.affix', { 'aria-hidden': 'true' }, unit)) };
    };
    const cal = numBox('calories', 'kcal', { inputmode: 'numeric', step: '1' });
    const dist = numBox('distance', dUnit());
    f.caloriesIn = cal.inp;
    f.distanceIn = dist.inp;
    f.caloriesField = field('Calories burned', cal.el);
    f.distanceField = field('Distance', dist.el);
    f.metricsGrid = h('div.form-grid.tr-metrics-grid', f.distanceField, f.caloriesField);

    // ---- exercises
    f.exBox = h('div.tr-ex-list');
    f.addExBtn = button({ label: 'Add exercise', icon: 'plus', variant: 'secondary', block: true, class: 'tr-add-ex', dataset: { fk: 'add-ex' }, onClick: () => addExercise() });
    f.exSection = h(
      'div.tr-ex-section',
      { role: 'group', 'aria-labelledby': `tr-ex-label-${uid}` },
      h('div.tr-ex-head', h('div.field-label', { id: `tr-ex-label-${uid}` }, h('span.field-label-text', 'Exercises')), h('span.tr-ex-total')),
      f.exBox,
      f.addExBtn
    );

    // ---- feeling, notes, date, time
    f.feel = moodPicker(draft.feeling, (v) => { draft.feeling = v; }, { labels: FEEL_LABELS, ariaLabel: 'How did it feel?' });
    f.notesIn = textarea({ value: draft.notes, rows: 2, placeholder: 'How did it go? Anything to remember next time…', onInput: (e) => { draft.notes = e.target.value; } });
    f.dateIn = input({
      type: 'date',
      value: draft.date,
      max: todayKey(),
      onChange: (e) => {
        draft.date = e.target.value || draft.date;
        f.dateField.setError(null);
        if (isValidKey(draft.date)) sheet.setSubtitle(relativeDay(draft.date));
      },
    });
    f.dateField = field('Date', f.dateIn);
    f.timeIn = input({ type: 'time', value: draft.time, onChange: (e) => { draft.time = e.target.value; } });

    mount(
      body,
      field('Type', f.typeChips),
      f.titleField,
      h('div.tr-dur-int', f.durField, f.intField),
      f.metricsGrid,
      f.exSection,
      field('How did it feel?', f.feel),
      field('Notes', f.notesIn),
      h('div.form-grid', f.dateField, field('Time', f.timeIn))
    );
    renderExercises();
    syncSections();
    paintPresets();
    paintIntensity();
    paintPace();
    suggestFromTitle();
  }

  function placeholderFor(t) {
    return { strength: 'e.g. Push day, Upper body', cardio: 'e.g. Easy run, Tempo run', hiit: 'e.g. HIIT circuit', yoga: 'e.g. Morning flow', sports: 'e.g. Badminton', walk: 'e.g. Evening walk', mobility: 'e.g. Hip mobility' }[t] || 'Name this workout';
  }

  function syncSections() {
    const hasEx = draft.exercises.some((e) => String(e.name).trim() || e.sets.some(validSet));
    const showEx = showsExercises(draft.type) || hasEx;
    const showDist = showsDistance(draft.type) || draft.distance !== null;
    f.exSection.hidden = !showEx;
    f.distanceField.hidden = !showDist;
    f.metricsGrid.classList.toggle('is-single', !showDist);
    if (showEx && !draft.exercises.length && isNew && !hasEx) {
      // start a new strength-type workout with one empty exercise row
      draft.exercises.push({ _k: nextKey(), name: '', sets: [{ _k: nextKey(), reps: null, weight: null }] });
      renderExercises();
    }
  }

  function paintPresets() {
    for (const b of f.presets.children) b.setAttribute('aria-pressed', String(Number(b.dataset.min) === draft.duration));
  }
  function paintIntensity() {
    const v = draft.intensity;
    f.intOut.textContent = v ? intensityText(v) : 'Not set';
    f.intOut.classList.toggle('is-unset', !v);
    f.intRange.classList.toggle('is-unset', !v);
    f.intRange.setAttribute('aria-valuetext', v ? intensityText(v) : 'Not set');
    f.intClear.hidden = !v;
  }
  function paintPace() {
    const p = PACE_TYPES.has(draft.type) ? paceOf(draft) : null;
    f.distanceField.setHint(p ? `Pace ${p}` : null);
  }

  function suggestFromTitle() {
    if (!f.titleSuggest) return;
    const k = lower(draft.title);
    const match = isNew && k ? [...all].reverse().find((w) => lower(w.title) === k) : null;
    const fresh = !draft.exercises.some((e) => String(e.name).trim() || e.sets.some(validSet));
    if (!match || !fresh || copiedFrom) {
      f.titleSuggest.hidden = true;
      return;
    }
    mount(
      f.titleSuggest,
      h(
        'button.tr-suggest-btn',
        { type: 'button', onClick: () => applyTemplate(match) },
        icon('repeat', { size: 16 }),
        h('span', `Fill in from ${fmtDate(match.date, 'short')} — ${[fmtDuration(match.duration), namedExercises(match).length ? plural(namedExercises(match).length, 'exercise') : null].filter(Boolean).join(', ')}`)
      )
    );
    f.titleSuggest.hidden = false;
  }

  // ---- exercise builder
  function focusKey(k) {
    const el = body.querySelector(`[data-fk="${k}"]`);
    if (el) el.focus();
  }
  function lastHint(ex) {
    const e = index.get(lower(ex.name));
    if (!e || !e.last) return null;
    return `Last time · ${setsText(e.last)} · ${fmtDate(e.lastDate, 'short')}`;
  }
  function volumeText(ex) {
    const sets = ex.sets.filter(validSet);
    const vol = sets.reduce((s, x) => s + (num(x.reps) || 0) * (num(x.weight) || 0), 0);
    return sets.length ? [plural(sets.length, 'set'), vol > 0 ? `${fmtNumber(Math.round(vol))} ${wUnit()} volume` : null].filter(Boolean).join(' · ') : '';
  }
  function paintTotal() {
    const t = f.exSection.querySelector('.tr-ex-total');
    const n = draft.exercises.filter((e) => String(e.name).trim()).length;
    const sets = draft.exercises.reduce((s, e) => s + e.sets.filter(validSet).length, 0);
    t.textContent = n || sets ? [n ? plural(n, 'exercise') : null, sets ? plural(sets, 'set') : null].filter(Boolean).join(' · ') : '';
  }

  function renderExercises(focus) {
    mount(f.exBox, draft.exercises.map((ex, i) => exerciseCard(ex, i)));
    paintTotal();
    if (focus) focusKey(focus);
  }

  function exerciseCard(ex, i) {
    const n = i + 1;
    const hintEl = h('div.tr-ex-hint');
    const errEl = h('div.field-error', { hidden: true, role: 'alert' });
    const volEl = h('span.tr-ex-vol');
    const paintHint = () => {
      const t = lastHint(ex);
      hintEl.textContent = t || '';
      hintEl.hidden = !t;
      volEl.textContent = volumeText(ex);
    };
    const nameIn = input({
      value: ex.name,
      placeholder: 'Exercise, e.g. Bench press',
      list: exListId,
      autocomplete: 'off',
      autocapitalize: 'sentences',
      maxlength: '60',
      enterkeyhint: 'next',
      'aria-label': `Exercise ${n} name`,
      class: 'tr-ex-name',
      dataset: { fk: `name:${ex._k}` },
      onInput: (e) => {
        ex.name = e.target.value;
        errEl.hidden = true;
        nameIn.removeAttribute('aria-invalid');
        paintHint();
        paintTotal();
      },
      onChange: () => maybeFill(ex),
    });
    nameIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        maybeFill(ex);
        const first = ex.sets[0];
        if (first) focusKey(`reps:${first._k}`);
      }
    });
    ex._err = (msg) => {
      errEl.replaceChildren();
      if (msg) errEl.append(icon('alert', { size: 14 }), h('span', msg));
      errEl.hidden = !msg;
      if (msg) nameIn.setAttribute('aria-invalid', 'true');
      else nameIn.removeAttribute('aria-invalid');
    };

    const rows = ex.sets.map((s, j) => setRow(ex, i, s, j, () => { volEl.textContent = volumeText(ex); paintTotal(); }));
    paintHint();
    return h(
      'div.tr-ex',
      { dataset: { k: ex._k } },
      h(
        'div.tr-ex-top',
        h('span.tr-ex-num', { 'aria-hidden': 'true' }, String(n)),
        nameIn,
        h('button.btn.btn-ghost.btn-icon.tr-icon-btn.tr-ex-remove', { type: 'button', 'aria-label': `Remove exercise ${n}${ex.name ? ` (${ex.name})` : ''}`, title: 'Remove exercise', dataset: { fk: `rmex:${ex._k}` }, onClick: () => removeExercise(i) }, icon('trash', { size: 18 }))
      ),
      hintEl,
      errEl,
      ex.sets.length
        ? h(
            'div.tr-sets',
            h('div.tr-sets-head', { 'aria-hidden': 'true' }, h('span', 'Set'), h('span', 'Reps'), h('span'), h('span', wUnit()), h('span'), h('span')),
            rows
          )
        : h('p.tr-no-sets', 'No sets yet'),
      h(
        'div.tr-ex-foot',
        h('button.btn.btn-ghost.btn-sm.tr-add-set', { type: 'button', dataset: { fk: `addset:${ex._k}` }, 'aria-label': `Add set to exercise ${n}`, onClick: () => addSet(ex) }, icon('plus', { size: 16 }), h('span', 'Add set')),
        volEl
      )
    );
  }

  function setRow(ex, i, s, j, onChanged) {
    const label = `Exercise ${i + 1}, set ${j + 1}`;
    const moveNext = (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      const boxes = [...f.exBox.querySelectorAll('.tr-set-in')];
      const at = boxes.indexOf(e.target);
      if (at >= 0 && at < boxes.length - 1) boxes[at + 1].focus();
      else f.exBox.querySelector(`[data-fk="addset:${ex._k}"]`)?.focus();
    };
    const reps = input({
      type: 'number', inputmode: 'numeric', step: '1', min: '0', max: '1000', placeholder: '0', enterkeyhint: 'next',
      value: s.reps === null ? '' : String(s.reps), class: 'tr-set-in', 'aria-label': `${label} reps`, dataset: { fk: `reps:${s._k}` },
      onInput: (e) => { s.reps = toNumber(e.target.value); reps.removeAttribute('aria-invalid'); onChanged(); },
    });
    const weight = input({
      type: 'number', min: '0', max: '2000', placeholder: '0', enterkeyhint: 'next',
      value: s.weight === null ? '' : String(s.weight), class: 'tr-set-in', 'aria-label': `${label} weight in ${wUnit()}`, dataset: { fk: `wt:${s._k}` },
      onInput: (e) => { s.weight = toNumber(e.target.value); weight.removeAttribute('aria-invalid'); onChanged(); },
    });
    reps.addEventListener('keydown', moveNext);
    weight.addEventListener('keydown', moveNext);
    s._inputs = { reps, weight };
    return h(
      'div.tr-set',
      h('span.tr-set-n.num', { 'aria-hidden': 'true' }, String(j + 1)),
      reps,
      h('span.tr-set-x', { 'aria-hidden': 'true' }, '×'),
      weight,
      h('button.btn.btn-ghost.btn-icon.tr-icon-btn', { type: 'button', 'aria-label': `Duplicate ${label.toLowerCase()}`, title: 'Duplicate set', dataset: { fk: `dup:${s._k}` }, onClick: () => dupSet(ex, j) }, icon('copy', { size: 17 })),
      h('button.btn.btn-ghost.btn-icon.tr-icon-btn.tr-set-remove', { type: 'button', 'aria-label': `Remove ${label.toLowerCase()}`, title: 'Remove set', dataset: { fk: `rmset:${s._k}` }, onClick: () => removeSet(ex, j) }, icon('x', { size: 18 }))
    );
  }

  function maybeFill(ex) {
    const e = index.get(lower(ex.name));
    if (!e || !e.last || ex.sets.some(validSet)) return;
    ex.name = e.name;
    ex.sets = e.last.map((s) => ({ _k: nextKey(), reps: s.reps, weight: s.weight }));
    const active = document.activeElement;
    const wasName = active && active.dataset && active.dataset.fk === `name:${ex._k}`;
    renderExercises(wasName ? `name:${ex._k}` : null);
  }
  function addExercise() {
    const ex = { _k: nextKey(), name: '', sets: [{ _k: nextKey(), reps: null, weight: null }] };
    draft.exercises.push(ex);
    renderExercises(`name:${ex._k}`);
  }
  function removeExercise(i) {
    const [gone] = draft.exercises.splice(i, 1);
    renderExercises('add-ex');
    if (!gone) return;
    if (String(gone.name).trim() || gone.sets.some(validSet)) {
      toast(`Removed ${String(gone.name).trim() || 'exercise'}`, {
        duration: 5000,
        action: { label: 'Undo', onClick: () => { draft.exercises.splice(Math.min(i, draft.exercises.length), 0, gone); renderExercises(`name:${gone._k}`); syncSections(); } },
      });
    }
  }
  function addSet(ex) {
    const prev = ex.sets[ex.sets.length - 1];
    const s = { _k: nextKey(), reps: prev ? prev.reps : null, weight: prev ? prev.weight : null };
    ex.sets.push(s);
    renderExercises(`reps:${s._k}`);
  }
  function dupSet(ex, j) {
    const src = ex.sets[j];
    const s = { _k: nextKey(), reps: src.reps, weight: src.weight };
    ex.sets.splice(j + 1, 0, s);
    renderExercises(`dup:${s._k}`);
  }
  function removeSet(ex, j) {
    ex.sets.splice(j, 1);
    const next = ex.sets[j] || ex.sets[j - 1];
    renderExercises(next ? `rmset:${next._k}` : `addset:${ex._k}`);
  }

  // ---- validation + save
  function validate() {
    let firstBad = null;
    const bad = (el) => { firstBad = firstBad || el; };
    const d = draft.duration;
    if (f.durStepper.input.validity && f.durStepper.input.validity.badInput) {
      f.durField.setError('Numbers only');
      bad(f.durStepper.input);
    } else if (d === null || !(d > 0)) {
      f.durField.setError('How long was it? Add the minutes');
      bad(f.durStepper.input);
    } else if (d > 1440) {
      f.durField.setError('That’s more than a day');
      bad(f.durStepper.input);
    }
    for (const [key, max] of [['distance', 1000], ['calories', 20000]]) {
      const fld = f[`${key}Field`];
      const inp = f[`${key}In`];
      if (fld.hidden) continue;
      if (inp.validity && inp.validity.badInput) (fld.setError('Numbers only'), bad(inp));
      else if (draft[key] !== null && draft[key] < 0) (fld.setError('Can’t be negative'), bad(inp));
      else if (draft[key] !== null && draft[key] > max) (fld.setError('That looks too big'), bad(inp));
    }
    if (!f.exSection.hidden) {
      for (const ex of draft.exercises) {
        let msg = null;
        let el = null;
        for (const s of ex.sets) {
          const r = s._inputs && s._inputs.reps;
          const w = s._inputs && s._inputs.weight;
          if (r && ((r.validity && r.validity.badInput) || (s.reps !== null && (s.reps < 0 || s.reps > 1000 || !Number.isInteger(s.reps))))) {
            msg = msg || 'Reps should be a whole number';
            r.setAttribute('aria-invalid', 'true');
            el = el || r;
          }
          if (w && ((w.validity && w.validity.badInput) || (s.weight !== null && (s.weight < 0 || s.weight > 2000)))) {
            msg = msg || 'Check the weight';
            w.setAttribute('aria-invalid', 'true');
            el = el || w;
          }
        }
        if (!String(ex.name).trim() && ex.sets.some(validSet)) {
          msg = 'Name this exercise';
          el = f.exBox.querySelector(`[data-fk="name:${ex._k}"]`);
        }
        ex._err && ex._err(msg);
        if (el) bad(el);
      }
    }
    if (!isValidKey(draft.date)) (f.dateField.setError('Pick a date'), bad(f.dateIn));
    else if (draft.date > todayKey()) (f.dateField.setError('Can’t log workouts in the future'), bad(f.dateIn));
    if (firstBad) firstBad.focus();
    return !firstBad;
  }

  function output() {
    const showEx = !f.exSection.hidden;
    const showDist = !f.distanceField.hidden;
    const exercises = showEx
      ? draft.exercises
          .map((e) => ({ name: String(e.name).trim().replace(/\s+/g, ' '), sets: e.sets.filter(validSet).map((s) => ({ reps: num(s.reps) || 0, weight: num(s.weight) || 0 })) }))
          .filter((e) => e.name)
      : [];
    const out = {
      ...(isNew ? {} : record),
      date: draft.date,
      time: draft.time || '',
      type: draft.type,
      title: draft.title.trim().replace(/\s+/g, ' '),
      duration: Math.round(draft.duration),
      intensity: num(draft.intensity),
      calories: num(draft.calories),
      distance: showDist ? num(draft.distance) : null,
      exercises,
      feeling: num(draft.feeling),
      notes: draft.notes.trim(),
    };
    if (isNew) delete out.sample;
    return out;
  }

  function newPRs(saved) {
    const out = [];
    for (const ex of namedExercises(saved)) {
      const prev = index.get(lower(ex.name));
      if (!prev || !prev.bestW) continue;
      const top = Math.max(0, ...ex.sets.map((s) => num(s.weight) || 0));
      if (top > prev.bestW.w) out.push(`${ex.name} ${fmtWeight(top)}`);
    }
    return out;
  }

  renderForm();

  // Past workouts → datalists, exercise hints, repeat list.
  db.all(STORE)
    .then((list) => {
      all = list.filter((w) => !record || w.id !== record.id);
      index = exerciseIndex(all);
      const seen = new Set();
      const titles = [];
      for (let i = all.length - 1; i >= 0 && titles.length < 200; i--) {
        const k = lower(all[i].title);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        titles.push(h('option', { value: String(all[i].title).trim() }));
      }
      mount(titleList, titles);
      const names = [...index.values()].sort((a, b) => b.count - a.count).slice(0, 300);
      mount(exList, names.map((e) => h('option', { value: e.name })));
      renderRepeat();
      // refresh "last time" hints without stealing focus
      for (const card of f.exBox.querySelectorAll('.tr-ex')) {
        const ex = draft.exercises.find((x) => x._k === card.dataset.k);
        const hint = card.querySelector('.tr-ex-hint');
        const t = ex && lastHint(ex);
        if (hint) (hint.textContent = t || ''), (hint.hidden = !t);
      }
      suggestFromTitle();
    })
    .catch((err) => console.warn('[daybook] training history', err));

  const sheet = openSheet({
    title: isNew ? 'Log workout' : 'Edit workout',
    subtitle: relativeDay(draft.date),
    icon: ICON,
    accent: COLOR,
    content: form,
    size: 'lg',
    className: 'training-sheet',
    initialFocus: null,
    guard: async () => {
      if (snapshot() === initial) return true;
      return confirmDialog({ title: isNew ? 'Discard this workout?' : 'Discard changes?', message: 'What you entered won’t be saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing' });
    },
    actions: [
      !isNew && {
        label: 'Delete',
        variant: 'danger',
        icon: 'trash',
        onClick: async () => {
          await removeWithUndo(STORE, record, { label: 'Workout deleted' });
          return null;
        },
      },
      { label: 'Cancel', variant: 'secondary' },
      {
        label: 'Save',
        variant: 'primary',
        onClick: async () => {
          if (!validate()) return false;
          const saved = await db.put(STORE, output());
          const prs = newPRs(saved);
          if (prs.length) toast(`🏆 New PR · ${prs.slice(0, 2).join(' · ')}${prs.length > 2 ? ` +${prs.length - 2}` : ''}`, { type: 'success', duration: 4200 });
          else toast('Saved', { type: 'success', duration: 1800 });
          return saved;
        },
      },
    ].filter(Boolean),
  });
  return sheet.result;
}

/** Most recent workouts with a distinct type + title, newest first. */
function recentDistinct(all, n) {
  const out = [];
  const seen = new Set();
  for (let i = all.length - 1; i >= 0 && out.length < n; i--) {
    const w = all[i];
    const k = `${w.type}|${lower(titleOf(w))}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────── body metrics (steps / weight)

function bodyMetrics(getDate) {
  let day = null;
  let lastWeight = null;
  const live = h('span.tr-saved', { 'aria-live': 'polite' });
  let liveTimer = 0;
  const flashSaved = () => {
    live.replaceChildren(icon('check', { size: 14 }), h('span', 'Saved'));
    live.classList.add('is-on');
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => live.classList.remove('is-on'), 1600);
  };

  function saver(key, parse, fieldEl) {
    let pendingDate = null;
    const run = debounce(async () => {
      const d = pendingDate;
      pendingDate = null;
      if (!d) return;
      const raw = fieldEl.input.value;
      const v = parse(raw);
      if (v === undefined) return; // invalid → error shown, nothing saved
      try {
        await db.patchDay(d, { [key]: v });
        flashSaved();
      } catch (err) {
        console.error('[daybook] training day save', err);
        toast('Couldn’t save — try again.', { type: 'error' });
      }
    }, 600);
    return {
      touch() {
        pendingDate = getDate();
        run();
      },
      flush: () => run.flush(),
      cancel: () => run.cancel(),
    };
  }

  const stepsIn = input({ type: 'number', inputmode: 'numeric', step: '1', min: '0', max: '200000', placeholder: '0', class: 'tr-big-in', enterkeyhint: 'done' });
  const stepsField = field('Steps', stepsIn);
  const stepsBar = progressBar(0, { accent: COLOR, height: 6, label: 'Steps progress' });
  const stepsSub = h('span.tr-bm-sub.num');
  const parseSteps = (raw) => {
    if (stepsIn.validity && stepsIn.validity.badInput) return stepsField.setError('Numbers only'), undefined;
    const v = toNumber(raw);
    if (v === null) return stepsField.setError(null), null;
    if (v < 0 || v > 200000 || !Number.isFinite(v)) return stepsField.setError('That doesn’t look right'), undefined;
    stepsField.setError(null);
    return Math.round(v);
  };
  const stepsSave = saver('steps', parseSteps, stepsField);

  const weightIn = input({ type: 'number', min: '0', max: '1000', placeholder: '—', class: 'tr-big-in', enterkeyhint: 'done' });
  const weightUnit = h('span.affix', { 'aria-hidden': 'true' });
  const weightField = field('Body weight', h('div.input-affix', weightIn, weightUnit));
  const weightSub = h('span.tr-bm-sub.num');
  const parseWeight = (raw) => {
    if (weightIn.validity && weightIn.validity.badInput) return weightField.setError('Numbers only'), undefined;
    const v = toNumber(raw);
    if (v === null) return weightField.setError(null), null;
    if (!(v > 0) || v > 1000) return weightField.setError('That doesn’t look right'), undefined;
    weightField.setError(null);
    return Math.round(v * 100) / 100;
  };
  const weightSave = saver('weight', parseWeight, weightField);

  const paintSteps = () => {
    const target = Number(getSettings().targets && getSettings().targets.steps) || 0;
    const v = toNumber(stepsIn.value) || 0;
    stepsBar.update(target ? Math.min(1, v / target) : 0);
    stepsBar.hidden = !target;
    stepsSub.textContent = target ? (v >= target ? `Goal reached · ${fmtNumber(target)}` : `${fmtNumber(Math.max(0, target - v))} steps to go · goal ${fmtNumber(target)}`) : 'No daily target';
    el.classList.toggle('is-steps-done', !!target && v >= target);
  };
  const paintWeight = () => {
    weightUnit.textContent = wUnit();
    const d = getDate();
    if (lastWeight && lastWeight.date !== d) weightSub.textContent = `Last: ${fmtWeight(lastWeight.weight)} · ${relativeDay(lastWeight.date)}`;
    else weightSub.textContent = toNumber(weightIn.value) !== null ? 'Logged for this day' : 'Weigh in to track your trend';
  };

  for (const [inp, sv, paint] of [[stepsIn, stepsSave, paintSteps], [weightIn, weightSave, paintWeight]]) {
    inp.addEventListener('input', () => { paint(); sv.touch(); });
    inp.addEventListener('blur', () => sv.flush());
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sv.flush(); inp.blur(); } });
  }

  const el = h(
    'div.tr-bm',
    h('div.tr-bm-head', h('h3.tr-bm-title', 'Steps & body weight'), live),
    h(
      'div.tr-bm-grid',
      h('div.tr-bm-cell', iconChip('footprints', { accent: COLOR, size: 'sm' }), h('div.tr-bm-main', stepsField, stepsBar, stepsSub)),
      h('div.tr-bm-cell', iconChip('scale', { accent: COLOR, size: 'sm' }), h('div.tr-bm-main', weightField, weightSub))
    )
  );

  el.update = (d, lw) => {
    day = d;
    lastWeight = lw;
    if (document.activeElement !== stepsIn) {
      stepsIn.value = num(day.steps) === null ? '' : String(day.steps);
      stepsField.setError(null);
    }
    if (document.activeElement !== weightIn) {
      weightIn.value = num(day.weight) === null ? '' : String(day.weight);
      weightField.setError(null);
    }
    paintSteps();
    paintWeight();
  };
  el.flush = () => { stepsSave.flush(); weightSave.flush(); };
  el.dispose = () => { el.flush(); clearTimeout(liveTimer); };
  return el;
}

// ──────────────────────────────────────────────────────────────────────────── page

async function render(root, ctx) {
  const today = todayKey();
  const param = ctx.route.params && ctx.route.params[0];
  let date = isValidKey(param) ? param : state.date || today;
  if (!isValidKey(date) || date > today) date = today;
  setWorkingDate(date);
  let disposed = false;
  let all = [];
  let index = new Map();
  let bodyToken = 0;

  const newWorkout = (extra = {}) => openEditor(null, { date, ...extra });

  // ---- persistent shell
  const weekHead = h('div.tr-week-head');
  const strip = h('div.tr-strip', { role: 'group', 'aria-label': 'Days of the week' });
  const weekSummary = h('div.tr-week-summary');
  const weekCard = h('section.card.tr-week', { 'aria-labelledby': 'tr-week-title' }, weekHead, strip, weekSummary);

  const dayHead = h('div.card-header.tr-day-head');
  const dayList = h('div.tr-day-list');
  const metrics = bodyMetrics(() => date);
  const dayCard = h('section.card.tr-day', { 'aria-labelledby': 'tr-day-title' }, dayHead, dayList, metrics);

  const cardShell = (id, iconName, title, sub, bodyEl, actions) =>
    h(
      'section.card.tr-card',
      { 'aria-labelledby': id },
      h('div.card-header', iconChip(iconName, { accent: COLOR }), h('div.card-header-text', h('h2.card-title', { id }, title), sub), actions ? h('div.card-actions', actions) : null),
      bodyEl
    );
  const prBody = h('div.tr-pr-body');
  const prSub = h('p.card-subtitle', 'Your best lifts');
  const progBody = h('div.tr-prog-body');
  const progActions = h('div.tr-prog-actions');
  const heatBody = h('div.tr-heat-body');
  const heatSub = h('p.card-subtitle', 'Minutes per day · last 26 weeks');
  const weeksBody = h('div.tr-weeks-body');
  const weeksSub = h('p.card-subtitle', 'Last 12 weeks');
  const bwBody = h('div.tr-bw-body');

  const prCard = cardShell('tr-pr-title', 'trophy', 'Personal records', prSub, prBody);
  const progCard = cardShell('tr-prog-title', 'line-chart', 'Exercise progress', h('p.card-subtitle', 'Top set & estimated 1RM'), progBody, progActions);
  const heatCard = cardShell('tr-heat-title', 'calendar', 'Activity', heatSub, heatBody);
  const weeksCard = cardShell('tr-weeks-title', 'bar-chart', 'Minutes per week', weeksSub, weeksBody);
  const bwCard = cardShell('tr-bw-title', 'scale', 'Body weight', h('p.card-subtitle', 'Last 90 days'), bwBody);

  mount(
    root,
    h(
      'div.page.training-page',
      { style: { '--accent': 'var(--training)' } },
      pageHeader({
        title: TITLE,
        subtitle: 'Workouts, steps & progress',
        actions: [{ label: 'Log workout', icon: 'plus', variant: 'primary', onClick: () => newWorkout() }],
      }),
      h('div.tr-layout', h('div.tr-main', weekCard, dayCard, weeksCard), h('div.tr-side', prCard, progCard, heatCard, bwCard))
    )
  );

  function selectDate(d, { scroll = false } = {}) {
    if (!isValidKey(d)) return;
    if (d > todayKey()) d = todayKey();
    if (d === date) {
      if (scroll) scrollToDay();
      return;
    }
    metrics.flush();
    date = d;
    setWorkingDate(d);
    drawWeek();
    drawDay();
    if (scroll) scrollToDay();
  }
  function scrollToDay() {
    if (window.matchMedia && window.matchMedia('(min-width: 960px)').matches) return;
    dayCard.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }

  const byDate = () => {
    const m = new Map();
    for (const w of all) {
      if (!m.has(w.date)) m.set(w.date, []);
      m.get(w.date).push(w);
    }
    return m;
  };
  let dayMap = new Map();
  const minutesOn = (k) => (dayMap.get(k) || []).reduce((s, w) => s + (num(w.duration) || 0), 0);

  // ---- week strip + summary
  function drawWeek() {
    const s = getSettings();
    const tg = s.targets || {};
    const now = todayKey();
    const keys = weekKeys(date, s.weekStart);
    const from = keys[0];
    const to = keys[6];
    const thisStart = startOfWeek(now, s.weekStart);
    const isThis = from === thisStart;
    const isLast = from === addDays(thisStart, -7);
    const label = isThis ? 'This week' : isLast ? 'Last week' : `Week of ${fmtDate(from, 'short')}`;

    remount(
      weekHead,
      h('div.tr-week-titles', h('h2.card-title#tr-week-title', label), h('p.card-subtitle.num', fmtRange(from, to))),
      h(
        'div.tr-week-nav',
        isThis ? null : button({ label: 'This week', variant: 'ghost', size: 'sm', class: 'tr-this-week', dataset: { focusKey: 'wk:this' }, onClick: () => selectDate(now) }),
        button({ icon: 'chevron-left', ariaLabel: 'Previous week', variant: 'ghost', class: 'tr-nav-btn', dataset: { focusKey: 'wk:prev' }, onClick: () => selectDate(addDays(date, -7)) }),
        button({ icon: 'chevron-right', ariaLabel: 'Next week', variant: 'ghost', class: 'tr-nav-btn', disabled: to >= now, dataset: { focusKey: 'wk:next' }, onClick: () => selectDate(addDays(date, 7) > now ? now : addDays(date, 7)) })
      )
    );

    const dayTarget = Number(tg.trainingMinutes) || 30;
    remount(
      strip,
      keys.map((k) => {
        const m = minutesOn(k);
        const n = (dayMap.get(k) || []).length;
        const future = k > now;
        const fill = Math.min(1, m / dayTarget);
        return h(
          'button.tr-pill',
          {
            type: 'button',
            disabled: future,
            class: { 'is-selected': k === date, 'is-today': k === now, 'is-active': m > 0, 'is-future': future },
            'aria-pressed': k === date ? 'true' : 'false',
            'aria-label': `${fmtDate(k, 'medium')}${k === now ? ', today' : ''}${n ? `, ${plural(n, 'workout')}, ${fmtDuration(m)}` : ', rest day'}`,
            dataset: { focusKey: `day:${k}` },
            style: { '--fill': String(fill) },
            onClick: () => selectDate(k),
          },
          h('span.tr-pill-wd', fmtDate(k, 'weekday')),
          h('span.tr-pill-day.num', fmtDate(k, 'day')),
          h('span.tr-pill-bar', { 'aria-hidden': 'true' }, h('span.tr-pill-bar-fill')),
          h('span.tr-pill-min.num', m > 0 ? (m < 60 ? `${Math.round(m)}m` : `${fmtNumber(m / 60, { maxDecimals: 1 })}h`) : future ? '' : '–')
        );
      })
    );

    // summary
    const inWeek = all.filter((w) => w.date >= from && w.date <= to);
    const mins = inWeek.reduce((sum, w) => sum + (num(w.duration) || 0), 0);
    const prevMins = all.filter((w) => w.date >= addDays(from, -7) && w.date <= addDays(to, -7)).reduce((sum, w) => sum + (num(w.duration) || 0), 0);
    const active = new Set(inWeek.map((w) => w.date)).size;
    const kcal = inWeek.reduce((sum, w) => sum + (num(w.calories) || 0), 0);
    const dist = inWeek.reduce((sum, w) => sum + (num(w.distance) || 0), 0);
    const target = Number(tg.weeklyTrainingMinutes) || 0;
    const done = target > 0 && mins >= target;
    const diff = mins - prevMins;
    const status = !target
      ? h('span.muted', 'No weekly target')
      : done
        ? h('span.tr-status.is-good', icon('check-circle', { size: 14 }), h('span', 'Weekly goal reached'))
        : h('span.tr-status', h('span.num', `${fmtDuration(target - mins)}`), h('span', ' to go'));
    const deltaEl = prevMins || mins
      ? h('span.tr-delta', { class: { 'is-up': diff > 0, 'is-down': diff < 0 } }, icon(diff > 0 ? 'arrow-up-right' : diff < 0 ? 'arrow-down-right' : 'minus', { size: 14 }), h('span.num', diff === 0 ? 'Same as' : `${fmtDuration(Math.abs(diff))} ${diff > 0 ? 'more than' : 'less than'}`), h('span', ' the week before'))
      : null;
    const stat = (label, value, sub) => h('div.tr-stat', h('span.tr-stat-label', label), h('span.tr-stat-value.num', value), sub ? h('span.tr-stat-sub', sub) : null);
    mount(
      weekSummary,
      h(
        'div.tr-ring-block',
        progressRing(target ? mins / target : 0, {
          size: 104,
          stroke: 10,
          accent: COLOR,
          label: fmtNumber(Math.round(mins)),
          sublabel: 'min',
          ariaLabel: `${fmtNumber(Math.round(mins))} of ${fmtNumber(target)} training minutes this week`,
        }),
        h('div.tr-ring-caption', h('span.tr-ring-name', 'Weekly minutes'), target ? h('span.muted.num', `Target ${fmtNumber(target)} min`) : null, status, deltaEl)
      ),
      h(
        'div.tr-stats',
        stat('Workouts', fmtNumber(inWeek.length)),
        stat('Active days', `${active}`, 'of 7'),
        stat('Calories', kcal ? fmtNumber(Math.round(kcal)) : '—', kcal ? 'kcal burned' : null),
        stat('Distance', dist ? fmtNumber(dist, { maxDecimals: 1 }) : '—', dist ? dUnit() : null)
      )
    );
  }

  // ---- selected day
  async function drawDay() {
    const token = ++bodyToken;
    const items = dayMap.get(date) || [];
    const mins = items.reduce((s, w) => s + (num(w.duration) || 0), 0);
    const rel = relativeDay(date);
    const isRel = rel === 'Today' || rel === 'Yesterday';
    remount(
      dayHead,
      h(
        'div.card-header-text',
        h('h2.card-title#tr-day-title', isRel ? `${rel} · ${fmtDate(date, 'medium')}` : fmtDate(date, 'long')),
        h('p.card-subtitle', items.length ? `${plural(items.length, 'workout')} · ${fmtDuration(mins)}` : 'Rest day so far')
      ),
      items.length ? h('div.card-actions', button({ label: 'Add', icon: 'plus', variant: 'ghost', size: 'sm', ariaLabel: 'Log another workout', dataset: { focusKey: 'day:add' }, onClick: () => newWorkout() })) : null
    );
    remount(
      dayList,
      items.length
        ? h('div.tr-workouts', items.map((w) => workoutRow(w)))
        : emptyState({
            icon: ICON,
            accent: COLOR,
            compact: true,
            title: date === todayKey() ? 'No workout yet today' : 'No workout logged',
            message: all.length ? 'Log a session, or repeat one you’ve done before.' : 'Log your first session — strength, a run, yoga, anything counts.',
            action: { label: 'Log workout', icon: 'plus', onClick: () => newWorkout(), dataset: { focusKey: 'day:log' } },
            actions: all.length ? [{ label: 'Repeat a workout', icon: 'repeat', onClick: () => newWorkout({ repeat: true }), dataset: { focusKey: 'day:repeat' } }] : [],
          })
    );
    const d = date;
    const [day, lw] = await Promise.all([db.getDay(d), lastWeightBefore(d)]);
    if (disposed || token !== bodyToken) return;
    metrics.update(day, lw);
  }

  async function lastWeightBefore(d) {
    const days = await db.getDays(addDays(d, -120), d);
    const keys = Object.keys(days).sort();
    for (let i = keys.length - 1; i >= 0; i--) {
      const v = num(days[keys[i]] && days[keys[i]].weight);
      if (v !== null) return { date: keys[i], weight: v };
    }
    return null;
  }

  function workoutRow(w) {
    const t = typeOf(w.type);
    const exs = namedExercises(w);
    const pace = PACE_TYPES.has(w.type) ? paceOf(w) : null;
    const detail = [];
    if (num(w.distance)) detail.push(fmtDistance(w.distance));
    if (pace) detail.push(pace);
    const meta = workoutMeta(w);
    const shown = exs.slice(0, 3);
    return h(
      'button.tr-workout',
      {
        type: 'button',
        dataset: { focusKey: `w:${w.id}` },
        style: { '--tc': t.color || 'var(--training)' },
        'aria-label': `${titleOf(w)}, ${t.name}, ${meta.join(', ')}${detail.length ? `, ${detail.join(', ')}` : ''}${exs.length ? `, ${plural(exs.length, 'exercise')}` : ''}. Edit`,
        onClick: () => openEditor(w),
      },
      h('span.tr-emoji.tr-emoji-lg', { 'aria-hidden': 'true' }, t.emoji || '💪'),
      h(
        'span.tr-workout-main',
        h('span.tr-workout-top', h('span.tr-workout-title', titleOf(w)), num(w.calories) ? h('span.tr-workout-kcal.num', `${fmtNumber(Math.round(w.calories))} kcal`) : null),
        h('span.tr-workout-meta', meta.map((m) => h('span.num', m))),
        detail.length ? h('span.tr-workout-detail', detail.map((m) => h('span.num', m))) : null,
        shown.length
          ? h(
              'span.tr-workout-ex',
              shown.map((e) => h('span.tr-ex-line', h('span.tr-ex-line-name', String(e.name).trim()), h('span.tr-ex-line-sets.num', setsText(e.sets)))),
              exs.length > 3 ? h('span.tr-ex-more', `+${exs.length - 3} more`) : null
            )
          : null,
        w.notes ? h('span.tr-workout-note', w.notes) : null
      ),
      icon('chevron-right', { size: 18, class: 'tr-chev' })
    );
  }

  // ---- side: PRs, progress, heatmap, weekly bars
  function drawRecords() {
    const list = [...index.values()].filter((e) => e.bestW || e.bestReps);
    const now = todayKey();
    if (!list.length) {
      prSub.textContent = 'Your best lifts';
      remount(
        prBody,
        emptyState({
          icon: 'trophy',
          accent: COLOR,
          compact: true,
          title: 'No records yet',
          message: 'Log a strength workout with sets and your best lifts and estimated 1RMs show up here.',
          actions: [{ label: 'Log strength workout', icon: 'plus', onClick: () => newWorkout({ type: 'strength' }) }],
        })
      );
      return;
    }
    list.sort((a, b) => String(prDate(b)).localeCompare(String(prDate(a))) || b.count - a.count);
    const fresh = list.filter((e) => diffDays(prDate(e), now) <= 6).length;
    prSub.textContent = fresh ? `${plural(fresh, 'new record')} this week 🎉` : `${plural(list.length, 'exercise')} tracked`;
    const shown = showAllPRs ? list : list.slice(0, PR_LIMIT);
    remount(
      prBody,
      h(
        'div.tr-prs',
        { role: 'list' },
        shown.map((e) => {
          const isNew = diffDays(prDate(e), now) <= 6;
          const canChart = !!e.bestW;
          const main = e.bestW
            ? h('span.tr-pr-best.num', fmtWeight(e.bestW.w), h('span.tr-pr-reps', ` × ${e.bestW.reps}`))
            : h('span.tr-pr-best.num', `${e.bestReps.reps}`, h('span.tr-pr-reps', ' reps'));
          const sub = [e.best1 ? `e1RM ${fmtWeight(Math.round(e.best1.v * 10) / 10)}` : 'Bodyweight', fmtDate(prDate(e), 'short')].join(' · ');
          return h(
            'div.tr-pr-li',
            { role: 'listitem' },
            h(
              canChart ? 'button.tr-pr' : 'div.tr-pr',
              canChart
                ? { type: 'button', dataset: { focusKey: `pr:${e.key}` }, 'aria-label': `${e.name}: best ${fmtWeight(e.bestW.w)} for ${e.bestW.reps} reps, ${sub}${isNew ? ', new' : ''}. Show progress`, onClick: () => { progressExercise = e.key; drawProgress(); progCard.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' }); progActions.querySelector('select')?.focus({ preventScroll: true }); } }
                : {},
              h('span.tr-pr-medal', { 'aria-hidden': 'true', class: { 'is-new': isNew } }, icon(isNew ? 'trophy' : 'medal', { size: 18 })),
              h('span.tr-pr-text', h('span.tr-pr-name', e.name, isNew ? badge('NEW', 'accent', { accent: COLOR, size: 'sm' }) : null), h('span.tr-pr-sub.num', sub)),
              main
            )
          );
        })
      ),
      list.length > PR_LIMIT
        ? h(
            'button.link-btn.tr-more',
            { type: 'button', dataset: { focusKey: 'pr:more' }, 'aria-expanded': showAllPRs ? 'true' : 'false', onClick: () => { showAllPRs = !showAllPRs; drawRecords(); } },
            showAllPRs ? 'Show fewer' : `Show all ${list.length}`
          )
        : null,
      h('p.tr-footnote', 'Estimated 1RM = weight × (1 + reps ÷ 30)')
    );
  }

  function drawProgress() {
    const opts = [...index.values()].filter((e) => e.bestW && e.sessions.size).sort((a, b) => b.sessions.size - a.sessions.size || String(b.lastDate).localeCompare(String(a.lastDate)));
    if (!opts.length) {
      mount(progActions);
      mount(
        progBody,
        emptyState({ icon: 'line-chart', accent: COLOR, compact: true, title: 'Nothing to chart yet', message: 'Log the same lift a few times and watch the line climb.' })
      );
      return;
    }
    if (!progressExercise || !opts.some((e) => e.key === progressExercise)) progressExercise = opts[0].key;
    const e = index.get(progressExercise);
    const sel = select(opts.map((x) => ({ value: x.key, label: x.name })), progressExercise, (v) => { progressExercise = v; drawProgress(); progActions.querySelector('select')?.focus({ preventScroll: true }); }, { 'aria-label': 'Exercise', class: 'select tr-prog-select' });
    mount(progActions, sel);
    const sessions = [...e.sessions.values()].filter((s) => s.top > 0).sort((a, b) => a.date.localeCompare(b.date));
    const first = sessions[0];
    const last = sessions[sessions.length - 1];
    const gain = last && first ? last.top - first.top : 0;
    const u = wUnit();
    const kpi = (label, value, sub) => h('div.tr-kpi', h('span.tr-kpi-label', label), h('span.tr-kpi-value.num', value), sub ? h('span.tr-kpi-sub', sub) : null);
    mount(
      progBody,
      h(
        'div.tr-kpis',
        kpi('Best set', `${fmtWeight(e.bestW.w)}`, `× ${e.bestW.reps} · ${fmtDate(e.bestW.date, 'short')}`),
        kpi('Best e1RM', e.best1 ? fmtWeight(Math.round(e.best1.v * 10) / 10) : '—', e.best1 ? `${fmtW(e.best1.w)} × ${e.best1.reps}` : null),
        kpi('Progress', sessions.length > 1 ? `${gain > 0 ? '+' : gain < 0 ? '−' : ''}${fmtW(Math.abs(gain))} ${u}` : '—', sessions.length > 1 ? `since ${fmtDate(first.date, 'short')} · ${plural(sessions.length, 'session')}` : 'One session so far')
      ),
      lineChart({
        series: [
          { name: 'Top set', color: COLOR, points: sessions.map((s) => ({ x: s.date, y: s.top })) },
          { name: 'Est. 1RM', color: '--chart-1', points: sessions.filter((s) => s.best1 > 0).map((s) => ({ x: s.date, y: Math.round(s.best1 * 10) / 10 })) },
        ],
        height: 200,
        yFormat: (v) => fmtW(v),
        tooltipFormat: (v) => fmtWeight(v),
        emptyText: 'No weighted sets yet',
        ariaLabel: `${e.name}: top-set weight and estimated 1RM over time`,
      })
    );
  }

  function drawActivity() {
    const now = todayKey();
    const s = getSettings();
    const from = addDays(now, -(26 * 7) + 1);
    const values = {};
    let count = 0;
    let mins = 0;
    for (const w of all) {
      if (w.date < from || w.date > now) continue;
      values[w.date] = (values[w.date] || 0) + (num(w.duration) || 0);
      count += 1;
      mins += num(w.duration) || 0;
    }
    const activeDays = Object.keys(values).filter((k) => values[k] > 0).length;
    heatSub.textContent = count ? `${plural(count, 'workout')} · ${plural(activeDays, 'active day')} · ${fmtDuration(mins)} in 26 weeks` : 'Minutes per day · last 26 weeks';
    mount(
      heatBody,
      count
        ? heatmap({ values, from, to: now, accent: COLOR, weekStart: s.weekStart, valueFormat: (v) => fmtDuration(v), onClick: (k) => selectDate(k, { scroll: true }), ariaLabel: 'Training minutes per day, last 26 weeks' })
        : emptyState({ icon: 'calendar', accent: COLOR, compact: true, title: 'Your activity map', message: 'Every workout fills a square. Log one to start the streak.' })
    );

    // weekly bars
    const ws0 = startOfWeek(now, s.weekStart);
    const target = Number(s.targets && s.targets.weeklyTrainingMinutes) || 0;
    const data = [];
    let hit = 0;
    let total = 0;
    for (let i = 11; i >= 0; i--) {
      const start = addDays(ws0, -7 * i);
      const end = addDays(start, 6);
      const ws = all.filter((w) => w.date >= start && w.date <= end);
      const m = ws.reduce((sum, w) => sum + (num(w.duration) || 0), 0);
      total += m;
      if (target && m >= target) hit += 1;
      data.push({ label: fmtDate(start, 'short'), value: m, start, tooltip: `${fmtRange(start, end)} · ${plural(ws.length, 'workout')}${i === 0 ? ' · this week' : ''}` });
    }
    weeksSub.textContent = total ? `Avg ${fmtDuration(total / 12)} / week${target ? ` · target hit ${hit} of 12` : ''}` : 'Last 12 weeks';
    mount(
      weeksBody,
      total
        ? barChart({
            data,
            height: 190,
            color: COLOR,
            target: target || undefined,
            targetLabel: target ? 'Target' : undefined, // short: the full label overlapped the right-hand bars
            yFormat: (v) => fmtNumber(v),
            tooltipFormat: (v) => fmtDuration(v),
            onClick: (d) => d && d.raw && selectDate(d.raw.start > todayKey() ? todayKey() : addDays(d.raw.start, 6) > todayKey() ? todayKey() : addDays(d.raw.start, 6)),
            ariaLabel: 'Training minutes per week, last 12 weeks',
          })
        : emptyState({ icon: 'bar-chart', accent: COLOR, compact: true, title: 'No weeks to show yet', message: target ? `Aim for ${fmtNumber(target)} minutes a week — every session adds up.` : 'Every session adds to your weekly total.'})
    );
  }

  async function drawBodyWeight() {
    const now = todayKey();
    const from = addDays(now, -89);
    const days = await db.getDays(from, now);
    if (disposed) return;
    const pts = Object.keys(days)
      .sort()
      .map((k) => ({ x: k, y: num(days[k] && days[k].weight) }))
      .filter((p) => p.y !== null);
    if (!pts.length) {
      mount(
        bwBody,
        emptyState({
          icon: 'scale',
          accent: COLOR,
          compact: true,
          title: 'No weigh-ins yet',
          message: 'Add your body weight in the day card — a few times a week is plenty.',
          actions: [{ label: 'Add today’s weight', icon: 'plus', onClick: () => { selectDate(todayKey()); setTimeout(() => { dayCard.querySelector('.tr-bm-cell:nth-child(2) input')?.focus(); }, 30); } }],
        })
      );
      return;
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    const change = Math.round((last.y - first.y) * 10) / 10;
    const ys = pts.map((p) => p.y);
    const u = wUnit();
    const kpi = (label, value, sub) => h('div.tr-kpi', h('span.tr-kpi-label', label), h('span.tr-kpi-value.num', value), sub ? h('span.tr-kpi-sub', sub) : null);
    mount(
      bwBody,
      h(
        'div.tr-kpis',
        kpi('Latest', fmtWeight(last.y), relativeDay(last.x)),
        kpi('Change', pts.length > 1 ? `${change > 0 ? '+' : change < 0 ? '−' : '±'}${fmtW(Math.abs(change))} ${u}` : '—', pts.length > 1 ? `since ${fmtDate(first.x, 'short')}` : 'Need 2 weigh-ins'),
        kpi('Range', pts.length > 1 ? `${fmtW(Math.min(...ys))}–${fmtW(Math.max(...ys))}` : '—', pts.length > 1 ? `${u} · ${plural(pts.length, 'weigh-in')}` : null)
      ),
      lineChart({
        series: [{ name: 'Body weight', color: COLOR, points: pts }],
        height: 180,
        yFormat: (v) => fmtW(v),
        tooltipFormat: (v) => fmtWeight(v),
        ariaLabel: 'Body weight, last 90 days',
      })
    );
  }

  function drawAllSync() {
    dayMap = byDate();
    index = exerciseIndex(all);
    drawWeek();
    drawDay();
    drawRecords();
    drawProgress();
    drawActivity();
  }

  async function reload() {
    const list = await db.all(STORE);
    if (disposed) return;
    all = list;
    drawAllSync();
  }

  await Promise.all([reload(), drawBodyWeight()]);
  if (disposed) return () => {};

  // ---- live updates
  const refresh = debounce(reload, 60);
  const refreshBW = debounce(drawBodyWeight, 200);
  const refreshMetrics = debounce(async () => {
    const d = date;
    const [day, lw] = await Promise.all([db.getDay(d), lastWeightBefore(d)]);
    if (!disposed && d === date) metrics.update(day, lw);
  }, 80);
  const offs = [
    on('db:change', (e) => {
      if (!e) return;
      if (e.store === STORE || e.store === '*') refresh();
      if (e.store === 'days' || e.store === '*') {
        const p = e.patch;
        const touches = (k) => !p || Object.prototype.hasOwnProperty.call(p, k);
        if (touches('weight')) refreshBW();
        if (touches('weight') || touches('steps')) refreshMetrics();
      }
    }),
    on('settings:change', () => {
      refresh();
      refreshBW();
      refreshMetrics();
    }),
  ];

  // Manifest shortcut / deep link: #/training?new=1 opens the editor, then drops the query.
  if (ctx.route.query && ctx.route.query.new === '1') {
    openEditor(null, { date, type: ctx.route.query.type });
    ctx.navigate(ctx.route.path, { replace: true });
  }

  return () => {
    disposed = true;
    [refresh, refreshBW, refreshMetrics].forEach((f) => f.cancel());
    metrics.dispose();
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
  quickActions: [{ id: 'workout', label: 'Workout', icon: ICON, color: COLOR, run: ({ date } = {}) => openEditor(null, { date }) }],

  async summarizeDay(date) {
    const [items, day] = await Promise.all([db.byDate(STORE, date), db.getDay(date)]);
    const mins = items.reduce((s, w) => s + (num(w.duration) || 0), 0);
    const steps = num(day.steps) || 0;
    const parts = [];
    if (items.length) parts.push(minLabel(mins), plural(items.length, 'workout'));
    if (steps > 0) parts.push(`${fmtNumber(steps)} steps`);
    return {
      id: ID,
      title: TITLE,
      icon: ICON,
      color: COLOR,
      headline: parts.join(' · '),
      empty: 'No workout yet',
      items: items.map((w) => ({
        id: w.id,
        time: w.time,
        title: `${typeOf(w.type).emoji || '💪'} ${titleOf(w)}`,
        meta: [fmtDuration(w.duration), num(w.intensity) ? intensityText(w.intensity) : null, num(w.distance) ? fmtDistance(w.distance) : null].filter(Boolean).join(' · '),
        onOpen: () => openEditor(w),
      })),
      addLabel: 'Log workout',
      onAdd: () => openEditor(null, { date }),
    };
  },

  async search(query) {
    const q = lower(query);
    if (q.length < 2) return [];
    const all = await db.all(STORE);
    return all
      .filter((w) => [w.title, w.notes, typeOf(w.type).name, ...namedExercises(w).map((e) => e.name)].some((s) => lower(s).includes(q)))
      .reverse()
      .slice(0, 50)
      .map((w) => {
        const exs = namedExercises(w);
        const hit = exs.find((e) => lower(e.name).includes(q));
        return {
          id: w.id,
          module: ID,
          icon: ICON,
          color: COLOR,
          title: `${typeOf(w.type).emoji || '💪'} ${titleOf(w)}`,
          subtitle: [typeOf(w.type).name, fmtDuration(w.duration), hit ? exerciseSummary(hit) : num(w.distance) ? fmtDistance(w.distance) : null, lower(w.notes).includes(q) ? w.notes : null].filter(Boolean).join(' · '),
          date: w.date,
          onOpen: () => openEditor(w),
        };
      });
  },
};
