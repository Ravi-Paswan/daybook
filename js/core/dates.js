// Date utilities (SPEC 3.7). Local time only — never toISOString() for date keys.
// Keys: 'YYYY-MM-DD'; months: 'YYYY-MM'; times: 'HH:MM' (24h); ISO weeks: 'YYYY-Www'.
// All functions tolerate null/invalid input: they return null (keys), '—' (display dates), '' (fmtTime) or
// false/[] instead of throwing. Arithmetic is calendar-based (noon anchors) so DST shifts never skip/duplicate days.
// Formatting uses Intl with navigator.language; formatters are cached.
// Extras beyond the spec: isValidKey, isToday, currentMonth, daysAgo, monthRange, weekKeys, monthKeys,
// weekdayLabels, fmtRange, timeToMinutes, minutesToTime, fmtDate styles 'shortYear' | 'mediumYear' |
// 'narrow' | 'weekdayLong' | 'day' | 'month' | 'full' (= 'long').

import { getSettings } from './settings.js';

const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function locale() {
  try {
    return (typeof navigator !== 'undefined' && (navigator.languages?.[0] || navigator.language)) || 'en-US';
  } catch {
    return 'en-US';
  }
}

function defaultWeekStart() {
  try {
    const w = getSettings()?.weekStart;
    return Number.isInteger(w) && w >= 0 && w <= 6 ? w : 1;
  } catch {
    return 1;
  }
}

function normWeekStart(ws) {
  if (ws === undefined || ws === null || ws === '') return defaultWeekStart();
  const n = Number(ws);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : defaultWeekStart();
}

/** → {y, m, d} or null. Accepts 'YYYY-MM-DD', 'YYYY-MM' (day 1) or a Date. */
function parse(key) {
  if (key instanceof Date) {
    if (Number.isNaN(key.getTime())) return null;
    return { y: key.getFullYear(), m: key.getMonth() + 1, d: key.getDate() };
  }
  if (typeof key !== 'string') return null;
  let mt = KEY_RE.exec(key);
  if (mt) {
    const y = +mt[1];
    const m = +mt[2];
    const d = +mt[3];
    if (m < 1 || m > 12 || d < 1 || d > new Date(y, m, 0).getDate()) return null;
    return { y, m, d };
  }
  mt = MONTH_RE.exec(key);
  if (mt) {
    const y = +mt[1];
    const m = +mt[2];
    if (m < 1 || m > 12) return null;
    return { y, m, d: 1 };
  }
  return null;
}

const keyOf = (y, m, d) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
const noon = (p) => new Date(p.y, p.m - 1, p.d, 12, 0, 0, 0);
const utcDay = (p) => Date.UTC(p.y, p.m - 1, p.d);

// ---------------------------------------------------------------------------------------------------
// Keys

export function isValidKey(key) {
  return typeof key === 'string' && KEY_RE.test(key) && parse(key) !== null;
}

/** Date | timestamp | 'YYYY-MM-DD' | ISO datetime string → local 'YYYY-MM-DD' (null when invalid). */
export function toKey(date) {
  if (date === null || date === undefined || date === '') return null;
  if (typeof date === 'string') {
    if (KEY_RE.test(date)) return isValidKey(date) ? date : null;
    if (MONTH_RE.test(date)) return startOfMonth(date);
    const d = new Date(date); // ISO datetime with time/zone → the local day of that instant
    if (Number.isNaN(d.getTime())) return null;
    return keyOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  const d = date instanceof Date ? date : typeof date === 'number' ? new Date(date) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return keyOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function todayKey() {
  return toKey(new Date());
}

/** Local midnight Date for a key (or month → first day). null when invalid. */
export function fromKey(key) {
  const p = parse(key);
  return p ? new Date(p.y, p.m - 1, p.d) : null;
}

export function addDays(key, n) {
  const p = parse(key);
  if (!p) return null;
  const k = Math.trunc(Number(n) || 0);
  const d = new Date(p.y, p.m - 1, p.d + k, 12);
  return keyOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Whole days from a to b (b − a). null when either is invalid. */
export function diffDays(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  return Math.round((utcDay(pb) - utcDay(pa)) / DAY_MS);
}

/** 0..6 (0 = Sunday). null when invalid. */
export function weekday(key) {
  const p = parse(key);
  return p ? new Date(utcDay(p)).getUTCDay() : null;
}

export function startOfWeek(key, weekStart) {
  const wd = weekday(key);
  if (wd === null) return null;
  const ws = normWeekStart(weekStart);
  return addDays(key, -((wd - ws + 7) % 7));
}

export function endOfWeek(key, weekStart) {
  const s = startOfWeek(key, weekStart);
  return s ? addDays(s, 6) : null;
}

/** 'YYYY-MM' from a key or month. */
export function monthOf(key) {
  const p = parse(key);
  return p ? `${String(p.y).padStart(4, '0')}-${pad(p.m)}` : null;
}

export function currentMonth() {
  return monthOf(todayKey());
}

export function daysInMonth(month) {
  const p = parse(month);
  return p ? new Date(p.y, p.m, 0).getDate() : null;
}

export function startOfMonth(keyOrMonth) {
  const p = parse(keyOrMonth);
  return p ? keyOf(p.y, p.m, 1) : null;
}

export function endOfMonth(keyOrMonth) {
  const p = parse(keyOrMonth);
  return p ? keyOf(p.y, p.m, new Date(p.y, p.m, 0).getDate()) : null;
}

export function monthRange(month) {
  return { from: startOfMonth(month), to: endOfMonth(month) };
}

/**
 * addMonths('2026-11', 2) → '2027-01'. Given a full key it returns a key with the day clamped
 * to the target month length (addMonths('2026-01-31', 1) → '2026-02-28').
 */
export function addMonths(month, n) {
  const p = parse(month);
  if (!p) return null;
  const total = p.y * 12 + (p.m - 1) + Math.trunc(Number(n) || 0);
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  if (typeof month === 'string' && MONTH_RE.test(month)) return `${String(y).padStart(4, '0')}-${pad(m)}`;
  return keyOf(y, m, Math.min(p.d, new Date(y, m, 0).getDate()));
}

/** Inclusive list of keys from → to ([] when from > to or invalid). Capped at ~30 years. */
export function rangeKeys(from, to) {
  const n = diffDays(from, to);
  if (n === null || n < 0) return [];
  const p = parse(from);
  const out = [];
  const count = Math.min(n, 11000);
  for (let i = 0; i <= count; i++) {
    const d = new Date(p.y, p.m - 1, p.d + i, 12);
    out.push(keyOf(d.getFullYear(), d.getMonth() + 1, d.getDate()));
  }
  return out;
}

/** 7 keys of the week containing `key`. */
export function weekKeys(key, weekStart) {
  const s = startOfWeek(key, weekStart);
  return s ? rangeKeys(s, addDays(s, 6)) : [];
}

/** Every key of a month. */
export function monthKeys(month) {
  return rangeKeys(startOfMonth(month), endOfMonth(month));
}

export function daysAgo(n) {
  return addDays(todayKey(), -n);
}

/** ISO-8601 week key, e.g. '2026-W48' (2027-01-01 → '2026-W53'). */
export function isoWeek(key) {
  const p = parse(key);
  if (!p) return null;
  const d = new Date(utcDay(p));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this week decides the year
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${isoYear}-W${pad(week)}`;
}

/** '2026-W48' → {from:'2026-11-23', to:'2026-11-29'} (ISO weeks are always Mon–Sun). */
export function weekRange(isoWeekKey) {
  const mt = /^(\d{4})-W(\d{1,2})$/.exec(String(isoWeekKey || ''));
  if (!mt) return { from: null, to: null };
  const y = +mt[1];
  const w = +mt[2];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const mondayW1 = Date.UTC(y, 0, 4 - (jan4Day - 1));
  const from = new Date(mondayW1 + (w - 1) * 7 * DAY_MS);
  const fromKey = keyOf(from.getUTCFullYear(), from.getUTCMonth() + 1, from.getUTCDate());
  return { from: fromKey, to: addDays(fromKey, 6) };
}

export function isToday(key) {
  return !!key && key === todayKey();
}

export function isFuture(key) {
  const k = toKey(key);
  return !!k && k > todayKey();
}

export function clampToToday(key) {
  const k = toKey(key);
  if (!k) return todayKey();
  return k > todayKey() ? todayKey() : k;
}

// ---------------------------------------------------------------------------------------------------
// Formatting

const fmtCache = new Map();
function dtf(opts) {
  const loc = locale();
  const id = loc + '|' + JSON.stringify(opts);
  let f = fmtCache.get(id);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(loc, opts);
    } catch {
      f = new Intl.DateTimeFormat('en-US', opts);
    }
    fmtCache.set(id, f);
  }
  return f;
}

const STYLES = {
  short: { day: 'numeric', month: 'short' }, // 24 Nov
  shortYear: { day: 'numeric', month: 'short', year: 'numeric' }, // 24 Nov 2026
  medium: { weekday: 'short', day: 'numeric', month: 'short' }, // Mon, 24 Nov
  mediumYear: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, // Mon, 24 Nov 2026
  long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, // Monday, 24 November 2026
  weekday: { weekday: 'short' }, // Mon
  weekdayLong: { weekday: 'long' }, // Monday
  narrow: { weekday: 'narrow' }, // M
  monthYear: { month: 'short', year: 'numeric' }, // Nov 2026
  month: { month: 'short' }, // Nov
  day: { day: 'numeric' }, // 24
};
STYLES.full = STYLES.long;

export function fmtDate(key, style = 'medium') {
  const p = parse(key);
  if (!p) return '—';
  return dtf(STYLES[style] || STYLES.medium).format(noon(p));
}

/** 'YYYY-MM' (or key) → "November 2026". */
export function fmtMonth(month) {
  const p = parse(month);
  if (!p) return '—';
  return dtf({ month: 'long', year: 'numeric' }).format(new Date(p.y, p.m - 1, 1, 12));
}

/** "18 – 24 Nov" style range (uses Intl formatRange when available). */
export function fmtRange(from, to, style = 'short') {
  const a = parse(from);
  const b = parse(to);
  if (!a && !b) return '—';
  if (!a || !b) return fmtDate(a ? from : to, style);
  const f = dtf(STYLES[style] || STYLES.short);
  try {
    if (typeof f.formatRange === 'function') return f.formatRange(noon(a), noon(b));
  } catch {
    /* fall through */
  }
  return `${f.format(noon(a))} – ${f.format(noon(b))}`;
}

/** Weekday labels starting at weekStart: style 'short' (Mon) | 'narrow' (M) | 'long' (Monday). */
export function weekdayLabels(weekStart, style = 'short') {
  const ws = normWeekStart(weekStart);
  const f = dtf({ weekday: style === 'long' ? 'long' : style === 'narrow' ? 'narrow' : 'short' });
  const out = [];
  for (let i = 0; i < 7; i++) {
    const wd = (ws + i) % 7;
    out.push(f.format(new Date(2023, 0, 1 + wd, 12))); // 2023-01-01 is a Sunday
  }
  return out;
}

export function relativeDay(key) {
  const k = toKey(key);
  if (!k) return '—';
  const n = diffDays(todayKey(), k);
  if (n === 0) return 'Today';
  if (n === -1) return 'Yesterday';
  if (n === 1) return 'Tomorrow';
  return fmtDate(k, 'medium');
}

export function nowTime() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 'HH:MM' → minutes since midnight (null when invalid). */
export function timeToMinutes(time) {
  const mt = /^(\d{1,2}):(\d{2})/.exec(String(time || ''));
  if (!mt) return null;
  const h = +mt[1];
  const m = +mt[2];
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** minutes since midnight → 'HH:MM' (wraps around 24h). */
export function minutesToTime(mins) {
  const n = Number(mins);
  if (!Number.isFinite(n)) return null;
  const t = ((Math.round(n) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

/** 'HH:MM' → locale time ("6:30 pm" / "18:30"); '' when empty/invalid. */
export function fmtTime(time) {
  const mins = timeToMinutes(time);
  if (mins === null) return '';
  return dtf({ hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, Math.floor(mins / 60), mins % 60));
}

export function greeting(date = new Date()) {
  const h = date instanceof Date && !Number.isNaN(date.getTime()) ? date.getHours() : new Date().getHours();
  if (h >= 4 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  return 'Good evening';
}
