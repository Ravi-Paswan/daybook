// js/modules/search.js — global search (SPEC 4.10).
// Choices not fixed by the spec:
// - Besides every module's search(), this view searches journal days (intention / wins / reflection / gratitude →
//   opens Today for that date), trading day plans (bias notes, watchlist, plan, review, lessons → Daily plan) and
//   period reviews (→ Insights for that period).
// - A query is remembered in "Recent" when you open a result, press Enter, or pause 1.5 s on a query with results.
// - Each group shows 6 rows first ("Show all n" expands). ↑/↓ move through visible rows, Enter opens.
import { db } from '../core/db.js';
import { on } from '../core/bus.js';
import { fmtDate, todayKey, diffDays, weekRange } from '../core/dates.js';
import { plural } from '../core/format.js';
import { h, mount, pageHeader, icon, iconChip, emptyState, debounce, colorVar, uniqueId } from '../core/ui.js';
import { getModules } from './registry.js';

const ID = 'search';
const TITLE = 'Search';
const ICON = 'search';
const COLOR = '--primary';
const LS_RECENT = 'daybook:search:recent';
const MAX_RECENT = 8;
const PER_GROUP = 6;
const MIN_CHARS = 2;

// ─────────────────────────────── helpers
function readRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_RECENT) || '[]');
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}
function writeRecent(list) {
  try { localStorage.setItem(LS_RECENT, JSON.stringify(list.slice(0, MAX_RECENT))); } catch { /* ignore */ }
}
function addRecent(q) {
  const t = String(q || '').trim();
  if (t.length < MIN_CHARS) return;
  writeRecent([t, ...readRecent().filter((s) => s.toLowerCase() !== t.toLowerCase())]);
}

/** Text with every case-insensitive occurrence of q wrapped in <mark> (text nodes only — never innerHTML). */
function highlight(text, q) {
  const s = String(text ?? '');
  const needle = q.toLowerCase();
  if (!needle) return [s];
  const lower = s.toLowerCase();
  const out = [];
  let i = 0;
  for (let j = lower.indexOf(needle); j !== -1 && out.length < 40; j = lower.indexOf(needle, i)) {
    if (j > i) out.push(document.createTextNode(s.slice(i, j)));
    out.push(h('mark', s.slice(j, j + needle.length)));
    i = j + needle.length;
  }
  if (i < s.length) out.push(document.createTextNode(s.slice(i)));
  return out;
}

/** A ~90-char window of `text` around the first match. */
function snippet(text, q, width = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const j = s.toLowerCase().indexOf(q.toLowerCase());
  if (j < 0 || s.length <= width) return s;
  const start = Math.max(0, Math.min(j - 30, s.length - width));
  return `${start > 0 ? '…' : ''}${s.slice(start, start + width).trim()}${start + width < s.length ? '…' : ''}`;
}

function relDate(k) {
  if (!k || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return '';
  const d = diffDays(k, todayKey());
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d > 1 && d < 7) return `${d} days ago`;
  return fmtDate(k, k.slice(0, 4) === todayKey().slice(0, 4) ? 'short' : 'shortYear');
}

const JOURNAL_FIELDS = [['intention', 'Intention'], ['wins', 'Wins'], ['reflection', 'Reflection'], ['gratitude', 'Gratitude']];
const PLAN_FIELDS = [['plan', 'Plan'], ['watchlist', 'Watchlist'], ['review', 'Review'], ['lessons', 'Lessons']];
const REVIEW_FIELDS = [['wentWell', 'Went well'], ['improve', 'To improve'], ['focus', 'Focus']];

async function searchOwn(q, navigate) {
  const needle = q.toLowerCase();
  const [days, reviews] = await Promise.all([db.all('days'), db.all('reviews').catch(() => [])]);
  const journal = [];
  const plans = [];
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (!d || !d.date) continue;
    const jHit = JOURNAL_FIELDS.find(([f]) => typeof d[f] === 'string' && d[f].toLowerCase().includes(needle));
    if (jHit && journal.length < 50) {
      journal.push({ id: `day:${d.date}`, title: fmtDate(d.date, 'mediumYear'), subtitle: `${jHit[1]}: ${snippet(d[jHit[0]], q)}`, date: d.date, onOpen: () => navigate(`/today/${d.date}`) });
    }
    const t = d.trading || {};
    const pHit = PLAN_FIELDS.find(([f]) => typeof t[f] === 'string' && t[f].toLowerCase().includes(needle));
    if (pHit && plans.length < 50) {
      plans.push({ id: `plan:${d.date}`, title: `Trading day · ${fmtDate(d.date, 'medium')}`, subtitle: `${pHit[1]}: ${snippet(t[pHit[0]], q)}`, date: d.date, onOpen: () => navigate(`/trades/plan/${d.date}`) });
    }
  }
  const revs = [];
  for (const r of reviews) {
    const hit = REVIEW_FIELDS.find(([f]) => typeof r[f] === 'string' && r[f].toLowerCase().includes(needle));
    if (!hit || !r.type || !r.period) continue;
    const label = r.type === 'week' ? `Week ${Number(String(r.period).slice(6))} review` : r.type === 'month' ? `${fmtDate(`${r.period}-01`, 'monthYear')} review` : `${r.period} review`;
    const date = r.type === 'week' ? weekRange(r.period).to : r.type === 'month' ? `${r.period}-01` : `${r.period}-01-01`;
    revs.push({ id: `review:${r.id}`, title: label, subtitle: `${hit[1]}: ${snippet(r[hit[0]], q)}`, date, onOpen: () => navigate(`/insights/${r.type}/${r.period}`) });
  }
  revs.sort((a, b) => (a.date < b.date ? 1 : -1));
  return [
    { id: 'journal', title: 'Journal', icon: 'note', color: '--mood', items: journal },
    { id: 'plans', title: 'Trading plans', icon: 'notebook', color: '--trades', items: plans },
    { id: 'reviews', title: 'Reviews', icon: 'insights', color: '--primary', items: revs },
  ];
}

// ─────────────────────────────── view
async function render(root, ctx) {
  let q = String((ctx.route.query && ctx.route.query.q) || '');
  let disposed = false;
  let seq = 0;
  let rows = []; // visible result buttons in order
  let active = -1;
  let expanded = new Set();
  let lastGroups = [];
  const listId = uniqueId('search-results');

  const inputEl = h('input.input.search-input', {
    type: 'search',
    value: q,
    placeholder: 'Meals, trades, notes, reflections…',
    'aria-label': 'Search your journal',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-controls': listId,
    'aria-autocomplete': 'list',
    onInput: (e) => {
      q = e.target.value;
      clearBtn.hidden = !q;
      syncUrl();
      expanded = new Set();
      saveIdle.cancel();
      if (q.trim().length < MIN_CHARS) {
        run.cancel();
        run();
      } else {
        status.textContent = '';
        run();
      }
    },
    onKeydown: (e) => onKeys(e),
  });
  const clearBtn = h('button.btn.btn-ghost.btn-icon.search-clear', { type: 'button', 'aria-label': 'Clear search', title: 'Clear', hidden: !q, onClick: () => setQuery('') }, icon('x', { size: 18 }));
  const box = h('div.search-box', h('span.search-box-icon', { 'aria-hidden': 'true' }, icon('search', { size: 20 })), inputEl, clearBtn);
  const status = h('p.search-status', { 'aria-live': 'polite' });
  const results = h('div.search-results', { id: listId, role: 'listbox', 'aria-label': 'Search results' });

  mount(root, h('div.page.search-page', { style: { '--accent': colorVar(COLOR) } },
    pageHeader({ title: TITLE, subtitle: 'Find anything you’ve logged' }),
    h('div.search-top', box, status),
    results));

  function syncUrl() {
    const t = q.trim();
    ctx.navigate(t ? `/search?q=${encodeURIComponent(t)}` : '/search', { replace: true, silent: true });
  }
  function setQuery(v) {
    q = v;
    inputEl.value = v;
    clearBtn.hidden = !v;
    expanded = new Set();
    syncUrl();
    run.cancel();
    run();
    inputEl.focus();
  }

  function setActive(i, scroll = true) {
    rows.forEach((r) => { r.classList.remove('is-active'); r.setAttribute('aria-selected', 'false'); });
    active = rows.length ? Math.max(-1, Math.min(rows.length - 1, i)) : -1;
    const el = rows[active];
    if (el) {
      el.classList.add('is-active');
      el.setAttribute('aria-selected', 'true');
      inputEl.setAttribute('aria-activedescendant', el.id);
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    } else inputEl.removeAttribute('aria-activedescendant');
  }

  function onKeys(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return;
      e.preventDefault();
      const fromRow = rows.indexOf(document.activeElement);
      const cur = fromRow >= 0 ? fromRow : active;
      const next = e.key === 'ArrowDown' ? (cur < 0 ? 0 : Math.min(rows.length - 1, cur + 1)) : cur - 1;
      if (fromRow >= 0) {
        if (next < 0) { setActive(-1); inputEl.focus(); return; }
        setActive(next);
        rows[next].focus();
      } else setActive(next < 0 ? -1 : next);
    } else if (e.key === 'Enter' && e.target === inputEl) {
      e.preventDefault();
      if (run.pending && run.pending()) run.flush();
      const target = rows[active >= 0 ? active : 0];
      addRecent(q);
      if (target) target.click();
    } else if (e.key === 'Escape' && e.target === inputEl && q) {
      e.preventDefault();
      setQuery('');
    }
  }

  async function doSearch() {
    const my = ++seq;
    const term = q.trim();
    if (term.length < MIN_CHARS) {
      lastGroups = [];
      inputEl.setAttribute('aria-expanded', 'false');
      status.textContent = term.length ? 'Type at least 2 characters' : '';
      drawIdle();
      return;
    }
    results.setAttribute('aria-busy', 'true');
    const mods = getModules().filter((m) => m && m.id !== ID && typeof m.search === 'function');
    const [settled, own] = await Promise.all([
      Promise.allSettled(mods.map((m) => Promise.resolve().then(() => m.search(term)))),
      searchOwn(term, ctx.navigate).catch((err) => { console.warn('[daybook] search: days failed', err); return []; }),
    ]);
    if (disposed || my !== seq) return;
    results.removeAttribute('aria-busy');
    const groups = [];
    settled.forEach((res, i) => {
      if (res.status !== 'fulfilled' || !Array.isArray(res.value) || !res.value.length) return;
      const m = mods[i];
      groups.push({ id: m.id, title: m.title || m.id, icon: m.icon || 'circle', color: m.color || '--primary', items: res.value.filter((r) => r && (r.title || r.subtitle)) });
    });
    for (const g of own) if (g.items.length) groups.push(g);
    lastGroups = groups.filter((g) => g.items.length);
    drawResults(term);
    if (lastGroups.length) saveIdle();
  }
  const run = debounce(doSearch, 200);
  const saveIdle = debounce(() => addRecent(q), 1500);

  function drawIdle() {
    rows = [];
    setActive(-1, false);
    const recent = readRecent();
    const tips = h('div.card.search-tips',
      h('h2.search-tips-title', 'Try searching for'),
      h('ul.search-tip-list',
        h('li', icon('food', { size: 16 }), 'A meal — “dal”, “oats”'),
        h('li', icon('trades', { size: 16 }), 'A symbol or setup — “NIFTY”, “breakout”'),
        h('li', icon('learning', { size: 16 }), 'Something you learned, or a #tag'),
        h('li', icon('note', { size: 16 }), 'A word from your reflections or trade reviews')));
    mount(results,
      recent.length
        ? h('section.card.search-recent', { 'aria-labelledby': 'search-recent-title' },
            h('div.search-recent-head',
              h('h2.search-tips-title', { id: 'search-recent-title' }, 'Recent searches'),
              h('button.link-btn.search-recent-clear', { type: 'button', onClick: () => { writeRecent([]); drawIdle(); inputEl.focus(); } }, 'Clear')),
            h('div.chips.search-recent-chips', recent.map((r) => h('button.chip', { type: 'button', onClick: () => setQuery(r) }, icon('history', { size: 14 }), r))))
        : null,
      tips);
  }

  function drawResults(term) {
    const total = lastGroups.reduce((s, g) => s + g.items.length, 0);
    inputEl.setAttribute('aria-expanded', total ? 'true' : 'false');
    if (!total) {
      rows = [];
      setActive(-1, false);
      status.textContent = 'No results';
      mount(results, h('div.card', emptyState({
        icon: 'search',
        accent: COLOR,
        title: `Nothing matches “${term}”`,
        message: 'Check the spelling, try fewer letters (“prot” finds protein), or search a tag without the #.',
        action: { label: 'Clear search', icon: 'x', onClick: () => setQuery('') },
      })));
      return;
    }
    status.textContent = `${plural(total, 'result')} in ${plural(lastGroups.length, 'section')}`;
    rows = [];
    let n = 0;
    const cards = lastGroups.map((g) => {
      const open = expanded.has(g.id);
      const shown = open ? g.items : g.items.slice(0, PER_GROUP);
      const headId = `sr-${g.id}-h`;
      return h('section.card.card-flush.search-group', { role: 'group', 'aria-labelledby': headId, style: { '--accent': colorVar(g.color) } },
        h('div.search-group-head',
          iconChip(g.icon, { accent: g.color, size: 'sm' }),
          h('h2.search-group-title', { id: headId }, g.title),
          h('span.search-count.num', String(g.items.length))),
        h('div.search-rows', shown.map((r) => {
          const accent = r.color || g.color;
          const btn = h('button.search-row', {
            type: 'button',
            role: 'option',
            id: `${listId}-${n++}`,
            'aria-selected': 'false',
            onClick: () => {
              addRecent(q);
              try { typeof r.onOpen === 'function' ? r.onOpen() : null; } catch (err) { console.error('[daybook] search: open failed', err); }
            },
            onKeydown: (e) => onKeys(e),
            onMouseenter: () => setActive(rows.indexOf(btn), false),
          },
          iconChip(r.icon || g.icon, { accent, size: 'sm' }),
          h('span.search-row-main',
            h('span.search-row-title', highlight(r.title || '', term)),
            r.subtitle ? h('span.search-row-sub', highlight(r.subtitle, term)) : null),
          r.date ? h('span.search-row-date', relDate(r.date)) : null);
          rows.push(btn);
          return btn;
        })),
        g.items.length > PER_GROUP
          ? h('button.search-more', { type: 'button', 'aria-expanded': String(open), onClick: () => { open ? expanded.delete(g.id) : expanded.add(g.id); drawResults(term); } },
              open ? 'Show less' : `Show all ${g.items.length}`, icon(open ? 'chevron-up' : 'chevron-down', { size: 16 }))
          : null);
    });
    const keep = active;
    mount(results, cards);
    rows.forEach((r) => r.addEventListener('focus', () => setActive(rows.indexOf(r), false)));
    setActive(keep >= 0 && keep < rows.length ? keep : -1, false);
  }

  // Autofocus — after the shell moves focus to the h1 on render.
  const focusInput = () => {
    if (disposed) return;
    inputEl.focus({ preventScroll: true });
    const len = inputEl.value.length;
    try { inputEl.setSelectionRange(len, len); } catch { /* type=search may refuse */ }
  };
  const onRendered = () => setTimeout(focusInput, 0);
  window.addEventListener('daybook:rendered', onRendered, { once: true });
  const focusTimer = setTimeout(focusInput, 60);

  await doSearch();

  const refresh = debounce(() => { if (q.trim().length >= MIN_CHARS) doSearch(); }, 150);
  const offs = [on('db:change', refresh), on('settings:change', refresh)];
  return () => {
    disposed = true;
    run.cancel();
    saveIdle.cancel();
    refresh.cancel();
    clearTimeout(focusTimer);
    window.removeEventListener('daybook:rendered', onRendered);
    offs.forEach((off) => off());
  };
}

export default { id: ID, title: TITLE, icon: ICON, color: COLOR, render };
