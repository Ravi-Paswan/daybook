// js/modules/learning.js — Learning journal with spaced repetition (SPEC 4.3, data 2.3).
//
// Choices not fixed by the spec (kept simple, documented here):
// - Tabs live in the URL: #/learning (Feed), #/learning/review, #/learning/library. Switching tabs on the page swaps the
//   view in place and rewrites the URL silently (no full re-render, focus stays on the tab); deep links / Back render
//   the tab directly.
// - Feed filters (category, tag, day, starred, text) are remembered while the app is open. Library tags, heatmap days
//   and donut slices jump to the Feed with that filter applied.
// - Learning streak = consecutive days with ≥ 1 entry, ending today (or yesterday while nothing is logged yet today).
// - Review queue = entries with nextReview <= today (db index), oldest due first, then oldest learned. A session keeps
//   its order while you review (graded cards stay graded; newly-due / deleted entries are merged in). "Again" schedules
//   tomorrow (SPEC 2.3) — it does not repeat in the same session. Grades can be undone (button or key U).
//   Keys on the Review tab: Space / Enter reveals, 1 / 2 / 3 grade Again / Hard / Good, U undoes.
// - Editor: a new entry also stores time = now (today) / '' (past day) so the feed orders same-day entries. Changing the
//   date of an entry that was never reviewed moves its first review to date + 1. Links without a scheme get https://;
//   only http(s) links are ever rendered as links (opened in a new tab, rel=noopener).

import { db } from '../core/db.js';
import { on, state } from '../core/bus.js';
import { getSettings, learningCategory } from '../core/settings.js';
import { todayKey, nowTime, addDays, diffDays, startOfWeek, monthOf, fmtDate, relativeDay, isValidKey } from '../core/dates.js';
import { fmtNumber, fmtPercent, fmtDuration, plural, toNumber } from '../core/format.js';
import {
  h, mount, icon, button, iconChip, pageHeader, emptyState, openSheet, field, input, textarea, segmented, chips, tagInput,
  toggle, toast, confirmDialog, statTile, progressBar, listItem, debounce,
} from '../core/ui.js';
import { heatmap, donutChart } from '../core/charts.js';
import { removeWithUndo } from '../core/undo.js';

const ID = 'learning';
const TITLE = 'Learning';
const ICON = 'learning';
const COLOR = '--learning';
const STORE = 'learning';

export const SOURCES = [
  { value: 'book', label: 'Book', emoji: '📖', name: 'Book title', ph: 'e.g. Atomic Habits' },
  { value: 'video', label: 'Video', emoji: '🎬', name: 'Video or channel', ph: 'e.g. 3Blue1Brown' },
  { value: 'course', label: 'Course', emoji: '🎓', name: 'Course', ph: 'e.g. CS50' },
  { value: 'article', label: 'Article', emoji: '📰', name: 'Article or site', ph: 'e.g. Paul Graham essay' },
  { value: 'podcast', label: 'Podcast', emoji: '🎧', name: 'Podcast', ph: 'e.g. Huberman Lab' },
  { value: 'person', label: 'Person', emoji: '🧑‍🏫', name: 'Who taught you?', ph: 'e.g. My mentor' },
  { value: 'practice', label: 'Practice', emoji: '🎯', name: 'What did you practise?', ph: 'e.g. Guitar scales' },
  { value: 'experience', label: 'Experience', emoji: '💡', name: 'Where or when?', ph: 'e.g. Client meeting' },
  { value: 'other', label: 'Other', emoji: '🔖', name: 'Source', ph: 'Where did it come from?' },
];
const SOURCE_BY_ID = Object.fromEntries(SOURCES.map((s) => [s.value, s]));

const GRADES = [
  { value: 'again', label: 'Again', key: '1', note: 'Forgot it' },
  { value: 'hard', label: 'Hard', key: '2', note: 'Took effort' },
  { value: 'good', label: 'Good', key: '3', note: 'Remembered' },
];
const GRADE_BY_ID = Object.fromEntries(GRADES.map((g) => [g.value, g]));
const MINUTE_PRESETS = [5, 10, 15, 30, 45, 60];
const PAGE_SIZE = 60;

// Remembered while the app is open.
const filters = { category: null, tag: null, day: null, starred: false, text: '' };
let session = null; // review session: { day, queue: [ids], pos, revealed, history: [{id, before, result}] }
const lastUsed = { category: null, source: null };

// ──────────────────────────────────────────────────────────────────────────── helpers

const lower = (s) => String(s || '').trim().toLowerCase();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const tagsOf = (r) => (Array.isArray(r.tags) ? r.tags.filter(Boolean) : []);
const reviewsOf = (r) => (Array.isArray(r.reviews) ? r.reviews : []);
const sourceOf = (r) => SOURCE_BY_ID[r.source] || SOURCE_BY_ID.other;

/** '45 min' under an hour, '1h 20m' above. */
function minutesLabel(m) {
  const n = Math.round(Number(m) || 0);
  return n < 60 ? `${n} min` : fmtDuration(n);
}

/** Interval hint for a grade button: '1d', '8d', '3mo', '1.2y'. */
function intervalLabel(days) {
  if (days < 60) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${fmtNumber(days / 365, { maxDecimals: 1 })}y`;
}
function whenLabel(days) {
  if (days === 1) return 'tomorrow';
  if (days < 60) return `in ${days} days`;
  if (days < 365) return `in ${plural(Math.round(days / 30), 'month')}`;
  return `in ${fmtNumber(days / 365, { maxDecimals: 1 })} years`;
}

/** SPEC 2.3 scheduling. again → 1; hard → max(1, round(i·1.2)); good → max(2, round(i·2.5)). */
export function nextInterval(interval, result) {
  const i = Number(interval) > 0 ? Number(interval) : 1;
  if (result === 'again') return 1;
  if (result === 'hard') return Math.max(1, Math.round(i * 1.2));
  return Math.max(2, Math.round(i * 2.5));
}
export function applyGrade(record, result, today = todayKey()) {
  const interval = nextInterval(record.interval, result);
  return { ...record, interval, nextReview: addDays(today, interval), reviews: [...reviewsOf(record), { date: today, result }] };
}

/** Loose link check: adds https:// when there is no scheme; only http(s) with a dotted host (or localhost) pass. */
function normalizeLink(raw) {
  let s = String(raw || '').trim();
  if (!s) return { value: '' };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return { error: 'Use a web link (http or https)' };
    if (!(u.hostname.includes('.') || u.hostname === 'localhost') || /\s/.test(s)) return { error: 'That doesn’t look like a link' };
    return { value: u.href };
  } catch {
    return { error: 'That doesn’t look like a link' };
  }
}
function safeUrl(link) {
  if (!link) return null;
  try {
    const u = new URL(String(link));
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
}
const hostOf = (u) => u.hostname.replace(/^www\./, '');

function haystack(r) {
  return [r.title, r.takeaway, r.notes, r.sourceName, ...tagsOf(r)].map(lower).join('\n');
}
function filterActive(f = filters) {
  return !!(f.category || f.tag || f.day || f.starred || f.text.trim());
}
function matches(r, f = filters) {
  if (f.category && (r.category || 'other') !== f.category) return false;
  if (f.tag && !tagsOf(r).includes(f.tag)) return false;
  if (f.day && r.date !== f.day) return false;
  if (f.starred && !r.starred) return false;
  const q = lower(f.text);
  if (q && !haystack(r).includes(q)) return false;
  return true;
}

function byDue(a, b) {
  return String(a.nextReview).localeCompare(String(b.nextReview)) || String(a.date).localeCompare(String(b.date)) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

function computeStats(all, today) {
  const dates = new Set(all.map((r) => r.date));
  let streak = 0;
  let d = dates.has(today) ? today : addDays(today, -1);
  while (dates.has(d)) {
    streak += 1;
    d = addDays(d, -1);
  }
  let best = 0;
  let run = 0;
  let prev = null;
  for (const k of [...dates].filter(isValidKey).sort()) {
    run = prev && addDays(prev, 1) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }
  const ws = startOfWeek(today);
  const lastWs = addDays(ws, -7);
  const month = monthOf(today);
  let week = 0;
  let lastWeek = 0;
  let monthMinutes = 0;
  let monthCount = 0;
  let starred = 0;
  for (const r of all) {
    if (r.date >= ws && r.date <= today) week += 1;
    else if (r.date >= lastWs && r.date < ws) lastWeek += 1;
    if (monthOf(r.date) === month) {
      monthCount += 1;
      monthMinutes += num(r.minutes) || 0;
    }
    if (r.starred) starred += 1;
  }
  return { streak, best, week, lastWeek, monthMinutes, monthCount, total: all.length, starred, loggedToday: dates.has(today) };
}

function tagCounts(all) {
  const m = new Map();
  for (const r of all) for (const t of tagsOf(r)) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function reviewedOn(all, day) {
  let n = 0;
  for (const r of all) for (const v of reviewsOf(r)) if (v && v.date === day) n += 1;
  return n;
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

function isTyping(t) {
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

function catChip(cat, size = 'md') {
  return h('span.learning-cat', { class: size === 'sm' && 'is-sm', style: { '--cat': cat.color || 'var(--learning)' }, 'aria-hidden': 'true' }, cat.emoji || '✨');
}

function rememberLast(all) {
  const last = all[all.length - 1];
  if (last) {
    lastUsed.category = last.category || lastUsed.category;
    lastUsed.source = SOURCE_BY_ID[last.source] ? last.source : lastUsed.source;
  }
}

// ──────────────────────────────────────────────────────────────────────────── editor

/** Add/edit sheet. record=null → new. opts={date, category}. → Promise<saved|null> */
function openEditor(record = null, opts = {}) {
  const isNew = !record || !record.id;
  const today = todayKey();
  const cats = getSettings().learningCategories || [];
  let date0 = (record && record.date) || opts.date || state.date || today;
  if (!isValidKey(date0) || date0 > today) date0 = today;
  const firstCat = (cats[0] && cats[0].id) || 'other';
  const draft = {
    title: (record && record.title) || '',
    takeaway: (record && record.takeaway) || '',
    notes: (record && record.notes) || '',
    category: (record && record.category) || opts.category || lastUsed.category || firstCat,
    source: record && SOURCE_BY_ID[record.source] ? record.source : lastUsed.source || 'article',
    sourceName: (record && record.sourceName) || '',
    link: (record && record.link) || '',
    minutes: num(record && record.minutes),
    tags: record ? [...tagsOf(record)] : [],
    starred: !!(record && record.starred),
    date: date0,
  };
  const snapshot = () => JSON.stringify(draft);
  let initial = snapshot();
  let catTouched = !!(record && record.category) || !!opts.category;
  let sourceTouched = !!(record && record.source);

  // ---- title / takeaway / notes
  const titleIn = input({
    value: draft.title,
    placeholder: 'e.g. How compound interest really works',
    autocomplete: 'off',
    autocapitalize: 'sentences',
    enterkeyhint: 'done',
    maxlength: '160',
    onInput: (e) => {
      draft.title = e.target.value;
      titleField.setError(null);
    },
  });
  const titleField = field('What did you learn?', titleIn, { required: true });
  const takeIn = input({
    value: draft.takeaway,
    placeholder: 'The one thing to remember',
    autocomplete: 'off',
    autocapitalize: 'sentences',
    enterkeyhint: 'done',
    maxlength: '240',
    onInput: (e) => {
      draft.takeaway = e.target.value;
    },
  });
  const takeField = field('Key takeaway', takeIn, { hint: 'This is what Review asks you to recall.' });
  const notesIn = textarea({ value: draft.notes, rows: 3, placeholder: 'Details, examples, a quote…', onInput: (e) => { draft.notes = e.target.value; } });

  // ---- category / source
  const catChips = chips(
    cats.map((c) => ({ value: c.id, label: c.name, emoji: c.emoji, color: c.color })),
    draft.category,
    (v) => {
      draft.category = v;
      catTouched = true;
    },
    { ariaLabel: 'Category', deselect: false, class: 'learning-cat-chips' }
  );
  const nameListId = `learning-names-${Math.random().toString(36).slice(2, 8)}`;
  const nameList = h('datalist', { id: nameListId });
  const nameIn = input({
    value: draft.sourceName,
    autocomplete: 'off',
    maxlength: '120',
    enterkeyhint: 'done',
    list: nameListId,
    onInput: (e) => {
      draft.sourceName = e.target.value;
    },
  });
  const nameField = field(sourceOf(draft).name, nameIn);
  const sourceChips = chips(
    SOURCES.map((s) => ({ value: s.value, label: s.label, emoji: s.emoji })),
    draft.source,
    (v) => {
      draft.source = v;
      sourceTouched = true;
      syncSourceName();
    },
    { ariaLabel: 'Source', deselect: false, class: 'learning-source-chips' }
  );
  let pastNames = [];
  function syncSourceName() {
    const s = sourceOf(draft);
    const label = nameField.querySelector('.field-label-text');
    if (label) label.textContent = s.name;
    nameIn.placeholder = s.ph;
    const names = pastNames.filter((p) => p.source === draft.source).map((p) => p.name);
    mount(nameList, names.slice(0, 200).map((n) => h('option', { value: n })));
  }
  syncSourceName();

  // ---- link / minutes / date
  const linkIn = input({
    type: 'url',
    inputmode: 'url',
    value: draft.link,
    placeholder: 'https://…',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: false,
    enterkeyhint: 'done',
    onInput: (e) => {
      draft.link = e.target.value;
      linkField.setError(null);
    },
  });
  const linkField = field('Link', linkIn);

  const minIn = input({
    type: 'number',
    min: '0',
    max: '1440',
    inputmode: 'numeric',
    value: draft.minutes === null ? '' : String(draft.minutes),
    placeholder: '—',
    onInput: (e) => {
      draft.minutes = toNumber(e.target.value);
      minField.setError(null);
      minChips.setValue(MINUTE_PRESETS.includes(draft.minutes) ? draft.minutes : null);
    },
  });
  const minChips = chips(
    MINUTE_PRESETS.map((m) => ({ value: m, label: m < 60 ? `${m}m` : '1h' })),
    MINUTE_PRESETS.includes(draft.minutes) ? draft.minutes : null,
    (v) => {
      draft.minutes = v;
      minIn.value = v === null ? '' : String(v);
      minField.setError(null);
    },
    { ariaLabel: 'Quick minutes', size: 'sm', class: 'learning-min-chips' }
  );
  const minControl = h('div.learning-min', h('div.input-affix', { onClick: (e) => { if (e.target !== minIn) minIn.focus(); } }, minIn, h('span.affix', { 'aria-hidden': 'true' }, 'min')), minChips);
  const minField = field('Time spent', minControl);

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
  let schedule = null;
  if (!isNew) {
    const n = reviewsOf(record).length;
    const nr = isValidKey(record.nextReview) ? record.nextReview : null;
    const dueIn = nr ? diffDays(today, nr) : null;
    schedule = nr ? `${dueIn <= 0 ? 'Due for review now' : `Next review ${relativeDay(nr) === 'Tomorrow' ? 'tomorrow' : fmtDate(nr, 'medium')}`} · ${n ? `reviewed ${plural(n, 'time')}` : 'not reviewed yet'}` : null;
  }
  const dateField = field('Date', dateIn, { hint: schedule });

  // ---- tags / star
  const tagPool = []; // filled once past entries load (tagInput reads it on every render)
  const tagsEl = tagInput(draft.tags, (t) => { draft.tags = t; }, { suggestions: tagPool, placeholder: 'Add a tag, press Enter' });
  const starEl = toggle(draft.starred, (v) => { draft.starred = v; }, { label: 'Star it', hint: 'Favourites are easy to find in your library' });

  const form = h(
    'form.stack.learning-editor',
    { autocomplete: 'off' },
    titleField,
    takeField,
    field('Notes', notesIn),
    field('Category', catChips),
    field('Source', sourceChips),
    h('div.form-grid', nameField, linkField),
    nameList,
    h('div.form-grid', minField, dateField),
    field('Tags', tagsEl),
    h('div.learning-star-row', starEl)
  );

  // Past entries → tag suggestions (by frequency), source names, default category/source for new entries.
  db.all(STORE)
    .then((all) => {
      for (const [t] of tagCounts(all)) tagPool.push(t);
      if (tagsEl.input && document.activeElement !== tagsEl.input) tagsEl.setTags(draft.tags); // re-render suggestions
      const seen = new Set();
      for (let i = all.length - 1; i >= 0; i--) {
        const r = all[i];
        const n = String(r.sourceName || '').trim();
        const k = `${r.source}|${lower(n)}`;
        if (!n || seen.has(k)) continue;
        seen.add(k);
        pastNames.push({ source: r.source, name: n });
      }
      syncSourceName();
      if (isNew && all.length) {
        const unchanged = snapshot() === initial;
        rememberLast(all);
        if (!catTouched && lastUsed.category && lastUsed.category !== draft.category) {
          draft.category = lastUsed.category;
          catChips.setValue(draft.category);
        }
        if (!sourceTouched && lastUsed.source && lastUsed.source !== draft.source) {
          draft.source = lastUsed.source;
          sourceChips.setValue(draft.source);
          syncSourceName();
        }
        if (unchanged) initial = snapshot();
      }
    })
    .catch((err) => console.warn('[daybook] learning suggestions', err));

  function validate() {
    let firstBad = null;
    if (!draft.title.trim()) {
      titleField.setError('Give it a short title');
      firstBad = firstBad || titleIn;
    }
    const link = normalizeLink(draft.link);
    if (link.error) {
      linkField.setError(link.error);
      firstBad = firstBad || linkIn;
    }
    if (minIn.validity && minIn.validity.badInput) {
      minField.setError('Numbers only');
      firstBad = firstBad || minIn;
    } else if (draft.minutes !== null && (draft.minutes < 0 || draft.minutes > 1440)) {
      minField.setError(draft.minutes < 0 ? 'Can’t be negative' : 'That’s more than a day');
      firstBad = firstBad || minIn;
    }
    if (!isValidKey(draft.date)) {
      dateField.setError('Pick a date');
      firstBad = firstBad || dateIn;
    } else if (draft.date > todayKey()) {
      dateField.setError('Can’t log the future');
      firstBad = firstBad || dateIn;
    }
    if (firstBad) firstBad.focus();
    return firstBad ? null : link;
  }

  const sheet = openSheet({
    title: isNew ? 'Log learning' : 'Edit learning',
    subtitle: relativeDay(draft.date),
    icon: ICON,
    accent: COLOR,
    content: form,
    className: 'learning-sheet',
    initialFocus: isNew ? titleIn : null,
    guard: async () => {
      if (snapshot() === initial) return true;
      return confirmDialog({ title: isNew ? 'Discard this entry?' : 'Discard changes?', message: 'What you entered won’t be saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing' });
    },
    actions: [
      !isNew && {
        label: 'Delete',
        variant: 'danger',
        icon: 'trash',
        onClick: async () => {
          await removeWithUndo(STORE, record, { label: 'Learning deleted' });
          return null;
        },
      },
      { label: 'Cancel', variant: 'secondary' },
      {
        label: 'Save',
        variant: 'primary',
        onClick: async () => {
          const link = validate();
          if (!link) return false;
          const minutes = draft.minutes === null ? null : Math.round(draft.minutes);
          const out = {
            ...(isNew ? {} : record),
            date: draft.date,
            title: draft.title.trim().replace(/\s+/g, ' '),
            takeaway: draft.takeaway.trim().replace(/\s+/g, ' '),
            notes: draft.notes.replace(/\s+$/, '').replace(/^\s*\n/, ''),
            category: draft.category || firstCat,
            source: draft.source || 'other',
            sourceName: draft.sourceName.trim(),
            link: link.value,
            minutes: minutes === 0 ? null : minutes,
            tags: [...draft.tags],
            starred: !!draft.starred,
          };
          if (isNew) {
            out.time = draft.date === todayKey() ? nowTime() : '';
            out.interval = 1;
            out.nextReview = addDays(draft.date, 1);
            out.reviews = [];
          } else {
            if (!reviewsOf(record).length && draft.date !== record.date) {
              out.interval = 1;
              out.nextReview = addDays(draft.date, 1);
            }
            if (!(Number(out.interval) > 0)) out.interval = 1;
            if (!isValidKey(out.nextReview)) out.nextReview = addDays(out.date, 1);
            if (!Array.isArray(out.reviews)) out.reviews = [];
          }
          const saved = await db.put(STORE, out);
          lastUsed.category = saved.category;
          lastUsed.source = saved.source;
          toast(isNew ? 'Saved — first review tomorrow' : 'Saved', { type: 'success', duration: 2200 });
          return saved;
        },
      },
    ].filter(Boolean),
  });
  return sheet.result;
}

async function toggleStar(r) {
  try {
    const fresh = (await db.get(STORE, r.id)) || r;
    await db.put(STORE, { ...fresh, starred: !fresh.starred });
  } catch (err) {
    console.error('[daybook] star', err);
    toast('Couldn’t update the star — try again.', { type: 'error' });
  }
}

// ──────────────────────────────────────────────────────────────────────────── entry card

function entryCard(r, { today, onTag }) {
  const cat = learningCategory(r.category);
  const src = sourceOf(r);
  const url = safeUrl(r.link);
  const due = isValidKey(r.nextReview) && r.nextReview <= today;
  const tags = tagsOf(r);
  const title = r.title || 'Untitled';
  const star = h(
    'button.learning-star',
    {
      type: 'button',
      class: { 'is-on': !!r.starred },
      'aria-pressed': r.starred ? 'true' : 'false',
      'aria-label': `Star “${title}”`,
      title: r.starred ? 'Starred' : 'Star',
      dataset: { focusKey: `star:${r.id}` },
      onClick: () => {
        const on = star.getAttribute('aria-pressed') !== 'true';
        star.setAttribute('aria-pressed', on ? 'true' : 'false');
        star.classList.toggle('is-on', on);
        mount(star, icon(on ? 'star-filled' : 'star', { size: 20 }));
        toggleStar(r);
      },
    },
    icon(r.starred ? 'star-filled' : 'star', { size: 20 })
  );
  const metaBits = [
    h('span.learning-src', h('span', { 'aria-hidden': 'true' }, src.emoji), h('span', r.sourceName ? r.sourceName : src.label)),
    num(r.minutes) ? h('span.learning-mins.num', icon('clock', { size: 14 }), minutesLabel(r.minutes)) : null,
    url
      ? h('a.learning-link', { href: url.href, target: '_blank', rel: 'noopener noreferrer', title: url.href, dataset: { focusKey: `link:${r.id}` } }, icon('external-link', { size: 14 }), h('span', hostOf(url)), h('span.sr-only', ' (opens in a new tab)'))
      : null,
    due ? h('span.learning-due-pill', icon('repeat', { size: 13 }), 'Due') : null,
  ].filter(Boolean);

  return h(
    'article.learning-entry',
    {
      style: { '--cat': cat.color || 'var(--learning)' },
      dataset: { id: r.id },
      onClick: (e) => {
        // (a detached target = a control that re-rendered its own content, e.g. the star icon swap)
        if (!e.currentTarget.contains(e.target) || e.target.closest('button, a, input, label')) return;
        if (window.getSelection && String(window.getSelection()).length) return; // let people select text
        openEditor(r);
      },
    },
    h(
      'div.learning-entry-head',
      catChip(cat),
      h(
        'div.learning-entry-titles',
        h('h3.learning-entry-title', h('button.learning-entry-open', { type: 'button', dataset: { focusKey: `open:${r.id}` }, onClick: () => openEditor(r) }, title)),
        h('span.learning-entry-cat', cat.name)
      ),
      star
    ),
    r.takeaway ? h('p.learning-takeaway', r.takeaway) : r.notes ? h('p.learning-notes-preview', r.notes) : null,
    r.takeaway && r.notes ? h('p.learning-notes-preview.is-secondary', r.notes) : null,
    h(
      'div.learning-entry-foot',
      h('div.learning-meta', metaBits),
      tags.length
        ? h(
            'div.learning-tags',
            tags.map((t) => h('button.learning-tag', { type: 'button', 'aria-label': `Filter by tag ${t}`, dataset: { focusKey: `tag:${r.id}:${t}` }, onClick: () => onTag(t) }, h('span.learning-tag-hash', { 'aria-hidden': 'true' }, '#'), t))
          )
        : null
    )
  );
}

// ──────────────────────────────────────────────────────────────────────────── page

async function render(root, ctx) {
  const param = ctx.route.params && ctx.route.params[0];
  let tab = param === 'review' || param === 'library' ? param : 'feed';
  let disposed = false;
  let data = { all: [], due: [], byId: new Map(), today: todayKey() };
  let view = null;
  let loadToken = 0;

  const addNew = () => openEditor(null, { date: filters.day || undefined, category: filters.category || undefined });

  const tabs = segmented(
    [
      { value: 'feed', label: 'Feed' },
      { value: 'review', label: 'Review' },
      { value: 'library', label: 'Library' },
    ],
    tab,
    (v) => setTab(v),
    { ariaLabel: 'Learning views', block: true, class: 'learning-tabs' }
  );
  const dueBadge = h('span.learning-tab-count.num', { hidden: true });
  const reviewBtn = tabs.querySelector('[data-value="review"]');
  if (reviewBtn) reviewBtn.append(dueBadge);

  const body = h('div.learning-body');
  mount(
    root,
    h(
      'div.page.learning-page',
      { style: { '--accent': 'var(--learning)' } },
      pageHeader({
        title: TITLE,
        subtitle: 'Ideas worth keeping — and remembering',
        actions: [{ label: 'Add learning', icon: 'plus', variant: 'primary', onClick: addNew }],
      }),
      h('div.learning-tabs-wrap', tabs),
      body
    )
  );

  const views = { feed: feedView, review: reviewView, library: libraryView };
  const api = {
    openFeed(patch = {}) {
      Object.assign(filters, { category: null, tag: null, day: null, starred: false, text: '' }, patch);
      setTab('feed', { force: true });
      window.scrollTo({ top: 0, behavior: 'auto' });
    },
    setTab: (t) => setTab(t),
    addNew,
  };

  function mountView() {
    if (view && view.destroy) view.destroy();
    view = views[tab](api);
    mount(body, view.el);
    view.update(data);
  }

  function setTab(t, { force = false } = {}) {
    if (t === tab && !force) return;
    tab = t;
    tabs.setValue(t);
    ctx.navigate(t === 'feed' ? '/learning' : `/learning/${t}`, { silent: true });
    mountView();
  }

  async function load() {
    const token = ++loadToken;
    const today = todayKey();
    const [all, due] = await Promise.all([db.all(STORE), db.byIndex(STORE, 'nextReview', IDBKeyRange.upperBound(today))]);
    if (disposed || token !== loadToken) return;
    rememberLast(all);
    data = { all, due: [...due].sort(byDue), byId: new Map(all.map((r) => [r.id, r])), today };
    dueBadge.textContent = due.length ? String(due.length) : '';
    dueBadge.hidden = !due.length;
    if (reviewBtn) reviewBtn.setAttribute('aria-label', due.length ? `Review, ${due.length} due` : 'Review');
    if (view) view.update(data);
  }

  view = views[tab](api);
  mount(body, view.el);
  await load();
  if (disposed) return () => {};

  const refresh = debounce(load, 60);
  const onKey = (e) => {
    if (view && view.onKey) view.onKey(e);
  };
  document.addEventListener('keydown', onKey);
  const offs = [
    on('db:change', (e) => {
      if (!e || e.store === STORE || e.store === '*') refresh();
    }),
    on('settings:change', () => {
      if (view && view.settingsChanged) view.settingsChanged();
      refresh();
    }),
  ];

  // Manifest shortcut / deep link: #/learning?new=1 opens the editor, then drops the query.
  if (ctx.route.query && ctx.route.query.new === '1') {
    addNew();
    ctx.navigate(ctx.route.path, { replace: true });
  }

  return () => {
    disposed = true;
    refresh.cancel();
    offs.forEach((off) => off());
    document.removeEventListener('keydown', onKey);
    if (view && view.destroy) view.destroy();
  };
}

// ──────────────────────────────────────────────────────────────────────────── feed

function feedView(api) {
  let data = null;
  let limit = PAGE_SIZE;
  const cats = () => getSettings().learningCategories || [];

  const searchIn = input({
    type: 'search',
    value: filters.text,
    placeholder: 'Search titles, takeaways, tags…',
    'aria-label': 'Search learnings',
    autocomplete: 'off',
    enterkeyhint: 'search',
    onInput: (e) => {
      filters.text = e.target.value;
      typed();
    },
    onKeydown: (e) => {
      if (e.key === 'Escape' && searchIn.value) {
        e.preventDefault();
        e.stopPropagation();
        searchIn.value = '';
        filters.text = '';
        limit = PAGE_SIZE;
        paintList();
      }
    },
  });
  const typed = debounce(() => {
    limit = PAGE_SIZE;
    paintList();
  }, 120);
  const starBtn = h(
    'button.chip.learning-star-filter',
    {
      type: 'button',
      'aria-pressed': filters.starred ? 'true' : 'false',
      class: { 'is-selected': filters.starred },
      onClick: () => {
        filters.starred = !filters.starred;
        starBtn.setAttribute('aria-pressed', filters.starred ? 'true' : 'false');
        starBtn.classList.toggle('is-selected', filters.starred);
        limit = PAGE_SIZE;
        paintList();
      },
    },
    icon('star', { size: 16 }),
    h('span.chip-label', 'Starred')
  );
  const catOptions = () => cats().map((c) => ({ value: c.id, label: c.name, emoji: c.emoji, color: c.color }));
  const catChips = chips(catOptions(), filters.category, (v) => {
    filters.category = v;
    limit = PAGE_SIZE;
    paintList();
  }, { ariaLabel: 'Filter by category', size: 'sm', scroll: true, class: 'learning-filter-chips' });

  const activeEl = h('div.learning-active', { 'aria-live': 'polite' });
  const statsEl = h('section.card.learning-stats', { 'aria-labelledby': 'learning-stats-title' });
  const dueEl = h('div.learning-due-slot');
  const listEl = h('div.learning-list');
  const sideEl = h('div.learning-side');

  const el = h(
    'div.learning-feed',
    statsEl,
    h(
      'div.learning-main',
      dueEl,
      h(
        'div.learning-filters',
        { role: 'search' },
        h('div.learning-search-row', h('div.input-affix.learning-search', h('span.affix', { 'aria-hidden': 'true' }, icon('search', { size: 18 })), searchIn), starBtn),
        catChips,
        activeEl
      ),
      listEl
    ),
    sideEl
  );

  function paintStats() {
    const s = computeStats(data.all, data.today);
    mount(
      statsEl,
      h('h2.sr-only#learning-stats-title', 'At a glance'),
      h(
        'div.stat-grid.learning-stat-grid',
        statTile({ label: 'This week', value: fmtNumber(s.week), sub: s.lastWeek || s.week ? `${fmtNumber(s.lastWeek)} last week` : 'Start the week strong', icon: 'calendar', accent: COLOR }),
        statTile({ label: 'Streak', value: fmtNumber(s.streak), unit: s.streak === 1 ? 'day' : 'days', sub: s.streak && !s.loggedToday ? 'Log today to keep it' : s.best > s.streak ? `Best ${plural(s.best, 'day')}` : s.streak ? 'Your best yet' : 'Learn something today', icon: 'flame', accent: COLOR }),
        statTile({ label: 'This month', value: fmtNumber(Math.round(s.monthMinutes)), unit: 'min', sub: s.monthMinutes >= 60 ? fmtDuration(Math.round(s.monthMinutes)) : `${plural(s.monthCount, 'entry', 'entries')}`, icon: 'clock', accent: COLOR }),
        statTile({ label: 'Total', value: fmtNumber(s.total), sub: s.starred ? `${fmtNumber(s.starred)} starred` : plural(s.total, 'thing') + ' learned', icon: 'book', accent: COLOR })
      )
    );
  }

  function paintDue() {
    const n = data.due.length;
    if (!n) {
      mount(dueEl);
      return;
    }
    const mins = Math.max(1, Math.round((n * 20) / 60));
    mount(
      dueEl,
      h(
        'button.learning-due-banner',
        { type: 'button', dataset: { focusKey: 'due' }, onClick: () => api.setTab('review') },
        h('span.learning-due-icon', { 'aria-hidden': 'true' }, icon('brain', { size: 22 })),
        h('span.learning-due-text', h('span.learning-due-title', `Due for review: ${n}`), h('span.learning-due-sub', `About ${plural(mins, 'minute')} to lock them in`)),
        h('span.learning-due-cta', h('span.hide-mobile', 'Start review'), icon('arrow-right', { size: 18 }))
      )
    );
  }

  function clearAll() {
    Object.assign(filters, { category: null, tag: null, day: null, starred: false, text: '' });
    searchIn.value = '';
    catChips.setValue(null);
    starBtn.setAttribute('aria-pressed', 'false');
    starBtn.classList.remove('is-selected');
    limit = PAGE_SIZE;
    paintList();
  }

  function setTag(t) {
    filters.tag = filters.tag === t ? null : t;
    limit = PAGE_SIZE;
    paintList();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function paintList() {
    if (!data) return;
    const focusKey = captureFocus(listEl) || captureFocus(activeEl);
    const all = data.all;
    if (!all.length) {
      el.classList.add('is-empty');
      mount(activeEl);
      mount(
        listEl,
        emptyState({
          icon: 'lightbulb',
          accent: COLOR,
          title: 'Your learning journal starts here',
          message: 'Log one thing you learned today — a fact, an idea, a lesson. Daybook will bring it back for review so it sticks.',
          action: { label: 'Log your first learning', icon: 'plus', onClick: api.addNew },
        })
      );
      return;
    }
    el.classList.remove('is-empty');
    const shown = all.filter((r) => matches(r)).reverse();

    // active filter pills
    const pills = [];
    const pill = (label, onRemove, key) =>
      h('button.learning-pill', { type: 'button', 'aria-label': `Remove filter ${label}`, dataset: { focusKey: `pill:${key}` }, onClick: onRemove }, h('span', label), icon('x', { size: 14, strokeWidth: 2.25 }));
    if (filters.tag) pills.push(pill(`#${filters.tag}`, () => { filters.tag = null; paintList(); }, 'tag'));
    if (filters.day) pills.push(pill(fmtDate(filters.day, 'medium'), () => { filters.day = null; paintList(); }, 'day'));
    if (filterActive()) {
      mount(
        activeEl,
        h('span.learning-count', `${fmtNumber(shown.length)} of ${plural(all.length, 'entry', 'entries')}`),
        pills,
        h('button.link-btn.learning-clear', { type: 'button', dataset: { focusKey: 'clear' }, onClick: clearAll }, 'Clear filters')
      );
    } else mount(activeEl);

    if (!shown.length) {
      mount(
        listEl,
        emptyState({
          icon: 'search',
          accent: COLOR,
          compact: true,
          title: 'Nothing matches',
          message: filters.day ? `Nothing logged on ${fmtDate(filters.day, 'medium')} with these filters.` : 'Try another word or clear the filters.',
          action: { label: 'Clear filters', onClick: clearAll },
          actions: filters.day ? [{ label: `Log for ${fmtDate(filters.day, 'short')}`, icon: 'plus', onClick: api.addNew }] : [],
        })
      );
      restoreFocus(activeEl, 'clear');
      return;
    }

    const page = shown.slice(0, limit);
    const groups = [];
    let cur = null;
    for (const r of page) {
      if (!cur || cur.date !== r.date) {
        cur = { date: r.date, items: [] };
        groups.push(cur);
      }
      cur.items.push(r);
    }
    const dayTotals = new Map();
    for (const r of shown) {
      const t = dayTotals.get(r.date) || { n: 0, m: 0 };
      t.n += 1;
      t.m += num(r.minutes) || 0;
      dayTotals.set(r.date, t);
    }
    const opts = { today: data.today, onTag: setTag };
    mount(
      listEl,
      groups.map((g) => {
        const t = dayTotals.get(g.date);
        return h(
          'section.learning-day',
          h(
            'div.learning-day-head',
            h('h2.learning-day-title', relativeDay(g.date)),
            h('span.learning-day-meta', [plural(t.n, 'thing'), t.m ? minutesLabel(t.m) : null].filter(Boolean).join(' · ')),
            relativeDay(g.date) === 'Today' || relativeDay(g.date) === 'Yesterday' ? h('span.learning-day-date', fmtDate(g.date, 'short')) : null
          ),
          h('div.learning-entries', g.items.map((r) => entryCard(r, opts)))
        );
      }),
      shown.length > limit
        ? h(
            'div.learning-more',
            button({
              label: `Show ${fmtNumber(Math.min(PAGE_SIZE, shown.length - limit))} more`,
              variant: 'secondary',
              dataset: { focusKey: 'more' },
              onClick: () => {
                limit += PAGE_SIZE;
                paintList();
              },
            }),
            h('span.muted.text-sm', `${fmtNumber(limit)} of ${fmtNumber(shown.length)} shown`)
          )
        : null
    );
    restoreFocus(listEl, focusKey);
    if (focusKey && focusKey.startsWith('pill:')) restoreFocus(activeEl, focusKey);
  }

  function paintSide() {
    if (!data.all.length) {
      mount(sideEl);
      return;
    }
    const from = addDays(data.today, -(16 * 7) + 1);
    const values = {};
    for (const r of data.all) if (r.date >= from && r.date <= data.today) values[r.date] = (values[r.date] || 0) + 1;
    const active = Object.keys(values).length;
    const top = tagCounts(data.all).slice(0, 14);
    mount(
      sideEl,
      h(
        'section.card.learning-side-card',
        { 'aria-labelledby': 'learning-side-act' },
        h('div.card-header', iconChip('calendar-check', { accent: COLOR }), h('div.card-header-text', h('h2.card-title#learning-side-act', 'Activity'), h('p.card-subtitle', `${plural(active, 'active day')} in 16 weeks`))),
        heatmap({ values, from, to: data.today, accent: COLOR, valueFormat: (v) => plural(v, 'thing'), onClick: (d) => api.openFeed({ day: d }), emptyText: 'No entries in the last 16 weeks', ariaLabel: 'Learning activity, last 16 weeks' }),
        h('p.learning-hint', 'Tap a day to see what you learned.')
      ),
      top.length
        ? h(
            'section.card.learning-side-card',
            { 'aria-labelledby': 'learning-side-tags' },
            h('div.card-header', iconChip('tag', { accent: COLOR }), h('div.card-header-text', h('h2.card-title#learning-side-tags', 'Top tags'))),
            h(
              'div.learning-cloud.is-compact',
              top.map(([t, n]) => h('button.learning-cloud-tag', { type: 'button', class: { 'is-selected': filters.tag === t }, 'aria-pressed': filters.tag === t ? 'true' : 'false', onClick: () => setTag(t) }, h('span', `#${t}`), h('span.learning-cloud-n.num', String(n))))
            )
          )
        : null
    );
  }

  return {
    el,
    update(d) {
      data = d;
      paintStats();
      paintDue();
      paintList();
      paintSide();
    },
    settingsChanged() {
      catChips.setOptions(catOptions(), filters.category);
    },
    destroy() {
      typed.cancel();
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────── review

function syncSession(data) {
  const today = data.today;
  if (!session || session.day !== today) session = { day: today, queue: [], pos: 0, revealed: false, history: [] };
  const dueIds = new Set(data.due.map((r) => r.id));
  const keep = [];
  let pos = session.pos;
  session.queue.forEach((id, i) => {
    const graded = i < session.pos;
    if (data.byId.has(id) && (graded || dueIds.has(id))) keep.push(id);
    else if (graded) pos -= 1;
    else if (i === session.pos) session.revealed = false;
  });
  const inQueue = new Set(keep);
  for (const r of data.due) if (!inQueue.has(r.id)) keep.push(r.id);
  session.queue = keep;
  session.pos = Math.max(0, Math.min(pos, keep.length));
  session.history = session.history.filter((x) => data.byId.has(x.id));
}

function reviewView(api) {
  let data = null;
  let busy = false;
  let lastPaintedId = null;
  const el = h('div.learning-review');
  const live = h('div.sr-only', { 'aria-live': 'polite' });
  const stage = h('div.learning-review-stage');
  el.append(stage, live);

  const current = () => (session && session.pos < session.queue.length ? data.byId.get(session.queue[session.pos]) : null);

  function reveal() {
    if (!current() || session.revealed) return;
    session.revealed = true;
    paint();
    const g = stage.querySelector('[data-focus-key="grade:good"]');
    if (g) g.focus({ preventScroll: true });
    // Phones: bring the grade buttons into view (CSS scroll-margin clears the bottom nav + FAB).
    const grades = stage.querySelector('.learning-grades');
    if (grades && grades.getBoundingClientRect().bottom > window.innerHeight) {
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      grades.scrollIntoView({ block: 'end', behavior: reduce ? 'auto' : 'smooth' });
    }
  }

  async function grade(result) {
    const rec = current();
    if (!rec || busy || !session.revealed) return;
    busy = true;
    const today = todayKey();
    try {
      const fresh = (await db.get(STORE, rec.id)) || rec;
      const updated = applyGrade(fresh, result, today);
      session.history.push({ id: rec.id, before: fresh, result });
      session.pos += 1;
      session.revealed = false;
      data.byId.set(rec.id, updated);
      await db.put(STORE, updated);
      live.textContent = `${GRADE_BY_ID[result].label}. Next review ${whenLabel(updated.interval)}.`;
    } catch (err) {
      console.error('[daybook] review grade', err);
      const last = session.history[session.history.length - 1];
      if (last && last.id === rec.id) {
        session.history.pop();
        session.pos = Math.max(0, session.pos - 1);
        data.byId.set(rec.id, last.before);
      }
      toast('Couldn’t save that grade — try again.', { type: 'error' });
    } finally {
      busy = false;
    }
    paint();
    focusPrimary();
  }

  async function undo() {
    if (busy || !session || !session.history.length) return;
    busy = true;
    const last = session.history.pop();
    try {
      await db.put(STORE, last.before, { touch: false });
      data.byId.set(last.id, last.before);
      let idx = session.queue.indexOf(last.id);
      if (idx < 0) {
        session.queue.splice(session.pos, 0, last.id);
        idx = session.pos;
      }
      session.pos = idx;
      session.revealed = true;
      live.textContent = `Undid ${GRADE_BY_ID[last.result].label}.`;
    } catch (err) {
      console.error('[daybook] review undo', err);
      session.history.push(last);
      toast('Couldn’t undo — try again.', { type: 'error' });
    } finally {
      busy = false;
    }
    paint();
    const g = stage.querySelector(`[data-focus-key="grade:${last.result}"]`) || stage.querySelector('[data-focus-key="grade:good"]');
    if (g) g.focus({ preventScroll: true });
  }

  function focusPrimary() {
    const t = stage.querySelector('[data-focus-key="reveal"]') || stage.querySelector('[data-focus-key="done"]');
    if (t && (document.activeElement === document.body || !document.activeElement || !document.activeElement.isConnected || el.contains(document.activeElement))) t.focus({ preventScroll: true });
  }

  function undoButton() {
    const last = session.history[session.history.length - 1];
    return last
      ? button({ label: 'Undo', icon: 'rotate-ccw', variant: 'ghost', size: 'sm', class: 'learning-undo', ariaLabel: `Undo last grade (${GRADE_BY_ID[last.result].label})`, title: 'Undo last grade (U)', dataset: { focusKey: 'undo' }, onClick: undo })
      : null;
  }

  function paintDone() {
    const reviewedToday = reviewedOn(data.all, data.today);
    if (!data.all.length) {
      mount(
        stage,
        emptyState({
          icon: 'brain',
          accent: COLOR,
          title: 'Nothing to review yet',
          message: 'Log what you learn and it comes back here the next day — short, spaced reviews make it stick.',
          action: { label: 'Log a learning', icon: 'plus', onClick: api.addNew },
        })
      );
      return;
    }
    // Next reviews coming up
    let nextDay = null;
    let nextCount = 0;
    for (const r of data.byId.values()) {
      if (!isValidKey(r.nextReview) || r.nextReview <= data.today) continue;
      if (!nextDay || r.nextReview < nextDay) {
        nextDay = r.nextReview;
        nextCount = 1;
      } else if (r.nextReview === nextDay) nextCount += 1;
    }
    const sessionCount = session.history.length;
    const celebrate = reviewedToday > 0;
    mount(
      stage,
      h(
        'section.card.learning-done',
        { class: { 'is-celebrate': celebrate }, 'aria-labelledby': 'learning-done-title' },
        celebrate ? h('div.learning-confetti', { 'aria-hidden': 'true' }, Array.from({ length: 14 }, (_, i) => h('span', { style: { '--i': String(i) } }))) : null,
        h('div.learning-done-emoji', { 'aria-hidden': 'true' }, celebrate ? '🎉' : '🌿'),
        h('h2.learning-done-title#learning-done-title', celebrate ? 'All caught up!' : 'Nothing due right now'),
        h(
          'p.learning-done-text',
          celebrate
            ? `You reviewed ${plural(reviewedToday, 'card')} today${sessionCount && sessionCount !== reviewedToday ? ` (${fmtNumber(sessionCount)} just now)` : ''}. Spaced reviews are how ideas stick.`
            : 'Your memory is up to date. New learnings show up here the day after you log them.'
        ),
        nextDay ? h('p.learning-done-next', icon('calendar', { size: 16 }), h('span', `Next: ${plural(nextCount, 'card')} ${relativeDay(nextDay) === 'Tomorrow' ? 'tomorrow' : `on ${fmtDate(nextDay, 'medium')}`}`)) : null,
        h(
          'div.learning-done-actions',
          button({ label: 'Back to feed', variant: 'primary', icon: 'list', dataset: { focusKey: 'done' }, onClick: () => api.setTab('feed') }),
          button({ label: 'Log something new', variant: 'secondary', icon: 'plus', onClick: api.addNew }),
          undoButton()
        )
      )
    );
  }

  function paint() {
    if (!data) return;
    const focusKey = captureFocus(stage);
    const rec = current();
    if (!rec) {
      lastPaintedId = null;
      paintDone();
      restoreFocus(stage, focusKey);
      return;
    }
    const total = session.queue.length;
    const n = session.pos + 1;
    const cat = learningCategory(rec.category);
    const src = sourceOf(rec);
    const url = safeUrl(rec.link);
    const reviews = reviewsOf(rec);
    const age = diffDays(rec.date, data.today);
    const overdue = isValidKey(rec.nextReview) ? diffDays(rec.nextReview, data.today) : 0;
    const isNewCard = lastPaintedId !== rec.id;
    lastPaintedId = rec.id;
    const revealed = session.revealed;

    const front = h(
      'div.learning-flash-front',
      h(
        'div.learning-flash-meta',
        catChip(cat, 'sm'),
        h('span.learning-flash-cat', cat.name),
        h('span.learning-flash-dot', { 'aria-hidden': 'true' }, '·'),
        h('span', age <= 0 ? 'Learned today' : age === 1 ? 'Learned yesterday' : `Learned ${fmtDate(rec.date, age > 300 ? 'mediumYear' : 'short')}`),
        h('span.learning-flash-dot', { 'aria-hidden': 'true' }, '·'),
        h('span', reviews.length ? `Review #${reviews.length + 1}` : 'First review'),
        overdue > 0 ? h('span.learning-flash-late', `${plural(overdue, 'day')} late`) : null
      ),
      h('h2.learning-flash-title', rec.title || 'Untitled')
    );

    const back = revealed
      ? h(
          'div.learning-flash-back',
          rec.takeaway
            ? h('blockquote.learning-flash-takeaway', rec.takeaway)
            : h('p.learning-flash-missing', 'No takeaway saved. ', h('button.link-btn', { type: 'button', onClick: () => openEditor(rec) }, 'Add one')),
          rec.notes ? h('p.learning-flash-notes', rec.notes) : null,
          h(
            'div.learning-meta.learning-flash-src',
            h('span.learning-src', h('span', { 'aria-hidden': 'true' }, src.emoji), h('span', rec.sourceName || src.label)),
            url ? h('a.learning-link', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, icon('external-link', { size: 14 }), h('span', hostOf(url)), h('span.sr-only', ' (opens in a new tab)')) : null,
            tagsOf(rec).length ? h('span.learning-flash-tags', tagsOf(rec).map((t) => `#${t}`).join(' ')) : null
          )
        )
      : h(
          'div.learning-flash-prompt',
          h('p.learning-flash-ask', rec.takeaway ? 'What was the key takeaway?' : 'What do you remember about this?'),
          h(
            'button.btn.btn-primary.btn-lg.learning-reveal',
            { type: 'button', dataset: { focusKey: 'reveal' }, onClick: reveal },
            icon('eye', { size: 20 }),
            h('span', 'Reveal'),
            h('kbd.learning-kbd.hide-mobile', { 'aria-hidden': 'true' }, 'Space')
          )
        );

    const interval = Number(rec.interval) > 0 ? Number(rec.interval) : 1;
    const grades = revealed
      ? h(
          'div.learning-grades',
          { role: 'group', 'aria-label': 'How well did you remember it?' },
          GRADES.map((g) => {
            const days = nextInterval(interval, g.value);
            return h(
              'button.learning-grade',
              {
                type: 'button',
                class: `is-${g.value}`,
                dataset: { focusKey: `grade:${g.value}` },
                'aria-label': `${g.label} — ${g.note}. Next review ${whenLabel(days)}. Key ${g.key}`,
                onClick: () => grade(g.value),
              },
              h('span.learning-grade-label', g.label),
              h('span.learning-grade-hint.num', intervalLabel(days)),
              h('kbd.learning-kbd.hide-mobile', { 'aria-hidden': 'true' }, g.key)
            );
          })
        )
      : null;

    mount(
      stage,
      h(
        'div.learning-review-top',
        h('span.learning-review-count.num', `${fmtNumber(n)} of ${fmtNumber(total)}`),
        h('div.learning-review-bar', progressBar(session.pos / total, { accent: COLOR, height: 6, label: `Card ${n} of ${total}` })),
        undoButton()
      ),
      h(
        'article.card.learning-flash',
        { class: { 'is-enter': isNewCard, 'is-revealed': revealed }, style: { '--cat': cat.color || 'var(--learning)' }, 'aria-label': `Card ${n} of ${total}: ${rec.title}` },
        front,
        back,
        h('div.learning-flash-foot', button({ label: 'Edit', icon: 'edit', variant: 'ghost', size: 'sm', dataset: { focusKey: 'edit' }, onClick: () => openEditor(rec) }))
      ),
      grades,
      h('p.learning-review-keys.hide-mobile', revealed ? 'Press 1, 2 or 3 to grade · U to undo' : 'Press Space to reveal · U to undo')
    );
    restoreFocus(stage, focusKey);
  }

  return {
    el,
    update(d) {
      data = d;
      syncSession(d);
      paint();
    },
    onKey(e) {
      if (!data || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('.sheet-layer, .menu, .lightbox')) return;
      const k = e.key;
      // Space/Enter on a control inside the card keep their native meaning; elsewhere (e.g. the tab bar) they reveal.
      const onControl = e.target && e.target.closest && (e.target.closest('a') || (el.contains(e.target) && e.target.closest('button')));
      if ((k === ' ' || k === 'Spacebar' || k === 'Enter') && !onControl && current() && !session.revealed) {
        e.preventDefault();
        reveal();
      } else if ((k === '1' || k === '2' || k === '3') && current() && session.revealed) {
        e.preventDefault();
        grade(GRADES[Number(k) - 1].value);
      } else if ((k === 'u' || k === 'U') && session && session.history.length) {
        e.preventDefault();
        undo();
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────── library

function libraryView(api) {
  const el = h('div.learning-library');

  function update(data) {
    const all = data.all;
    if (!all.length) {
      mount(
        el,
        emptyState({
          icon: 'library',
          accent: COLOR,
          title: 'Your library is empty',
          message: 'Every learning you log builds your library — categories, sources, tags and favourites.',
          action: { label: 'Log a learning', icon: 'plus', onClick: api.addNew },
        })
      );
      return;
    }
    const today = data.today;

    // Overview numbers
    const totalMin = all.reduce((s, r) => s + (num(r.minutes) || 0), 0);
    let reviews = 0;
    let good = 0;
    for (const r of all) for (const v of reviewsOf(r)) {
      reviews += 1;
      if (v && v.result === 'good') good += 1;
    }
    const overview = h(
      'section.card.learning-overview',
      { 'aria-labelledby': 'learning-ov-title' },
      h('h2.sr-only#learning-ov-title', 'Overview'),
      h(
        'div.stat-grid.learning-stat-grid',
        statTile({ label: 'Things learned', value: fmtNumber(all.length), sub: `since ${fmtDate(all[0].date, 'shortYear')}`, icon: 'lightbulb', accent: COLOR }),
        statTile({ label: 'Time invested', value: totalMin >= 60 ? `${fmtNumber(totalMin / 60, { maxDecimals: totalMin >= 6000 ? 0 : 1 })} h` : `${Math.round(totalMin)} min`, sub: `${plural(all.filter((r) => num(r.minutes)).length, 'timed entry', 'timed entries')}`, icon: 'clock', accent: COLOR }),
        statTile({ label: 'Reviews done', value: fmtNumber(reviews), sub: `${fmtNumber(reviewedOn(all, today))} today`, icon: 'repeat', accent: COLOR }),
        statTile({ label: 'Recall rate', value: reviews ? fmtPercent(good / reviews, { decimals: 0 }) : '—', sub: reviews ? 'graded Good' : 'Review to see it', icon: 'brain', accent: COLOR })
      )
    );

    // Heatmap — last 26 weeks
    const from = addDays(today, -(26 * 7) + 1);
    const values = {};
    for (const r of all) if (r.date >= from && r.date <= today) values[r.date] = (values[r.date] || 0) + 1;
    const activeDays = Object.keys(values).length;
    const inRange = Object.values(values).reduce((s, v) => s + v, 0);
    const heat = h(
      'section.card.learning-heat',
      { 'aria-labelledby': 'learning-heat-title' },
      h('div.card-header', iconChip('calendar-check', { accent: COLOR }), h('div.card-header-text', h('h2.card-title#learning-heat-title', 'Activity'), h('p.card-subtitle', `${plural(inRange, 'thing')} on ${plural(activeDays, 'day')} · last 26 weeks`))),
      h('div.learning-heat-scroll', heatmap({ values, from, to: today, accent: COLOR, valueFormat: (v) => plural(v, 'thing'), onClick: (d) => api.openFeed({ day: d }), emptyText: 'Nothing logged in the last 26 weeks', ariaLabel: 'Learning activity, last 26 weeks' })),
      h('p.learning-hint', 'Tap a day to see what you learned.')
    );

    // Categories donut (colour follows the category from settings)
    const catCounts = new Map();
    for (const r of all) catCounts.set(r.category || 'other', (catCounts.get(r.category || 'other') || 0) + 1);
    const catData = [...catCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => {
        const c = learningCategory(id);
        return { id, label: `${c.emoji || ''} ${c.name}`.trim(), value: n, color: c.color };
      });
    const top = catData[0];
    const catsCard = h(
      'section.card.learning-cats',
      { 'aria-labelledby': 'learning-cats-title' },
      h('div.card-header', iconChip('pie', { accent: COLOR }), h('div.card-header-text', h('h2.card-title#learning-cats-title', 'Categories'), h('p.card-subtitle', top ? `Mostly ${learningCategory(top.id).name.toLowerCase()} · ${fmtPercent(top.value / all.length, { decimals: 0 })}` : ''))),
      h(
        'div.learning-donut',
        donutChart({
          data: catData,
          size: 168,
          thickness: 20,
          centerValue: fmtNumber(all.length),
          centerLabel: all.length === 1 ? 'thing' : 'things',
          valueFormat: (v) => plural(v, 'thing'),
          onClick: (d) => {
            if (d && d.id) api.openFeed({ category: d.id });
          },
          ariaLabel: 'Learnings by category',
        })
      )
    );

    // Sources
    const srcStats = new Map();
    const named = new Map();
    for (const r of all) {
      const s = sourceOf(r).value;
      const st = srcStats.get(s) || { n: 0, m: 0 };
      st.n += 1;
      st.m += num(r.minutes) || 0;
      srcStats.set(s, st);
      const nm = String(r.sourceName || '').trim();
      if (nm) {
        const k = lower(nm);
        const e = named.get(k) || { name: nm, n: 0, source: s };
        e.n += 1;
        named.set(k, e);
      }
    }
    const srcRows = [...srcStats.entries()].sort((a, b) => b[1].n - a[1].n);
    const maxN = srcRows.length ? srcRows[0][1].n : 1;
    const topNamed = [...named.values()].filter((x) => x.n > 1).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 5);
    const srcCard = h(
      'section.card.learning-sources',
      { 'aria-labelledby': 'learning-src-title' },
      h('div.card-header', iconChip('book', { accent: COLOR }), h('div.card-header-text', h('h2.card-title#learning-src-title', 'Sources'), h('p.card-subtitle', 'Where your learning comes from'))),
      h(
        'ul.learning-src-list',
        srcRows.map(([s, st]) =>
          h(
            'li.learning-src-row',
            h('span.learning-src-name', h('span', { 'aria-hidden': 'true' }, SOURCE_BY_ID[s].emoji), h('span', SOURCE_BY_ID[s].label)),
            h('span.learning-src-bar', { 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.max(4, (st.n / maxN) * 100)}%` } })),
            h('span.learning-src-n.num', fmtNumber(st.n)),
            h('span.learning-src-m.num', st.m ? minutesLabel(st.m) : '—')
          )
        )
      ),
      topNamed.length
        ? h(
            'div.learning-src-top',
            h('h3.learning-sub-title', 'Go-to sources'),
            h('ol.learning-named', topNamed.map((x) => h('li', h('span', { 'aria-hidden': 'true' }, SOURCE_BY_ID[x.source].emoji), h('span.learning-named-name', x.name), h('span.muted.num', `${x.n}×`))))
          )
        : null
    );

    // Tag cloud
    const tags = tagCounts(all).slice(0, 40);
    const maxT = tags.length ? tags[0][1] : 1;
    const tagsCard = h(
      'section.card.learning-tagcard',
      { 'aria-labelledby': 'learning-tags-title' },
      h('div.card-header', iconChip('tag', { accent: COLOR }), h('div.card-header-text', h('h2.card-title#learning-tags-title', 'Top tags'), h('p.card-subtitle', tags.length ? 'Tap a tag to see its entries' : ''))),
      tags.length
        ? h(
            'div.learning-cloud',
            tags.map(([t, n]) => {
              const lv = Math.max(1, Math.ceil((n / maxT) * 4));
              return h('button.learning-cloud-tag', { type: 'button', class: `lv-${lv}`, 'aria-label': `#${t}, ${plural(n, 'entry', 'entries')}`, onClick: () => api.openFeed({ tag: t }) }, h('span', `#${t}`), h('span.learning-cloud-n.num', String(n)));
            })
          )
        : emptyState({ icon: 'tag', accent: COLOR, compact: true, title: 'No tags yet', message: 'Add tags when you log — they group related ideas.' })
    );

    // Starred
    const starred = all.filter((r) => r.starred).reverse();
    const starCard = h(
      'section.card.card-flush.learning-starred',
      { 'aria-labelledby': 'learning-star-title' },
      h(
        'div.card-header',
        iconChip('star', { accent: COLOR }),
        h('div.card-header-text', h('h2.card-title#learning-star-title', 'Starred'), h('p.card-subtitle', starred.length ? plural(starred.length, 'favourite') : 'Your favourites')),
        starred.length > 8 ? h('div.card-actions', button({ label: 'See all', variant: 'ghost', size: 'sm', iconEnd: 'arrow-right', onClick: () => api.openFeed({ starred: true }) })) : null
      ),
      starred.length
        ? h(
            'div.list.learning-star-list',
            starred.slice(0, 8).map((r) => {
              const c = learningCategory(r.category);
              return listItem({ emoji: c.emoji, accent: c.color, title: r.title, meta: [r.takeaway || c.name], trailMeta: fmtDate(r.date, 'short'), onClick: () => openEditor(r) });
            })
          )
        : h('div.learning-pad', emptyState({ icon: 'star', accent: COLOR, compact: true, title: 'Nothing starred yet', message: 'Tap the star on an entry to keep your best ideas close.', action: { label: 'Browse the feed', onClick: () => api.setTab('feed') } }))
    );

    mount(el, overview, heat, h('div.learning-lib-grid', catsCard, srcCard, tagsCard, starCard));
  }

  return { el, update };
}

// ──────────────────────────────────────────────────────────────────────────── module

export default {
  id: ID,
  title: TITLE,
  icon: ICON,
  color: COLOR,
  render,
  openEditor,
  quickActions: [{ id: 'learning', label: 'Learned', icon: ICON, color: COLOR, run: ({ date } = {}) => openEditor(null, { date }) }],

  async summarizeDay(date) {
    const items = await db.byDate(STORE, date);
    const mins = items.reduce((s, r) => s + (num(r.minutes) || 0), 0);
    const parts = [];
    if (items.length) parts.push(plural(items.length, 'thing'));
    if (mins) parts.push(minutesLabel(mins));
    return {
      id: ID,
      title: TITLE,
      icon: ICON,
      color: COLOR,
      headline: parts.join(' · '),
      empty: 'Nothing learned yet',
      items: items.map((r) => {
        const c = learningCategory(r.category);
        return {
          id: r.id,
          time: r.time || '',
          title: `${c.emoji || '✨'} ${r.title}`,
          meta: r.takeaway || [c.name, r.sourceName].filter(Boolean).join(' · '),
          onOpen: () => openEditor(r),
        };
      }),
      addLabel: 'Add learning',
      onAdd: () => openEditor(null, { date }),
    };
  },

  async search(query) {
    const q = lower(query);
    if (q.length < 2) return [];
    const all = await db.all(STORE);
    return all
      .filter((r) => haystack(r).includes(q))
      .reverse()
      .slice(0, 50)
      .map((r) => {
        const c = learningCategory(r.category);
        return {
          id: r.id,
          module: ID,
          icon: ICON,
          color: COLOR,
          title: `${c.emoji || '✨'} ${r.title}`,
          subtitle: [r.takeaway, r.sourceName, tagsOf(r).map((t) => `#${t}`).join(' ')].filter(Boolean).join(' · ') || c.name,
          date: r.date,
          onOpen: () => openEditor(r),
        };
      });
  },
};
