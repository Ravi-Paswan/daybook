// Daybook — app shell (spec section 5): boot, nav, router wiring, quick add, SW registration, theme.
//
// Choices beyond the spec (kept small and additive):
//   - Core modules are imported dynamically inside boot(), so a broken core file shows a friendly
//     "couldn't start" card on the splash instead of a blank page.
//   - Each route renders into a fresh <div class="view-page"> inside <main id="view">; a render that
//     finishes after the user already navigated away is discarded and its cleanup is run immediately.
//   - window.daybook also exposes getModule, openQuickAdd, currentRoute and applyTheme (extras).
//   - Keyboard: n quick add · / search · ? shortcuts · g then t/f/l/w/e/r/p/o/c/i/s go to a page.
//   - Sidebar badges: learning reviews due, open trade positions (read-only queries, best effort).

import { startRouter, navigate, currentRoute } from './core/router.js';
import { loadModules, getModules, getModule, getModuleError } from './modules/registry.js';

const VERSION = '1.0.0';
const LS_THEME = 'daybook.theme';
const LS_JOURNAL = 'daybook.lastJournal';
const THEME_FALLBACK = { light: '#f4f5f8', dark: '#0b0d12' };

// Static nav config. Icons are icons.js names; colors are CSS custom property names.
const PAGES = {
  today: { label: 'Today', icon: 'today', color: '--primary' },
  food: { label: 'Food', short: 'Food', icon: 'food', color: '--food' },
  learning: { label: 'Learning', short: 'Learn', icon: 'learning', color: '--learning' },
  training: { label: 'Training', short: 'Train', icon: 'training', color: '--training' },
  expenses: { label: 'Expenses', short: 'Money', icon: 'expenses', color: '--expenses' },
  trades: { label: 'Trades', icon: 'trades', color: '--trades' },
  goals: { label: 'Goals', icon: 'goals', color: '--goals', sub: 'Daily targets & streaks' },
  calendar: { label: 'Calendar', icon: 'calendar', color: '--water', sub: 'Your month at a glance' },
  insights: { label: 'Insights', icon: 'insights', color: '--mood' },
  search: { label: 'Search', icon: 'search', color: '--primary', sub: 'Find any entry, trade or note' },
  settings: { label: 'Settings', icon: 'settings', color: '--text-2', sub: 'Preferences, backup & data' },
  welcome: { label: 'Welcome', icon: 'sparkles', color: '--primary' },
};

const JOURNAL = ['food', 'learning', 'training', 'expenses'];
const MORE = ['goals', 'calendar', 'search', 'settings'];

const SIDEBAR_GROUPS = [
  { label: null, items: ['today'] },
  { label: 'Journal', items: JOURNAL },
  { label: 'Trading', items: ['trades'] },
  { label: 'Review', items: ['goals', 'calendar', 'insights'] },
];

const GOTO = {
  t: '/today',
  f: '/food',
  l: '/learning',
  w: '/training',
  e: '/expenses',
  m: '/expenses',
  r: '/trades',
  p: '/trades/plan',
  o: '/goals',
  c: '/calendar',
  i: '/insights',
  s: '/settings',
};

const SHORTCUTS = [
  [['N'], 'Quick add'],
  [['/'], 'Search'],
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
  [['?'], 'Show these shortcuts'],
];

// Core modules (loaded in boot)
let ui = null;
let bus = null;
let dbm = null;
let settingsm = null;
let syncm = null;
let dates = null;

const html = document.documentElement;
const $ = (id) => document.getElementById(id);

// Shell element refs
const refs = {
  view: null,
  sidebarItems: new Map(), // id → <a>
  badges: new Map(), // id → <span>
  bottomItems: new Map(), // key → el
  switchItems: new Map(), // id → <a>
  installEls: [],
  journalTab: null,
  tbTitle: null,
  sbSearch: null,
  offlineNote: null,
};

// ---------------------------------------------------------------- small helpers
function cssColor(c, fallback = 'var(--primary)') {
  if (!c) return fallback;
  const s = String(c).trim();
  return s.startsWith('--') ? `var(${s})` : s;
}

function ic(name, opts = {}) {
  try {
    const el = ui.icon(name, opts);
    if (el) return el;
  } catch {
    /* unknown icon / icons.js issue → blank placeholder keeps layout */
  }
  const size = opts.size || 20;
  return ui.h('span.icon', { 'aria-hidden': 'true', style: { width: size + 'px', height: size + 'px' } });
}

function page(id) {
  const p = PAGES[id] || {};
  let mod = null;
  try {
    mod = getModule(id);
  } catch {
    mod = null;
  }
  return {
    id,
    label: p.label || (mod && mod.title) || id,
    short: p.short || p.label || (mod && mod.title) || id,
    icon: p.icon || (mod && mod.icon) || 'circle',
    color: (mod && mod.color) || p.color || '--primary',
    sub: p.sub || '',
  };
}

function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage */
  }
}

let memJournal = null; // fallback when localStorage is blocked

function lastJournal() {
  const v = memJournal || lsGet(LS_JOURNAL);
  return JOURNAL.includes(v) ? v : 'food';
}

function rememberJournal(id) {
  memJournal = id;
  lsSet(LS_JOURNAL, id);
}

function todayKeySafe() {
  try {
    return dates.todayKey();
  } catch {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}

function workingDate() {
  return (bus && bus.state && bus.state.date) || todayKeySafe();
}

function prefersReducedMotion() {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function safeToast(message, opts) {
  try {
    if (ui) ui.toast(message, opts);
  } catch (err) {
    console.warn('[daybook] toast failed', err);
  }
}

function runCleanup(fn) {
  if (typeof fn !== 'function') return;
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((err) => console.error('[daybook] cleanup failed:', err));
  } catch (err) {
    console.error('[daybook] cleanup failed:', err);
  }
}

function overlayOpen() {
  return !!document.querySelector(
    '.sheet-backdrop, .lightbox, [role="dialog"][aria-modal="true"], [role="alertdialog"], .menu:not([hidden])'
  );
}

const NON_TEXT_INPUTS = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image']);

function isTypingTarget(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(String(el.type || 'text').toLowerCase());
  return false;
}

// ---------------------------------------------------------------- errors
let lastErrorToast = 0;

function reportError(err, where = 'error') {
  console.error(`[daybook] ${where}:`, err);
  const now = Date.now();
  if (!ui || now - lastErrorToast < 4000) return;
  lastErrorToast = now;
  safeToast('Something went wrong — your data is safe.', { type: 'error', duration: 5000 });
}

window.addEventListener('error', (e) => {
  const msg = (e && e.message) || '';
  if (/ResizeObserver loop/i.test(msg)) return;
  if (e && e.target && e.target !== window) return; // resource errors
  reportError(e.error || msg || e, 'uncaught error');
});

window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r && r.name === 'AbortError') return;
  reportError(r, 'unhandled rejection');
});

function fatal(message, err) {
  console.error('[daybook] could not start:', err);
  const detail = err ? (err.message || String(err)) : '';
  if (typeof window.__daybookBootFail === 'function') {
    window.__daybookBootFail(message, detail);
    return;
  }
  // Fallback when the inline helper is missing: plain DOM, no innerHTML.
  const box = document.createElement('div');
  box.className = 'boot is-error';
  const p = document.createElement('p');
  p.className = 'boot-msg';
  p.textContent = message;
  const b = document.createElement('button');
  b.className = 'boot-btn';
  b.textContent = 'Reload';
  b.addEventListener('click', () => location.reload());
  const inner = document.createElement('div');
  inner.className = 'boot-inner';
  inner.append(p, b);
  box.append(inner);
  document.body.append(box);
}

// ---------------------------------------------------------------- install (PWA)
let deferredPrompt = null;

function isStandalone() {
  try {
    return (
      matchMedia('(display-mode: standalone)').matches ||
      matchMedia('(display-mode: fullscreen)').matches ||
      matchMedia('(display-mode: window-controls-overlay)').matches ||
      navigator.standalone === true
    );
  } catch {
    return false;
  }
}

function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function canInstall() {
  return !isStandalone() && (!!deferredPrompt || isIOS());
}

function refreshInstallUI() {
  const show = canInstall();
  refs.installEls.forEach((el) => {
    el.hidden = !show;
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  refreshInstallUI();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  refreshInstallUI();
  safeToast('Daybook is installed — find it on your home screen.', { type: 'success' });
});

async function promptInstall() {
  if (deferredPrompt) {
    const p = deferredPrompt;
    deferredPrompt = null; // a prompt can only be used once
    refreshInstallUI();
    try {
      await p.prompt();
      const choice = await p.userChoice;
      if (choice && choice.outcome === 'accepted') safeToast('Installing Daybook…', { type: 'success' });
    } catch (err) {
      console.warn('[daybook] install prompt failed', err);
    }
    return;
  }
  if (isIOS()) {
    openIOSInstall();
    return;
  }
  safeToast('Use your browser menu → “Install app” or “Add to Home screen”.', { duration: 5000 });
}

function openIOSInstall() {
  const { h } = ui;
  ui.openSheet({
    title: 'Install Daybook',
    subtitle: 'Add it to your Home Screen — it opens full-screen and works offline.',
    accent: '--primary',
    content: () =>
      h(
        'ol.install-steps',
        h('li.install-step', h('span', 'Tap the ', h('strong', 'Share'), ' button in Safari’s toolbar.')),
        h('li.install-step', h('span', 'Scroll down and choose ', h('strong', 'Add to Home Screen'), '.')),
        h('li.install-step', h('span', 'Tap ', h('strong', 'Add'), '. Your journal stays on this device.'))
      ),
    actions: [{ label: 'Got it', variant: 'primary', onClick: () => true }],
  });
}

// ---------------------------------------------------------------- theme
let themeTimer = 0;

function readToken(name) {
  try {
    return getComputedStyle(html).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

function updateThemeColor(theme) {
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((m) => {
    if (!m.dataset.default) m.dataset.default = m.getAttribute('content') || '';
  });
  if (theme === 'light' || theme === 'dark') {
    const color = readToken('--bg') || THEME_FALLBACK[theme];
    metas.forEach((m) => m.setAttribute('content', color));
  } else {
    metas.forEach((m) => m.setAttribute('content', m.dataset.default));
  }
}

function applyTheme(theme, { animate = false } = {}) {
  const t = theme === 'light' || theme === 'dark' ? theme : 'system';
  const prev = html.getAttribute('data-theme') || 'system';
  if (animate && prev !== t && !prefersReducedMotion()) {
    html.classList.add('theme-changing');
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => html.classList.remove('theme-changing'), 320);
  }
  if (t === 'system') html.removeAttribute('data-theme');
  else html.setAttribute('data-theme', t);
  lsSet(LS_THEME, t);
  updateThemeColor(t);
}

// ---------------------------------------------------------------- shell
function buildShell() {
  const { h } = ui;
  refs.view = $('view');

  // Skip link
  const skip = $('skip-link');
  if (skip) skip.addEventListener('click', () => focusView(true));

  // ---- Sidebar (desktop)
  const sbNew = $('sb-new');
  if (sbNew) {
    sbNew.prepend(ic('plus', { size: 18 }));
    sbNew.addEventListener('click', () => openQuickAdd());
  }
  const sbSearch = $('sb-search');
  if (sbSearch) {
    sbSearch.prepend(ic('search', { size: 17 }));
    sbSearch.addEventListener('click', () => navigate('/search'));
    refs.sbSearch = sbSearch;
  }

  const nav = $('sb-nav');
  if (nav) {
    const groups = SIDEBAR_GROUPS.map((g) =>
      h(
        'div.sb-group',
        { role: 'group', 'aria-label': g.label || 'Home' },
        g.label ? h('div.sb-group-label', { 'aria-hidden': 'true' }, g.label) : null,
        g.items.map((id) => sidebarItem(id))
      )
    );
    ui.mount(nav, groups);
  }

  const footer = $('sb-footer');
  if (footer) {
    const install = h(
      'button.sb-item.sb-install',
      { type: 'button', hidden: true, style: { '--accent': 'var(--primary)' }, onClick: () => promptInstall() },
      ic('install', { size: 19 }),
      h('span.sb-item-label', 'Install app')
    );
    refs.installEls.push(install);
    const offline = h('div.sb-offline', { hidden: true }, ic('wifi-off', { size: 14 }), h('span', 'Offline — still saving locally'));
    refs.offlineNote = offline;
    ui.mount(
      footer,
      h('div.sb-footer-rule', { 'aria-hidden': 'true' }),
      sidebarItem('settings'),
      install,
      h('div.sb-note', ic('lock', { size: 14 }), h('span', 'Saved on this device')),
      offline
    );
  }

  // ---- Top bar (mobile)
  const title = $('tb-title');
  if (title) {
    refs.tbTitle = title;
    title.addEventListener('click', () => window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }));
  }
  const tbSearch = $('tb-search');
  if (tbSearch) {
    ui.mount(tbSearch, ic('search', { size: 22 }));
    tbSearch.addEventListener('click', () => navigate('/search'));
  }

  // ---- Journal switcher (mobile, on journal pages)
  const sw = $('journal-switch');
  if (sw) {
    const items = JOURNAL.map((id) => {
      const p = page(id);
      const a = h(
        'a.js-item',
        { href: '#/' + id, dataset: { id }, style: { '--accent': cssColor(p.color) }, onClick: (e) => sameRouteClick(e, '/' + id) },
        ic(p.icon, { size: 16 }),
        h('span', p.short)
      );
      refs.switchItems.set(id, a);
      return a;
    });
    ui.mount(sw, h('div.js-track', items));
  }

  // ---- Bottom nav (mobile)
  const bn = $('bottom-nav');
  if (bn) {
    const make = (key, label, iconName, color, href) => {
      const el = h(
        'a.bn-item',
        {
          href,
          dataset: { key },
          style: { '--accent': cssColor(color) },
          onClick: (e) => {
            const target = (el.getAttribute('href') || '').replace(/^#/, '');
            sameRouteClick(e, target);
          },
        },
        h('span.bn-icon', ic(iconName, { size: 22 })),
        h('span.bn-label', label)
      );
      refs.bottomItems.set(key, el);
      return el;
    };
    const lj = lastJournal();
    const today = make('today', 'Today', 'today', page('today').color, '#/today');
    const journal = make('journal', 'Journal', 'notebook', page(lj).color, '#/' + lj);
    refs.journalTab = journal;
    const trades = make('trades', 'Trades', 'trades', page('trades').color, '#/trades');
    const insights = make('insights', 'Insights', 'insights', page('insights').color, '#/insights');
    const more = h(
      'button.bn-item',
      {
        type: 'button',
        dataset: { key: 'more' },
        'aria-haspopup': 'dialog',
        style: { '--accent': 'var(--primary)' },
        onClick: () => openMore(),
      },
      h('span.bn-icon', ic('grid', { size: 22 })),
      h('span.bn-label', 'More')
    );
    refs.bottomItems.set('more', more);
    ui.mount(bn, today, journal, trades, insights, more);
  }

  // ---- FAB
  const fab = $('fab');
  if (fab) {
    ui.mount(fab, ic('plus', { size: 26 }));
    fab.addEventListener('click', () => openQuickAdd());
  }

  refreshInstallUI();
  refreshOffline();
}

function sidebarItem(id) {
  const { h } = ui;
  const p = page(id);
  const badge = h('span.sb-badge', { hidden: true });
  const el = h(
    'a.sb-item',
    {
      href: '#/' + id,
      dataset: { id },
      style: { '--accent': cssColor(p.color) },
      onClick: (e) => sameRouteClick(e, '/' + id),
    },
    ic(p.icon, { size: 19 }),
    h('span.sb-item-label', p.label),
    badge
  );
  refs.sidebarItems.set(id, el);
  refs.badges.set(id, badge);
  return el;
}

// Tapping the nav item of the page you're on scrolls to the top instead of doing nothing.
function sameRouteClick(e, path) {
  if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const cur = currentRoute();
  if (cur.path === path || (path === '/' + cur.id && cur.params.length === 0)) {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
}

function setCurrent(el, on) {
  if (!el) return;
  if (on) el.setAttribute('aria-current', 'page');
  else el.removeAttribute('aria-current');
}

function updateChrome(route) {
  const id = route.id;
  html.dataset.module = id;
  html.classList.toggle('is-fullscreen', id === 'welcome');
  html.style.setProperty('--route-accent', cssColor(page(id).color));

  refs.sidebarItems.forEach((el, key) => setCurrent(el, key === id));
  if (refs.sbSearch) refs.sbSearch.classList.toggle('is-active', id === 'search');

  const lj = lastJournal();
  if (refs.journalTab) {
    refs.journalTab.setAttribute('href', '#/' + lj);
    refs.journalTab.style.setProperty('--accent', cssColor(page(lj).color));
  }
  const bottomKey = JOURNAL.includes(id) ? 'journal' : MORE.includes(id) ? 'more' : id;
  refs.bottomItems.forEach((el, key) => {
    const on = key === bottomKey;
    if (el.tagName === 'BUTTON') el.classList.toggle('is-active', on);
    else setCurrent(el, on);
  });

  const sw = $('journal-switch');
  const isJournal = JOURNAL.includes(id);
  if (sw) sw.hidden = !isJournal;
  html.classList.toggle('has-switch', isJournal);
  refs.switchItems.forEach((el, key) => setCurrent(el, key === id));
}

let titleKey = '';

function setPageTitle(text, route) {
  const label = String(text || '').trim() || page(route.id).label;
  document.title = `${label} · Daybook`;
  const el = refs.tbTitle;
  if (!el) return;
  const brand = route.id === 'today';
  const key = brand ? '__brand' : label;
  if (key === titleKey) return;
  titleKey = key;
  const { h } = ui;
  el.classList.toggle('is-brand', brand);
  el.setAttribute('aria-label', brand ? 'Daybook — scroll to top' : `${label} — scroll to top`);
  if (brand) ui.mount(el, brandMark(), h('span.tb-title-text', 'Daybook'));
  else ui.mount(el, h('span.tb-title-text', label));
  // restart the small fade so title changes feel intentional
  el.classList.remove('tb-title-swap');
  void el.offsetWidth;
  el.classList.add('tb-title-swap');
}

// Same glyph as assets/icons/icon.svg (sunrise over journal lines); the gradient tile is CSS.
const GLYPH =
  '<svg viewBox="0 0 512 512" aria-hidden="true"><g fill="#fff"><path d="M176 250a80 80 0 0 1 160 0z"/><rect x="112" y="273" width="288" height="34" rx="17"/></g><path d="M256 144V100M334.77 179.07l32.7-29.44M177.23 179.07l-32.7-29.44" stroke="#fff" stroke-width="30" stroke-linecap="round"/><rect x="112" y="332" width="218" height="28" rx="14" fill="#fff" opacity=".8"/><rect x="112" y="384" width="138" height="28" rx="14" fill="#fff" opacity=".55"/></svg>';

function brandMark() {
  // Trusted static SVG (same glyph as index.html).
  return ui.h('span.brand-mark', { 'aria-hidden': 'true', html: GLYPH });
}

// ---------------------------------------------------------------- route rendering
let renderSeq = 0;
let currentCleanup = null;
let firstRender = true;

const progress = {
  timer: 0,
  el: null,
  start() {
    this.el = this.el || $('route-progress');
    if (!this.el) return;
    clearTimeout(this.timer);
    this.el.classList.remove('is-active', 'is-done');
    this.timer = setTimeout(() => this.el && this.el.classList.add('is-active'), 140);
  },
  done() {
    clearTimeout(this.timer);
    if (!this.el) return;
    if (this.el.classList.contains('is-active')) {
      this.el.classList.remove('is-active');
      this.el.classList.add('is-done');
    }
  },
};

async function renderRoute(route) {
  const seq = ++renderSeq;
  const prev = currentCleanup;
  currentCleanup = null;
  runCleanup(prev);

  const id = route.id;
  if (JOURNAL.includes(id)) rememberJournal(id);
  updateChrome(route);

  const mod = getModule(id);
  setPageTitle(mod ? mod.title || page(id).label : page(id).label, route);
  try {
    bus.emit('route:change', { route });
  } catch (err) {
    console.error('[daybook] route:change listener failed', err);
  }

  const view = refs.view || $('view');
  const root = ui.h('div.view-page', { dataset: { module: id } });
  ui.mount(view, root);
  if (!firstRender) window.scrollTo(0, 0);
  progress.start();

  let result = null;
  if (!mod) {
    renderErrorCard(root, route, { kind: 'load', error: getModuleError(id) });
  } else {
    const ctx = {
      route,
      navigate,
      setTitle: (text) => {
        if (seq === renderSeq) setPageTitle(text, route);
      },
    };
    try {
      result = await mod.render(root, ctx);
    } catch (err) {
      console.error(`[daybook] "${id}" failed to render:`, err);
      if (seq === renderSeq) renderErrorCard(root, route, { kind: 'render', error: err });
    }
  }

  const cleanup = typeof result === 'function' ? result : null;
  if (seq !== renderSeq) {
    runCleanup(cleanup); // user already moved on
    return;
  }
  currentCleanup = cleanup;
  progress.done();
  afterRender(route, root);
}

// Phones: the top bar title stays quiet while the page's own <h1> is on screen (iOS "large title" feel)
// and fades in once the heading scrolls under the bar.
let titleObserver = null;

function watchPageTitle(root) {
  if (titleObserver) titleObserver.disconnect();
  titleObserver = null;
  html.classList.remove('title-in-view');
  const h1 = root.querySelector('h1');
  if (!h1 || typeof IntersectionObserver !== 'function') return;
  // Everything sticky at the top (top bar + journal switcher) covers the heading before it leaves the screen.
  const bar = $('topbar');
  const sw = $('journal-switch');
  const covered = (bar ? bar.offsetHeight : 0) + (sw && !sw.hidden ? sw.offsetHeight : 0);
  titleObserver = new IntersectionObserver(
    (entries) => {
      const e = entries[entries.length - 1];
      html.classList.toggle('title-in-view', !!(e && e.isIntersecting));
    },
    { rootMargin: `-${Math.max(0, Math.round(covered)) || 56}px 0px 0px 0px` }
  );
  titleObserver.observe(h1);
}

function afterRender(route, root) {
  html.dataset.route = route.path;
  watchPageTitle(root);
  const wasFirst = firstRender;
  firstRender = false;

  // Move focus to the page heading unless the page (or a sheet it opened) already took focus.
  const active = document.activeElement;
  const tookFocus =
    active && active !== document.body && (root.contains(active) || (active.closest && active.closest('[role="dialog"], .sheet')));
  if (!tookFocus) {
    const h1 = root.querySelector('h1');
    if (h1) {
      if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
      try {
        h1.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    } else if (!wasFirst) {
      focusView(false);
    }
  }

  window.dispatchEvent(new CustomEvent('daybook:rendered', { detail: { route } }));
  hideSplash();
}

function focusView(scroll) {
  const v = refs.view || $('view');
  if (!v) return;
  try {
    v.focus({ preventScroll: !scroll });
  } catch {
    /* ignore */
  }
}

function renderErrorCard(root, route, { kind, error }) {
  const { h } = ui;
  const p = page(route.id);
  const onToday = route.id === 'today';
  const title = kind === 'load' ? `${p.label} couldn’t load` : 'Something went wrong';
  const message =
    kind === 'load'
      ? `This part of Daybook didn’t load. It may still be updating — reloading usually fixes it. Your data is safe.`
      : `We hit a snag while opening ${p.label}. Your data is safe on this device.`;
  const detail = errorDetail(error);

  const actions = [
    h(
      'button.btn.btn-primary',
      { type: 'button', onClick: () => location.reload() },
      ic('refresh', { size: 18 }),
      h('span', 'Reload')
    ),
    onToday
      ? h(
          'button.btn.btn-secondary',
          { type: 'button', onClick: () => navigate(route.path) },
          ic('rotate-ccw', { size: 18 }),
          h('span', 'Try again')
        )
      : h(
          'button.btn.btn-secondary',
          { type: 'button', onClick: () => navigate('/today') },
          ic('today', { size: 18 }),
          h('span', 'Go to Today')
        ),
  ];

  setPageTitle(title, route);
  ui.mount(
    root,
    h(
      'section.view-error',
      { role: 'alert', style: { '--accent': kind === 'load' ? 'var(--warning)' : 'var(--danger)' } },
      h('div.view-error-icon', ic(kind === 'load' ? 'cloud-off' : 'alert', { size: 28 })),
      h('h1', { tabindex: '-1' }, title),
      h('p', message),
      h('div.view-error-actions', actions),
      detail ? h('details', h('summary', 'Technical details'), h('pre', detail)) : null
    )
  );
}

function errorDetail(error) {
  if (!error) return '';
  const head = error.message ? `${error.name || 'Error'}: ${error.message}` : String(error);
  const stack = error.stack
    ? String(error.stack)
        .split('\n')
        .filter((l) => /^\s*at\s|@/.test(l))
        .slice(0, 6)
        .map((l) => l.trim())
        .join('\n')
    : '';
  return [head, stack].filter(Boolean).join('\n');
}

let splashHidden = false;

function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  const boot = $('boot');
  if (!boot) return;
  boot.classList.add('is-done');
  boot.setAttribute('aria-hidden', 'true');
  setTimeout(() => boot.remove(), 420);
}

// ---------------------------------------------------------------- quick add
let quickAddApi = null;

function collectQuickActions() {
  const out = [];
  for (const mod of getModules()) {
    let list = [];
    try {
      list = typeof mod.quickActions === 'function' ? mod.quickActions() : mod.quickActions;
    } catch (err) {
      console.error(`[daybook] quickActions of "${mod.id}" failed`, err);
    }
    if (!Array.isArray(list)) continue;
    for (const action of list) {
      if (action && typeof action.run === 'function') out.push({ action, mod });
    }
  }
  return out;
}

function runQuickAction(action) {
  const date = workingDate();
  try {
    const r = action.run({ date });
    if (r && typeof r.catch === 'function') r.catch((err) => reportError(err, `quick action "${action.id}"`));
  } catch (err) {
    reportError(err, `quick action "${action.id}"`);
  }
}

function openQuickAdd() {
  if (!ui || quickAddApi) return quickAddApi;
  const { h } = ui;
  const items = collectQuickActions();
  const date = workingDate();
  const isToday = date === todayKeySafe();
  let keyHandler = null;

  const content = (api) => {
    if (!items.length) {
      return ui.emptyState({
        icon: 'sparkles',
        title: 'Nothing to add yet',
        message: 'Quick actions show up here as soon as your journal sections are ready.',
        action: { label: 'Go to Today', icon: 'today', onClick: () => api.close({ nav: '/today' }) },
      });
    }
    let dateLabel = 'Today';
    try {
      dateLabel = isToday ? 'today' : dates.relativeDay(date);
    } catch {
      dateLabel = date;
    }
    const tiles = items.map(({ action, mod }, i) =>
      h(
        'button.qa-tile',
        {
          type: 'button',
          style: { '--accent': cssColor(action.color || mod.color), '--i': String(i) },
          'aria-keyshortcuts': i < 9 ? String(i + 1) : null,
          dataset: { action: `${mod.id}:${action.id || i}` },
          onClick: () => api.close({ quickAction: action }),
        },
        h('span.qa-chip', ic(action.icon || mod.icon || 'plus', { size: 24 })),
        h('span.qa-label', action.label || mod.title),
        i < 9 ? h('kbd.qa-key', { 'aria-hidden': 'true' }, String(i + 1)) : null
      )
    );
    keyHandler = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, items.length)) {
        e.preventDefault();
        api.close({ quickAction: items[n - 1].action });
      }
    };
    document.addEventListener('keydown', keyHandler);
    const max = Math.min(9, items.length);
    return h(
      'div.qa',
      h(
        'div',
        h(
          isToday ? 'span.qa-date' : 'span.qa-date.is-past',
          ic(isToday ? 'calendar' : 'history', { size: 15 }),
          h('span', isToday ? 'Adding to today' : `Adding to ${dateLabel}`)
        )
      ),
      h('div.qa-grid', { role: 'group', 'aria-label': 'Quick actions' }, tiles),
      h(
        'p.qa-foot',
        h('span', 'Press'),
        h('kbd', '1'),
        max > 1 ? [h('span', '–'), h('kbd', String(max))] : null,
        h('span', 'to choose ·'),
        h('kbd', 'N'),
        h('span', 'opens this anywhere')
      )
    );
  };

  let api;
  try {
    api = ui.openSheet({
      title: 'Quick add',
      subtitle: 'What would you like to log?',
      accent: '--primary',
      size: 'md',
      content,
    });
  } catch (err) {
    reportError(err, 'quick add');
    return null;
  }
  quickAddApi = api;
  Promise.resolve(api && api.result)
    .then((res) => {
      quickAddApi = null;
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      if (res && res.quickAction) setTimeout(() => runQuickAction(res.quickAction), 0);
      else if (res && res.nav) navigate(res.nav);
    })
    .catch(() => {
      quickAddApi = null;
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
    });
  return api;
}

// ---------------------------------------------------------------- more sheet (mobile)
function openMore() {
  if (!ui) return;
  const { h } = ui;
  const cur = currentRoute();
  const row = (opts) =>
    h(
      'button.more-item',
      {
        type: 'button',
        style: { '--accent': cssColor(opts.color) },
        'aria-current': opts.current ? 'page' : null,
        onClick: opts.onClick,
      },
      h('span.more-chip', ic(opts.icon, { size: 21 })),
      h('span.more-text', h('span.more-label', opts.label), opts.sub ? h('span.more-sub', opts.sub) : null),
      ic('chevron-right', { size: 18, class: 'more-chev' })
    );

  let sheet;
  try {
    sheet = ui.openSheet({
    title: 'More',
    size: 'md',
    content: (api) => {
      const items = MORE.map((id) => {
        const p = page(id);
        return row({
          ...p,
          current: cur.id === id,
          onClick: () => api.close({ nav: '/' + id }),
        });
      });
      if (canInstall()) {
        items.push(
          row({
            label: 'Install app',
            sub: 'Add Daybook to your home screen',
            icon: 'install',
            color: '--primary',
            onClick: () => api.close({ install: true }),
          })
        );
      }
      return h(
        'div',
        h('nav.more-list', { 'aria-label': 'More pages' }, items),
        h('p.more-note', ic('lock', { size: 14 }), h('span', 'Your journal is saved privately on this device'))
      );
    },
    });
  } catch (err) {
    reportError(err, 'more sheet');
    return;
  }
  Promise.resolve(sheet && sheet.result)
    .then((res) => {
      if (!res) return;
      if (res.nav) navigate(res.nav);
      else if (res.install) promptInstall();
    })
    .catch(() => {});
}

// ---------------------------------------------------------------- shortcuts sheet
let shortcutsOpen = false;

function openShortcuts() {
  if (!ui || shortcutsOpen) return;
  const { h } = ui;
  shortcutsOpen = true;
  const rows = SHORTCUTS.map(([keys, label]) =>
    h(
      'div.kb-row',
      h('span', label),
      h(
        'span.kb-keys',
        keys.map((k, i) => [i > 0 ? h('span', 'then') : null, h('kbd', k)])
      )
    )
  );
  try {
    const api = ui.openSheet({
      title: 'Keyboard shortcuts',
      subtitle: 'Work faster on a keyboard',
      accent: '--primary',
      content: () => h('div.kb-list', rows),
    });
    Promise.resolve(api && api.result).finally(() => {
      shortcutsOpen = false;
    });
  } catch (err) {
    shortcutsOpen = false;
    reportError(err, 'shortcuts');
  }
}

// ---------------------------------------------------------------- keyboard
let gPending = false;
let gTimer = 0;

function onKeydown(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return;
  if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
  if (html.classList.contains('is-fullscreen')) return;
  if (overlayOpen()) {
    gPending = false;
    return;
  }
  const k = e.key;
  if (gPending) {
    gPending = false;
    clearTimeout(gTimer);
    const dest = GOTO[String(k).toLowerCase()];
    if (dest) {
      e.preventDefault();
      navigate(dest);
    }
    return;
  }
  if (k === 'n' || k === 'N') {
    e.preventDefault();
    openQuickAdd();
  } else if (k === '/') {
    e.preventDefault();
    navigate('/search');
  } else if (k === '?') {
    e.preventDefault();
    openShortcuts();
  } else if (k === 'g' || k === 'G') {
    gPending = true;
    clearTimeout(gTimer);
    gTimer = setTimeout(() => {
      gPending = false;
    }, 1200);
  }
}

// ---------------------------------------------------------------- service worker
let reloadRequested = false;
let reloading = false;
let updateToastShown = false;

function showUpdateToast(worker) {
  if (updateToastShown) return;
  updateToastShown = true;
  safeToast('Update ready', {
    type: 'info',
    duration: 60000,
    action: {
      label: 'Reload',
      onClick: () => {
        reloadRequested = true;
        try {
          worker.postMessage({ type: 'SKIP_WAITING' });
        } catch {
          /* ignore */
        }
        // If the new worker never takes control, reload anyway.
        setTimeout(() => {
          if (!reloading) {
            reloading = true;
            location.reload();
          }
        }, 4000);
      },
    },
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;
  let reg;
  try {
    reg = await navigator.serviceWorker.register('./sw.js');
  } catch (err) {
    console.warn('[daybook] service worker not registered:', (err && err.message) || err);
    return;
  }
  if (!reg) return; // blocked (e.g. automation / privacy settings)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadRequested || reloading) return;
    reloading = true;
    location.reload();
  });
  if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    if (!w) return;
    w.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(w);
    });
  });
  // Look for a new version when the app comes back to the foreground (at most every 30 minutes).
  let lastCheck = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastCheck < 30 * 60 * 1000) return;
    lastCheck = Date.now();
    reg.update().catch(() => {});
  });
}

// ---------------------------------------------------------------- online / offline
function refreshOffline() {
  const offline = navigator.onLine === false;
  html.classList.toggle('is-offline', offline);
  if (refs.offlineNote) refs.offlineNote.hidden = !offline;
}

// ---------------------------------------------------------------- sidebar badges
let badgeTimer = 0;

function setBadge(id, count, label) {
  const el = refs.badges.get(id);
  if (!el) return;
  if (count > 0) {
    el.textContent = count > 99 ? '99+' : String(count);
    el.setAttribute('aria-label', label);
    el.title = label;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function refreshBadges() {
  if (!dbm || !dbm.db || typeof dbm.db.byIndex !== 'function') return;
  try {
    const due = await dbm.db.byIndex('learning', 'nextReview', IDBKeyRange.upperBound(todayKeySafe()));
    const n = Array.isArray(due) ? due.length : 0;
    setBadge('learning', n, `${n} to review`);
  } catch {
    /* store/index not ready — no badge */
  }
  try {
    const open = await dbm.db.byIndex('trades', 'status', 'open');
    const n = Array.isArray(open) ? open.length : 0;
    setBadge('trades', n, `${n} open ${n === 1 ? 'position' : 'positions'}`);
  } catch {
    /* ignore */
  }
}

function scheduleBadges(delay = 400) {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(refreshBadges, delay);
}

// ---------------------------------------------------------------- global listeners
function wireGlobalEvents() {
  document.addEventListener('keydown', onKeydown);

  window.addEventListener('offline', () => {
    refreshOffline();
    safeToast('You’re offline — Daybook keeps working and saving on this device.', { duration: 4500 });
  });
  window.addEventListener('online', () => {
    refreshOffline();
    safeToast('Back online', { type: 'success', duration: 2200 });
  });

  bus.on('settings:change', (payload) => {
    const s = (payload && payload.settings) || settingsm.getSettings();
    if (s) applyTheme(s.theme, { animate: true });
  });

  bus.on('db:change', (payload) => {
    const store = payload && payload.store;
    if (!store || store === '*' || store === 'learning' || store === 'trades') scheduleBadges();
  });

  // Display-mode can change (installed from the browser while open)
  try {
    matchMedia('(display-mode: standalone)').addEventListener('change', () => {
      html.classList.toggle('is-standalone', isStandalone());
      refreshInstallUI();
    });
  } catch {
    /* old Safari */
  }

  // "Typing" state hides the FAB on phones so it never covers an input.
  document.addEventListener('focusin', (e) => html.classList.toggle('is-typing', isTypingTarget(e.target)));
  document.addEventListener('focusout', () => {
    setTimeout(() => html.classList.toggle('is-typing', isTypingTarget(document.activeElement)), 0);
  });

  // Hairline under the top bar once content scrolls beneath it.
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      html.classList.toggle('is-scrolled', window.scrollY > 2);
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  // Day rollover: refresh badges when the app comes back after midnight.
  let lastDay = todayKeySafe();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = todayKeySafe();
    if (now !== lastDay) {
      lastDay = now;
      scheduleBadges(50);
    }
  });
}

// ---------------------------------------------------------------- expose
function exposeGlobal() {
  const api = window.daybook && typeof window.daybook === 'object' ? window.daybook : {};
  Object.assign(api, {
    db: dbm.db,
    getSettings: settingsm.getSettings,
    updateSettings: settingsm.updateSettings,
    navigate,
    bus: { on: bus.on, emit: bus.emit },
    state: bus.state,
    getModules,
    getModule,
    version: VERSION,
    openQuickAdd,
    currentRoute,
    applyTheme,
    sync: syncm,
  });
  Object.defineProperty(api, 'installPrompt', {
    configurable: true,
    enumerable: true,
    get: () => deferredPrompt,
    set: (v) => {
      deferredPrompt = v || null;
      refreshInstallUI();
    },
  });
  window.daybook = api;
}

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    [bus, dbm, settingsm, ui, dates] = await Promise.all([
      import('./core/bus.js'),
      import('./core/db.js'),
      import('./core/settings.js'),
      import('./core/ui.js'),
      import('./core/dates.js'),
    ]);
  } catch (err) {
    fatal('Daybook couldn’t start. Please reload — if this keeps happening, the app may still be updating.', err);
    return;
  }

  try {
    await dbm.openDB();
  } catch (err) {
    fatal(
      'Daybook couldn’t open its on-device storage. If you’re in a private window, try a normal one, then reload.',
      err
    );
    return;
  }

  try {
    await settingsm.loadSettings();
  } catch (err) {
    console.error('[daybook] settings failed to load — using defaults', err);
  }

  // Cloud sync: finish an email-link sign-in (#access_token=…) before the router sees the hash, then start.
  let authRedirect = null;
  try {
    syncm = await import('./core/sync.js');
    if (syncm.isConfigured()) {
      authRedirect = await syncm.handleAuthRedirect();
      await syncm.startSync();
    }
  } catch (err) {
    console.error('[daybook] cloud sync failed to start', err);
  }

  let settings = null;
  try {
    settings = settingsm.getSettings();
  } catch {
    settings = null;
  }
  applyTheme(settings && settings.theme);
  html.classList.toggle('is-standalone', isStandalone());
  html.classList.toggle('is-ios', isIOS());

  try {
    await loadModules();
  } catch (err) {
    console.error('[daybook] module registry failed', err);
  }

  try {
    buildShell();
    exposeGlobal();
    wireGlobalEvents();

    if (!(settings && settings.onboarded) && currentRoute().id !== 'welcome' && !authRedirect) {
      navigate('/welcome', { replace: true });
    }
    startRouter(renderRoute);
  } catch (err) {
    fatal('Daybook couldn’t start. Please reload.', err);
    return;
  }

  registerServiceWorker();
  scheduleBadges(600);

  // Never leave the splash up if the first page is slow.
  setTimeout(hideSplash, 4000);

  window.__daybookReady = true;
  window.dispatchEvent(new Event('daybook:ready'));
}

boot();
