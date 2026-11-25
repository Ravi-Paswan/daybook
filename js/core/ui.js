// Daybook UI kit (SPEC 3.5): h() DOM builder + every shared component. Styles live in css/components.css.
//
// Choices beyond the spec (all additive — every spec signature is honoured):
//   - h(): 'tag#id.cls' shorthand, `text` prop (textContent), `on: {event: fn}` for custom events, aria-* and
//     enumerated attributes (spellcheck, draggable, contenteditable) keep `false` as "false" (aria-pressed=false
//     is meaningful). `value/checked/selected/indeterminate` are applied AFTER children (so <select value> works).
//   - field() renders <div class="field"> with <label class="field-label" for=…> rather than wrapping the control
//     in a <label>: a wrapping label would "click" the first button of chips/segmented controls. Non-labelable
//     controls (chips, segmented, rating, mood) are tied with aria-labelledby. Returns el with setError()/setHint().
//     `required` sets aria-required (not the native attribute, so forms never show browser validation bubbles).
//   - openSheet(): extra opts `icon` (header icon chip), `dismissible` (default true), `guard(api)` (async; return
//     false to keep the sheet open on Esc/backdrop/swipe — e.g. "discard changes?"), `className`, `initialFocus`
//     (element | selector), and size 'sm' (420px). Danger actions default to align:'start'. An action without
//     onClick closes with its `value` (default null). Pressing Enter in a <form> inside the sheet runs the primary
//     action unless the form's own submit handler called preventDefault() (works with any number of inputs — the
//     sheet requests the submit itself because the footer buttons sit outside the form). Forms get noValidate.
//     api also has: footer, layer, header, setTitle(t), setSubtitle(t), setActions(list), submit(), dismiss().
//   - chips(): single-select chips can be cleared by tapping the selected chip (pass `deselect:false` to prevent).
//     Options may be strings, {value,label,emoji,icon,color} or settings categories {id,name,emoji,color}.
//   - toast(): extra `onClose(reason)`; returns {el, close}. menu(): items may be {divider:true}, {heading}, and have
//     `hint`, `checked`, `disabled`; returns {el, close}; calling it again on the same anchor toggles it closed.
//   - Extras for module authors: button, iconChip, badge, listItem, listGroupHeader, section, kv, table, skeleton,
//     spinner, checkbox, range, promptDialog, popover, colorVar, uniqueId, plus overlay helpers used by images.js
//     (pushEscape, lockScroll, unlockScroll, isolate).

import { iconSVG, hasIcon } from './icons.js';
import { currencySymbol, fmtPercent, fmtNumber } from './format.js';
import { todayKey, addDays, diffDays, fmtDate, relativeDay, addMonths, fmtMonth, currentMonth, locale } from './dates.js';
import { navigate } from './router.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HAS_DOM = typeof document !== 'undefined';

// ════════════════════════════════════════════════════════════════════════════ small utils

let idSeq = 0;
/** Unique DOM id: uniqueId('field') → 'db-field-7'. */
export function uniqueId(prefix = 'ui') {
  idSeq += 1;
  return `db-${prefix}-${idSeq}`;
}

/** '--food' → 'var(--food)'; 'var(--x)' / '#f97316' / 'tomato' pass through. */
export function colorVar(c, fallback = null) {
  if (c === null || c === undefined || c === '') return fallback;
  const s = String(c).trim();
  return s.startsWith('--') ? `var(${s})` : s;
}

function isPlainProps(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  if (HAS_DOM && x instanceof Node) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function toArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

/** Normalises options: 'x' | {value,label,…} | {id,name,…} → {value,label,emoji,icon,color,disabled,…}. */
function normOptions(options) {
  return toArray(options)
    .filter((o) => o !== null && o !== undefined)
    .map((o) => {
      if (typeof o !== 'object') return { value: o, label: String(o) };
      const value = o.value !== undefined ? o.value : o.id;
      const label = o.label !== undefined ? o.label : o.name !== undefined ? o.name : o.icon && o.ariaLabel ? '' : String(value);
      return { ...o, value, label };
    });
}

function decimalsOf(n) {
  const s = String(n);
  if (s.includes('e-')) return Number(s.split('e-')[1]) || 0;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

function prefersReducedMotion() {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function isMobileLayout() {
  try {
    return matchMedia('(max-width: 719.98px)').matches;
  } catch {
    return false;
  }
}

function focusEl(el) {
  if (!el || typeof el.focus !== 'function') return false;
  try {
    el.focus({ preventScroll: true });
  } catch {
    try {
      el.focus();
    } catch {
      return false;
    }
  }
  return document.activeElement === el;
}

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], summary';

function focusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0 && !el.closest('[inert]') && el.tabIndex !== -1
  );
}

/** Debounce with .cancel() and .flush(). */
export function debounce(fn, ms = 250) {
  let timer = 0;
  let lastArgs = null;
  let lastThis = null;
  const run = () => {
    timer = 0;
    const args = lastArgs;
    lastArgs = null;
    return fn.apply(lastThis, args || []);
  };
  function debounced(...args) {
    lastArgs = args;
    lastThis = this;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  }
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = 0;
    lastArgs = null;
  };
  debounced.flush = () => {
    if (!timer) return undefined;
    clearTimeout(timer);
    return run();
  };
  debounced.pending = () => !!timer;
  return debounced;
}

// ════════════════════════════════════════════════════════════════════════════ h() / mount / clear

const DEFERRED_PROPS = new Set(['value', 'checked', 'selected', 'indeterminate', 'defaultValue', 'defaultChecked']);
const ENUMERATED_ATTRS = new Set(['spellcheck', 'draggable', 'contenteditable', 'translate', 'autocorrect']);

function classList(v, out = []) {
  if (!v) return out;
  if (typeof v === 'string') {
    for (const c of v.split(/\s+/)) if (c) out.push(c);
  } else if (Array.isArray(v)) {
    for (const x of v) classList(x, out);
  } else if (typeof v === 'object') {
    for (const [k, on] of Object.entries(v)) if (on) classList(k, out);
  }
  return out;
}

function applyStyle(el, v) {
  if (!v) return;
  if (typeof v === 'string') {
    el.style.cssText = v;
    return;
  }
  for (const [k, val] of Object.entries(v)) {
    if (val === null || val === undefined || val === false) continue;
    if (k.startsWith('--') || k.includes('-')) el.style.setProperty(k, String(val));
    else el.style[k] = val;
  }
}

function appendChildren(el, kids) {
  for (const c of kids) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) {
      appendChildren(el, c);
    } else if (c instanceof Node) {
      el.appendChild(c);
    } else if (typeof c === 'object' && typeof c[Symbol.iterator] === 'function') {
      appendChildren(el, Array.from(c));
    } else {
      el.appendChild(document.createTextNode(String(c)));
    }
  }
}

/**
 * h('div.card.big', {props}, ...children) — builds DOM safely (text via text nodes, never innerHTML).
 * 'svg:path' (or 'svg') creates SVG-namespace elements. The props object may be omitted.
 */
export function h(tag, props, ...children) {
  if (!isPlainProps(props)) {
    if (props !== undefined) children.unshift(props);
    props = null;
  }
  let t = String(tag || 'div');
  let svg = false;
  if (t.startsWith('svg:')) {
    svg = true;
    t = t.slice(4);
  }
  const parts = t.split(/(?=[.#])/);
  let name = parts[0] && !/^[.#]/.test(parts[0]) ? parts.shift() : 'div';
  if (name === 'svg') svg = true;
  const el = svg ? document.createElementNS(SVG_NS, name) : document.createElement(name);
  const classes = [];
  for (const p of parts) {
    if (p[0] === '.') classes.push(p.slice(1));
    else if (p[0] === '#') el.id = p.slice(1);
  }
  const deferred = [];
  const refs = [];
  if (props) {
    classList(props.class, classes);
    classList(props.className, classes);
    for (const [rawKey, v] of Object.entries(props)) {
      let k = rawKey;
      if (k === 'class' || k === 'className' || k === 'key') continue;
      if (v === null || v === undefined) continue;
      const keepFalse = k.startsWith('aria-') || ENUMERATED_ATTRS.has(k);
      if (v === false && !keepFalse) continue;
      if (k === 'style') {
        applyStyle(el, v);
      } else if (k === 'dataset') {
        for (const [dk, dv] of Object.entries(v)) {
          if (dv !== null && dv !== undefined && dv !== false) el.dataset[dk] = String(dv);
        }
      } else if (k === 'ref') {
        if (typeof v === 'function') refs.push(v);
      } else if (k === 'html') {
        el.innerHTML = v; // TRUSTED static markup only (icons.js / charts.js)
      } else if (k === 'text') {
        el.textContent = String(v);
      } else if (k === 'on' && typeof v === 'object') {
        for (const [ev, fn] of Object.entries(v)) if (typeof fn === 'function') el.addEventListener(ev, fn);
      } else if (k.length > 2 && k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (DEFERRED_PROPS.has(k) && !svg) {
        deferred.push([k, v]);
      } else if (svg) {
        el.setAttribute(k, v === true ? '' : String(v));
      } else if (keepFalse) {
        el.setAttribute(k, String(v));
      } else {
        if (k === 'htmlFor') k = 'for';
        if (k === 'tabIndex') k = 'tabindex';
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  if (classes.length) {
    if (svg) el.setAttribute('class', classes.join(' '));
    else el.className = classes.join(' ');
  }
  appendChildren(el, children);
  for (const [k, v] of deferred) {
    try {
      el[k] = v;
    } catch {
      el.setAttribute(k, String(v));
    }
  }
  for (const fn of refs) fn(el);
  return el;
}

/** Clear root, then append children. Returns root. */
export function mount(root, ...children) {
  if (!root) return root;
  root.replaceChildren();
  appendChildren(root, children);
  return root;
}

export function clear(el) {
  if (el) el.replaceChildren();
  return el;
}

// ════════════════════════════════════════════════════════════════════════════ icons

const iconCache = new Map();

/** → SVGElement for an icons.js name (unknown names fall back to 'circle'). */
export function icon(name, { size = 20, class: cls, title, strokeWidth } = {}) {
  const n = hasIcon(name) ? name : 'circle';
  const c = classList(cls).join(' ');
  const key = `${n}|${size}|${c}|${title || ''}|${strokeWidth || ''}`;
  let tpl = iconCache.get(key);
  if (!tpl) {
    tpl = document.createElement('template');
    tpl.innerHTML = iconSVG(n, { size, cls: c, title, strokeWidth: strokeWidth || undefined });
    if (iconCache.size > 600) iconCache.clear();
    iconCache.set(key, tpl);
  }
  return tpl.content.firstElementChild.cloneNode(true);
}

function maybeIcon(name, opts) {
  if (!name) return null;
  if (typeof name !== 'string') return name; // already a Node
  return icon(name, opts);
}

// ════════════════════════════════════════════════════════════════════════════ overlay plumbing

const escStack = [];

/** Register an Escape handler on top of the overlay stack. Returns pop(). */
export function pushEscape(fn) {
  const entry = { fn };
  escStack.push(entry);
  return () => {
    const i = escStack.indexOf(entry);
    if (i >= 0) escStack.splice(i, 1);
  };
}

if (HAS_DOM) {
  // Bubble phase: inner controls (chip add input, tag input…) can preventDefault() to keep the sheet open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented || !escStack.length) return;
    e.preventDefault();
    e.stopPropagation();
    escStack[escStack.length - 1].fn(e);
  });
}

let lockCount = 0;

/** Body scroll lock (ref-counted). */
export function lockScroll() {
  lockCount += 1;
  if (lockCount !== 1) return;
  const root = document.documentElement;
  const sbw = Math.max(0, window.innerWidth - root.clientWidth);
  root.style.setProperty('--scrollbar-comp', sbw + 'px');
  if (sbw) document.body.style.paddingRight = sbw + 'px';
  root.classList.add('ui-scroll-lock');
}

export function unlockScroll() {
  if (lockCount <= 0) return;
  lockCount -= 1;
  if (lockCount !== 0) return;
  const root = document.documentElement;
  root.classList.remove('ui-scroll-lock');
  root.style.removeProperty('--scrollbar-comp');
  document.body.style.paddingRight = '';
}

/** Makes every other top-level body child inert (modal isolation). Returns restore(). */
export function isolate(keep) {
  const changed = [];
  for (const el of Array.from(document.body.children)) {
    if (el === keep || el.inert || el.hasAttribute('data-ui-keep')) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'TEMPLATE' || el.tagName === 'NOSCRIPT') continue;
    el.inert = true;
    changed.push(el);
  }
  return () => {
    for (const el of changed) el.inert = false;
  };
}

function trapTab(e, root) {
  if (e.key !== 'Tab') return;
  const items = focusables(root);
  if (!items.length) {
    e.preventDefault();
    focusEl(root);
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
    e.preventDefault();
    focusEl(last);
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    focusEl(first);
  }
}

// ════════════════════════════════════════════════════════════════════════════ buttons & small pieces

const VARIANTS = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  'danger-solid': 'btn-danger btn-danger-solid',
  success: 'btn-success',
  plain: '',
};

/**
 * button({label, icon, variant='secondary', size, iconOnly, pill, block, onClick, ariaLabel, type='button', ...props})
 * Icon-only buttons (iconOnly or no label) get aria-label from ariaLabel || label.
 */
export function button(opts = {}) {
  const {
    label,
    icon: iconName,
    iconEnd,
    variant = 'secondary',
    size,
    iconOnly = false,
    pill = false,
    block = false,
    ariaLabel,
    class: cls,
    type = 'button',
    ...rest
  } = opts;
  const onlyIcon = iconOnly || (!label && label !== 0);
  const iconSize = size === 'sm' ? 16 : size === 'lg' ? 22 : 18;
  return h(
    'button.btn',
    {
      type,
      class: [VARIANTS[variant] ?? VARIANTS.secondary, size && `btn-${size}`, onlyIcon && 'btn-icon', pill && 'btn-pill', block && 'btn-block', cls],
      'aria-label': onlyIcon ? ariaLabel || (typeof label === 'string' ? label : null) : ariaLabel || null,
      title: onlyIcon && typeof label === 'string' ? label : rest.title,
      ...rest,
    },
    maybeIcon(iconName, { size: onlyIcon && size !== 'sm' ? 20 : iconSize }),
    onlyIcon ? null : h('span', label),
    maybeIcon(iconEnd, { size: iconSize })
  );
}

/** Descriptor ({label, icon, variant, onClick, iconOnly}) or Node → Node. Used for page/card actions. */
function actionNode(a, defaults = {}) {
  if (!a) return null;
  if (a instanceof Node) return a;
  return button({ ...defaults, ...a });
}

export function spinner({ size = 18, class: cls } = {}) {
  return h('span.spinner', { class: cls, role: 'presentation', style: { width: size + 'px', height: size + 'px' } });
}

/** iconChip('food', {accent:'--food', size:'sm'|'md'|'lg', emoji}) — rounded tinted square with a coloured icon. */
export function iconChip(name, { accent, size = 'md', emoji, solid = false, class: cls } = {}) {
  const px = size === 'sm' ? 16 : size === 'lg' ? 24 : 20;
  return h(
    emoji ? 'span.emoji-chip' : 'span.icon-chip',
    {
      class: [size !== 'md' && `icon-chip-${size}`, solid && 'icon-chip-solid', cls],
      style: accent ? { '--accent': colorVar(accent) } : null,
      'aria-hidden': 'true',
    },
    emoji || icon(name, { size: px })
  );
}

/** badge('Long', 'long') — variants: profit loss neutral long short open accent warning. */
export function badge(label, variant, { icon: iconName, accent, dot = false, size } = {}) {
  return h(
    'span.badge',
    {
      class: [variant && `badge-${variant}`, dot && 'badge-dot', size === 'lg' && 'badge-lg'],
      style: accent ? { '--accent': colorVar(accent) } : null,
    },
    maybeIcon(iconName, { size: 12 }),
    label
  );
}

/** skeleton({width, height, lines, circle, radius}) — shimmering placeholder(s). */
export function skeleton({ width, height = 14, lines = 1, circle = false, radius, class: cls } = {}) {
  const one = (w) =>
    h('span.skeleton', {
      class: [circle && 'skeleton-circle', lines > 1 && 'skeleton-text', cls],
      'aria-hidden': 'true',
      style: {
        width: typeof w === 'number' ? w + 'px' : w || (circle ? height + 'px' : '100%'),
        height: typeof height === 'number' ? height + 'px' : height,
        borderRadius: radius,
      },
    });
  if (lines <= 1) return one(width);
  return h(
    'div.stack-sm',
    { 'aria-hidden': 'true' },
    Array.from({ length: lines }, (_, i) => one(i === lines - 1 ? '62%' : width))
  );
}

// ════════════════════════════════════════════════════════════════════════════ toasts

let toastStack = null;
const TOAST_ICONS = { info: 'info', success: 'check-circle', error: 'alert' };

function getToastStack() {
  if (!toastStack || !toastStack.isConnected) {
    toastStack = h('div.toast-stack', { role: 'status', 'aria-live': 'polite', 'aria-relevant': 'additions', 'data-ui-keep': '' });
    document.body.appendChild(toastStack);
  }
  return toastStack;
}

/**
 * toast(message, {type:'info'|'success'|'error', duration=3200, action:{label,onClick}, onClose})
 * Max 3 visible (oldest leaves), pauses while hovered/focused, swipe sideways to dismiss. → {el, close}
 */
export function toast(message, { type = 'info', duration, action, onClose } = {}) {
  if (!HAS_DOM) return { el: null, close() {} };
  const stack = getToastStack();
  const life = Number.isFinite(duration) ? duration : action ? 5600 : 3200;
  let timer = 0;
  let remaining = life;
  let startedAt = 0;
  let closed = false;

  const actionBtn = action
    ? h(
        'button.toast-action',
        {
          type: 'button',
          onClick: async () => {
            close('action');
            try {
              await action.onClick?.();
            } catch (err) {
              console.error('[daybook] toast action failed', err);
            }
          },
        },
        action.label || 'Undo'
      )
    : null;

  const el = h(
    'div.toast',
    { class: `toast-${type}`, role: type === 'error' ? 'alert' : null },
    icon(TOAST_ICONS[type] || 'info', { size: 20, class: 'toast-icon' }),
    h('div.toast-msg', message),
    actionBtn
  );

  function start() {
    if (closed || !(life > 0) || life === Infinity) return;
    startedAt = Date.now();
    clearTimeout(timer);
    timer = setTimeout(() => close('timeout'), remaining);
  }
  function pause() {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    remaining = Math.max(900, remaining - (Date.now() - startedAt));
  }
  function close(reason = 'close') {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    el.classList.add('is-leaving');
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      el.remove();
    };
    el.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 260);
    try {
      onClose?.(reason);
    } catch (err) {
      console.error('[daybook] toast onClose failed', err);
    }
  }

  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', start);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', start);

  // Swipe sideways to dismiss.
  let sx = 0;
  let dx = 0;
  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    dragging = true;
    sx = e.clientX;
    dx = 0;
    el.style.transition = 'none';
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - sx;
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 220));
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    el.style.transition = '';
    if (Math.abs(dx) > 80) {
      el.style.transform = `translateX(${dx > 0 ? 120 : -120}%)`;
      el.style.opacity = '0';
      close('swipe');
    } else {
      el.style.transform = '';
      el.style.opacity = '';
    }
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  const live = Array.from(stack.children).filter((c) => !c.classList.contains('is-leaving'));
  while (live.length >= 3) {
    const old = live.shift();
    old.__close ? old.__close('overflow') : old.remove();
  }
  el.__close = close;
  stack.appendChild(el);
  start();
  return { el, close: () => close('close') };
}

// ════════════════════════════════════════════════════════════════════════════ sheets

const sheetStack = [];
const NON_SUBMIT_INPUTS = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image']);

/**
 * openSheet({ title, subtitle, content, actions, size='md'|'lg'|'full'|'sm', onClose, accent, icon,
 *             dismissible=true, guard, className, initialFocus })
 * → api { el, body, footer, header, layer, close(result), setBusy(bool), result: Promise, setTitle, setSubtitle,
 *         setActions, submit, dismiss }
 */
export function openSheet(opts = {}) {
  const {
    title = '',
    subtitle,
    content,
    actions = [],
    size = 'md',
    onClose,
    accent,
    icon: iconName,
    dismissible = true,
    guard,
    className,
    initialFocus,
    role = 'dialog',
    hideHeader = false,
    labelledBy,
    describedBy,
  } = opts;

  let resolveResult;
  const result = new Promise((r) => {
    resolveResult = r;
  });
  let closed = false;
  let busy = false;
  let busyTimer = 0;
  const opener = document.activeElement;
  const titleId = uniqueId('sheet-title');
  const subId = uniqueId('sheet-sub');

  const backdrop = h('div.sheet-backdrop', { 'aria-hidden': 'true' });
  const titleEl = h('h2.sheet-title', { id: titleId }, title);
  const subEl = h('p.sheet-subtitle', { id: subId, hidden: !subtitle }, subtitle || '');
  const closeBtn = dismissible
    ? h('button.btn.btn-ghost.btn-icon.sheet-close', { type: 'button', 'aria-label': 'Close', onClick: () => dismiss() }, icon('x', { size: 20 }))
    : null;
  const header = hideHeader
    ? null
    : h(
        'div.sheet-header',
        iconName ? iconChip(iconName, { accent }) : null,
        h('div.sheet-titles', titleEl, subEl),
        closeBtn
      );
  const handle = h('div.sheet-handle', { 'aria-hidden': 'true' });
  const body = h('div.sheet-body');
  const footer = h('div.sheet-footer', { hidden: true });
  const sheet = h(
    'div.sheet',
    {
      class: [`sheet-${size}`, className, { 'has-accent': !!accent, 'is-alert': hideHeader }],
      role,
      'aria-modal': 'true',
      'aria-labelledby': labelledBy || (title && !hideHeader ? titleId : null),
      'aria-label': !labelledBy && (hideHeader || !title) ? title || 'Dialog' : null,
      'aria-describedby': describedBy || (subtitle && !hideHeader ? subId : null),
      tabindex: '-1',
      style: accent ? { '--accent': colorVar(accent) } : null,
    },
    handle,
    header,
    body,
    footer
  );
  const layer = h('div.sheet-layer', sheet);
  layer.insertBefore(backdrop, sheet);

  let actionList = [];
  let primaryBtn = null;

  const api = {
    el: sheet,
    body,
    footer,
    header,
    layer,
    result,
    close,
    setBusy,
    dismiss,
    submit,
    setTitle(t) {
      titleEl.textContent = t == null ? '' : String(t);
    },
    setSubtitle(t) {
      subEl.textContent = t == null ? '' : String(t);
      subEl.hidden = !t;
    },
    setActions: renderActions,
    get isOpen() {
      return !closed;
    },
  };

  function renderActions(list = []) {
    actionList = toArray(list).filter(Boolean);
    primaryBtn = null;
    const start = h('div.sheet-footer-start');
    const end = h('div.sheet-footer-end');
    for (const a of actionList) {
      const variant = a.variant || 'secondary';
      const btn = h(
        'button.btn',
        {
          type: 'button',
          class: [VARIANTS[variant] ?? VARIANTS.secondary, a.class],
          disabled: a.disabled || busy,
          dataset: a.id ? { action: a.id } : null,
          onClick: () => runAction(a, btn),
        },
        maybeIcon(a.icon, { size: 18 }),
        h('span', a.label)
      );
      btn.__action = a;
      if (!primaryBtn && variant === 'primary') primaryBtn = { a, btn };
      const align = a.align || (variant === 'danger' || variant === 'danger-solid' ? (actionList.length > 1 ? 'start' : 'end') : 'end');
      (align === 'start' ? start : end).appendChild(btn);
    }
    footer.replaceChildren(start, end);
    footer.hidden = actionList.length === 0;
    body.classList.toggle('is-last', actionList.length === 0);
  }

  async function runAction(a, btn) {
    if (busy || closed) return;
    if (typeof a.onClick !== 'function') {
      close(a.value !== undefined ? a.value : null);
      return;
    }
    setBusy(true, btn);
    let r;
    try {
      r = await a.onClick(api);
    } catch (err) {
      console.error('[daybook] sheet action failed:', err);
      toast('Something went wrong — please try again.', { type: 'error' });
      r = false;
    }
    if (closed) return;
    setBusy(false);
    if (r === false) return;
    close(r === undefined ? null : r);
  }

  function setBusy(on, btn) {
    busy = !!on;
    sheet.classList.toggle('is-busy', busy);
    sheet.setAttribute('aria-busy', busy ? 'true' : 'false');
    clearTimeout(busyTimer);
    footer.querySelectorAll('button').forEach((b) => {
      const a = b.__action;
      b.disabled = busy || !!(a && a.disabled);
      if (!busy) {
        b.classList.remove('is-busy');
        b.querySelector(':scope > .spinner')?.remove();
      }
    });
    if (closeBtn) closeBtn.disabled = busy;
    if (busy && btn) {
      // Only show a spinner when the work is noticeable (avoids a flash on fast saves).
      busyTimer = setTimeout(() => {
        if (!busy || closed || sheetStack[sheetStack.length - 1] !== entry) return; // not behind a nested dialog
        btn.classList.add('is-busy');
        btn.prepend(spinner({ size: 16 }));
      }, 140);
    }
  }

  function submit() {
    if (busy || closed) return;
    const p = primaryBtn || (actionList.length ? { a: actionList[actionList.length - 1], btn: footer.querySelector('.sheet-footer-end > .btn:last-child') } : null);
    if (p) runAction(p.a, p.btn);
  }

  async function dismiss() {
    if (closed || busy || !dismissible) return;
    if (typeof guard === 'function') {
      let ok = true;
      try {
        ok = await guard(api);
      } catch (err) {
        console.error('[daybook] sheet guard failed', err);
      }
      if (ok === false || closed) return;
    }
    close(null);
  }

  // ---- content
  renderActions(actions);
  let built = null;
  built = typeof content === 'function' ? content(api) : content;
  appendChildren(body, [built]);
  body.querySelectorAll('form').forEach((f) => {
    f.noValidate = true;
  });

  // Enter in a form → primary action (unless the module handled submit itself).
  body.addEventListener('submit', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    submit();
  });
  // Browsers only submit implicitly when a form has a submit button or a single text field, and the sheet's
  // buttons live in the footer (outside the form). So Enter in any single-line input inside a <form> requests
  // a submit itself. Controls that use Enter (chip/tag inputs, pickers) call preventDefault() first.
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (!t || t.tagName !== 'INPUT' || NON_SUBMIT_INPUTS.has(String(t.type).toLowerCase())) return;
    const form = t.form;
    if (!form || !body.contains(form)) return;
    e.preventDefault();
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); // → listener above
  });

  // Hairline under the header once the body scrolls.
  body.addEventListener(
    'scroll',
    () => {
      if (header) header.classList.toggle('is-scrolled', body.scrollTop > 2);
    },
    { passive: true }
  );

  backdrop.addEventListener('click', () => dismiss());
  sheet.addEventListener('keydown', (e) => trapTab(e, sheet));

  // ---- swipe down to close (mobile: handle + header)
  let drag = null;
  const onDown = (e) => {
    if (!dismissible || busy || !isMobileLayout()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('button, a, input, select, textarea, [contenteditable="true"]')) return;
    drag = { y0: e.clientY, y: e.clientY, t: e.timeStamp, v: 0, dy: 0, target: e.currentTarget, id: e.pointerId };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    sheet.classList.add('is-dragging');
  };
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dt = Math.max(1, e.timeStamp - drag.t);
    drag.v = (e.clientY - drag.y) / dt;
    drag.y = e.clientY;
    drag.t = e.timeStamp;
    drag.dy = e.clientY - drag.y0;
    const y = drag.dy > 0 ? drag.dy : -Math.pow(-drag.dy, 0.6);
    sheet.style.transform = `translateY(${y}px)`;
  };
  const onUp = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const { dy, v } = drag;
    drag = null;
    sheet.classList.remove('is-dragging');
    sheet.style.transform = '';
    if (dy > Math.min(140, sheet.offsetHeight * 0.3) || (v > 0.55 && dy > 24)) dismiss();
  };
  for (const zone of [handle, header].filter(Boolean)) {
    zone.addEventListener('pointerdown', onDown);
    zone.addEventListener('pointermove', onMove);
    zone.addEventListener('pointerup', onUp);
    zone.addEventListener('pointercancel', onUp);
  }

  // ---- on-screen keyboard (visualViewport): lift the sheet above it and keep the focused field visible
  const vv = window.visualViewport;
  const onViewport = () => {
    if (!vv) return;
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    layer.style.setProperty('--kb', kb > 80 ? kb + 'px' : '0px');
    const a = document.activeElement;
    if (kb > 80 && a && body.contains(a) && typeof a.scrollIntoView === 'function') {
      requestAnimationFrame(() => a.scrollIntoView({ block: 'nearest' }));
    }
  };
  if (vv) vv.addEventListener('resize', onViewport);

  // ---- mount
  const below = sheetStack[sheetStack.length - 1];
  if (below) {
    layer.classList.add('is-stacked');
    below.sheet.classList.add('is-covered');
  }
  const entry = { sheet, layer, api };
  sheetStack.push(entry);
  document.body.appendChild(layer);
  const restoreInert = isolate(layer);
  lockScroll();
  const popEsc = pushEscape(() => dismiss());
  void layer.offsetWidth; // commit the closed state so the open transition runs
  layer.classList.add('is-open');

  // ---- initial focus
  let target = null;
  if (initialFocus) target = typeof initialFocus === 'string' ? sheet.querySelector(initialFocus) : initialFocus;
  if (!target) target = body.querySelector('[autofocus]');
  if (!focusEl(target)) focusEl(sheet);

  function close(value = null) {
    if (closed) return;
    closed = true;
    clearTimeout(busyTimer);
    const idx = sheetStack.indexOf(entry);
    const wasTop = idx === sheetStack.length - 1;
    if (idx >= 0) sheetStack.splice(idx, 1);
    if (wasTop) sheetStack[sheetStack.length - 1]?.sheet.classList.remove('is-covered');
    popEsc();
    restoreInert();
    unlockScroll();
    if (vv) vv.removeEventListener('resize', onViewport);

    // Return focus first (keyboard users never lose their place), then animate out.
    const active = document.activeElement;
    if (!active || active === document.body || layer.contains(active)) {
      if (!(opener && opener.isConnected && focusEl(opener))) {
        const top = sheetStack[sheetStack.length - 1];
        if (top) focusEl(top.sheet);
        else if (active && layer.contains(active)) active.blur();
        // The opener may be a footer button disabled while its action awaits this dialog: retry once it re-enables.
        if (opener && opener.isConnected && opener.disabled) {
          setTimeout(() => {
            const now = document.activeElement;
            if (opener.isConnected && !opener.disabled && (!now || now === document.body || (top && now === top.sheet))) focusEl(opener);
          }, 0);
        }
      }
    }

    layer.classList.remove('is-open');
    layer.classList.add('is-closing');
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      layer.remove();
    };
    sheet.addEventListener('transitionend', (e) => {
      if (e.target === sheet) remove();
    });
    setTimeout(remove, prefersReducedMotion() ? 30 : 420);

    resolveResult(value);
    if (typeof onClose === 'function') {
      try {
        onClose(value);
      } catch (err) {
        console.error('[daybook] sheet onClose failed', err);
      }
    }
  }

  return api;
}

/** confirmDialog({title, message, confirmLabel='Delete', cancelLabel='Cancel', danger=true, icon}) → Promise<boolean> */
export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true, icon: iconName } = {}) {
  const tid = uniqueId('confirm-title');
  const mid = uniqueId('confirm-msg');
  const glyph = iconName || (danger ? (/delete|remove|clear|discard/i.test(confirmLabel) ? 'trash' : 'alert') : 'help');
  const api = openSheet({
    title,
    size: 'sm',
    hideHeader: true,
    role: 'alertdialog',
    labelledBy: tid,
    describedBy: message ? mid : null,
    className: 'sheet-confirm',
    content: h(
      'div.confirm-body',
      iconChip(glyph, { accent: danger ? '--danger' : '--primary', size: 'lg', class: 'confirm-icon' }),
      h('div.confirm-text', h('h2.confirm-title', { id: tid }, title), message ? h('p.confirm-message', { id: mid }, message) : null)
    ),
    actions: [
      { label: cancelLabel, variant: 'secondary', value: false, align: 'end' },
      { label: confirmLabel, variant: danger ? 'danger-solid' : 'primary', value: true, align: 'end' },
    ],
  });
  const btns = api.footer.querySelectorAll('button');
  focusEl(danger ? btns[0] : btns[1]);
  return api.result.then((v) => v === true);
}

/**
 * promptDialog({title, message, label, value, placeholder, confirmLabel='Save', cancelLabel='Cancel', validate, inputProps})
 * → Promise<string|null>. validate(text) may return an error message (string) to keep the dialog open.
 */
export function promptDialog({ title = '', message, label = '', value = '', placeholder = '', confirmLabel = 'Save', cancelLabel = 'Cancel', validate, inputProps = {} } = {}) {
  const inp = input({ value, placeholder, autocomplete: 'off', autofocus: true, ...inputProps });
  const f = field(label || title, inp);
  const api = openSheet({
    title,
    subtitle: message,
    size: 'sm',
    content: h('form', f),
    actions: [
      { label: cancelLabel, variant: 'secondary', value: null },
      {
        label: confirmLabel,
        variant: 'primary',
        onClick: async () => {
          const text = inp.value.trim();
          const err = typeof validate === 'function' ? await validate(text) : !text ? 'Please enter something' : null;
          if (err) {
            f.setError(err);
            inp.focus();
            return false;
          }
          return text;
        },
      },
    ],
  });
  inp.addEventListener('input', () => f.setError(null));
  return api.result.then((v) => (typeof v === 'string' ? v : null));
}

// ════════════════════════════════════════════════════════════════════════════ forms

const LABELABLE = 'input:not([type="hidden"]):not([type="file"]), select, textarea';

/**
 * field(label, control, {hint, error, required, inline, aside}) → <div class="field"> (label + control + hint/error).
 * The returned element has .setError(msg|null), .setHint(msg|null) and .control.
 */
export function field(label, control, { hint, error, required = false, inline = false, aside, id } = {}) {
  const labelId = uniqueId('label');
  const hintId = uniqueId('hint');
  const errId = uniqueId('err');
  const target = control && control.matches && control.matches(LABELABLE) ? control : control && control.querySelector ? control.querySelector(LABELABLE) : null;
  const isGroup = !target;
  if (target && !target.id) target.id = id || uniqueId('field');
  if (target) target.removeAttribute('aria-label');

  const labelKids = [h('span.field-label-text', label), required ? h('span.field-req', { 'aria-hidden': 'true' }, '*') : null, aside ? h('span.field-label-aside', aside) : null];
  const labelEl = isGroup ? h('div.field-label', { id: labelId }, labelKids) : h('label.field-label', { id: labelId, for: target.id }, labelKids);
  const hintEl = h('div.field-hint', { id: hintId, hidden: !hint }, hint || '');
  const errEl = h('div.field-error', { id: errId, hidden: !error, role: 'alert' });

  const wrap = h('div.field', { class: { 'field-inline': inline, 'has-error': !!error } }, labelEl, control, hintEl, errEl);
  const describe = control && control.nodeType === 1 ? (target || control) : null;

  if (isGroup && control && control.setAttribute) {
    if (control.getAttribute('role')) control.setAttribute('aria-labelledby', labelId);
    else {
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-labelledby', labelId);
    }
  }
  if (required && describe) describe.setAttribute('aria-required', 'true');

  function syncDescribed() {
    if (!describe) return;
    const ids = [];
    if (!hintEl.hidden) ids.push(hintId);
    if (!errEl.hidden) ids.push(errId);
    if (ids.length) describe.setAttribute('aria-describedby', ids.join(' '));
    else describe.removeAttribute('aria-describedby');
  }

  wrap.setError = (msg) => {
    const on = !!msg;
    wrap.classList.toggle('has-error', on);
    errEl.hidden = !on;
    errEl.replaceChildren();
    if (on) errEl.append(icon('alert', { size: 14 }), h('span', msg));
    if (describe) {
      if (on) describe.setAttribute('aria-invalid', 'true');
      else describe.removeAttribute('aria-invalid');
    }
    syncDescribed();
    return wrap;
  };
  wrap.setHint = (msg) => {
    hintEl.textContent = msg || '';
    hintEl.hidden = !msg;
    syncDescribed();
    return wrap;
  };
  wrap.control = control;
  wrap.input = target;
  if (error) wrap.setError(error);
  else syncDescribed();
  return wrap;
}

/** <input class="input">. type=number gets step="any" inputmode="decimal" by default. */
export function input(props = {}) {
  const p = { type: 'text', ...props };
  if (p.type === 'number') {
    if (p.step === undefined) p.step = 'any';
    if (p.inputmode === undefined && p.inputMode === undefined) p.inputmode = 'decimal';
  }
  return h('input.input', p);
}

const FIELD_SIZING = HAS_DOM && typeof CSS !== 'undefined' && CSS.supports && CSS.supports('field-sizing', 'content');

/** <textarea class="textarea"> that grows with its content. el.autogrow() re-measures after value changes. */
export function textarea(props = {}) {
  const el = h('textarea.textarea', { rows: 3, ...props });
  el.autogrow = () => {};
  if (!FIELD_SIZING) {
    el.classList.add('is-autogrow');
    const grow = () => {
      if (!el.isConnected) return;
      const max = Math.round(window.innerHeight * 0.6);
      el.style.height = 'auto';
      const hgt = Math.min(el.scrollHeight + 2, max);
      el.style.height = hgt + 'px';
      el.style.overflowY = el.scrollHeight + 2 > max ? 'auto' : 'hidden';
    };
    el.autogrow = grow;
    el.addEventListener('input', grow);
    if (typeof ResizeObserver === 'function') {
      let lastW = 0;
      const ro = new ResizeObserver(() => {
        const w = el.clientWidth;
        if (w && w !== lastW) {
          lastW = w;
          grow();
        }
      });
      ro.observe(el);
    }
  }
  return el;
}

/** select(options, value, onChange(value, event), props) — options: [{value,label,disabled}] | string[] */
export function select(options, value, onChange, props = {}) {
  const opts = normOptions(options);
  const el = h(
    'select.select',
    props,
    opts.map((o) => h('option', { value: String(o.value ?? ''), disabled: o.disabled }, o.label))
  );
  const setValue = (v) => {
    const i = opts.findIndex((o) => sameValue(o.value, v) || (v == null && (o.value === '' || o.value == null)));
    if (i >= 0) el.selectedIndex = i;
    else if (v != null && v !== '') el.selectedIndex = -1;
  };
  setValue(value);
  el.addEventListener('change', (e) => {
    const o = opts[el.selectedIndex];
    if (typeof onChange === 'function') onChange(o ? o.value : el.value, e);
  });
  el.setValue = setValue;
  el.getValue = () => {
    const o = opts[el.selectedIndex];
    return o ? o.value : null;
  };
  return el;
}

/** Roving-tabindex radiogroup keyboard support shared by segmented / rating / mood. */
function radioKeys(e, buttons, currentIndex, choose) {
  const enabled = buttons.map((b, i) => (b.disabled ? -1 : i)).filter((i) => i >= 0);
  if (!enabled.length) return;
  let pos = enabled.indexOf(currentIndex);
  if (pos < 0) pos = 0;
  let next = null;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = enabled[(pos + 1) % enabled.length];
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = enabled[(pos - 1 + enabled.length) % enabled.length];
      break;
    case 'Home':
      next = enabled[0];
      break;
    case 'End':
      next = enabled[enabled.length - 1];
      break;
    default:
      return;
  }
  e.preventDefault();
  choose(next);
  focusEl(buttons[next]);
}

/**
 * segmented(options, value, onChange, {size:'sm'|'md'|'lg', ariaLabel, block}) — options: [{value,label,icon}]
 * role=radiogroup with a sliding thumb and arrow-key navigation. Returns el with .setValue(v) / .getValue().
 */
export function segmented(options, value, onChange, { size = 'md', ariaLabel, block = false, class: cls } = {}) {
  const opts = normOptions(options);
  let current = value;
  const thumb = h('span.segmented-thumb', { 'aria-hidden': 'true' });
  const canThumb = typeof ResizeObserver === 'function';
  const el = h('div.segmented', {
    role: 'radiogroup',
    'aria-label': ariaLabel,
    class: [size !== 'md' && `segmented-${size}`, block && 'segmented-block', canThumb && 'has-thumb no-anim', cls],
  });
  const buttons = opts.map((o, i) =>
    h(
      'button.segmented-btn',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': 'false',
        'aria-label': o.label === '' || o.label == null ? o.ariaLabel || String(o.value) : o.ariaLabel || null,
        title: o.title,
        disabled: o.disabled,
        dataset: { value: String(o.value) },
        onClick: () => choose(i, true),
      },
      o.icon ? icon(o.icon, { size: size === 'sm' ? 14 : 16 }) : null,
      o.label !== '' && o.label != null ? h('span', o.label) : null
    )
  );
  if (canThumb) el.appendChild(thumb);
  buttons.forEach((b) => el.appendChild(b));

  const indexOf = (v) => opts.findIndex((o) => sameValue(o.value, v));

  function place() {
    if (!canThumb) return;
    const b = buttons[indexOf(current)];
    if (!b || !b.offsetWidth) {
      thumb.style.opacity = '0';
      return;
    }
    thumb.style.opacity = '';
    el.style.setProperty('--thumb-x', b.offsetLeft + 'px');
    el.style.setProperty('--thumb-w', b.offsetWidth + 'px');
  }

  function sync() {
    const idx = indexOf(current);
    buttons.forEach((b, i) => {
      b.setAttribute('aria-checked', i === idx ? 'true' : 'false');
      b.tabIndex = i === idx || (idx < 0 && i === 0) ? 0 : -1;
    });
    place();
  }

  function choose(i, fire) {
    const o = opts[i];
    if (!o || o.disabled) return;
    const changed = !sameValue(o.value, current);
    current = o.value;
    sync();
    if (fire && changed && typeof onChange === 'function') onChange(o.value);
  }

  el.addEventListener('keydown', (e) => radioKeys(e, buttons, indexOf(current), (i) => choose(i, true)));

  if (canThumb) {
    let first = true;
    const ro = new ResizeObserver(() => {
      place();
      if (first && el.offsetWidth) {
        first = false;
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('no-anim')));
      }
    });
    ro.observe(el);
    buttons.forEach((b) => ro.observe(b));
  }

  sync();
  el.setValue = (v) => {
    current = v;
    sync();
  };
  el.getValue = () => current;
  return el;
}

/**
 * chips(options, selected, onChange, {multiple, allowAdd, onAdd, ariaLabel, size, scroll, deselect=true, addLabel})
 * options: [{value,label,emoji,icon,color}] | string[]; onChange(value|null) or onChange(values[]).
 * allowAdd shows a '+ Add' chip that turns into an inline input; Enter adds (onAdd(text) may return
 * false to cancel, a value, or an option object; may be async). Returns el with setValue/getValue/setOptions.
 */
export function chips(options, selected, onChange, { multiple = false, allowAdd = false, onAdd, ariaLabel, size, scroll = false, deselect = true, addLabel = 'Add', class: cls } = {}) {
  let opts = normOptions(options);
  let sel = multiple ? new Set(toArray(selected).map(String)) : selected ?? null;
  const el = h('div.chips', { role: 'group', 'aria-label': ariaLabel, class: [scroll && 'chips-scroll', cls] });

  // Keep selected values that are no longer offered (e.g. a renamed setting) visible instead of dropping them.
  function keepUnknown() {
    const known = new Set(opts.map((o) => String(o.value)));
    const chosen = multiple ? [...sel] : sel === null || sel === undefined || sel === '' ? [] : [sel];
    for (const v of chosen) if (!known.has(String(v))) opts.push({ value: v, label: String(v) });
  }
  keepUnknown();

  const isSel = (v) => (multiple ? sel.has(String(v)) : sameValue(v, sel));

  function chipEl(o) {
    const b = h(
      'button.chip',
      {
        type: 'button',
        'aria-pressed': 'false',
        class: [size === 'sm' && 'chip-sm'],
        style: o.color ? { '--accent': colorVar(o.color) } : null,
        disabled: o.disabled,
        title: o.title,
        dataset: { value: String(o.value) },
        onClick: () => toggle(o.value),
      },
      multiple ? icon('check', { size: 14, strokeWidth: 2.5, class: 'chip-check' }) : null,
      o.emoji ? h('span.chip-emoji', { 'aria-hidden': 'true' }, o.emoji) : o.icon ? icon(o.icon, { size: 16 }) : o.dot ? h('span.chip-dot') : null,
      h('span.chip-label', o.label)
    );
    b.__value = o.value;
    return b;
  }

  function output() {
    if (!multiple) return sel;
    const ordered = opts.map((o) => o.value).filter((v) => sel.has(String(v)));
    return ordered;
  }

  function sync() {
    el.querySelectorAll(':scope > .chip:not(.chip-add):not(.chip-input-wrap)').forEach((b) => {
      const on = isSel(b.__value);
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function toggle(v) {
    if (multiple) {
      const k = String(v);
      if (sel.has(k)) sel.delete(k);
      else sel.add(k);
    } else if (sameValue(v, sel)) {
      if (!deselect) return;
      sel = null;
    } else {
      sel = v;
    }
    sync();
    if (typeof onChange === 'function') onChange(output());
  }

  let addChip = null;
  function makeAddChip() {
    return h('button.chip.chip-add', { type: 'button', class: [size === 'sm' && 'chip-sm'], onClick: () => startAdd() }, icon('plus', { size: 15 }), h('span.chip-label', addLabel));
  }

  function startAdd() {
    const inp = h('input.chip-input', {
      type: 'text',
      placeholder: 'New…',
      'aria-label': `Add ${ariaLabel ? ariaLabel.toLowerCase() : 'option'}`,
      enterkeyhint: 'done',
      autocomplete: 'off',
    });
    const wrap = h('span.chip.chip-input-wrap', { onClick: () => inp.focus() }, inp);
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const text = inp.value.trim();
      if (commit && text) await addValue(text);
      addChip = makeAddChip();
      wrap.replaceWith(addChip);
      if (commit) focusEl(addChip);
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
        focusEl(addChip);
      }
    });
    inp.addEventListener('blur', () => setTimeout(() => finish(true), 0));
    addChip.replaceWith(wrap);
    inp.focus();
  }

  async function addValue(text) {
    const existing = opts.find((o) => String(o.label).toLowerCase() === text.toLowerCase() || String(o.value).toLowerCase() === text.toLowerCase());
    let opt = existing;
    if (!opt) {
      let r = text;
      if (typeof onAdd === 'function') {
        try {
          r = await onAdd(text);
        } catch (err) {
          console.error('[daybook] chips onAdd failed', err);
          toast('Couldn’t add that — please try again.', { type: 'error' });
          return;
        }
        if (r === false || r === null) return;
        if (r === undefined) r = text;
      }
      opt = normOptions([r])[0];
      opts.push(opt);
      const c = chipEl(opt);
      if (addChip && addChip.isConnected) el.insertBefore(c, addChip);
      else {
        const wrap = el.querySelector(':scope > .chip-input-wrap');
        if (wrap) el.insertBefore(c, wrap);
        else el.appendChild(c);
      }
    }
    if (!isSel(opt.value)) toggle(opt.value);
  }

  function render() {
    el.replaceChildren(...opts.map(chipEl));
    if (allowAdd) {
      addChip = makeAddChip();
      el.appendChild(addChip);
    }
    sync();
  }
  render();

  el.setValue = (v) => {
    sel = multiple ? new Set(toArray(v).map(String)) : v ?? null;
    const before = opts.length;
    keepUnknown();
    if (opts.length !== before) render();
    else sync();
  };
  el.getValue = output;
  el.setOptions = (next, v) => {
    opts = normOptions(next);
    if (v !== undefined) sel = multiple ? new Set(toArray(v).map(String)) : v ?? null;
    keepUnknown();
    render();
  };
  return el;
}

function normTag(t) {
  return String(t || '')
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** tagInput(tags, onChange(tags[]), {suggestions, placeholder}) — lowercase tags; Enter/comma adds, Backspace removes. */
export function tagInput(tags, onChange, { suggestions = [], placeholder = 'Add tag', max = 30 } = {}) {
  let list = [];
  for (const t of toArray(tags)) {
    const n = normTag(t);
    if (n && !list.includes(n)) list.push(n);
  }
  const fieldEl = h('input.tag-input-field', {
    type: 'text',
    placeholder,
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: false,
    enterkeyhint: 'done',
  });
  const box = h('div.tag-input', { onClick: (e) => { if (e.target === box) fieldEl.focus(); } });
  const sugg = h('div.tag-suggestions', { hidden: true, role: 'group', 'aria-label': 'Suggested tags' });
  const wrap = h('div.tag-input-wrap', box, sugg);

  function emit() {
    if (typeof onChange === 'function') onChange([...list]);
  }
  function add(raw) {
    let changed = false;
    for (const part of String(raw).split(',')) {
      const t = normTag(part);
      if (t && !list.includes(t) && list.length < max) {
        list.push(t);
        changed = true;
      }
    }
    if (changed) {
      render();
      emit();
    }
    return changed;
  }
  function remove(t) {
    list = list.filter((x) => x !== t);
    render();
    emit();
  }
  function render() {
    const tagEls = list.map((t) =>
      h(
        'span.tag',
        h('span.tag-hash', { 'aria-hidden': 'true' }, '#'),
        h('span', t),
        h('button.tag-remove', { type: 'button', 'aria-label': `Remove tag ${t}`, onClick: (e) => { e.stopPropagation(); remove(t); fieldEl.focus(); } }, icon('x', { size: 12, strokeWidth: 2.25 }))
      )
    );
    box.replaceChildren(...tagEls, fieldEl);
    renderSuggestions();
  }
  function renderSuggestions() {
    const q = normTag(fieldEl.value);
    const pool = [];
    for (const s of toArray(suggestions)) {
      const n = normTag(typeof s === 'object' ? s.value ?? s.label : s);
      if (n && !list.includes(n) && !pool.includes(n) && (!q || n.startsWith(q) || n.includes(q))) pool.push(n);
    }
    const items = pool.slice(0, 8);
    sugg.replaceChildren(
      ...items.map((t) =>
        h('button.chip.chip-sm', { type: 'button', onClick: () => { add(t); fieldEl.value = ''; renderSuggestions(); fieldEl.focus(); } }, icon('plus', { size: 13 }), h('span.chip-label', t))
      )
    );
    sugg.hidden = items.length === 0;
  }
  fieldEl.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',') && fieldEl.value.trim()) {
      e.preventDefault();
      add(fieldEl.value);
      fieldEl.value = '';
      renderSuggestions();
    } else if (e.key === ',') {
      e.preventDefault();
    } else if (e.key === 'Backspace' && !fieldEl.value && list.length) {
      e.preventDefault();
      remove(list[list.length - 1]);
      fieldEl.focus();
    } else if (e.key === 'Escape' && fieldEl.value) {
      e.preventDefault();
      fieldEl.value = '';
      renderSuggestions();
    }
  });
  fieldEl.addEventListener('input', () => {
    if (fieldEl.value.includes(',')) {
      add(fieldEl.value);
      fieldEl.value = '';
    }
    renderSuggestions();
  });
  fieldEl.addEventListener('blur', () => {
    if (fieldEl.value.trim()) {
      add(fieldEl.value);
      fieldEl.value = '';
      renderSuggestions();
    }
  });
  render();
  wrap.setTags = (t) => {
    list = [];
    for (const x of toArray(t)) {
      const n = normTag(x);
      if (n && !list.includes(n)) list.push(n);
    }
    render();
  };
  wrap.getTags = () => [...list];
  wrap.input = fieldEl;
  return wrap;
}

/** ratingInput(value, onChange(value|null), {max=5, icon='star', labels, ariaLabel, size}) — tap again to clear. */
export function ratingInput(value, onChange, { max = 5, icon: iconName = 'star', labels, ariaLabel = 'Rating', size } = {}) {
  let current = Number.isFinite(Number(value)) && value !== null ? Number(value) : null;
  const labelEl = h('span.rating-label', { 'aria-hidden': 'true' });
  const el = h('div.rating', { role: 'radiogroup', 'aria-label': ariaLabel, class: [size === 'sm' && 'rating-sm'] });
  const px = size === 'sm' ? 20 : 26;
  const buttons = Array.from({ length: max }, (_, i) => {
    const n = i + 1;
    const lbl = labels && labels[i] ? `${labels[i]} (${n} of ${max})` : `${n} of ${max}`;
    return h(
      'button.rating-btn',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': 'false',
        'aria-label': lbl,
        onClick: () => choose(current === n ? null : n, true),
        onPointerenter: (e) => {
          if (e.pointerType === 'mouse') preview(n);
        },
      },
      icon(iconName, { size: px })
    );
  });
  el.append(...buttons, labelEl);
  el.addEventListener('pointerleave', () => preview(null));

  function preview(n) {
    buttons.forEach((b, i) => b.classList.toggle('is-preview', n !== null && i < n && !(current && i < current)));
    labelEl.textContent = labels ? (n ? labels[n - 1] : current ? labels[current - 1] : '') || '' : '';
  }
  function sync() {
    buttons.forEach((b, i) => {
      const n = i + 1;
      b.classList.toggle('is-on', current !== null && n <= current);
      b.setAttribute('aria-checked', n === current ? 'true' : 'false');
      b.tabIndex = n === current || (current === null && i === 0) ? 0 : -1;
    });
    preview(null);
    labelEl.hidden = !labels;
  }
  function choose(n, fire) {
    if (n === current) return;
    current = n;
    sync();
    if (fire && typeof onChange === 'function') onChange(current);
  }
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace' || e.key === '0') {
      e.preventDefault();
      choose(null, true);
      return;
    }
    radioKeys(e, buttons, current ? current - 1 : -1, (i) => choose(i + 1, true));
  });
  sync();
  el.setValue = (v) => {
    current = v === null || v === undefined ? null : Number(v);
    sync();
  };
  el.getValue = () => current;
  return el;
}

const MOODS = ['😫', '😕', '😐', '🙂', '😄'];
const MOOD_LABELS = ['Awful', 'Low', 'Okay', 'Good', 'Great'];

/** moodPicker(value 1..5|null, onChange) — five faces with labels; tap again to clear. */
export function moodPicker(value, onChange, { labels = MOOD_LABELS, emojis = MOODS, ariaLabel = 'Mood' } = {}) {
  let current = value ? Number(value) : null;
  const el = h('div.mood-picker', { role: 'radiogroup', 'aria-label': ariaLabel });
  const buttons = emojis.map((emo, i) =>
    h(
      'button.mood-option',
      { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { mood: i + 1 }, onClick: () => choose(current === i + 1 ? null : i + 1, true) },
      h('span.mood-emoji', { 'aria-hidden': 'true' }, emo),
      h('span.mood-label', labels[i])
    )
  );
  el.append(...buttons);
  function sync() {
    el.classList.toggle('has-value', !!current);
    buttons.forEach((b, i) => {
      b.setAttribute('aria-checked', current === i + 1 ? 'true' : 'false');
      b.tabIndex = current === i + 1 || (!current && i === 2) ? 0 : -1;
    });
  }
  function choose(n, fire) {
    current = n;
    sync();
    if (fire && typeof onChange === 'function') onChange(current);
  }
  el.addEventListener('keydown', (e) => radioKeys(e, buttons, current ? current - 1 : 2, (i) => choose(i + 1, true)));
  sync();
  el.setValue = (v) => {
    current = v ? Number(v) : null;
    sync();
  };
  el.getValue = () => current;
  return el;
}

/**
 * stepper(value, onChange, {min=0, max=Infinity, step=1, label, unit, decimals}) — [−] value [+]; hold to repeat.
 * Returns el with setValue/getValue.
 */
export function stepper(value, onChange, { min = 0, max = Infinity, step = 1, label = 'Value', unit, decimals, inputProps = {} } = {}) {
  const dec = decimals ?? decimalsOf(step);
  const toNum = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  let current = toNum(value);
  const round = (v) => Math.round(v * 10 ** dec) / 10 ** dec;
  const clamp = (v) => Math.min(max, Math.max(min, v));

  const inp = h('input.stepper-input', {
    type: 'number',
    inputmode: dec > 0 ? 'decimal' : 'numeric',
    step: String(step),
    min: Number.isFinite(min) ? String(min) : null,
    max: Number.isFinite(max) ? String(max) : null,
    'aria-label': label,
    ...inputProps,
  });
  const minus = h('button.stepper-btn', { type: 'button', 'aria-label': `Decrease ${label.toLowerCase()}`, tabindex: '-1' }, icon('minus', { size: 18, strokeWidth: 2 }));
  const plus = h('button.stepper-btn', { type: 'button', 'aria-label': `Increase ${label.toLowerCase()}`, tabindex: '-1' }, icon('plus', { size: 18, strokeWidth: 2 }));
  const el = h('div.stepper', { role: 'group', 'aria-label': label }, minus, h('span.stepper-value', inp, unit ? h('span.stepper-unit', { 'aria-hidden': 'true' }, unit) : null), plus);

  function show() {
    const txt = current === null ? '' : String(round(current));
    if (document.activeElement !== inp || toNum(inp.value) !== current) inp.value = txt;
    el.style.setProperty('--stepper-ch', Math.max(2, (txt || '0').length + 1) + 'ch');
    minus.disabled = current !== null && current <= min;
    plus.disabled = current !== null && current >= max;
  }
  function set(v, fire = true) {
    const next = v === null ? null : clamp(round(v));
    if (next === current) {
      show();
      return;
    }
    current = next;
    show();
    if (fire && typeof onChange === 'function') onChange(current);
  }
  const floor = Number.isFinite(min) ? min : 0;
  const bump = (dir) => {
    if (current !== null) set(current + dir * step);
    else set(dir > 0 ? (floor > 0 ? floor : floor + step) : floor);
  };

  // Press & hold to repeat (pointer); keyboard/assistive clicks handled via click with detail 0.
  for (const [btn, dir] of [[minus, -1], [plus, 1]]) {
    let t1 = 0;
    let t2 = 0;
    const stop = () => {
      clearTimeout(t1);
      clearInterval(t2);
    };
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (btn.disabled) return;
      e.preventDefault();
      bump(dir);
      stop();
      t1 = setTimeout(() => {
        t2 = setInterval(() => {
          if (btn.disabled) stop();
          else bump(dir);
        }, 70);
      }, 420);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('click', (e) => {
      if (e.detail === 0) bump(dir);
    });
  }
  inp.addEventListener('input', () => {
    const v = toNum(inp.value);
    if (inp.value === '') {
      current = null;
      el.style.setProperty('--stepper-ch', '3ch');
      if (typeof onChange === 'function') onChange(null);
      return;
    }
    if (v !== null && v >= min && v <= max) {
      current = round(v);
      el.style.setProperty('--stepper-ch', Math.max(2, inp.value.length + 1) + 'ch');
      minus.disabled = current <= min;
      plus.disabled = current >= max;
      if (typeof onChange === 'function') onChange(current);
    }
  });
  inp.addEventListener('change', () => {
    const v = toNum(inp.value);
    if (v === null) set(null);
    else set(v);
    show();
  });
  show();
  el.setValue = (v) => {
    current = toNum(v);
    show();
  };
  el.getValue = () => current;
  el.input = inp;
  return el;
}

/** toggle(checked, onChange(checked), {label, ariaLabel, end, disabled}) → <label class="switch"> */
export function toggle(checked, onChange, { label, ariaLabel, end = false, disabled = false, hint } = {}) {
  const inp = h('input', { type: 'checkbox', role: 'switch', checked: !!checked, disabled, 'aria-label': label ? null : ariaLabel || 'Toggle' });
  inp.addEventListener('change', (e) => {
    if (typeof onChange === 'function') onChange(inp.checked, e);
  });
  const el = h(
    'label.switch',
    { class: { 'is-end': end } },
    inp,
    h('span.switch-track', { 'aria-hidden': 'true' }, h('span.switch-thumb')),
    label ? h('span.switch-label', label, hint ? h('span.switch-hint', hint) : null) : null
  );
  el.input = inp;
  el.setChecked = (v) => {
    inp.checked = !!v;
  };
  el.getValue = () => inp.checked;
  return el;
}

/** checkbox(checked, onChange(checked), {label, strike}) → <label class="checkbox"> */
export function checkbox(checked, onChange, { label, strike = false, ariaLabel, accent } = {}) {
  const inp = h('input', { type: 'checkbox', checked: !!checked, 'aria-label': label ? null : ariaLabel || 'Done' });
  inp.addEventListener('change', (e) => {
    if (typeof onChange === 'function') onChange(inp.checked, e);
  });
  const el = h('label.checkbox', { style: accent ? { '--accent': colorVar(accent) } : null }, inp, label ? h('span.checkbox-label', { class: { strike } }, label) : null);
  el.input = inp;
  el.setChecked = (v) => {
    inp.checked = !!v;
  };
  return el;
}

/** range(value, onChange(number), {min, max, step, label, accent, onInput}) → <input type=range class="range"> */
export function range(value, onChange, { min = 0, max = 100, step = 1, label, accent, ...props } = {}) {
  const el = h('input.range', { type: 'range', min, max, step, value: value ?? min, 'aria-label': label, style: accent ? { '--accent': colorVar(accent) } : null, ...props });
  const paint = () => {
    const pct = ((Number(el.value) - min) / (max - min || 1)) * 100;
    el.style.setProperty('--pct', pct + '%');
  };
  el.addEventListener('input', (e) => {
    paint();
    if (typeof onChange === 'function') onChange(Number(el.value), e);
  });
  paint();
  el.setValue = (v) => {
    el.value = v;
    paint();
  };
  return el;
}

/** moneyInput(value, onInput(number|null, event), props) — input with the currency symbol as a prefix. */
export function moneyInput(value, onInput, props = {}) {
  const { currency, size, class: cls, ...rest } = props || {};
  const lg = size === 'lg' || classList(cls).includes('input-lg');
  const inp = h('input.input', {
    type: 'number',
    step: 'any',
    inputmode: 'decimal',
    min: '0',
    placeholder: '0',
    autocomplete: 'off',
    ...rest,
    class: [cls, lg && 'input-lg'],
    value: value === null || value === undefined || !Number.isFinite(Number(value)) ? '' : String(value),
  });
  const parse = () => (inp.value === '' || !Number.isFinite(Number(inp.value)) ? null : Number(inp.value));
  inp.addEventListener('input', (e) => {
    if (typeof onInput === 'function') onInput(parse(), e);
  });
  const el = h(
    'div.input-affix',
    { class: { 'input-affix-lg': lg }, onClick: (e) => { if (e.target !== inp) inp.focus(); } },
    h('span.affix', { 'aria-hidden': 'true' }, currencySymbol(currency)),
    inp
  );
  el.input = inp;
  el.setValue = (v) => {
    inp.value = v === null || v === undefined ? '' : String(v);
  };
  el.getValue = parse;
  return el;
}

// ════════════════════════════════════════════════════════════════════════════ layout & display

/** emptyState({icon, title, message, action:{label,onClick,icon}, actions, accent, compact}) */
export function emptyState({ icon: iconName = 'sparkles', title, message, action, actions = [], accent, compact = false, class: cls } = {}) {
  const btns = [];
  if (action) btns.push(actionNode(action, { variant: 'primary' }));
  for (const a of toArray(actions)) btns.push(actionNode(a, { variant: 'secondary' }));
  return h(
    'div.empty-state',
    { class: [compact && 'is-compact', cls], style: accent ? { '--accent': colorVar(accent) } : null },
    h('div.empty-state-icon', { 'aria-hidden': 'true' }, maybeIcon(iconName, { size: compact ? 22 : 28 })),
    title ? h('h3.empty-state-title', title) : null,
    message ? h('p.empty-state-message', message) : null,
    btns.length ? h('div.empty-state-actions', btns) : null
  );
}

/** pageHeader({title, subtitle, actions=[], back}) — back: path ('/trades') or function. One <h1> per page. */
export function pageHeader({ title, subtitle, actions = [], back, class: cls, children } = {}) {
  const backBtn = back
    ? h(
        'button.btn.btn-ghost.btn-icon.page-back',
        {
          type: 'button',
          'aria-label': 'Back',
          title: 'Back',
          onClick: () => (typeof back === 'function' ? back() : navigate(back)),
        },
        icon('arrow-left', { size: 20 })
      )
    : null;
  const acts = toArray(actions).map((a) => actionNode(a, { variant: 'secondary' }));
  return h(
    'header.page-header',
    { class: cls },
    h(
      'div.page-header-main',
      backBtn,
      h('div.page-header-text', h('h1.page-title', { tabindex: '-1' }, title), subtitle ? h('p.page-subtitle', subtitle) : null)
    ),
    acts.length ? h('div.page-actions', acts) : null,
    children
  );
}

/** section({title, action:{label, onClick|href}, children, class}) → <section class="section"> with .section-title */
export function section({ title, action, children, class: cls, id } = {}) {
  let link = null;
  if (action instanceof Node) link = action;
  else if (action) {
    link = action.href
      ? h('a.section-link', { href: action.href }, action.label, icon('chevron-right', { size: 16 }))
      : h('button.section-link', { type: 'button', onClick: action.onClick }, action.label, icon('chevron-right', { size: 16 }));
  }
  return h('section.section', { class: cls, id }, title ? h('h2.section-title', title, link) : null, children);
}

/** card({title, subtitle, icon, accent, actions, children, class, flush=false}) — accent sets --accent (icon chip). Add class 'card-accent' for the tinted top hairline. */
export function card({ title, subtitle, icon: iconName, emoji, accent, actions, children, class: cls, flush = false, titleTag = 'h2', onClick, id } = {}) {
  const acts = toArray(actions).map((a) => actionNode(a, { variant: 'ghost', size: 'sm' }));
  const hasHeader = title || subtitle || iconName || emoji || acts.length;
  const header = hasHeader
    ? h(
        'div.card-header',
        iconName || emoji ? iconChip(iconName, { emoji }) : null,
        h('div.card-header-text', title ? h(`${titleTag}.card-title`, title) : null, subtitle ? h('p.card-subtitle', subtitle) : null),
        acts.length ? h('div.card-actions', acts) : null
      )
    : null;
  const body = flush ? null : h('div.card-body', children);
  const el = h(
    onClick ? 'div.card.card-interactive' : 'section.card',
    {
      class: [flush && 'card-flush', cls],
      style: accent ? { '--accent': colorVar(accent) } : null,
      role: onClick ? 'button' : null,
      tabindex: onClick ? '0' : null,
      onClick: onClick
        ? (e) => {
            if (e.target.closest && e.target.closest('.card-actions')) return; // header actions keep their own click
            onClick(e);
          }
        : null,
      onKeydown: onClick
        ? (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
              e.preventDefault();
              onClick(e);
            }
          }
        : null,
      id,
    },
    header,
    flush ? children : body
  );
  el.body = body || el;
  return el;
}

/**
 * statTile({label, value, sub, delta, deltaGood='up', tone, accent, icon, onClick, unit})
 * delta is a fraction (0.12 → ▲ 12%); good/bad colour follows deltaGood. tone 'profit'|'loss' colours the value.
 */
export function statTile({ label, value, sub, delta, deltaGood = 'up', deltaLabel, tone, accent, icon: iconName, onClick, unit, class: cls } = {}) {
  let deltaEl = null;
  if (typeof delta === 'number' && Number.isFinite(delta)) {
    const dir = Math.abs(delta) < 0.0005 ? 'flat' : delta > 0 ? 'up' : 'down';
    const good = dir === 'flat' ? null : (dir === deltaGood) === true;
    const abs = Math.abs(delta);
    deltaEl = h(
      'span.stat-delta',
      { class: [dir !== 'flat' && dir, good === true && 'good', good === false && 'bad'], title: deltaLabel || null },
      dir === 'flat' ? icon('minus', { size: 13, strokeWidth: 2.25 }) : icon(dir === 'up' ? 'arrow-up-right' : 'arrow-down-right', { size: 13, strokeWidth: 2.25 }),
      h('span.sr-only', dir === 'up' ? 'Up ' : dir === 'down' ? 'Down ' : 'No change '),
      fmtPercent(abs, { decimals: abs >= 0.1 ? 0 : 1 })
    );
  }
  const val = typeof value === 'number' ? fmtNumber(value) : value ?? '—';
  return h(
    onClick ? 'button.stat' : 'div.stat',
    { class: cls, style: accent ? { '--accent': colorVar(accent) } : null, type: onClick ? 'button' : null, onClick },
    h('div.stat-head', h('span.stat-label', label), iconName ? iconChip(iconName, { size: 'sm' }) : null),
    h('div.stat-value', { class: { 'text-profit': tone === 'profit', 'text-loss': tone === 'loss' } }, val, unit ? h('span.stat-value-unit', unit) : null),
    deltaEl || sub ? h('div.stat-foot', deltaEl, sub ? h('span.stat-sub', sub) : null) : null
  );
}

/**
 * progressRing(fraction, {size=56, stroke=6, accent='--primary', label, sublabel, over, ariaLabel})
 * SVG ring that animates in. fraction > 1 draws the overflow as a second, darker lap. el.update(fraction, {label, sublabel}).
 */
export function progressRing(fraction, { size = 56, stroke = 6, accent = '--primary', label, sublabel, over = false, ariaLabel } = {}) {
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const c = size / 2;
  const circle = (cls) => h('svg:circle', { class: cls, cx: c, cy: c, r, fill: 'none', 'stroke-width': stroke, 'stroke-linecap': 'round' });
  const track = circle('ring-track');
  const arc = circle('ring-arc');
  const arcOver = circle('ring-arc-over');
  for (const a of [arc, arcOver]) {
    a.setAttribute('stroke-dasharray', `${C} ${C}`);
    a.setAttribute('stroke-dashoffset', String(C));
  }
  const svg = h('svg:svg', { class: 'ring-svg', viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true', focusable: 'false' }, track, arc, arcOver);
  const valueEl = h('span.ring-value');
  const subEl = h('span.ring-sub');
  const el = h('div.ring', { role: 'img', style: { '--ring-size': size + 'px', '--accent': colorVar(accent) } }, svg, h('div.ring-label', valueEl, subEl));

  let first = true;
  function update(f, opts = {}) {
    const v = Number.isFinite(Number(f)) ? Math.max(0, Number(f)) : 0;
    const main = Math.min(1, v);
    const extra = Math.min(1, Math.max(0, v - 1));
    const isOver = opts.over !== undefined ? opts.over : over;
    el.classList.toggle('is-over', !!isOver);
    const apply = () => {
      arc.setAttribute('stroke-dashoffset', String(C * (1 - main)));
      arc.style.opacity = main > 0 ? '1' : '0';
      arcOver.setAttribute('stroke-dashoffset', String(C * (1 - extra)));
      arcOver.style.opacity = extra > 0 ? '1' : '0';
    };
    if (first && !prefersReducedMotion()) {
      first = false;
      arc.style.opacity = main > 0 ? '1' : '0';
      requestAnimationFrame(() => requestAnimationFrame(apply));
    } else {
      first = false;
      apply();
    }
    const lab = opts.label !== undefined ? opts.label : label;
    const sub = opts.sublabel !== undefined ? opts.sublabel : sublabel;
    mount(valueEl, lab ?? '');
    mount(subEl, sub ?? '');
    valueEl.hidden = lab === undefined || lab === null || lab === '';
    subEl.hidden = sub === undefined || sub === null || sub === '';
    const text = [typeof lab === 'string' || typeof lab === 'number' ? lab : null, typeof sub === 'string' ? sub : null].filter((x) => x !== null && x !== '').join(' ');
    const al = opts.ariaLabel !== undefined ? opts.ariaLabel : ariaLabel;
    el.setAttribute('aria-label', al || `${text ? text + ' — ' : ''}${Math.round(v * 100)}%`);
  }
  update(fraction);
  el.update = update;
  return el;
}

/** progressBar(fraction, {accent='--primary', over=false, height=8, label}) — el.update(fraction, {over}). */
export function progressBar(fraction, { accent = '--primary', over = false, height = 8, label } = {}) {
  const fill = h('div.progress-fill');
  const el = h('div.progress', {
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-label': label || null,
    style: { '--accent': colorVar(accent), '--progress-h': height + 'px' },
  }, fill);
  let first = true;
  function update(f, opts = {}) {
    const v = Number.isFinite(Number(f)) ? Math.max(0, Number(f)) : 0;
    const isOver = opts.over !== undefined ? opts.over : over;
    el.classList.toggle('is-over', !!isOver);
    el.classList.toggle('is-done', v >= 1 && !isOver);
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    const apply = () => el.style.setProperty('--value', String(Math.min(1, v)));
    if (first && !prefersReducedMotion()) {
      first = false;
      el.style.setProperty('--value', '0');
      requestAnimationFrame(() => requestAnimationFrame(apply));
    } else {
      first = false;
      apply();
    }
  }
  update(fraction);
  el.update = update;
  return el;
}

/** listItem({icon, emoji, accent, title, meta, trail, trailMeta, onClick, href, chevron, class}) */
export function listItem({ icon: iconName, emoji, accent, lead, title, meta, trail, trailMeta, onClick, href, chevron = false, class: cls, ariaLabel } = {}) {
  const metaKids = toArray(meta).filter((m) => m !== null && m !== undefined && m !== false && m !== '');
  const metaEl = metaKids.length ? h('div.list-item-meta', metaKids.map((m, i) => [i > 0 ? h('span.sep', { 'aria-hidden': 'true' }) : null, typeof m === 'object' ? m : h('span', m)])) : null;
  const leadEl = lead || iconName || emoji ? h('div.list-item-icon', lead || iconChip(iconName, { emoji, accent })) : null;
  const trailEl = trail !== undefined && trail !== null || trailMeta ? h('div.list-item-trail', trail ?? null, trailMeta ? h('div.list-item-meta', trailMeta) : null) : null;
  const tag = href ? 'a.list-item' : onClick ? 'button.list-item' : 'div.list-item';
  return h(
    tag,
    { class: cls, href, type: onClick && !href ? 'button' : null, onClick, 'aria-label': ariaLabel, style: accent ? { '--accent': colorVar(accent) } : null },
    leadEl,
    h('div.list-item-main', h('div.list-item-title', title), metaEl),
    trailEl,
    chevron ? icon('chevron-right', { size: 18, class: 'list-item-chevron' }) : null
  );
}

/** listGroupHeader(label, trail) → <div class="list-group-header"> (e.g. 'Mon, 24 Nov' · '₹1,240'). */
export function listGroupHeader(label, trail, { sticky = false } = {}) {
  return h('div.list-group-header', { class: { 'is-sticky': sticky } }, h('span', label), trail !== undefined && trail !== null ? h('span', trail) : null);
}

/** kv(pairs, {grid}) — pairs: [[label, value], …] | [{label, value, tone}] → <dl class="kv"> */
export function kv(pairs, { grid = false, class: cls } = {}) {
  return h(
    'dl.kv',
    { class: [grid && 'kv-grid', cls] },
    toArray(pairs)
      .filter(Boolean)
      .map((p) => {
        const [k, v, tone] = Array.isArray(p) ? p : [p.label, p.value, p.tone];
        return h('div', h('dt', k), h('dd', { class: { 'text-profit': tone === 'profit', 'text-loss': tone === 'loss' } }, v ?? '—'));
      })
  );
}

/**
 * table({columns, rows, compact, empty, footer, onRowClick, maxHeight})
 * columns: [{key | value(row), label, num, format(v,row), render(row) → Node, class}]
 */
export function table({ columns = [], rows = [], compact = false, empty = 'Nothing here yet', footer, onRowClick, maxHeight, caption } = {}) {
  const cellValue = (c, row) => {
    if (typeof c.render === 'function') return c.render(row);
    const v = typeof c.value === 'function' ? c.value(row) : row[c.key];
    return typeof c.format === 'function' ? c.format(v, row) : v ?? '—';
  };
  const head = h('thead', h('tr', columns.map((c) => h('th', { scope: 'col', class: [c.num && 'num', c.class] }, c.label ?? ''))));
  const bodyRows = rows.length
    ? rows.map((row) =>
        h(
          'tr',
          {
            class: { 'is-clickable': !!onRowClick },
            tabindex: onRowClick ? '0' : null,
            onClick: onRowClick ? () => onRowClick(row) : null,
            onKeydown: onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row); } : null,
          },
          columns.map((c) => h('td', { class: [c.num && 'num', c.wrap && 'wrap', c.class] }, cellValue(c, row)))
        )
      )
    : [h('tr', h('td.table-empty', { colspan: String(columns.length || 1) }, empty))];
  const foot = footer ? h('tfoot', h('tr', columns.map((c, i) => h('td', { class: [c.num && 'num', c.class] }, Array.isArray(footer) ? footer[i] ?? '' : typeof footer === 'object' ? footer[c.key] ?? '' : '')))) : null;
  return h(
    'div.table-wrap',
    { style: maxHeight ? { '--table-max-h': typeof maxHeight === 'number' ? maxHeight + 'px' : maxHeight } : null, tabindex: '0', role: 'region', 'aria-label': caption || 'Table' },
    h('table.table', { class: { 'table-compact': compact } }, caption ? h('caption.sr-only', caption) : null, head, h('tbody', bodyRows), foot)
  );
}

// ════════════════════════════════════════════════════════════════════════════ date & month navigation

const CAN_SHOW_PICKER = HAS_DOM && typeof HTMLInputElement !== 'undefined' && 'showPicker' in HTMLInputElement.prototype;

function relativeText(n, unitDays = 'day') {
  try {
    const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
    const a = Math.abs(n);
    if (a < 14) return rtf.format(n, unitDays);
    if (a < 60) return rtf.format(Math.round(n / 7), 'week');
    if (a < 730) return rtf.format(Math.round(n / 30.44), 'month');
    return rtf.format(Math.round(n / 365.25), 'year');
  } catch {
    return n < 0 ? `${-n} days ago` : `in ${n} days`;
  }
}

/** dateNav(date, onChange(key), {allowFuture=false}) — ‹ Today · Mon, 24 Nov › + 'Today' pill + native picker. */
export function dateNav(date, onChange, { allowFuture = false, min } = {}) {
  let cur = date || todayKey();
  const label = h('span.date-nav-label');
  const sub = h('span.date-nav-sub');
  const inp = h('input.date-nav-input', { type: 'date', tabindex: '-1', 'aria-hidden': 'true', min });
  const center = h('button.date-nav-center', { type: 'button', 'aria-haspopup': 'dialog' }, label, sub);
  const prev = h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Previous day', title: 'Previous day' }, icon('chevron-left', { size: 20 }));
  const next = h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Next day', title: 'Next day' }, icon('chevron-right', { size: 20 }));
  const todayBtn = h('button.btn.btn-sm.btn-pill.date-nav-today', { type: 'button' }, icon('rotate-ccw', { size: 14, strokeWidth: 2 }), h('span', 'Today'));
  const el = h(
    'div.date-nav',
    { role: 'group', 'aria-label': 'Date', class: { 'no-showpicker': !CAN_SHOW_PICKER } },
    h('div.date-nav-group', prev, h('div.date-nav-center-wrap', center, inp), next),
    todayBtn
  );

  function render() {
    const t = todayKey();
    const n = diffDays(t, cur); // cur - today
    const near = Math.abs(n) <= 1;
    const sameYear = cur.slice(0, 4) === t.slice(0, 4);
    label.textContent = near ? relativeDay(cur) : fmtDate(cur, sameYear ? 'medium' : 'mediumYear');
    sub.textContent = near ? fmtDate(cur, 'medium') : relativeText(n);
    center.setAttribute('aria-label', `${label.textContent}, ${sub.textContent}. Choose a date`);
    inp.value = cur;
    if (!allowFuture) inp.max = t;
    const atEnd = !allowFuture && cur >= t;
    if (atEnd && document.activeElement === next) focusEl(center);
    next.disabled = atEnd;
    todayBtn.hidden = cur === t;
  }
  function set(k, fire) {
    if (!k) return;
    const t = todayKey();
    if (!allowFuture && k > t) k = t;
    if (min && k < min) k = min;
    if (k === cur) return;
    cur = k;
    render();
    if (fire && typeof onChange === 'function') onChange(cur);
  }
  prev.addEventListener('click', () => set(addDays(cur, -1), true));
  next.addEventListener('click', () => set(addDays(cur, 1), true));
  todayBtn.addEventListener('click', () => {
    set(todayKey(), true);
    focusEl(center);
  });
  center.addEventListener('click', () => {
    if (CAN_SHOW_PICKER) {
      try {
        inp.showPicker();
        return;
      } catch {
        /* not allowed here — fall through */
      }
    }
    inp.focus();
    inp.click();
  });
  center.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      set(addDays(cur, -1), true);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      set(addDays(cur, 1), true);
    }
  });
  inp.addEventListener('change', () => {
    if (inp.value) set(inp.value, true);
  });
  render();
  el.setDate = (k) => {
    if (k) cur = k;
    render();
  };
  el.getDate = () => cur;
  return el;
}

/** monthNav(month 'YYYY-MM', onChange(month), {allowFuture=false}) — ‹ November 2026 › + month picker popover. */
export function monthNav(month, onChange, { allowFuture = false } = {}) {
  let cur = month || currentMonth();
  const label = h('span.date-nav-label');
  const center = h('button.date-nav-center', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, icon('calendar', { size: 16 }), label);
  const prev = h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Previous month', title: 'Previous month' }, icon('chevron-left', { size: 20 }));
  const next = h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Next month', title: 'Next month' }, icon('chevron-right', { size: 20 }));
  const nowBtn = h('button.btn.btn-sm.btn-pill.date-nav-today', { type: 'button' }, icon('rotate-ccw', { size: 14, strokeWidth: 2 }), h('span', 'This month'));
  const el = h('div.month-nav', { role: 'group', 'aria-label': 'Month' }, h('div.date-nav-group', prev, center, next), nowBtn);

  function render() {
    const now = currentMonth();
    label.textContent = fmtMonth(cur);
    center.setAttribute('aria-label', `${fmtMonth(cur)}. Choose a month`);
    const atEnd = !allowFuture && cur >= now;
    if (atEnd && document.activeElement === next) focusEl(center);
    next.disabled = atEnd;
    nowBtn.hidden = cur === now;
  }
  function set(m, fire) {
    const now = currentMonth();
    if (!allowFuture && m > now) m = now;
    if (m === cur) return;
    cur = m;
    render();
    if (fire && typeof onChange === 'function') onChange(cur);
  }
  prev.addEventListener('click', () => set(addMonths(cur, -1), true));
  next.addEventListener('click', () => set(addMonths(cur, 1), true));
  nowBtn.addEventListener('click', () => {
    set(currentMonth(), true);
    focusEl(center);
  });

  center.addEventListener('click', () => {
    let year = Number(cur.slice(0, 4));
    const yearEl = h('span.month-picker-year');
    const grid = h('div.month-picker-grid');
    const prevY = h('button.btn.btn-ghost.btn-icon.btn-sm', { type: 'button', 'aria-label': 'Previous year' }, icon('chevron-left', { size: 18 }));
    const nextY = h('button.btn.btn-ghost.btn-icon.btn-sm', { type: 'button', 'aria-label': 'Next year' }, icon('chevron-right', { size: 18 }));
    const content = h('div.month-picker', h('div.month-picker-head', prevY, yearEl, nextY), grid);
    const draw = () => {
      const now = currentMonth();
      yearEl.textContent = String(year);
      nextY.disabled = !allowFuture && `${year + 1}-01` > now;
      grid.replaceChildren(
        ...Array.from({ length: 12 }, (_, i) => {
          const m = `${year}-${String(i + 1).padStart(2, '0')}`;
          return h(
            'button.month-picker-btn',
            {
              type: 'button',
              'aria-pressed': m === cur ? 'true' : 'false',
              'aria-current': m === now ? 'date' : null,
              'aria-label': fmtMonth(m),
              disabled: !allowFuture && m > now,
              onClick: () => {
                pop.close(true);
                set(m, true);
              },
            },
            fmtDate(`${m}-01`, 'month')
          );
        })
      );
    };
    prevY.addEventListener('click', () => {
      year -= 1;
      draw();
    });
    nextY.addEventListener('click', () => {
      year += 1;
      draw();
    });
    draw();
    const pop = popover(center, content, { ariaLabel: 'Choose a month', align: 'center' });
    if (pop) focusEl(grid.querySelector('[aria-pressed="true"]') || grid.querySelector('button:not(:disabled)'));
  });
  render();
  el.setMonth = (m) => {
    if (m) cur = m;
    render();
  };
  el.getMonth = () => cur;
  return el;
}

// ════════════════════════════════════════════════════════════════════════════ popover & menu

let openFloating = null;

/**
 * popover(anchorEl, content, {align:'start'|'end'|'center', ariaLabel, onClose, className}) → {el, close(restoreFocus)}
 * Positioned under the anchor (flips above near the bottom edge), closes on outside click / Esc / resize.
 * Calling it again for the same anchor closes it (toggle) and returns null.
 */
export function popover(anchorEl, content, { align = 'start', ariaLabel, onClose, className, role = 'dialog', menu: isMenu = false } = {}) {
  if (openFloating && openFloating.anchor === anchorEl) {
    openFloating.close(true);
    return null;
  }
  if (openFloating) openFloating.close(false);
  const el = h(isMenu ? 'div.menu' : 'div.popover', { role, tabindex: '-1', 'aria-label': ariaLabel, class: className }, content);
  let closed = false;
  document.body.appendChild(el);

  function position() {
    if (!anchorEl.isConnected) {
      close(false);
      return;
    }
    const r = anchorEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const m = 8;
    const w = el.offsetWidth;
    const ht = el.offsetHeight;
    let left = align === 'end' ? r.right - w : align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
    if (left + w > vw - m) left = Math.max(m, r.right - w);
    if (left + w > vw - m) left = vw - m - w;
    if (left < m) left = m;
    let top = r.bottom + 6;
    let above = false;
    if (top + ht > vh - m) {
      if (r.top - 6 - ht >= m) {
        top = r.top - 6 - ht;
        above = true;
      } else {
        top = Math.max(m, vh - m - ht);
      }
    }
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.classList.toggle('is-above', above);
    el.style.transformOrigin = `${Math.round(Math.min(w, Math.max(0, r.left + r.width / 2 - left)))}px ${above ? '100%' : '0'}`;
  }
  position();

  const onDown = (e) => {
    if (!el.contains(e.target) && !anchorEl.contains(e.target)) close(false);
  };
  const onResize = () => close(false);
  const onScroll = (e) => {
    if (e.target instanceof Node && el.contains(e.target)) return;
    position();
  };
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onScroll, true);
  const popEsc = pushEscape(() => close(true));
  anchorEl.setAttribute('aria-expanded', 'true');
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !isMenu) {
      const items = focusables(el);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        close(true);
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        close(true);
      }
    }
  });

  function close(restoreFocus = false) {
    if (closed) return;
    closed = true;
    if (openFloating && openFloating.el === el) openFloating = null;
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll, true);
    popEsc();
    anchorEl.setAttribute('aria-expanded', 'false');
    if (restoreFocus || el.contains(document.activeElement)) focusEl(anchorEl);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), prefersReducedMotion() ? 0 : 130);
    if (typeof onClose === 'function') {
      try {
        onClose();
      } catch (err) {
        console.error('[daybook] popover onClose failed', err);
      }
    }
  }
  const handle = { el, anchor: anchorEl, close };
  openFloating = handle;
  return handle;
}

/**
 * menu(anchorEl, items) — items: [{label, icon, danger, onClick, disabled, hint, checked}] | {divider:true} | {heading}
 * Arrow keys / Home / End navigate; Esc or outside click closes; focus returns to the anchor. → {el, close}
 */
export function menu(anchorEl, items = [], { align = 'start', ariaLabel } = {}) {
  const buttons = [];
  const kids = [];
  for (const it of toArray(items)) {
    if (!it) continue;
    if (it === '-' || it.divider) {
      kids.push(h('div.menu-divider', { role: 'separator' }));
      continue;
    }
    if (it.heading) {
      kids.push(h('div.menu-label', { role: 'presentation' }, it.heading));
      continue;
    }
    const hasCheck = it.checked !== undefined && it.checked !== null;
    const b = h(
      'button.menu-item',
      {
        type: 'button',
        role: hasCheck ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': hasCheck ? String(!!it.checked) : null,
        class: { 'is-danger': !!it.danger },
        disabled: it.disabled,
        tabindex: '-1',
        onClick: () => {
          handle && handle.close(true);
          if (typeof it.onClick === 'function') {
            try {
              const r = it.onClick();
              if (r && typeof r.catch === 'function') r.catch((err) => console.error('[daybook] menu action failed', err));
            } catch (err) {
              console.error('[daybook] menu action failed', err);
            }
          }
        },
      },
      it.icon ? icon(it.icon, { size: 18 }) : null,
      h('span.menu-item-label', it.label),
      it.hint ? h('span.menu-item-hint', it.hint) : null,
      hasCheck && it.checked ? icon('check', { size: 16, strokeWidth: 2.25, class: 'menu-item-check' }) : null
    );
    buttons.push(b);
    kids.push(b);
  }
  if (!anchorEl.hasAttribute('aria-haspopup')) anchorEl.setAttribute('aria-haspopup', 'menu');
  const handle = popover(anchorEl, kids, { align, ariaLabel, role: 'menu', menu: true });
  if (!handle) return null;
  const enabled = () => buttons.filter((b) => !b.disabled);
  handle.el.addEventListener('keydown', (e) => {
    const list = enabled();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    let n = null;
    if (e.key === 'ArrowDown') n = list[(i + 1) % list.length];
    else if (e.key === 'ArrowUp') n = list[(i - 1 + list.length) % list.length];
    else if (e.key === 'Home') n = list[0];
    else if (e.key === 'End') n = list[list.length - 1];
    else if (e.key === 'Tab') {
      e.preventDefault();
      handle.close(true);
      return;
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const start = i + 1;
      for (let j = 0; j < list.length; j++) {
        const b = list[(start + j) % list.length];
        if (b.textContent.trim().toLowerCase().startsWith(k)) {
          n = b;
          break;
        }
      }
    }
    if (n) {
      e.preventDefault();
      focusEl(n);
    }
  });
  focusEl(enabled()[0] || handle.el);
  return handle;
}
