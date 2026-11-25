// Daybook charts — dependency-free, responsive, theme-aware SVG charts (SPEC 3.12).
//
// Choices not fixed by the spec (kept simple and documented here):
// - Self-contained: numbers/dates are formatted with Intl directly (browser locale), so this file has no
//   imports and never breaks if another core file fails to load. Pass yFormat/valueFormat for money etc.
// - Every chart returns <div class="chart chart-<kind>">. Extra: el.update(patch) re-renders with merged options.
// - Colors accept '--food' (CSS var name), 'var(--x)', '#hex', 'rgb()/hsl()/oklch()'. Missing colors take the
//   categorical slots --chart-1..8 in fixed order (never cycled; a 9th+ series uses --chart-other gray).
// - SVG is built with DOM APIs (createElementNS + textContent), so labels are never parsed as markup.
// - Hover: line charts use a snapping crosshair; bars/cells/segments are their own hit targets. Touch: tap shows
//   the tooltip (tap outside hides it); when onClick is given, a second tap on the same mark activates it.
//   Keyboard: charts are focusable; arrows move, Home/End jump, Enter activates, Esc hides.
// - barChart maxBars keeps the FIRST n items (callers sort/slice). Horizontal bars size their own height.
// - Heatmap weekStart defaults to window.daybook settings (when present), else Monday. donutChart folds a
//   9th+ slice into "Other". Invalid values (null/NaN/±Infinity/non-numeric) are skipped everywhere.

const SVGNS = 'http://www.w3.org/2000/svg';
const MINUS = '−';
const LOCALE = (() => {
  try {
    return (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  } catch {
    return 'en-US';
  }
})();

/* ------------------------------------------------------------------------------------------------ utils */

let seq = 0;
const uid = (p) => `${p}${(++seq).toString(36)}`;
const f1 = (n) => Math.round(n * 10) / 10;
const crisp = (n) => Math.round(n) + 0.5;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function toNum(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function svgEl(tag, attrs = {}, text) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style') {
      for (const p in v) if (v[p] !== null && v[p] !== undefined) el.style.setProperty(p, String(v[p]));
    } else el.setAttribute(k, String(v));
  }
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function htmlEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

let mixOK = null;
function supportsMix() {
  if (mixOK === null) {
    try {
      mixOK = CSS.supports('color', 'color-mix(in oklab, red 50%, blue)');
    } catch {
      mixOK = false;
    }
  }
  return mixOK;
}

/* --------------------------------------------------------------------------------------------- colors */

const COLOR_FN = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\([^;{}<>]*\)$/i;

/** Categorical slot for series i (0-based) as a CSS var name: '--chart-1' … '--chart-8', then '--chart-other'. */
export function seriesColor(i = 0) {
  return i >= 0 && i < 8 ? `--chart-${i + 1}` : '--chart-other';
}

function slotVar(i) {
  return i >= 0 && i < 8 ? `var(--_c${i + 1})` : 'var(--_other)';
}

/** Resolve a user color into a CSS color expression; falls back to the categorical slot for index i. */
function cssColor(c, i = 0) {
  if (typeof c === 'string') {
    const t = c.trim();
    if (/^--[A-Za-z0-9_-]+$/.test(t)) {
      const m = /^--chart-([1-8])$/.exec(t);
      if (m) return `var(--_c${m[1]})`;
      if (t === '--chart-other') return 'var(--_other)';
      if (t === '--profit') return 'var(--_profit)';
      if (t === '--loss') return 'var(--_loss)';
      return `var(${t}, ${slotVar(i)})`;
    }
    if (/^var\(--[A-Za-z0-9_-]+\s*(,[^;{}<>]*)?\)$/.test(t)) return t;
    if (/^#[0-9a-f]{3,8}$/i.test(t) || COLOR_FN.test(t) || /^[a-z]{3,20}$/i.test(t)) return t;
  }
  return slotVar(i);
}

/* ------------------------------------------------------------------------------------------ formatting */

const nfCache = new Map();
function nf(o) {
  const k = JSON.stringify(o);
  let fmt = nfCache.get(k);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(LOCALE, o);
    } catch {
      fmt = new Intl.NumberFormat('en-US', o);
    }
    nfCache.set(k, fmt);
  }
  return fmt;
}

const dfCache = new Map();
function df(o) {
  const k = JSON.stringify(o);
  let fmt = dfCache.get(k);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat(LOCALE, o);
    } catch {
      fmt = new Intl.DateTimeFormat('en-US', o);
    }
    dfCache.set(k, fmt);
  }
  return fmt;
}

/**
 * Default number formatting: grouping, compact from 10,000 (12.5K), true minus sign.
 * compact: undefined → per value (≥ 10,000); true → compact from 1,000 (one style per axis); false → never.
 */
function fmtNum(v, { step, sign = false, compact } = {}) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  let s;
  if (compact === undefined ? a >= 10000 : compact && a >= 1000) {
    s = nf({ notation: 'compact', maximumFractionDigits: a >= 100000 && a < 1e6 ? 0 : 1 }).format(v);
  } else {
    let dec;
    if (step) dec = clamp(Math.ceil(-Math.log10(step) - 1e-9), 0, 3);
    else dec = a === 0 ? 0 : a < 1 ? 2 : a < 100 ? 1 : 0;
    s = nf({ maximumFractionDigits: dec }).format(v);
  }
  s = s.replace(/-/g, MINUS);
  if (sign && v > 0) s = '+' + s;
  return s;
}

/**
 * Calls a user formatter as fn(value, ctx). ctx is shaped like format.js options, so fmtMoney / fmtNumber can be
 * passed directly: axis ticks get { axis: true, compact, step } (compact = the axis reaches 10,000, one style per
 * axis); tooltips / labels get { axis: false }. A formatter that throws or returns nothing falls back to fallback().
 */
const VCTX = Object.freeze({ axis: false });
function safeFmt(fn, v, fallback, ctx) {
  if (typeof fn === 'function') {
    try {
      const out = ctx === undefined ? fn(v) : fn(v, ctx);
      if (out !== undefined && out !== null) return String(out);
    } catch {
      /* fall through */
    }
  }
  return fallback(v);
}

/** Tick formatter for a scale: one consistent style per axis (all compact or none). */
function tickFormatter(fn, sc, { sign = false } = {}) {
  const compact = Math.max(Math.abs(sc.min), Math.abs(sc.max)) >= 10000;
  const ctx = { axis: true, compact, step: sc.step };
  return (v) => safeFmt(fn, v, (x) => fmtNum(x, { step: sc.step, compact, sign }), ctx);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const WEEK_RE = /^(\d{4})-W(\d{1,2})$/;
const pad2 = (n) => String(n).padStart(2, '0');

function keyToDate(k) {
  const m = DATE_RE.exec(k);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}
function dayNum(k) {
  const m = DATE_RE.exec(k);
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5);
}
function keyFromNum(n) {
  const d = new Date(n * 864e5);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
const weekdayOfNum = (n) => (((n + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const isTimeKey = (x) => DATE_RE.test(x) || MONTH_RE.test(x) || WEEK_RE.test(x);

/** Short axis label: '24 Nov' (locale order), 'Nov', 'W48', or the label itself. */
function fmtXShort(x, multiYear) {
  const s = String(x);
  if (DATE_RE.test(s)) return df({ day: 'numeric', month: 'short' }).format(keyToDate(s));
  if (MONTH_RE.test(s)) {
    const [y, m] = s.split('-');
    return df(multiYear ? { month: 'short', year: '2-digit' } : { month: 'short' }).format(new Date(+y, +m - 1, 1));
  }
  if (WEEK_RE.test(s)) return 'W' + Number(WEEK_RE.exec(s)[2]);
  return s;
}

/** Long tooltip title: 'Mon, 24 Nov' (+ year when not this year), 'November 2026', 'Week 48'. */
function fmtXLong(x) {
  const s = String(x);
  const thisYear = new Date().getFullYear();
  if (DATE_RE.test(s)) {
    const d = keyToDate(s);
    const o = { weekday: 'short', day: 'numeric', month: 'short' };
    if (d.getFullYear() !== thisYear) o.year = 'numeric';
    return df(o).format(d);
  }
  if (MONTH_RE.test(s)) {
    const [y, m] = s.split('-');
    return df({ month: 'long', year: 'numeric' }).format(new Date(+y, +m - 1, 1));
  }
  if (WEEK_RE.test(s)) {
    const [, y, w] = WEEK_RE.exec(s);
    return `Week ${Number(w)}${Number(y) !== thisYear ? `, ${y}` : ''}`;
  }
  return s;
}

function fmtPct(fr) {
  if (!isNum(fr)) return '—';
  if (fr > 0 && fr < 0.005) return '<1%';
  return nf({ style: 'percent', maximumFractionDigits: fr < 0.1 ? 1 : 0 }).format(fr);
}

/* --------------------------------------------------------------------------------------- measurement */

let mctx = null;
let mfont = null;
function textWidth(str, size = 11, weight = 400) {
  const s = String(str ?? '');
  try {
    if (!mctx) mctx = document.createElement('canvas').getContext('2d');
    if (!mfont) {
      const ff = getComputedStyle(document.body || document.documentElement).fontFamily;
      mfont = ff || 'system-ui, sans-serif';
    }
  } catch {
    /* ignore */
  }
  if (!mctx) return s.length * size * 0.58;
  mctx.font = `${weight} ${size}px ${mfont}`;
  return mctx.measureText(s).width;
}

function truncate(str, maxW, size = 12, weight = 400) {
  const s = String(str ?? '');
  if (textWidth(s, size, weight) <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(s.slice(0, mid) + '…', size, weight) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo).trimEnd() + '…' : '…';
}

/* -------------------------------------------------------------------------------------------- scales */

function niceStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** Nice 1-2-5 ticks covering [min, max]. → { min, max, step, ticks } */
export function niceTicks(lo, hi, count = 5, { integer = false } = {}) {
  if (!isNum(lo) || !isNum(hi)) {
    lo = 0;
    hi = 1;
  }
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else {
      const p = Math.abs(lo) * 0.1 || 1;
      if (lo > 0) {
        lo = Math.max(0, lo - p);
        hi += p;
      } else {
        hi = Math.min(0, hi + p);
        lo -= p;
      }
    }
  }
  let step = niceStep((hi - lo) / Math.max(1, count));
  if (integer) step = Math.max(1, Math.round(step));
  const i0 = Math.floor(lo / step + 1e-9);
  const i1 = Math.max(i0 + 1, Math.ceil(hi / step - 1e-9));
  const dec = clamp(Math.ceil(-Math.log10(step) - 1e-9), 0, 12);
  const ticks = [];
  for (let i = i0; i <= i1 && ticks.length < 40; i++) ticks.push(+(i * step).toFixed(dec));
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
}

const tickCount = (plotH) => clamp(Math.round(plotH / 46), 2, 6);

/* --------------------------------------------------------------------------------------- path helpers */

function pathLinear(P) {
  return P.map((p, i) => `${i ? 'L' : 'M'}${f1(p.x)},${f1(p.y)}`).join('');
}

// Monotone cubic interpolation in x (Steffen 1990, as d3.curveMonotoneX): smooth, never overshoots the data.
function pathMonotone(P) {
  const n = P.length;
  if (n < 3) return pathLinear(P);
  const sgn = (v) => (v < 0 ? -1 : 1);
  const t = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const h0 = P[i].x - P[i - 1].x;
    const h1 = P[i + 1].x - P[i].x;
    const s0 = h0 ? (P[i].y - P[i - 1].y) / h0 : 0;
    const s1 = h1 ? (P[i + 1].y - P[i].y) / h1 : 0;
    const p = h0 + h1 ? (s0 * h1 + s1 * h0) / (h0 + h1) : 0;
    t[i] = (sgn(s0) + sgn(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  const ha = P[1].x - P[0].x;
  t[0] = ha ? (3 * (P[1].y - P[0].y)) / ha / 2 - t[1] / 2 : t[1];
  const hb = P[n - 1].x - P[n - 2].x;
  t[n - 1] = hb ? (3 * (P[n - 1].y - P[n - 2].y)) / hb / 2 - t[n - 2] / 2 : t[n - 2];
  let d = `M${f1(P[0].x)},${f1(P[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (P[i + 1].x - P[i].x) / 3;
    d +=
      `C${f1(P[i].x + dx)},${f1(P[i].y + dx * t[i])},` +
      `${f1(P[i + 1].x - dx)},${f1(P[i + 1].y - dx * t[i + 1])},${f1(P[i + 1].x)},${f1(P[i + 1].y)}`;
  }
  return d;
}

/** Bar with a 4px rounded data-end and a square base. end: 'top' | 'bottom' | 'right' | 'left'. */
function barPath(x, y, w, h, end, r = 4) {
  if (!(w > 0) || !(h > 0)) return '';
  r = Math.max(0, Math.min(r, w / 2, h / 2, end === 'top' || end === 'bottom' ? h : w));
  if (end === 'left' || end === 'right') r = Math.min(r, w, h / 2);
  else r = Math.min(r, w / 2, h);
  const [X, Y, W, H, R] = [x, y, w, h, r].map(f1);
  const a = `A${R},${R} 0 0 1`;
  switch (end) {
    case 'bottom':
      return `M${X},${Y}H${f1(X + W)}V${f1(Y + H - R)}${a} ${f1(X + W - R)},${f1(Y + H)}H${f1(X + R)}${a} ${X},${f1(Y + H - R)}Z`;
    case 'right':
      return `M${X},${Y}H${f1(X + W - R)}${a} ${f1(X + W)},${f1(Y + R)}V${f1(Y + H - R)}${a} ${f1(X + W - R)},${f1(Y + H)}H${X}Z`;
    case 'left':
      return `M${f1(X + W)},${Y}V${f1(Y + H)}H${f1(X + R)}${a} ${X},${f1(Y + H - R)}V${f1(Y + R)}${a} ${f1(X + R)},${Y}Z`;
    case 'none':
      return `M${X},${Y}H${f1(X + W)}V${f1(Y + H)}H${X}Z`;
    default:
      return `M${X},${f1(Y + H)}V${f1(Y + R)}${a} ${f1(X + R)},${Y}H${f1(X + W - R)}${a} ${f1(X + W)},${f1(Y + R)}V${f1(Y + H)}Z`;
  }
}

/** Label thinning: keeps the last label and every label at least (widest + gap) away from the next kept one. */
function thin(items, size = 11, gap = 12) {
  const keep = new Array(items.length).fill(false);
  if (!items.length) return keep;
  const maxW = Math.max(...items.map((it) => textWidth(it.text, size)));
  let last = Infinity;
  for (let i = items.length - 1; i >= 0; i--) {
    if (last - items[i].x >= maxW + gap) {
      keep[i] = true;
      last = items[i].x;
    }
  }
  return keep;
}

/* -------------------------------------------------------------------------------- shared DOM pieces */

function emptyBlock(height, text) {
  const el = htmlEl('div', 'chart-empty');
  el.style.minHeight = `${Math.max(72, Math.round(height))}px`;
  const art = svgEl('svg', { viewBox: '0 0 48 32', width: 48, height: 32, class: 'chart-empty-art', 'aria-hidden': 'true', focusable: 'false' });
  [
    [5, 12],
    [16, 20],
    [27, 8],
    [38, 16],
  ].forEach(([x, h]) => art.append(svgEl('rect', { x, y: 28 - h, width: 7, height: h, rx: 2 })));
  art.append(svgEl('path', { d: 'M1 28.5H47', class: 'chart-empty-base' }));
  el.append(art, htmlEl('div', 'chart-empty-text', text || 'No data yet'));
  return el;
}

/** Legend row: items [{label, color, value}], shape 'rect' | 'line' | 'dot'. */
export function legend(items, { shape = 'rect' } = {}) {
  const el = htmlEl('div', 'chart-legend');
  (Array.isArray(items) ? items : []).forEach((it, i) => {
    if (!it) return;
    const item = htmlEl('span', 'chart-legend-item');
    const sw = htmlEl('i', 'chart-legend-swatch');
    sw.dataset.shape = it.shape || shape;
    sw.style.setProperty('--sw', cssColor(it.color, i));
    item.append(sw, htmlEl('span', 'chart-legend-label', it.label ?? ''));
    if (it.value !== undefined && it.value !== null && it.value !== '') item.append(htmlEl('span', 'chart-legend-value', it.value));
    el.append(item);
  });
  return el;
}

function srTable(caption, headers, rows) {
  const t = htmlEl('table', 'chart-sr');
  t.append(htmlEl('caption', null, caption));
  const thead = htmlEl('thead');
  const tr = htmlEl('tr');
  headers.forEach((h) => tr.append(htmlEl('th', null, h)));
  thead.append(tr);
  const tb = htmlEl('tbody');
  rows.slice(-100).forEach((r) => {
    const row = htmlEl('tr');
    r.forEach((c, i) => row.append(htmlEl(i ? 'td' : 'th', null, c)));
    tb.append(row);
  });
  t.append(thead, tb);
  return t;
}

function makeSvg(W, H, cls = '') {
  return svgEl('svg', {
    class: `chart-svg ${cls}`.trim(),
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    'aria-hidden': 'true',
    focusable: 'false',
  });
}

function svgToClient(svg, W, x, y) {
  const r = svg.getBoundingClientRect();
  const k = r.width ? r.width / W : 1;
  return { x: r.left + x * k, y: r.top + y * k };
}
function clientToSvg(svg, W, cx, cy) {
  const r = svg.getBoundingClientRect();
  const k = r.width ? W / r.width : 1;
  return { x: (cx - r.left) * k, y: (cy - r.top) * k };
}

/* ------------------------------------------------------------------------------- tooltip + chart base */

let touchActive = null; // the chart whose tooltip was opened by touch
let docHooked = false;
function hookTouchDismiss() {
  if (docHooked || typeof document === 'undefined') return;
  docHooked = true;
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (touchActive && !touchActive.root.contains(e.target)) {
        const c = touchActive;
        touchActive = null;
        c.hide();
      }
    },
    { capture: true, passive: true },
  );
}

function fillTip(tip, c) {
  tip.textContent = '';
  if (c.title) tip.append(htmlEl('div', 'chart-tooltip-title', c.title));
  if (c.rows && c.rows.length) {
    const list = htmlEl('div', 'chart-tooltip-rows');
    for (const r of c.rows) {
      const row = htmlEl('div', 'chart-tooltip-row' + (r.total ? ' is-total' : ''));
      const key = htmlEl('i', 'chart-tooltip-key');
      key.dataset.shape = r.shape || 'line';
      if (r.color) key.style.setProperty('--key', r.color);
      else key.dataset.shape = 'none';
      row.append(key, htmlEl('span', 'chart-tooltip-value', r.value));
      if (r.label) row.append(htmlEl('span', 'chart-tooltip-label', r.label));
      list.append(row);
    }
    tip.append(list);
  }
  for (const n of [].concat(c.note || [])) if (n) tip.append(htmlEl('div', 'chart-tooltip-note', n));
  if (c.hint) tip.append(htmlEl('div', 'chart-tooltip-hint', c.hint));
}

function tipText(c) {
  const parts = [];
  if (c.title) parts.push(c.title);
  for (const r of c.rows || []) parts.push([r.label, r.value].filter(Boolean).join(' '));
  for (const n of [].concat(c.note || [])) if (n) parts.push(n);
  return parts.join(', ');
}

function guessWidth() {
  try {
    return clamp((window.innerWidth || 800) - 64, 260, 720);
  } catch {
    return 600;
  }
}

/**
 * Chart scaffold: wrapper, tooltip, live region, responsive re-render, pointer/touch/keyboard interaction.
 * draw(ctx) renders into ctx.body and returns an interaction model (or null):
 *   { count, label, initial, pick(clientX, clientY, target) → index|null, show(i, info) → tooltip content|null,
 *     clear(), activate?(i), navigate?(i, key) → index|null }
 */
function createChart(kind, opts, draw, { responsive = true } = {}) {
  const root = htmlEl('div', `chart chart-${kind}`);
  if (typeof opts.class === 'string' && opts.class) root.className += ' ' + opts.class;
  root.setAttribute('role', 'figure');
  const body = htmlEl('div', 'chart-body');
  const tip = htmlEl('div', 'chart-tooltip');
  tip.setAttribute('aria-hidden', 'true');
  const live = htmlEl('div', 'chart-sr');
  live.setAttribute('aria-live', 'polite');
  root.append(body, tip, live);

  const st = { opts: { ...opts }, width: 0, model: null, active: null, visible: false, pointer: 'mouse', prevTap: null, measured: false, timer: 0 };

  const api = { root, hide };

  function hide() {
    if (st.visible) tip.classList.remove('is-visible');
    st.visible = false;
    st.active = null;
    if (touchActive === api) touchActive = null;
    try {
      st.model && st.model.clear && st.model.clear();
    } catch {
      /* ignore */
    }
  }

  function render(width, animate) {
    hide();
    st.width = width;
    body.textContent = '';
    root.classList.toggle('chart-anim', !!animate && !reducedMotion());
    let model = null;
    try {
      model = draw({ root, body, width, opts: st.opts }) || null;
    } catch (err) {
      console.warn('[daybook] chart render failed:', err);
      body.textContent = '';
      body.append(emptyBlock(toNum(st.opts.height) || 160, 'Chart unavailable'));
      model = null;
    }
    st.model = model;
    const label = (model && model.label) || `${st.opts.ariaLabel || st.opts.title || 'Chart'}: no data yet`;
    root.setAttribute('aria-label', label);
    if (model && model.count > 0) root.tabIndex = 0;
    else root.removeAttribute('tabindex');
  }

  function place(c, touch) {
    const anchor = c.anchor || { x: 0, y: 0 };
    const rr = root.getBoundingClientRect();
    const ax = anchor.x - rr.left;
    const ay = anchor.y - rr.top;
    const rw = root.clientWidth;
    const rh = root.clientHeight;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const off = touch ? 22 : 12;
    const cx = (v) => Math.max(0, Math.min(v, rw - tw));
    const cy = (v) => Math.max(0, Math.min(v, rh - th));
    let x;
    let y;
    if (c.placement === 'above' && ay - th - off >= 0) {
      x = cx(ax - tw / 2);
      y = ay - th - off;
    } else {
      x = ax + off;
      if (x + tw > rw) x = ax - off - tw;
      if (x < 0) x = cx(ax - tw / 2);
      y = cy(ay - th / 2);
    }
    const wasVisible = st.visible;
    if (!wasVisible) tip.style.transition = 'none';
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (!wasVisible) {
      void tip.offsetWidth;
      tip.style.transition = '';
    }
  }

  function setActive(i, via) {
    const m = st.model;
    if (!m || i === null || i === undefined || i < 0 || i >= m.count) return;
    if (st.active === i && st.visible && via !== 'key') return;
    st.active = i;
    let c = null;
    try {
      c = m.show(i, { via, touch: st.pointer !== 'mouse' && via !== 'key' });
    } catch (err) {
      console.warn('[daybook] chart tooltip failed:', err);
    }
    if (via === 'key' && c) live.textContent = c.announce || tipText(c);
    if (!c || c.tip === false) {
      if (st.visible) tip.classList.remove('is-visible');
      st.visible = false;
      return;
    }
    if (via !== 'key' && st.pointer !== 'mouse' && m.activate && !c.hint) c.hint = 'Tap again to open';
    fillTip(tip, c);
    place(c, via !== 'key' && st.pointer !== 'mouse');
    tip.classList.add('is-visible');
    st.visible = true;
  }

  const pick = (e) => {
    const m = st.model;
    if (!m || !m.pick || !m.count) return null;
    try {
      return m.pick(e.clientX, e.clientY, e.target);
    } catch {
      return null;
    }
  };

  body.addEventListener('pointermove', (e) => {
    st.pointer = e.pointerType || 'mouse';
    const i = pick(e);
    if (i === null || i === undefined) {
      if (st.pointer === 'mouse') hide();
      return;
    }
    setActive(i, 'pointer');
  });
  body.addEventListener('pointerdown', (e) => {
    st.pointer = e.pointerType || 'mouse';
    st.prevTap = st.active; // the mark already previewed (tooltip or donut centre readout)
    if (st.pointer === 'mouse') return;
    const i = pick(e);
    if (i === null || i === undefined) return hide();
    setActive(i, 'pointer');
    touchActive = api;
    hookTouchDismiss();
  });
  body.addEventListener('pointerleave', (e) => {
    if ((e.pointerType || 'mouse') === 'mouse') hide();
  });
  body.addEventListener('pointercancel', () => hide());
  body.addEventListener('click', (e) => {
    const m = st.model;
    if (!m || !m.activate) return;
    const i = pick(e);
    if (i === null || i === undefined) return;
    if (st.pointer !== 'mouse' && st.prevTap !== i) return; // first tap previews
    try {
      m.activate(i);
    } catch (err) {
      console.warn('[daybook] chart onClick failed:', err);
    }
  });

  root.addEventListener('keydown', (e) => {
    const m = st.model;
    if (!m || !m.count || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    const cur = st.active ?? (m.initial ?? m.count - 1);
    let next = null;
    if (k === 'Escape') {
      if (st.active !== null) {
        hide();
        e.preventDefault();
      }
      return;
    }
    if ((k === 'Enter' || k === ' ') && m.activate && st.active !== null) {
      e.preventDefault();
      m.activate(st.active);
      return;
    }
    if (k === 'Home') next = 0;
    else if (k === 'End') next = m.count - 1;
    else if (m.navigate) next = st.active === null && k.startsWith('Arrow') ? cur : m.navigate(cur, k);
    else if (k === 'ArrowRight' || k === 'ArrowDown') next = st.active === null ? cur : Math.min(m.count - 1, cur + 1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp') next = st.active === null ? cur : Math.max(0, cur - 1);
    if (next !== null && next !== undefined) {
      e.preventDefault();
      st.pointer = 'key';
      setActive(clamp(next, 0, m.count - 1), 'key');
    }
  });
  root.addEventListener('focus', () => {
    let fv = false;
    try {
      fv = root.matches(':focus-visible');
    } catch {
      /* ignore */
    }
    const m = st.model;
    if (fv && m && m.count) {
      st.pointer = 'key';
      setActive(st.active ?? (m.initial ?? m.count - 1), 'key');
    }
  });
  root.addEventListener('blur', () => hide());

  if (responsive && typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[entries.length - 1].contentRect.width);
      if (w <= 0) return;
      if (!st.measured) {
        st.measured = true;
        if (w !== st.width) render(w, true);
        return;
      }
      if (Math.abs(w - st.width) < 1) return;
      clearTimeout(st.timer);
      st.timer = setTimeout(() => render(w, false), 90);
    });
    ro.observe(root);
  }

  root.update = (patch = {}) => {
    st.opts = { ...st.opts, ...(patch || {}) };
    render(st.width || guessWidth(), false);
    return root;
  };

  render(Math.floor(toNum(opts.width) || 0) || guessWidth(), true);
  return root;
}

/* ---------------------------------------------------------------------------------- shared axis bits */

function drawYGrid(g, sc, yPos, x1, x2, labels) {
  const zi = sc.ticks.indexOf(0);
  const axisAt = zi >= 0 ? zi : 0; // the baseline sits at zero when zero is on the axis
  sc.ticks.forEach((t, i) => {
    const y = crisp(yPos(t));
    g.append(svgEl('line', { x1, x2, y1: y, y2: y, class: i === axisAt ? 'chart-axis-line' : 'chart-grid-line' }));
    g.append(svgEl('text', { x: x1 - 8, y, dy: '0.32em', 'text-anchor': 'end', class: 'chart-tick' }, labels[i]));
  });
}

function drawXLabels(g, items, y, W) {
  const keep = thin(items);
  items.forEach((it, i) => {
    if (!keep[i]) return;
    const w = textWidth(it.text, 11);
    const x = clamp(it.x, w / 2 + 1, W - w / 2 - 1);
    g.append(svgEl('text', { x: f1(x), y, 'text-anchor': 'middle', class: 'chart-tick chart-tick-x' }, it.text));
  });
}

/**
 * Dashed target line + label. The label tries right-above, right-below, left-above, left-below and takes the
 * first spot that overlaps the fewest marks (obstacles: [{x1,x2,y1,y2}] in SVG units), so it rarely sits on data.
 */
function drawTarget(g, o, yPos, x1, x2, top, fmt, obstacles = [], bottom = Infinity) {
  const tv = toNum(o.target);
  if (tv === null) return;
  const y = crisp(yPos(tv));
  g.append(svgEl('line', { x1, x2, y1: y, y2: y, class: 'chart-target' }));
  if (o.targetLabel === false) return;
  const text = typeof o.targetLabel === 'string' ? o.targetLabel : `Target ${fmt(tv)}`;
  const lw = textWidth(text, 11, 600) + 6;
  // Preferred spots first (right/left end, above/below), then positions sliding along the line.
  const spots = [
    { x: x2, anchor: 'end', by: y - 6 },
    { x: x2, anchor: 'end', by: y + 15 },
    { x: x1 + 4, anchor: 'start', by: y - 6 },
    { x: x1 + 4, anchor: 'start', by: y + 15 },
  ];
  const span = x2 - x1 - 4 - lw;
  for (let k = 1; k < 8 && span > 0; k++) {
    const sx = x1 + 4 + (span * k) / 8;
    spots.push({ x: sx, anchor: 'start', by: y - 6 }, { x: sx, anchor: 'start', by: y + 15 });
  }
  let best = null;
  let bestHits = Infinity;
  for (const s of spots.filter((sp) => sp.by - 11 >= top - 10 && sp.by + 3 <= bottom)) {
    const bx1 = s.anchor === 'end' ? s.x - lw : s.x - 3;
    const bx2 = bx1 + lw;
    const by1 = s.by - 11;
    const by2 = s.by + 3;
    // Overlapped area (px²); text obstacles weigh 4×, so grazing a mark beats covering another label.
    let hits = 0;
    for (const r of obstacles) {
      const ox = Math.min(r.x2, bx2) - Math.max(r.x1, bx1);
      const oy = Math.min(r.y2, by2) - Math.max(r.y1, by1);
      if (ox > 0 && oy > 0) hits += ox * oy * (r.text ? 4 : 1);
    }
    if (hits < bestHits) (best = s), (bestHits = hits);
    if (!hits) break;
  }
  if (!best) best = { x: x2, anchor: 'end', by: y - 6 < top ? y + 15 : y - 6 };
  g.append(svgEl('text', { x: best.x, y: f1(best.by), 'text-anchor': best.anchor, class: 'chart-target-label' }, text));
}

/** Obstacle boxes for a polyline (each segment's bounding box; monotone curves stay inside it). */
function lineObstacles(P, pad = 3) {
  if (P.length === 1) return [{ x1: P[0].x - 6, x2: P[0].x + 6, y1: P[0].y - 6, y2: P[0].y + 6 }];
  const out = [];
  const K = 4; // split long segments so a diagonal doesn't claim its whole bounding box
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1];
    const b = P[i];
    for (let k = 0; k < K; k++) {
      const ax = a.x + ((b.x - a.x) * k) / K;
      const bx = a.x + ((b.x - a.x) * (k + 1)) / K;
      const ay = a.y + ((b.y - a.y) * k) / K;
      const by = a.y + ((b.y - a.y) * (k + 1)) / K;
      out.push({ x1: Math.min(ax, bx) - pad, x2: Math.max(ax, bx) + pad, y1: Math.min(ay, by) - pad, y2: Math.max(ay, by) + pad });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ lineChart */

/**
 * lineChart({ series:[{name, color, points:[{x, y}]}], height=220, area=false, yFormat, xFormat, zeroLine=false,
 *             target, showDots='auto', curve=true, legend=true, targetLabel, tooltipTitle, emptyText, ariaLabel })
 */
export function lineChart(opts = {}) {
  return createChart('line', opts || {}, drawLine);
}

function normSeries(series) {
  if (!Array.isArray(series)) return [];
  return series
    .filter((s) => s && typeof s === 'object')
    .map((s, i) => {
      const map = new Map();
      for (const p of Array.isArray(s.points) ? s.points : []) {
        if (!p || p.x === null || p.x === undefined || p.x === '') continue;
        const y = toNum(p.y);
        if (y === null) continue;
        map.set(String(p.x), y);
      }
      return { name: s.name === null || s.name === undefined ? '' : String(s.name), color: cssColor(s.color, i), map, i };
    });
}

function drawLine({ body, width: W, opts: o }) {
  const H = Math.max(100, toNum(o.height) || 220);
  const series = normSeries(o.series);
  const title = o.ariaLabel || o.title || (series.length === 1 && series[0].name) || 'Line chart';
  if (!series.some((s) => s.map.size)) {
    body.append(emptyBlock(H, o.emptyText));
    return null;
  }

  // x domain: true time scale for date keys, otherwise ordinal (union, first-seen order; time-like keys sorted)
  const seen = [];
  const seenSet = new Set();
  for (const s of series) for (const k of s.map.keys()) if (!seenSet.has(k)) seenSet.add(k), seen.push(k);
  const isTime = seen.every((k) => DATE_RE.test(k));
  let keys = seen;
  if (isTime) keys = [...seen].sort((a, b) => dayNum(a) - dayNum(b));
  else if (seen.every((k) => MONTH_RE.test(k)) || seen.every((k) => WEEK_RE.test(k))) keys = [...seen].sort();
  const n = keys.length;
  const multiYear = isTimeKey(keys[0]) && keys[0].slice(0, 4) !== keys[n - 1].slice(0, 4);

  if (series.length > 1 && o.legend !== false) {
    body.append(legend(series.map((s) => ({ label: s.name, color: s.color })), { shape: 'line' }));
  }

  // y domain
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) for (const v of s.map.values()) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  const tv = toNum(o.target);
  if (tv !== null) (lo = Math.min(lo, tv)), (hi = Math.max(hi, tv));
  if (o.zeroLine) (lo = Math.min(lo, 0)), (hi = Math.max(hi, 0));
  const m = { t: 14, r: 14, b: 28, l: 0 };
  const sc = niceTicks(lo, hi, tickCount(H - m.t - m.b), { integer: !!o.integer });
  const fmtTick = tickFormatter(o.yFormat, sc);
  const fmtVal = (v) => safeFmt(o.tooltipFormat || o.yFormat, v, (x) => fmtNum(x), VCTX);
  const tickLabels = sc.ticks.map(fmtTick);
  m.l = Math.ceil(Math.max(...tickLabels.map((t) => textWidth(t, 11)))) + 12;
  const pw = Math.max(20, W - m.l - m.r);
  const ph = H - m.t - m.b;
  const yPos = (v) => m.t + ph * (1 - (v - sc.min) / (sc.max - sc.min || 1));
  const inset = n > 1 ? 6 : 0;
  const t0 = isTime ? dayNum(keys[0]) : 0;
  const t1 = isTime ? dayNum(keys[n - 1]) : n - 1;
  const xOf = (k, i) => {
    const t = isTime ? dayNum(k) : i;
    return m.l + inset + (pw - 2 * inset) * (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0));
  };
  const xs = keys.map((k, i) => xOf(k, i));
  const xFmt = (k) => safeFmt(o.xFormat, k, (x) => fmtXShort(x, multiYear));

  const svg = makeSvg(W, H);
  const defs = svgEl('defs');
  svg.append(defs);
  const gGrid = svgEl('g', { class: 'chart-grid' });
  drawYGrid(gGrid, sc, yPos, m.l, W - m.r, tickLabels);
  drawXLabels(gGrid, keys.map((k, i) => ({ x: xs[i], text: xFmt(k) })), H - 8, W);
  svg.append(gGrid);

  const gRef = svgEl('g', { class: 'chart-ref' });
  if (o.zeroLine && sc.min < 0 && sc.max > 0) {
    const y0 = crisp(yPos(0));
    gRef.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: y0, y2: y0, class: 'chart-zero' }));
  }
  svg.append(gRef);

  const gArea = svgEl('g');
  const gLines = svgEl('g');
  const gDots = svgEl('g');
  svg.append(gArea, gLines, gDots);
  const baseV = clamp(0, sc.min, sc.max);
  const yBase = yPos(baseV);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const drawn = [];

  series.forEach((s, si) => {
    const P = [...s.map.entries()]
      .map(([k, v]) => ({ k, v, i: idx.get(k), x: xs[idx.get(k)], y: yPos(v) }))
      .sort((a, b) => a.i - b.i);
    drawn.push(P);
    if (!P.length) return;
    const d = o.curve === false ? pathLinear(P) : pathMonotone(P);
    if (o.area && P.length > 1) {
      const gid = uid('cg');
      const grad = svgEl('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
      const peak = series.length > 1 ? 0.14 : 0.2;
      grad.append(
        svgEl('stop', { offset: '0%', style: { 'stop-color': s.color, 'stop-opacity': peak } }),
        svgEl('stop', { offset: '100%', style: { 'stop-color': s.color, 'stop-opacity': 0.015 } }),
      );
      defs.append(grad);
      const ad = `${d}L${f1(P[P.length - 1].x)},${f1(yBase)}L${f1(P[0].x)},${f1(yBase)}Z`;
      gArea.append(svgEl('path', { d: ad, class: 'chart-area', style: { fill: `url(#${gid})` } }));
    }
    if (P.length > 1) {
      gLines.append(svgEl('path', { d, pathLength: 1, class: 'chart-line', style: { stroke: s.color, '--i': si } }));
    }
    const dotsMode = o.showDots === undefined ? 'auto' : o.showDots;
    const allDots = dotsMode === true || (dotsMode === 'auto' && P.length <= 14 && pw / Math.max(1, n) >= 20);
    if (dotsMode !== false || P.length === 1) {
      P.forEach((p, j) => {
        if (!allDots && j !== P.length - 1) return;
        gDots.append(svgEl('circle', { cx: f1(p.x), cy: f1(p.y), r: 4, class: 'chart-dot', style: { fill: s.color } }));
      });
    }
  });

  drawTarget(gRef, o, yPos, m.l, W - m.r, m.t, fmtVal, drawn.flatMap((P) => lineObstacles(P)), H - m.b);

  // crosshair + active dots
  const gX = svgEl('g', { class: 'chart-crosshair' });
  const xl = svgEl('line', { y1: m.t - 4, y2: H - m.b, class: 'chart-crosshair-line' });
  gX.append(xl);
  const act = series.map((s) => {
    const c = svgEl('circle', { r: 4.5, class: 'chart-dot chart-dot-active', style: { fill: s.color } });
    gX.append(c);
    return c;
  });
  svg.append(gX);
  body.append(svg);

  // accessibility
  const flat = series.length === 1 ? drawn[0] : null;
  let label = `${title}. ${n} point${n === 1 ? '' : 's'}`;
  if (n > 1) label += `, ${xFmt(keys[0])} to ${xFmt(keys[n - 1])}`;
  if (flat && flat.length) {
    const vs = flat.map((p) => p.v);
    label += `. Latest ${fmtVal(vs[vs.length - 1])}, high ${fmtVal(Math.max(...vs))}, low ${fmtVal(Math.min(...vs))}`;
  } else label += `. Series: ${series.map((s) => s.name).filter(Boolean).join(', ')}`;
  if (tv !== null) label += `. Target ${fmtVal(tv)}`;
  body.append(
    srTable(title, ['', ...series.map((s, i) => s.name || `Series ${i + 1}`)], keys.map((k) => [fmtXLong(k), ...series.map((s) => (s.map.has(k) ? fmtVal(s.map.get(k)) : '—'))])),
  );

  return {
    count: n,
    label,
    initial: n - 1,
    pick(cx, cy) {
      const p = clientToSvg(svg, W, cx, cy);
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const dd = Math.abs(xs[i] - p.x);
        if (dd < bd) (bd = dd), (best = i);
      }
      return best;
    },
    show(i) {
      const k = keys[i];
      const x = f1(xs[i]);
      xl.setAttribute('x1', x);
      xl.setAttribute('x2', x);
      let top = Infinity;
      const rows = [];
      series.forEach((s, si) => {
        const v = s.map.get(k);
        if (v === undefined) {
          act[si].style.display = 'none';
          return;
        }
        const y = yPos(v);
        top = Math.min(top, y);
        act[si].style.display = '';
        act[si].setAttribute('cx', x);
        act[si].setAttribute('cy', f1(y));
        rows.push({ color: s.color, value: fmtVal(v), label: series.length > 1 || o.showName ? s.name : '', shape: 'line' });
      });
      svg.classList.add('has-active');
      const ttl = typeof o.tooltipTitle === 'function' ? safeFmt(o.tooltipTitle, k, String) : isTimeKey(k) ? fmtXLong(k) : xFmt(k);
      if (!rows.length) rows.push({ value: 'No data', label: '' });
      return {
        title: ttl,
        rows,
        note: tv !== null ? (typeof o.targetLabel === 'string' ? o.targetLabel : `Target ${fmtVal(tv)}`) : null,
        anchor: svgToClient(svg, W, xs[i], Number.isFinite(top) ? top : m.t + ph / 2),
        placement: 'side',
      };
    },
    clear() {
      svg.classList.remove('has-active');
    },
  };
}

/* ------------------------------------------------------------------------------------------- barChart */

/**
 * barChart({ data:[{label, value, color, tooltip}], height=220, yFormat, xFormat, signed=false, target,
 *            horizontal=false, maxBars, onClick(datum), color, valueLabels='auto', emptyText, ariaLabel })
 */
export function barChart(opts = {}) {
  const o = opts || {};
  return createChart(o.horizontal ? 'bar chart-bar-h' : 'bar', o, o.horizontal ? drawBarsH : drawBarsV);
}

function normBars(data, maxBars) {
  let arr = (Array.isArray(data) ? data : []).filter((d) => d && typeof d === 'object');
  const mb = toNum(maxBars);
  if (mb !== null && mb > 0) arr = arr.slice(0, Math.floor(mb));
  return arr.map((d) => ({
    raw: d,
    label: d.label === null || d.label === undefined ? '' : String(d.label),
    value: toNum(d.value !== undefined ? d.value : d.count),
    color: d.color,
    tooltip: d.tooltip,
  }));
}

function barColor(d, o, v) {
  if (d.color) return cssColor(d.color, 0);
  if (o.signed) return v < 0 ? 'var(--_loss)' : 'var(--_profit)';
  return cssColor(o.color, 0);
}

function noteOf(t) {
  if (t === null || t === undefined || t === '') return null;
  return Array.isArray(t) ? t.map(String) : String(t);
}

function drawBarsV({ body, width: W, opts: o }, mode = 'bar') {
  const H = Math.max(100, toNum(o.height) || (mode === 'hist' ? 200 : 220));
  const data = normBars(o.data, o.maxBars);
  const n = data.length;
  const title = o.ariaLabel || o.title || (mode === 'hist' ? 'Histogram' : 'Bar chart');
  const vals = data.map((d) => d.value).filter(isNum);
  if (!n || !vals.length) {
    body.append(emptyBlock(H, o.emptyText));
    return null;
  }
  const signed = !!o.signed;
  const tv = toNum(o.target);
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  if (tv !== null) (lo = Math.min(lo, tv)), (hi = Math.max(hi, tv));
  const fmtDefault = (v, step) => fmtNum(v, { step, sign: signed && !step });
  const fmtVal = (v) => safeFmt(o.tooltipFormat || o.yFormat || o.valueFormat, v, (x) => fmtDefault(x), VCTX);
  const total = vals.reduce((a, b) => a + b, 0);
  const allInt = vals.every((v) => Number.isInteger(v));
  const m = { t: 14, r: 10, b: 28, l: 0 };

  // decide on cap labels before the scale (they need headroom)
  const capFmt = data.map((d) => (isNum(d.value) ? fmtVal(d.value) : ''));
  const sc0 = niceTicks(lo, hi, tickCount(H - m.t - m.b), { integer: mode === 'hist' || (allInt && hi - lo <= 8) });
  const fmtTick = tickFormatter(o.yFormat || o.valueFormat, sc0);
  const tickLabels = sc0.ticks.map(fmtTick);
  m.l = Math.ceil(Math.max(...tickLabels.map((t) => textWidth(t, 11)))) + 12;
  const pw = Math.max(20, W - m.l - m.r);
  const band = pw / n;
  const vl = o.valueLabels === undefined ? 'auto' : o.valueLabels;
  const caps = vl === true || (vl === 'auto' && mode !== 'hist' && n <= 8 && capFmt.every((t) => textWidth(t, 11, 600) <= band - 4));
  if (caps) m.t = 22;
  if (caps && lo < 0) m.b = 40;
  const sc = sc0;
  const ph = H - m.t - m.b;
  const yPos = (v) => m.t + ph * (1 - (v - sc.min) / (sc.max - sc.min || 1));
  const y0 = yPos(0);
  let barW;
  if (mode === 'hist') barW = Math.max(1, Math.min(band - 2, 44));
  else {
    barW = Math.min(toNum(o.barWidth) || 24, Math.max(1, band * 0.64));
    if (band - barW < 2) barW = Math.max(1, band - 2);
  }
  const multiYear = isTimeKey(data[0].label) && data[0].label.slice(0, 4) !== data[n - 1].label.slice(0, 4);
  const xFmt = (l) => safeFmt(o.xFormat, l, (x) => fmtXShort(x, multiYear));
  const cx = (i) => m.l + band * i + band / 2;

  const svg = makeSvg(W, H);
  const gGrid = svgEl('g', { class: 'chart-grid' });
  drawYGrid(gGrid, sc, yPos, m.l, W - m.r, tickLabels);
  const gHover = svgEl('g');
  const hoverBand = svgEl('rect', { class: 'chart-hover-band', y: m.t - 6, height: ph + 6, rx: 6 });
  gHover.append(hoverBand);
  svg.append(gHover, gGrid);
  drawXLabels(gGrid, data.map((d, i) => ({ x: cx(i), text: xFmt(d.label) })), H - 8, W);

  const gBars = svgEl('g', { class: 'chart-bars' });
  const els = [];
  const obstacles = [];
  data.forEach((d, i) => {
    const v = d.value;
    if (caps && isNum(v)) {
      const cw = textWidth(capFmt[i], 11, 600);
      const ly = v < 0 ? yPos(v) + 14 : yPos(v) - 7;
      obstacles.push({ x1: cx(i) - cw / 2 - 2, x2: cx(i) + cw / 2 + 2, y1: ly - 11, y2: ly + 3, text: true });
    }
    if (!isNum(v) || v === 0) {
      els.push(null);
      return;
    }
    const yv = yPos(v);
    let top = Math.min(yv, y0);
    let h = Math.abs(yv - y0);
    if (h < 1.5) {
      h = 1.5;
      if (v > 0) top = y0 - h;
    }
    const x = cx(i) - barW / 2;
    obstacles.push({ x1: x, x2: x + barW, y1: top, y2: top + h });
    const el = svgEl('path', {
      d: barPath(x, top, barW, h, v < 0 ? 'bottom' : 'top', 4),
      class: 'chart-bar' + (v < 0 ? ' is-neg' : ''),
      style: { fill: barColor(d, o, v), '--i': Math.min(i, 40) },
    });
    gBars.append(el);
    els.push(el);
  });
  svg.append(gBars);

  const gRef = svgEl('g', { class: 'chart-ref' });
  if (sc.min < 0) gRef.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: crisp(y0), y2: crisp(y0), class: 'chart-zero' }));
  drawTarget(gRef, o, yPos, m.l, W - m.r, m.t, fmtVal, obstacles, H - m.b);
  if (caps) {
    data.forEach((d, i) => {
      if (!isNum(d.value)) return;
      const yv = yPos(d.value);
      const y = d.value < 0 ? yv + 14 : yv - 7;
      gRef.append(svgEl('text', { x: f1(cx(i)), y: f1(y), 'text-anchor': 'middle', class: 'chart-value-label' }, capFmt[i]));
    });
  }
  svg.append(gRef);
  body.append(svg);

  const hi1 = data.reduce((b, d, i) => (isNum(d.value) && (b < 0 || d.value > data[b].value) ? i : b), -1);
  const lo1 = data.reduce((b, d, i) => (isNum(d.value) && (b < 0 || d.value < data[b].value) ? i : b), -1);
  let label = `${title}. ${n} ${mode === 'hist' ? 'bins' : 'bars'}`;
  if (hi1 >= 0) label += `. Highest ${xFmt(data[hi1].label)}: ${fmtVal(data[hi1].value)}`;
  if (lo1 >= 0 && lo1 !== hi1) label += `. Lowest ${xFmt(data[lo1].label)}: ${fmtVal(data[lo1].value)}`;
  if (tv !== null) label += `. Target ${fmtVal(tv)}`;
  body.append(srTable(title, ['', 'Value'], data.map((d) => [isTimeKey(d.label) ? fmtXLong(d.label) : xFmt(d.label), fmtVal(d.value)])));

  return {
    count: n,
    label,
    initial: n - 1,
    pick(cxp, cyp) {
      const p = clientToSvg(svg, W, cxp, cyp);
      if (p.x < m.l - 8 || p.x > W - m.r + 8) return null;
      return clamp(Math.floor((p.x - m.l) / band), 0, n - 1);
    },
    show(i) {
      const d = data[i];
      hoverBand.setAttribute('x', f1(m.l + band * i + Math.max(0, (band - Math.max(barW + 12, Math.min(band, 36))) / 2)));
      hoverBand.setAttribute('width', f1(Math.min(band, Math.max(barW + 12, 36))));
      svg.classList.add('has-active');
      els.forEach((el, j) => el && el.classList.toggle('is-active', j === i));
      const v = d.value;
      const rows = [{ color: isNum(v) ? barColor(d, o, v) : null, value: isNum(v) ? fmtVal(v) : 'No data', shape: 'rect' }];
      const notes = [];
      if (mode === 'hist' && isNum(v) && total > 0) rows[0].label = fmtPct(v / total);
      const tn = noteOf(d.tooltip);
      if (tn) notes.push(...[].concat(tn));
      if (tv !== null && isNum(v)) notes.push(typeof o.targetLabel === 'string' ? o.targetLabel : `Target ${fmtVal(tv)}`);
      const yv = isNum(v) ? Math.min(yPos(v), y0) : y0;
      return {
        title: isTimeKey(d.label) ? fmtXLong(d.label) : xFmt(d.label),
        rows,
        note: notes,
        anchor: svgToClient(svg, W, cx(i), yv),
        placement: 'above',
      };
    },
    clear() {
      svg.classList.remove('has-active');
      els.forEach((el) => el && el.classList.remove('is-active'));
    },
    activate: typeof o.onClick === 'function' ? (i) => o.onClick(data[i].raw) : null,
  };
}

function drawBarsH({ body, width: W, opts: o }) {
  const data = normBars(o.data, o.maxBars);
  const n = data.length;
  const title = o.ariaLabel || o.title || 'Bar chart';
  const vals = data.map((d) => d.value).filter(isNum);
  if (!n || !vals.length) {
    body.append(emptyBlock(toNum(o.height) || 160, o.emptyText));
    return null;
  }
  const signed = !!o.signed;
  const rowH = clamp(toNum(o.rowHeight) || 32, 20, 64);
  const barH = clamp(Math.round(rowH * 0.44), 6, 24);
  const pad = 4;
  const H = n * rowH + pad * 2;
  const fmtVal = (v) => safeFmt(o.tooltipFormat || o.yFormat || o.valueFormat, v, (x) => fmtNum(x, { sign: signed }), VCTX);
  const xFmt = (l) => safeFmt(o.xFormat, l, (x) => fmtXShort(x, false));
  const labels = data.map((d) => xFmt(d.label));
  const vText = data.map((d) => (isNum(d.value) ? fmtVal(d.value) : '—'));
  const labelMax = Math.min(Math.max(...labels.map((l) => textWidth(l, 12.5))), W * 0.38, 180);
  const vw = Math.max(...vText.map((t) => textWidth(t, 12, 600)));
  const hasNeg = vals.some((v) => v < 0);
  const hasPos = vals.some((v) => v > 0) || !hasNeg;
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  if (lo === hi) hi = 1;
  const xa = Math.ceil(labelMax) + 14 + (hasNeg ? vw + 8 : 0);
  const xb = W - (hasPos ? vw + 10 : 6);
  const xS = (v) => xa + Math.max(10, xb - xa) * ((v - lo) / (hi - lo));
  const x0 = xS(0);
  const cy = (i) => pad + rowH * i + rowH / 2;

  const svg = makeSvg(W, H);
  const hoverBand = svgEl('rect', { class: 'chart-hover-band', x: 0, width: W, height: rowH - 2, rx: 8 });
  svg.append(hoverBand);
  const gBars = svgEl('g', { class: 'chart-bars' });
  const gText = svgEl('g');
  const els = [];
  data.forEach((d, i) => {
    gText.append(
      svgEl('text', { x: 0, y: f1(cy(i)), dy: '0.34em', class: 'chart-cat-label' }, truncate(labels[i], labelMax, 12.5)),
    );
    const v = d.value;
    if (!isNum(v)) {
      els.push(null);
      return;
    }
    const xv = xS(v);
    let w = Math.abs(xv - x0);
    let x = Math.min(xv, x0);
    if (w < 1.5 && v !== 0) {
      w = 1.5;
      if (v < 0) x = x0 - w;
    }
    let el = null;
    if (v !== 0) {
      el = svgEl('path', {
        d: barPath(x, cy(i) - barH / 2, w, barH, v < 0 ? 'left' : 'right', 4),
        class: 'chart-bar chart-bar-h' + (v < 0 ? ' is-neg' : ''),
        style: { fill: barColor(d, o, v), '--i': Math.min(i, 30) },
      });
      gBars.append(el);
    }
    els.push(el);
    const tx = v < 0 ? x - 6 : x + w + 6;
    gText.append(svgEl('text', { x: f1(tx), y: f1(cy(i)), dy: '0.34em', 'text-anchor': v < 0 ? 'end' : 'start', class: 'chart-value-label' }, vText[i]));
  });
  svg.append(gBars);
  if (hasNeg) svg.append(svgEl('line', { x1: crisp(x0), x2: crisp(x0), y1: pad, y2: H - pad, class: 'chart-zero' }));
  svg.append(gText);
  body.append(svg);

  const label = `${title}. ${data.map((d, i) => `${labels[i]} ${vText[i]}`).slice(0, 12).join('; ')}`;
  body.append(srTable(title, ['', 'Value'], data.map((d, i) => [labels[i], vText[i]])));

  return {
    count: n,
    label,
    initial: 0,
    pick(cxp, cyp) {
      const p = clientToSvg(svg, W, cxp, cyp);
      if (p.y < 0 || p.y > H) return null;
      return clamp(Math.floor((p.y - pad) / rowH), 0, n - 1);
    },
    show(i) {
      const d = data[i];
      hoverBand.setAttribute('y', f1(pad + rowH * i + 1));
      svg.classList.add('has-active');
      els.forEach((el, j) => el && el.classList.toggle('is-active', j === i));
      const v = d.value;
      const notes = [].concat(noteOf(d.tooltip) || []);
      return {
        title: labels[i],
        rows: [{ color: isNum(v) ? barColor(d, o, v) : null, value: vText[i], shape: 'rect' }],
        note: notes,
        anchor: svgToClient(svg, W, isNum(v) ? xS(v) : x0, cy(i) - barH / 2),
        placement: 'above',
      };
    },
    clear() {
      svg.classList.remove('has-active');
      els.forEach((el) => el && el.classList.remove('is-active'));
    },
    activate: typeof o.onClick === 'function' ? (i) => o.onClick(data[i].raw) : null,
  };
}

/* ------------------------------------------------------------------------------------ stackedBarChart */

/** stackedBarChart({ labels:[...], series:[{name, color, values:[...]}], height=220, yFormat, xFormat, legend=true }) */
export function stackedBarChart(opts = {}) {
  return createChart('stacked', opts || {}, drawStacked);
}

function drawStacked({ body, width: W, opts: o }) {
  const H = Math.max(100, toNum(o.height) || 220);
  const labels = (Array.isArray(o.labels) ? o.labels : []).map((l) => (l === null || l === undefined ? '' : String(l)));
  const series = (Array.isArray(o.series) ? o.series : [])
    .filter((s) => s && typeof s === 'object')
    .map((s, i) => ({
      name: s.name === null || s.name === undefined ? `Series ${i + 1}` : String(s.name),
      color: cssColor(s.color, i),
      values: labels.map((_, j) => toNum(Array.isArray(s.values) ? s.values[j] : null)),
    }));
  const n = labels.length;
  const title = o.ariaLabel || o.title || 'Stacked bar chart';
  const hasData = series.some((s) => s.values.some((v) => isNum(v) && v !== 0));
  if (!n || !series.length || !hasData) {
    body.append(emptyBlock(H, o.emptyText));
    return null;
  }
  if (series.length > 1 && o.legend !== false) body.append(legend(series.map((s) => ({ label: s.name, color: s.color })), { shape: 'rect' }));

  const pos = labels.map((_, j) => series.reduce((a, s) => a + (s.values[j] > 0 ? s.values[j] : 0), 0));
  const neg = labels.map((_, j) => series.reduce((a, s) => a + (s.values[j] < 0 ? s.values[j] : 0), 0));
  const m = { t: 14, r: 10, b: 28, l: 0 };
  const sc = niceTicks(Math.min(0, ...neg), Math.max(0, ...pos), tickCount(H - m.t - m.b));
  const fmtTick = tickFormatter(o.yFormat, sc);
  const fmtVal = (v) => safeFmt(o.tooltipFormat || o.yFormat, v, (x) => fmtNum(x), VCTX);
  const tickLabels = sc.ticks.map(fmtTick);
  m.l = Math.ceil(Math.max(...tickLabels.map((t) => textWidth(t, 11)))) + 12;
  const pw = Math.max(20, W - m.l - m.r);
  const ph = H - m.t - m.b;
  const band = pw / n;
  let barW = Math.min(toNum(o.barWidth) || 24, Math.max(1, band * 0.64));
  if (band - barW < 2) barW = Math.max(1, band - 2);
  const yPos = (v) => m.t + ph * (1 - (v - sc.min) / (sc.max - sc.min || 1));
  const multiYear = isTimeKey(labels[0]) && labels[0].slice(0, 4) !== labels[n - 1].slice(0, 4);
  const xFmt = (l) => safeFmt(o.xFormat, l, (x) => fmtXShort(x, multiYear));
  const cx = (i) => m.l + band * i + band / 2;
  const GAP = 2;

  const svg = makeSvg(W, H);
  const hoverBand = svgEl('rect', { class: 'chart-hover-band', y: m.t - 6, height: ph + 6, rx: 6 });
  svg.append(hoverBand);
  const gGrid = svgEl('g', { class: 'chart-grid' });
  drawYGrid(gGrid, sc, yPos, m.l, W - m.r, tickLabels);
  drawXLabels(gGrid, labels.map((l, i) => ({ x: cx(i), text: xFmt(l) })), H - 8, W);
  svg.append(gGrid);
  const gBars = svgEl('g', { class: 'chart-bars' });
  const groups = [];
  for (let i = 0; i < n; i++) {
    const g = svgEl('g', { class: 'chart-bar chart-stack', style: { '--i': Math.min(i, 40) } });
    let pBase = 0;
    let nBase = 0;
    const lastPos = series.reduce((b, s, j) => (s.values[i] > 0 ? j : b), -1);
    const lastNeg = series.reduce((b, s, j) => (s.values[i] < 0 ? j : b), -1);
    let firstPos = true;
    let firstNeg = true;
    series.forEach((s, j) => {
      const v = s.values[i];
      if (!isNum(v) || v === 0) return;
      let yTop;
      let yBot;
      if (v > 0) {
        yTop = yPos(pBase + v);
        yBot = yPos(pBase);
        pBase += v;
        if (!firstPos) yBot -= GAP;
        firstPos = false;
      } else {
        yTop = yPos(nBase);
        yBot = yPos(nBase + v);
        nBase += v;
        if (!firstNeg) yTop += GAP;
        firstNeg = false;
      }
      const h = yBot - yTop;
      if (h <= 0.4) return;
      const end = v > 0 ? (j === lastPos ? 'top' : 'none') : j === lastNeg ? 'bottom' : 'none';
      g.append(svgEl('path', { d: barPath(cx(i) - barW / 2, yTop, barW, h, end, 4), style: { fill: s.color } }));
    });
    gBars.append(g);
    groups.push(g);
  }
  svg.append(gBars);
  if (sc.min < 0) {
    const y0 = crisp(yPos(0));
    svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: y0, y2: y0, class: 'chart-zero' }));
  }
  body.append(svg);

  const totals = labels.map((_, i) => pos[i] + neg[i]);
  const best = totals.reduce((b, v, i) => (v > totals[b] ? i : b), 0);
  const label = `${title}. ${n} bars, series ${series.map((s) => s.name).join(', ')}. Highest total ${xFmt(labels[best])}: ${fmtVal(totals[best])}`;
  body.append(
    srTable(title, ['', ...series.map((s) => s.name), 'Total'], labels.map((l, i) => [isTimeKey(l) ? fmtXLong(l) : xFmt(l), ...series.map((s) => fmtVal(s.values[i])), fmtVal(totals[i])])),
  );

  return {
    count: n,
    label,
    initial: n - 1,
    pick(cxp, cyp) {
      const p = clientToSvg(svg, W, cxp, cyp);
      if (p.x < m.l - 8 || p.x > W - m.r + 8) return null;
      return clamp(Math.floor((p.x - m.l) / band), 0, n - 1);
    },
    show(i) {
      const bw = Math.min(band, Math.max(barW + 12, 36));
      hoverBand.setAttribute('x', f1(cx(i) - bw / 2));
      hoverBand.setAttribute('width', f1(bw));
      svg.classList.add('has-active');
      groups.forEach((g, j) => g.classList.toggle('is-active', j === i));
      const rows = [];
      for (let j = series.length - 1; j >= 0; j--) {
        const v = series[j].values[i];
        if (isNum(v) && v !== 0) rows.push({ color: series[j].color, value: fmtVal(v), label: series[j].name, shape: 'rect' });
      }
      if (rows.length > 1) rows.push({ value: fmtVal(totals[i]), label: 'Total', total: true });
      if (!rows.length) rows.push({ value: fmtVal(0), label: '' });
      return {
        title: isTimeKey(labels[i]) ? fmtXLong(labels[i]) : xFmt(labels[i]),
        rows,
        anchor: svgToClient(svg, W, cx(i), yPos(Math.max(0, pos[i]))),
        placement: 'above',
      };
    },
    clear() {
      svg.classList.remove('has-active');
      groups.forEach((g) => g.classList.remove('is-active'));
    },
  };
}

/* ------------------------------------------------------------------------------------------ histogram */

/** histogram({ data:[{label, count, color, tooltip}], height=200, yFormat, color, onClick }) — one series, adjacent bins. */
export function histogram(opts = {}) {
  return createChart('histogram', opts || {}, (ctx) => drawBarsV(ctx, 'hist'));
}

/* ----------------------------------------------------------------------------------------- donutChart */

/**
 * donutChart({ data:[{label, value, color}], size=180, thickness=22, centerLabel, centerValue, valueFormat,
 *              legend=true, onClick(datum) })
 */
export function donutChart(opts = {}) {
  return createChart('donut', opts || {}, drawDonut);
}

function drawDonut({ root, body, width, opts: o }) {
  const S = clamp(toNum(o.size) || 180, 80, 420);
  const T = clamp(toNum(o.thickness) || 22, 4, S / 3);
  const title = o.ariaLabel || o.title || 'Donut chart';
  const fmtVal = (v) => safeFmt(o.valueFormat, v, (x) => fmtNum(x), VCTX);
  let items = (Array.isArray(o.data) ? o.data : [])
    .filter((d) => d && typeof d === 'object')
    .map((d, i) => ({ raw: d, label: d.label === null || d.label === undefined ? '' : String(d.label), value: toNum(d.value), color: cssColor(d.color, i) }))
    .filter((d) => isNum(d.value) && d.value > 0);
  if (!items.length) {
    body.append(emptyBlock(S, o.emptyText));
    return null;
  }
  if (items.length > 8) {
    const sorted = [...items].sort((a, b) => b.value - a.value);
    const keep = new Set(sorted.slice(0, 7));
    const rest = items.filter((d) => !keep.has(d));
    const otherVal = rest.reduce((a, d) => a + d.value, 0);
    items = items.filter((d) => keep.has(d));
    items.push({ raw: { label: 'Other', value: otherVal, items: rest.map((d) => d.raw) }, label: 'Other', value: otherVal, color: 'var(--_other)' });
  }
  const total = items.reduce((a, d) => a + d.value, 0);
  const showLegend = o.legend !== false;
  root.classList.toggle('is-stacked', !showLegend || width < S + 200);

  const wrap = htmlEl('div', 'chart-donut-wrap');
  const svg = makeSvg(S, S, 'chart-donut-svg');
  svg.style.width = `${S}px`;
  svg.style.height = `${S}px`;
  const c = S / 2;
  const r = (S - T) / 2 - 3;
  const gArcs = svgEl('g', { class: 'chart-arcs' });
  const arcs = [];
  const padA = items.length > 1 ? Math.min(2 / r, 0.04) : 0;
  let acc = 0;
  const DUR = 0.75;
  items.forEach((d) => {
    const fr = d.value / total;
    const a0 = -Math.PI / 2 + acc * 2 * Math.PI;
    const a1 = a0 + fr * 2 * Math.PI;
    const style = { stroke: d.color, 'stroke-width': T, '--arc-delay': `${(acc * DUR).toFixed(3)}s`, '--arc-dur': `${Math.max(0.05, fr * DUR).toFixed(3)}s` };
    let el;
    if (items.length === 1 || fr > 0.9999) {
      el = svgEl('circle', { cx: c, cy: c, r: f1(r), pathLength: 1, class: 'chart-arc', style, transform: `rotate(-90 ${c} ${c})` });
    } else {
      let s0 = a0 + padA / 2;
      let s1 = a1 - padA / 2;
      const minSpan = 1.2 / r;
      if (s1 - s0 < minSpan) {
        const mid = (a0 + a1) / 2;
        s0 = mid - minSpan / 2;
        s1 = mid + minSpan / 2;
      }
      const large = s1 - s0 > Math.PI ? 1 : 0;
      const p0 = [c + r * Math.cos(s0), c + r * Math.sin(s0)];
      const p1 = [c + r * Math.cos(s1), c + r * Math.sin(s1)];
      el = svgEl('path', {
        d: `M${f1(p0[0])},${f1(p0[1])}A${f1(r)},${f1(r)} 0 ${large} 1 ${f1(p1[0])},${f1(p1[1])}`,
        pathLength: 1,
        class: 'chart-arc',
        style,
      });
    }
    d.a0 = a0;
    d.a1 = a1;
    d.fr = fr;
    gArcs.append(el);
    arcs.push(el);
    acc += fr;
  });
  svg.append(gArcs);

  // center readout
  const inner = (r - T / 2) * 2 * 0.8;
  const vSize = Math.round(clamp(S * 0.125, 14, 34));
  const lSize = Math.round(clamp(S * 0.068, 11, 15));
  const cv = svgEl('text', { x: c, y: c, 'text-anchor': 'middle', class: 'chart-donut-value' });
  const cl = svgEl('text', { x: c, y: c, 'text-anchor': 'middle', class: 'chart-donut-label' });
  const cs = svgEl('text', { x: c, y: c, 'text-anchor': 'middle', class: 'chart-donut-sub' });
  svg.append(cv, cl, cs);
  const baseValue = o.centerValue !== undefined && o.centerValue !== null ? String(o.centerValue) : fmtVal(total);
  const baseLabel = o.centerLabel !== undefined && o.centerLabel !== null ? String(o.centerLabel) : 'Total';
  /** Center readout: optional label line, value, optional sub line — stacked by cap height, centred as one block. */
  function setCenter(value, lbl, sub) {
    let vs = vSize;
    const w = textWidth(value, vs, 650);
    if (w > inner) vs = Math.max(11, Math.floor((vs * inner) / w));
    cv.textContent = value;
    cv.style.fontSize = `${vs}px`;
    cl.style.fontSize = `${lSize}px`;
    cs.style.fontSize = `${lSize}px`;
    const capV = vs * 0.72;
    const capL = lSize * 0.72;
    const gap = Math.max(6, lSize * 0.5);
    const lines = [];
    if (lbl) lines.push([cl, capL, inner * 0.86]);
    lines.push([cv, capV, 0]);
    if (sub) lines.push([cs, capL, inner * 0.86]);
    let y = c - (lines.reduce((a, l) => a + l[1], 0) + gap * (lines.length - 1)) / 2;
    for (const [node, cap] of lines) {
      y += cap;
      node.setAttribute('y', f1(y));
      y += gap;
    }
    cl.textContent = lbl ? truncate(lbl, inner * 0.86, lSize, 500) : '';
    cs.textContent = sub ? truncate(sub, inner * 0.86, lSize, 500) : '';
  }
  setCenter(baseValue, baseLabel);
  wrap.append(svg);

  const rows = [];
  if (showLegend) {
    const list = htmlEl('div', 'chart-donut-legend');
    items.forEach((d, i) => {
      const row = htmlEl('div', 'chart-donut-row');
      row.dataset.i = String(i);
      const sw = htmlEl('i', 'chart-legend-swatch');
      sw.style.setProperty('--sw', d.color);
      row.append(sw, htmlEl('span', 'chart-donut-name', d.label), htmlEl('span', 'chart-donut-amt', fmtVal(d.value)), htmlEl('span', 'chart-donut-pct', fmtPct(d.fr)));
      list.append(row);
      rows.push(row);
    });
    wrap.append(list);
  }
  if (typeof o.onClick === 'function') root.classList.add('is-clickable');
  body.append(wrap);

  const label = `${title}. Total ${fmtVal(total)}. ${items.map((d) => `${d.label} ${fmtVal(d.value)} (${fmtPct(d.fr)})`).join('; ')}`;
  body.append(srTable(title, ['', 'Value', 'Share'], items.map((d) => [d.label, fmtVal(d.value), fmtPct(d.fr)])));

  return {
    count: items.length,
    label,
    initial: 0,
    pick(cx, cy, target) {
      const row = target && target.closest ? target.closest('.chart-donut-row') : null;
      if (row && body.contains(row)) return Number(row.dataset.i);
      const p = clientToSvg(svg, S, cx, cy);
      const dx = p.x - c;
      const dy = p.y - c;
      const dist = Math.hypot(dx, dy);
      if (dist < r - T / 2 - 6 || dist > r + T / 2 + 8) return null;
      let a = Math.atan2(dy, dx);
      if (a < -Math.PI / 2) a += 2 * Math.PI;
      const i = items.findIndex((d) => a >= d.a0 && a < d.a1);
      return i >= 0 ? i : items.length - 1;
    },
    show(i) {
      const d = items[i];
      svg.classList.add('has-active');
      arcs.forEach((el, j) => el.classList.toggle('is-active', j === i));
      rows.forEach((el, j) => el.classList.toggle('is-active', j === i));
      setCenter(fmtVal(d.value), d.label, fmtPct(d.fr));
      return { tip: false, announce: `${d.label}: ${fmtVal(d.value)}, ${fmtPct(d.fr)}` };
    },
    clear() {
      svg.classList.remove('has-active');
      arcs.forEach((el) => el.classList.remove('is-active'));
      rows.forEach((el) => el.classList.remove('is-active'));
      setCenter(baseValue, baseLabel);
    },
    activate: typeof o.onClick === 'function' ? (i) => o.onClick(items[i].raw) : null,
  };
}

/* -------------------------------------------------------------------------------------------- heatmap */

function appWeekStart() {
  try {
    const s = window.daybook && typeof window.daybook.getSettings === 'function' ? window.daybook.getSettings() : null;
    const ws = s ? toNum(s.weekStart) : null;
    if (ws !== null && ws >= 0 && ws <= 6) return ws;
  } catch {
    /* ignore */
  }
  return 1;
}

// Intensity buckets 1..4 as % of the hue mixed into the chart surface (0 = empty cell color).
const LEVELS = [0, 34, 56, 78, 100];

/**
 * heatmap({ values:{[dateKey]: number}, from, to, accent='--primary', weekStart, max, valueFormat,
 *           onClick(dateKey), signed=false, emptyLabel, legend=true })
 */
export function heatmap(opts = {}) {
  return createChart('heatmap', opts || {}, drawHeatmap);
}

function drawHeatmap({ body, width: W, opts: o }) {
  const vals = o.values && typeof o.values === 'object' ? o.values : {};
  const title = o.ariaLabel || o.title || 'Activity heatmap';
  const today = todayKey();
  let to = DATE_RE.test(o.to || '') ? o.to : today;
  let from = DATE_RE.test(o.from || '') ? o.from : keyFromNum(dayNum(to) - 26 * 7 + 1);
  let fromN = dayNum(from);
  let toN = dayNum(to);
  if (fromN > toN) [fromN, toN] = [toN, fromN];
  if (toN - fromN > 800) fromN = toN - 800;
  from = keyFromNum(fromN);
  to = keyFromNum(toN);
  const wsRaw = toNum(o.weekStart);
  const ws = wsRaw !== null && wsRaw >= 0 && wsRaw <= 6 ? wsRaw : appWeekStart();
  const startN = fromN - ((weekdayOfNum(fromN) - ws + 7) % 7);
  const weeks = Math.floor((toN - startN) / 7) + 1;
  const count = toN - fromN + 1;
  const signed = !!o.signed;
  const fmtVal = (v) => safeFmt(o.valueFormat, v, (x) => fmtNum(x, { sign: signed }), VCTX);

  const dayVals = new Array(count);
  let maxAbs = 0;
  let any = false;
  for (let i = 0; i < count; i++) {
    const v = toNum(vals[keyFromNum(fromN + i)]);
    dayVals[i] = v;
    if (v !== null) {
      any = true;
      maxAbs = Math.max(maxAbs, Math.abs(v));
    }
  }
  if (!any) {
    body.append(emptyBlock(toNum(o.height) || 140, o.emptyText));
    return null;
  }
  const mx = toNum(o.max) > 0 ? toNum(o.max) : maxAbs || 1;
  const levelOf = (v) => (v === null || v === 0 ? 0 : clamp(Math.ceil((Math.min(1, Math.abs(v) / mx) * 4) - 1e-9), 1, 4));
  const accent = cssColor(o.accent || '--primary', 0);
  const mix = supportsMix();
  const paint = (v) => {
    const lv = levelOf(v);
    if (!lv) return { fill: 'var(--_empty)' };
    const base = signed ? (v < 0 ? 'var(--_loss)' : 'var(--_profit)') : accent;
    if (lv === 4) return { fill: base };
    return mix ? { fill: `color-mix(in oklab, ${base} ${LEVELS[lv]}%, var(--_surface))` } : { fill: base, 'fill-opacity': LEVELS[lv] / 100 };
  };

  // layout
  const wdFmt = df({ weekday: 'short' });
  const wdName = (wd) => wdFmt.format(new Date(2024, 0, 7 + wd)); // 2024-01-07 was a Sunday
  const rowLabels = [0, 1, 2, 3, 4, 5, 6].map((r) => {
    const wd = (ws + r) % 7;
    return wd === 1 || wd === 3 || wd === 5 ? wdName(wd) : '';
  });
  const leftW = Math.ceil(Math.max(...rowLabels.map((l) => textWidth(l, 10.5)))) + 8;
  const topH = 18;
  let gap = 3;
  const avail = Math.max(60, W - leftW);
  let cell = Math.floor((avail - (weeks - 1) * gap) / weeks);
  let scroll = false;
  if (cell < 10) {
    gap = 2;
    cell = Math.floor((avail - (weeks - 1) * gap) / weeks);
  }
  if (cell < 9) {
    cell = 11;
    gap = 3;
    scroll = true;
  }
  cell = Math.min(cell, toNum(o.maxCell) || 20);
  const step = cell + gap;
  const gridW = weeks * step - gap;
  const H = topH + 7 * step - gap;

  const row = htmlEl('div', 'chart-heatmap-row');
  const lsvg = makeSvg(leftW, H, 'chart-heatmap-labels');
  lsvg.style.width = `${leftW}px`;
  lsvg.style.height = `${H}px`;
  rowLabels.forEach((l, r) => {
    if (l) lsvg.append(svgEl('text', { x: 0, y: f1(topH + r * step + cell / 2), dy: '0.34em', class: 'chart-tick' }, l));
  });
  const scroller = htmlEl('div', 'chart-scroll' + (scroll ? ' is-scroll' : ''));
  const svg = makeSvg(gridW, H, 'chart-heatmap-grid');
  svg.style.width = `${gridW}px`;
  svg.style.height = `${H}px`;

  // month labels
  const multiYear = from.slice(0, 4) !== to.slice(0, 4);
  const mFmt = df({ month: 'short' });
  const myFmt = df({ month: 'short', year: '2-digit' });
  let lastX = -Infinity;
  const marks = [];
  // A month is labelled at the column holding its 1st; the partial first month is labelled at column 0
  // only when there is room before the next label.
  for (let c = 0; c < weeks; c++) {
    let mark = null;
    for (let r = 0; r < 7; r++) {
      const n = startN + c * 7 + r;
      if (n < fromN || n > toN) continue;
      const k = keyFromNum(n);
      if (k.endsWith('-01')) {
        mark = { c, k, first: false };
        break;
      }
    }
    if (!mark && c === 0) mark = { c, k: keyFromNum(fromN), first: true };
    if (mark) marks.push(mark);
  }
  marks.forEach((mk, i) => {
    const d = keyToDate(mk.k);
    const text = multiYear && (d.getMonth() === 0 || i === 0) ? myFmt.format(d) : mFmt.format(d);
    const x = mk.c * step;
    const w = textWidth(text, 10.5);
    const next = marks[i + 1];
    if (mk.first && next && next.c * step - x < w + 8) return;
    if (x - lastX < w + 8 && lastX > -Infinity) return;
    if (x + w > gridW + 2) return;
    svg.append(svgEl('text', { x, y: 11, class: 'chart-tick chart-month' }, text));
    lastX = x;
  });

  const gCells = svgEl('g', { class: 'chart-cells' });
  const cells = new Array(count);
  const rx = cell >= 12 ? 3 : 2;
  for (let i = 0; i < count; i++) {
    const n = fromN + i;
    const c = Math.floor((n - startN) / 7);
    const r = (n - startN) % 7;
    const v = dayVals[i];
    const k = keyFromNum(n);
    const style = { ...paint(v), '--c': Math.min(c, 60) };
    const el = svgEl('rect', {
      x: c * step,
      y: topH + r * step,
      width: cell,
      height: cell,
      rx,
      class: 'chart-cell' + (k === today ? ' is-today' : ''),
      style,
    });
    gCells.append(el);
    cells[i] = el;
  }
  svg.append(gCells);
  scroller.append(svg);
  row.append(lsvg, scroller);
  body.append(row);
  if (typeof o.onClick === 'function') svg.classList.add('is-clickable');

  if (o.legend !== false) {
    const foot = htmlEl('div', 'chart-heatmap-foot');
    foot.style.maxWidth = `${leftW + Math.min(gridW, avail)}px`;
    const scale = htmlEl('div', 'chart-scale');
    const sw = (st) => {
      const s = htmlEl('i', 'chart-scale-swatch');
      for (const k in st) s.style.setProperty(k === 'fill' ? 'background' : 'opacity', String(st[k]));
      return s;
    };
    if (signed) {
      scale.append(htmlEl('span', null, 'Loss'));
      [4, 3, 2, 1].forEach((lv) => scale.append(sw(paint((-lv / 4) * mx))));
      scale.append(sw(paint(null)));
      [1, 2, 3, 4].forEach((lv) => scale.append(sw(paint((lv / 4) * mx))));
      scale.append(htmlEl('span', null, 'Profit'));
    } else {
      scale.append(htmlEl('span', null, 'Less'));
      [0, 1, 2, 3, 4].forEach((lv) => scale.append(sw(paint(lv ? (lv / 4) * mx : null))));
      scale.append(htmlEl('span', null, 'More'));
    }
    foot.append(scale);
    body.append(foot);
  }

  if (scroll) {
    requestAnimationFrame(() => {
      scroller.scrollLeft = scroller.scrollWidth;
    });
  }

  let active = 0;
  let sum = 0;
  let best = -1;
  dayVals.forEach((v, i) => {
    if (v !== null && v !== 0) active++;
    if (v !== null) sum += v;
    if (v !== null && (best < 0 || (signed ? v > dayVals[best] : Math.abs(v) > Math.abs(dayVals[best])))) best = i;
  });
  let label = `${title}. ${fmtXLong(from)} to ${fmtXLong(to)}. ${active} active day${active === 1 ? '' : 's'}`;
  if (best >= 0) label += `. Highest ${fmtXLong(keyFromNum(fromN + best))}: ${fmtVal(dayVals[best])}`;
  if (signed) label += `. Net ${fmtVal(sum)}`;

  const longFmt = (n) => {
    const d = keyToDate(keyFromNum(n));
    return df({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  };

  return {
    count,
    label,
    initial: count - 1,
    pick(cx, cy) {
      const p = clientToSvg(svg, gridW, cx, cy);
      const c = Math.floor((p.x + gap / 2) / step);
      const r = Math.floor((p.y - topH + gap / 2) / step);
      if (c < 0 || c >= weeks || r < 0 || r > 6) return null;
      const n = startN + c * 7 + r;
      if (n < fromN || n > toN) return null;
      return n - fromN;
    },
    show(i, info) {
      cells.forEach((el, j) => el.classList.toggle('is-active', j === i));
      const el = cells[i];
      if (scroll && info && info.via === 'key') {
        const x = Number(el.getAttribute('x'));
        if (x < scroller.scrollLeft || x + cell > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = x - scroller.clientWidth / 2;
      }
      const v = dayVals[i];
      const n = fromN + i;
      const st = paint(v);
      const value = v === null ? (typeof o.emptyLabel === 'string' ? o.emptyLabel : 'Nothing logged') : fmtVal(v);
      return {
        title: longFmt(n),
        rows: [{ color: v === null || v === 0 ? null : st.fill, value, shape: 'rect' }],
        anchor: svgToClient(svg, gridW, Number(el.getAttribute('x')) + cell / 2, Number(el.getAttribute('y'))),
        placement: 'above',
      };
    },
    clear() {
      cells.forEach((el) => el.classList.remove('is-active'));
    },
    navigate(i, key) {
      const d = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 }[key];
      return d === undefined ? null : clamp(i + d, 0, count - 1);
    },
    activate: typeof o.onClick === 'function' ? (i) => o.onClick(keyFromNum(fromN + i)) : null,
  };
}

/* ------------------------------------------------------------------------------------------ sparkline */

/** sparkline(values, { color='--primary', width=96, height=28, area=true }) — tiny trend line for stat tiles. */
export function sparkline(values, opts = {}) {
  const o = opts || {};
  const W = clamp(toNum(o.width) || 96, 16, 2000);
  const H = clamp(toNum(o.height) || 28, 8, 400);
  const color = cssColor(o.color || '--primary', 0);
  const root = htmlEl('div', 'chart chart-sparkline');
  root.setAttribute('role', 'img');
  root.style.width = `${W}px`;
  root.style.height = `${H}px`;
  if (typeof o.class === 'string' && o.class) root.className += ' ' + o.class;
  const raw = Array.isArray(values) ? values : [];
  const P = [];
  raw.forEach((v, i) => {
    const y = toNum(v);
    if (y !== null) P.push({ i, v: y });
  });
  const svg = makeSvg(W, H);
  svg.style.width = `${W}px`;
  svg.style.height = `${H}px`;
  const fmt = (v) => safeFmt(o.valueFormat, v, (x) => fmtNum(x), VCTX);
  if (!P.length) {
    svg.append(svgEl('line', { x1: 2, x2: W - 2, y1: crisp(H / 2), y2: crisp(H / 2), class: 'chart-spark-empty' }));
    root.append(svg);
    root.setAttribute('aria-label', `${o.ariaLabel || 'Trend'}: no data yet`);
    return root;
  }
  const padX = 3.5;
  const padY = 3.5;
  let lo = Math.min(...P.map((p) => p.v));
  let hi = Math.max(...P.map((p) => p.v));
  const n = Math.max(1, raw.length - 1);
  const pts = P.map((p) => ({
    x: P.length === 1 ? W / 2 : padX + ((W - 2 * padX) * p.i) / n,
    y: hi === lo ? H / 2 : padY + (H - 2 * padY) * (1 - (p.v - lo) / (hi - lo)),
    v: p.v,
  }));
  const defs = svgEl('defs');
  svg.append(defs);
  if (pts.length > 1) {
    const d = pathMonotone(pts);
    if (o.area !== false) {
      const gid = uid('sg');
      const grad = svgEl('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.append(
        svgEl('stop', { offset: '0%', style: { 'stop-color': color, 'stop-opacity': 0.24 } }),
        svgEl('stop', { offset: '100%', style: { 'stop-color': color, 'stop-opacity': 0 } }),
      );
      defs.append(grad);
      svg.append(svgEl('path', { d: `${d}L${f1(pts[pts.length - 1].x)},${H}L${f1(pts[0].x)},${H}Z`, class: 'chart-area', style: { fill: `url(#${gid})` } }));
    }
    svg.append(svgEl('path', { d, class: 'chart-line chart-spark-line', style: { stroke: color } }));
  }
  const last = pts[pts.length - 1];
  svg.append(svgEl('circle', { cx: f1(last.x), cy: f1(last.y), r: 2.75, class: 'chart-dot chart-spark-dot', style: { fill: color } }));
  root.append(svg);
  const first = P[0].v;
  const lastV = P[P.length - 1].v;
  root.setAttribute(
    'aria-label',
    `${o.ariaLabel || 'Trend'}: ${P.length} values, from ${fmt(first)} to ${fmt(lastV)}, high ${fmt(hi)}, low ${fmt(lo)}`,
  );
  return root;
}
