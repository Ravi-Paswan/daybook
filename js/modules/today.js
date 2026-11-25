// Today — the home screen and daily journal (SPEC 4.1).
//
// Notes / choices (things the spec leaves open):
// - Layout: one DOM order (the phone order: hero → goals → quick log → water → module cards → reflection →
//   resurface) so tab order always matches what you see. At ≥ 1180px the same nodes are moved into two columns
//   (main: hero, goals, module cards · side: quick log, water, reflection, resurface) by a matchMedia listener.
// - The page header (h1 + dateNav) and the reflection form are never re-rendered by data refreshes, so focus and
//   typing are never interrupted. Every other block re-draws itself on db:change / settings:change, keeping
//   keyboard focus on the same control (data-fk keys).
// - The dateNav's own "Today" pill is hidden (CSS) in favour of a clearer "Back to today" pill next to it.
// - Changing the date rewrites the URL silently (#/today/<date>, or #/today for today) and sets the working date.
// - Reflection autosaves 600 ms after the last change (mood/energy save immediately), and flushes on date change,
//   route change (cleanup), pagehide and when the tab is hidden. Our own writes are recognised by their patch
//   object so they never reset the form; edits made elsewhere update fields that are not being edited.
// - Tapping an auto goal jumps to where its data comes from (water → water card, sleep/reflection → reflection
//   card, others → the module page when it exists).
// - Resurface: a learning from exactly 7/30/90/365 days before the shown date (starred first, then rotating by
//   date); otherwise the oldest learning due for review. Hidden when there is neither.
// - Backup banner: lastBackupAt older than backupReminderDays (0 = off), or never backed up with ≥ 20 records.
//   "Not now" hides it for the rest of the day (sessionStorage).
// - If the app stays open past midnight on "today", the page follows to the new day when it becomes visible.

import { db } from '../core/db.js';
import { on, setWorkingDate } from '../core/bus.js';
import { getSettings, learningCategory } from '../core/settings.js';
import { todayKey, addDays, diffDays, fmtDate, relativeDay, greeting, isValidKey, fmtTime, toKey } from '../core/dates.js';
import { fmtNumber, plural } from '../core/format.js';
import { METRICS, getGoalsForDay, getDayScores, getLoggingStreak, formatMetricValue } from '../core/metrics.js';
import {
  h, mount, icon, iconChip, button, card, dateNav, progressRing, progressBar, moodPicker, ratingInput, stepper,
  textarea, field, emptyState, skeleton, toast, debounce, colorVar,
} from '../core/ui.js';
import { getModules, getModule } from './registry.js';

const ID = 'today';
const WIDE_QUERY = '(min-width: 1180px)';
const REFLECTION_KEYS = ['mood', 'energy', 'sleep', 'intention', 'wins', 'reflection', 'gratitude'];
const ENERGY_LABELS = ['Drained', 'Low', 'Okay', 'Good', 'Charged'];
const RESURFACE = [
  [7, '1 week ago'],
  [30, '1 month ago'],
  [90, '3 months ago'],
  [365, '1 year ago'],
];
// Where an auto goal's data comes from. 'water' / 'reflection' are cards on this page.
const METRIC_SOURCE = {
  water: 'water', sleep: 'reflection', reflection: 'reflection', calories: 'food', protein: 'food', meals: 'food',
  trainingMinutes: 'training', workouts: 'training', steps: 'training', learnings: 'learning', learningMinutes: 'learning',
  spend: 'expenses', trades: 'trades',
};
const BACKUP_DISMISS_KEY = 'daybook.today.backupDismissed';
const COUNT_STORES = ['food', 'learning', 'workouts', 'expenses', 'trades', 'days'];

// ─────────────────────────────────────────────────────────────────────────────────────────── helpers

function ssGet(k) {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}
function ssSet(k, v) {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* private mode — the banner simply comes back */
  }
}

/** Re-mount `container`, keeping keyboard focus on the control with the same data-fk key. */
function remount(container, ...kids) {
  const active = document.activeElement;
  const key = active && container.contains(active) && active.dataset ? active.dataset.fk : null;
  mount(container, ...kids);
  if (key) {
    const el = Array.from(container.querySelectorAll('[data-fk]')).find((n) => n.dataset.fk === key);
    if (el) {
      try {
        el.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function safeRun(fn, what) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') {
      r.catch((err) => {
        console.error(`[today] ${what} failed`, err);
        toast('Something went wrong there.', { type: 'error' });
      });
    }
  } catch (err) {
    console.error(`[today] ${what} failed`, err);
    toast('Something went wrong there.', { type: 'error' });
  }
}

const toList = (v) => (v === null || v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]);

function longDay(date) {
  const sameYear = date.slice(0, 4) === todayKey().slice(0, 4);
  return `${fmtDate(date, 'weekdayLong')}, ${fmtDate(date, sameYear ? 'short' : 'shortYear')}`;
}

/** "6 / 8 glasses", "₹420 used of ₹500", "No data yet"… for a goal evaluation. */
function goalValueText(ev) {
  const g = ev.goal;
  if (g.kind === 'check') return ev.done ? 'Done' : 'Tap to check off';
  const def = METRICS[g.metric] || {};
  const fv = (v) => formatMetricValue(g.metric, v);
  if (def.unit === 'bool') return ev.done ? 'Written' : 'Not yet';
  if (ev.comparator === 'lte') {
    if (def.requiresData && ev.noData) return 'No data yet';
    const used = ev.value ?? 0;
    if (ev.over) return ev.target > 0 ? `${fv(used)} used · ${fv(used - ev.target)} over` : `${fv(used)} — over`;
    if (!ev.target) return used ? `${fv(used)} used` : 'Nothing so far';
    return `${fv(used)} used of ${fv(ev.target)}`;
  }
  const left = def.unit === 'min' || def.unit === 'money' ? fv(ev.value ?? 0) : fmtNumber(ev.value ?? 0, { maxDecimals: 1 });
  return `${left} / ${fv(ev.target)}`;
}

function motto({ total, done, isToday }) {
  if (!total) return isToday ? 'Set a few daily goals and watch your day fill up.' : 'No goals were set for this day.';
  const left = total - done;
  if (!isToday) {
    if (!left) return 'Perfect day — every goal hit.';
    if (done) return `You hit ${done} of ${total} goals that day.`;
    return 'A quiet day. Every day still counts.';
  }
  if (!left) return 'Every goal done. That’s a perfect day!';
  if (!done) {
    const hr = new Date().getHours();
    if (hr < 12) return 'Fresh start — pick one goal and make it happen.';
    if (hr < 18) return 'Plenty of day left. One small win gets you moving.';
    return 'Evening check-in — log what you did and close a goal or two.';
  }
  if (left === 1) return 'Just one goal to go — finish strong.';
  if (done / total >= 0.5) return `Over halfway there — ${left} to go.`;
  return 'Nice start — keep the momentum going.';
}

// ─────────────────────────────────────────────────────────────────────────────────────────── render

async function render(root, ctx) {
  const settings0 = getSettings();
  const param = ctx.route.params && ctx.route.params[0];
  let date = todayKey();
  if (param && isValidKey(param)) date = param > todayKey() ? todayKey() : param;
  if (param && param !== date) ctx.navigate(date === todayKey() ? '/today' : `/today/${date}`, { silent: true });
  setWorkingDate(date);

  let disposed = false;
  let onToday = date === todayKey(); // was the user looking at "today"? (follow it past midnight)
  let seq = 0; // bumps on date change; stale async draws compare against it
  const ownPatches = new WeakSet();
  const offs = [];

  // ── header (never re-rendered) ────────────────────────────────────────────────────────────────
  const eyebrow = h('p.today-eyebrow');
  const title = h('h1.page-title', { tabindex: '-1' });
  const backPill = button({ label: 'Back to today', icon: 'rotate-ccw', size: 'sm', pill: true, class: 'today-back', onClick: () => setDate(todayKey(), true) });
  const nav = dateNav(date, (d) => setDate(d, false));
  const header = h(
    'header.page-header.today-header',
    h('div.page-header-main', h('div.page-header-text', eyebrow, title)),
    h('div.today-datebar', nav, backPill)
  );

  // ── blocks ────────────────────────────────────────────────────────────────────────────────────
  const banner = h('div.today-banner-slot');
  const hero = h('section.card.today-hero', { 'aria-label': 'Day score' });
  const goalsBox = h('div.today-goals-slot');
  const quickBox = h('div.today-quick-slot');
  const waterBox = h('div.today-water-slot');
  const cardsBox = h('section.section.today-modules', { 'aria-label': 'Journal' });
  const reflectBox = h('div.today-reflect-slot');
  const resurfaceBox = h('div.today-resurface-slot');

  const grid = h('div.today-grid');
  const page = h('div.page.today-page', header, banner, grid);
  mount(root, page);

  // Move blocks between one column (phone order) and two columns.
  const mq = typeof matchMedia === 'function' ? matchMedia(WIDE_QUERY) : null;
  function place() {
    const wide = !!(mq && mq.matches);
    grid.classList.toggle('is-wide', wide);
    if (wide) {
      mount(grid, h('div.today-col.today-main', hero, goalsBox, cardsBox), h('div.today-col.today-side', quickBox, waterBox, reflectBox, resurfaceBox));
    } else {
      mount(grid, h('div.today-col', hero, goalsBox, h('div.today-pair', quickBox, waterBox), cardsBox, reflectBox, resurfaceBox));
    }
  }
  place();
  if (mq) {
    const onMq = () => place();
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
    offs.push(() => (mq.removeEventListener ? mq.removeEventListener('change', onMq) : mq.removeListener && mq.removeListener(onMq)));
  }

  // ── header text ───────────────────────────────────────────────────────────────────────────────
  function drawHeader() {
    const t = todayKey();
    const isToday = date === t;
    const name = (getSettings().name || '').trim();
    page.classList.toggle('is-past', !isToday);
    if (isToday) {
      eyebrow.textContent = longDay(date);
      title.textContent = name ? `${greeting()}, ${name}` : greeting();
      ctx.setTitle('Today');
    } else {
      const ago = diffDays(date, t);
      const rel = relativeDay(date);
      title.textContent = rel === 'Yesterday' ? 'Yesterday' : longDay(date);
      eyebrow.textContent = rel === 'Yesterday' ? `Looking back · ${longDay(date)}` : `Looking back · ${plural(ago, 'day')} ago`;
      ctx.setTitle(fmtDate(date, 'medium'));
    }
    backPill.hidden = isToday;
  }

  // ── hero: day score, streak, motivational line, 7-day strip ───────────────────────────────────
  let heroRing = null;
  function heroSkeleton() {
    mount(
      hero,
      h('div.today-hero-top', skeleton({ circle: true, height: 120, class: 'today-hero-skel-ring' }), h('div.today-hero-text', skeleton({ width: 90, height: 12 }), skeleton({ lines: 2, height: 16 }), skeleton({ width: 140, height: 28, radius: '999px' }))),
      h('div.today-week', Array.from({ length: 7 }, () => skeleton({ circle: true, height: 34 })))
    );
    heroRing = null;
  }

  function streakPill(streak, isToday) {
    const cur = streak ? streak.current : 0;
    const best = streak ? streak.best : 0;
    if (!cur) {
      return h('span.today-pill.today-streak.is-cold', icon('flame', { size: 16 }), h('span', isToday ? 'Start a streak today' : 'No streak yet'));
    }
    const keepGoing = isToday && streak && !streak.todayLogged;
    return h(
      'span.today-pill.today-streak',
      { title: `Best streak: ${plural(best, 'day')}` },
      icon('flame', { size: 16 }),
      h('span', h('strong.num', fmtNumber(cur)), '-day streak'),
      keepGoing ? h('span.today-pill-sub', '· log today to keep it') : best > cur ? h('span.today-pill-sub', `· best ${fmtNumber(best)}`) : null
    );
  }

  function avgPill(scores) {
    const vals = Object.values(scores || {}).filter((s) => s && s.score !== null && s.score !== undefined);
    if (vals.length < 2) return null;
    const avg = vals.reduce((a, s) => a + s.score, 0) / vals.length;
    return h('span.today-pill.today-avg', { title: 'Average day score over the days below' }, icon('bar-chart', { size: 15 }), h('span', h('strong.num', `${Math.round(avg * 100)}%`), ` ${vals.length}-day average`));
  }

  function weekStrip(scores, end) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(end, i - 6));
    const t = todayKey();
    return h(
      'nav.today-week',
      { 'aria-label': 'Recent days' },
      days.map((k) => {
        const s = scores[k] || { score: null, done: 0, total: 0 };
        const sel = k === date;
        const label = `${fmtDate(k, 'medium')}: ${s.total ? `${s.done} of ${s.total} goals` : 'no goals'}`;
        return h(
          'button.today-day',
          {
            type: 'button',
            class: { 'is-selected': sel, 'is-today': k === t, 'is-perfect': s.total > 0 && s.done === s.total },
            'aria-label': label,
            'aria-current': sel ? 'date' : null,
            dataset: { fk: `day-${k}` },
            onClick: () => setDate(k, true),
          },
          h('span.today-day-name', { 'aria-hidden': 'true' }, fmtDate(k, 'narrow')),
          progressRing(s.score ?? 0, { size: 34, stroke: 4, accent: s.total && s.done === s.total ? '--success' : '--primary', label: fmtDate(k, 'day'), ariaLabel: label })
        );
      })
    );
  }

  async function drawHero(goals) {
    const my = seq;
    const t = todayKey();
    const isToday = date === t;
    let end = addDays(date, 3);
    if (end > t) end = t;
    const [scores, streak] = await Promise.all([
      getDayScores(addDays(end, -6), end).catch(() => ({})),
      getLoggingStreak().catch(() => null),
    ]);
    if (disposed || my !== seq) return;
    const total = goals.length;
    const done = goals.filter((g) => g.done).length;
    const frac = total ? done / total : 0;
    const perfect = total > 0 && done === total;
    const ringLabel = total ? `${Math.round(frac * 100)}%` : '—';
    const ringSub = total ? `${done} of ${total} goals` : 'No goals yet';
    const accent = perfect ? '--success' : '--primary';
    hero.classList.toggle('is-perfect', perfect);
    if (heroRing && hero.contains(heroRing)) {
      heroRing.style.setProperty('--accent', colorVar(accent));
      heroRing.update(frac, { label: ringLabel, sublabel: ringSub });
    } else {
      heroRing = progressRing(frac, { size: 128, stroke: 12, accent, label: ringLabel, sublabel: ringSub, ariaLabel: `Day score ${ringLabel}, ${ringSub}` });
    }
    heroRing.setAttribute('aria-label', `Day score ${ringLabel}, ${ringSub}`);
    remount(
      hero,
      h(
        'div.today-hero-top',
        h('div.today-hero-ring', heroRing, perfect ? h('span.today-hero-badge', { 'aria-hidden': 'true' }, icon('trophy', { size: 16 })) : null),
        h(
          'div.today-hero-text',
          h('p.today-hero-kicker', isToday ? 'Today’s score' : 'Day score'),
          h('p.today-motto', motto({ total, done, isToday })),
          h(
            'div.today-hero-pills',
            streakPill(streak, isToday),
            avgPill(scores),
            !total ? h('a.today-pill.today-pill-link', { href: '#/goals', dataset: { fk: 'hero-goals' } }, icon('plus', { size: 15 }), h('span', 'Add goals')) : null
          )
        )
      ),
      weekStrip(scores, end)
    );
  }

  // ── goals checklist ───────────────────────────────────────────────────────────────────────────
  function goalsSkeleton() {
    mount(
      goalsBox,
      card({
        title: 'Goals',
        icon: 'target',
        accent: '--goals',
        class: 'today-goals',
        flush: true,
        children: h('div.today-goal-list', Array.from({ length: 4 }, () => h('div.today-goal.is-skeleton', skeleton({ width: 36, height: 36, radius: '11px' }), h('div.today-goal-main', skeleton({ width: '55%', height: 14 }), skeleton({ height: 6 }))))),
      })
    );
  }

  function jumpTo(target) {
    if (target === 'water') {
      const btn = waterBox.querySelector('[data-fk="water-plus"]');
      waterBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (btn) btn.focus({ preventScroll: true });
      return;
    }
    if (target === 'reflection') {
      reflectBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const first = reflectBox.querySelector('.mood-option[tabindex="0"], textarea');
      if (first) first.focus({ preventScroll: true });
      return;
    }
    ctx.navigate(`/${target}`);
  }

  async function toggleCheck(goal, row) {
    const next = row.getAttribute('aria-checked') !== 'true';
    row.setAttribute('aria-checked', String(next));
    row.classList.toggle('is-done', next);
    const meta = row.querySelector('.today-goal-value');
    if (meta) meta.textContent = next ? 'Done' : 'Tap to check off';
    try {
      const p = { checks: { [goal.id]: next } };
      await db.patchDay(date, p);
    } catch (err) {
      console.error('[today] check failed', err);
      toast('Couldn’t save that. Try again.', { type: 'error' });
    }
  }

  function goalRow(ev) {
    const g = ev.goal;
    const accent = g.color || (METRICS[g.metric] || {}).color || '--goals';
    const ic = g.icon || (METRICS[g.metric] || {}).icon || 'target';
    const chip = iconChip(ic, { accent });
    if (g.kind === 'check') {
      const row = h(
        'button.today-goal.is-check',
        {
          type: 'button',
          role: 'checkbox',
          'aria-checked': String(!!ev.done),
          class: { 'is-done': ev.done },
          style: { '--accent': colorVar(accent) },
          dataset: { fk: `goal-${g.id}` },
          onClick: () => toggleCheck(g, row),
        },
        chip,
        h('span.today-goal-main', h('span.today-goal-title', g.title), h('span.today-goal-value', ev.done ? 'Done' : 'Tap to check off')),
        h('span.today-check', { 'aria-hidden': 'true' }, icon('check', { size: 16, strokeWidth: 3 }))
      );
      return row;
    }
    const src = METRIC_SOURCE[g.metric];
    const canJump = src === 'water' || src === 'reflection' || (src && getModule(src));
    const status = ev.over
      ? h('span.today-goal-status.is-over', { title: 'Over the limit' }, icon('alert', { size: 18 }))
      : ev.done
        ? h('span.today-goal-status.is-done', { title: 'Done' }, icon('check', { size: 14, strokeWidth: 3 }))
        : h('span.today-goal-status', { 'aria-hidden': 'true' });
    const statusText = ev.over ? 'Over the limit' : ev.done ? 'Done' : 'Not done yet';
    return h(
      canJump ? 'button.today-goal' : 'div.today-goal',
      {
        type: canJump ? 'button' : null,
        class: { 'is-done': ev.done, 'is-over': ev.over, 'is-nodata': ev.noData && ev.comparator === 'lte' },
        style: { '--accent': colorVar(accent) },
        dataset: { fk: `goal-${g.id}` },
        onClick: canJump ? () => jumpTo(src) : null,
      },
      chip,
      h(
        'span.today-goal-main',
        h('span.today-goal-line', h('span.today-goal-title', g.title), h('span.today-goal-value.num', goalValueText(ev))),
        progressBar(ev.comparator === 'lte' && ev.noData ? 0 : ev.progress, { accent, over: ev.over, height: 6, label: `${g.title}: ${goalValueText(ev)}` })
      ),
      h('span.sr-only', statusText),
      status
    );
  }

  function drawGoals(goals) {
    const total = goals.length;
    const done = goals.filter((g) => g.done).length;
    const isToday = date === todayKey();
    const manage = button({ label: 'Manage', variant: 'ghost', size: 'sm', iconEnd: 'chevron-right', class: 'today-manage', onClick: () => ctx.navigate('/goals'), 'data-fk': 'goals-manage' });
    const body = total
      ? h('div.today-goal-list', goals.map(goalRow))
      : emptyState({
          icon: 'target',
          accent: '--goals',
          compact: true,
          title: isToday ? 'No goals for today' : 'No goals that day',
          message: 'Goals turn your logs into a daily score — water, protein, training, reading…',
          action: { label: 'Add goals', icon: 'plus', onClick: () => ctx.navigate('/goals') },
        });
    remount(
      goalsBox,
      card({
        title: isToday ? 'Today’s goals' : 'Goals',
        subtitle: total ? (done === total ? `All ${total} done` : `${done} of ${total} done`) : null,
        icon: 'target',
        accent: '--goals',
        class: 'today-goals',
        flush: true,
        actions: [manage],
        children: body,
      })
    );
  }

  async function drawScore() {
    const my = seq;
    let goals = [];
    try {
      goals = await getGoalsForDay(date);
    } catch (err) {
      console.error('[today] goals failed', err);
    }
    if (disposed || my !== seq) return;
    drawGoals(goals);
    await drawHero(goals);
  }

  // ── quick log ─────────────────────────────────────────────────────────────────────────────────
  function drawQuick() {
    const tiles = [];
    for (const mod of getModules()) {
      if (!mod || mod.id === ID) continue;
      let list = [];
      try {
        list = typeof mod.quickActions === 'function' ? mod.quickActions() : mod.quickActions;
      } catch (err) {
        console.error(`[today] quickActions of "${mod.id}" failed`, err);
      }
      for (const a of toList(list)) {
        if (!a || typeof a.run !== 'function') continue;
        tiles.push(
          h(
            'button.today-qa',
            {
              type: 'button',
              style: { '--accent': colorVar(a.color || mod.color || '--primary') },
              dataset: { fk: `qa-${mod.id}-${a.id}` },
              onClick: () => safeRun(() => a.run({ date }), `quick action ${a.id}`),
            },
            h('span.today-qa-chip', { 'aria-hidden': 'true' }, icon(a.icon || mod.icon || 'plus', { size: 22 })),
            h('span.today-qa-label', a.label || mod.title)
          )
        );
      }
    }
    remount(
      quickBox,
      card({
        title: 'Quick log',
        icon: 'plus',
        accent: '--primary',
        class: 'today-quick',
        children: tiles.length
          ? h('div.today-qa-grid', { role: 'group', 'aria-label': 'Quick log' }, tiles)
          : h('p.today-muted', 'Quick actions appear here as your journal sections come online.'),
      })
    );
  }

  // ── water ─────────────────────────────────────────────────────────────────────────────────────
  let water = 0;
  async function setWater(n) {
    const v = Math.max(0, Math.min(40, Math.round(n)));
    if (v === water) return;
    water = v;
    renderWater();
    try {
      await db.patchDay(date, { water: v });
    } catch (err) {
      console.error('[today] water failed', err);
      toast('Couldn’t save water. Try again.', { type: 'error' });
    }
  }
  function renderWater() {
    const s = getSettings();
    const target = Math.max(1, Math.round(Number(s.targets && s.targets.water) || 8));
    const ml = Number(s.targets && s.targets.glassMl) || 250;
    const count = Math.min(16, Math.max(target, water + (water >= target ? 1 : 0)));
    const litres = (water * ml) / 1000;
    const done = water >= target;
    const glasses = Array.from({ length: count }, (_, i) => {
      const n = i + 1;
      const full = n <= water;
      return h(
        'button.today-glass',
        {
          type: 'button',
          class: { 'is-full': full, 'is-bonus': n > target },
          'aria-pressed': String(full),
          'aria-label': full && n === water ? `${plural(n, 'glass', 'glasses')} — tap to undo` : `Set to ${plural(n, 'glass', 'glasses')}`,
          dataset: { fk: `glass-${n}` },
          onClick: () => setWater(water === n ? n - 1 : n),
        },
        h('span.today-glass-fill', { 'aria-hidden': 'true' })
      );
    });
    remount(
      waterBox,
      card({
        title: 'Water',
        subtitle: `${fmtNumber(litres, { maxDecimals: 2 })} L of ${fmtNumber((target * ml) / 1000, { maxDecimals: 2 })} L`,
        icon: 'water',
        accent: '--water',
        class: ['today-water', done && 'is-done'],
        children: [
          h('div.today-glasses', { role: 'group', 'aria-label': 'Glasses of water' }, glasses),
          h(
            'div.today-water-bar',
            button({ label: 'One glass less', icon: 'minus', iconOnly: true, variant: 'secondary', disabled: water <= 0, onClick: () => setWater(water - 1), 'data-fk': 'water-minus' }),
            h(
              'div.today-water-count',
              { 'aria-live': 'polite' },
              h('span.today-water-num.num', fmtNumber(water)),
              h('span.today-water-of', ` / ${plural(target, 'glass', 'glasses')}`),
              done ? h('span.today-water-done', icon('check', { size: 14, strokeWidth: 3 }), 'Goal met') : null
            ),
            button({ label: 'One more glass', icon: 'plus', iconOnly: true, variant: 'primary', onClick: () => setWater(water + 1), 'data-fk': 'water-plus' })
          ),
        ],
      })
    );
  }
  async function drawWater() {
    const my = seq;
    let day;
    try {
      day = await db.getDay(date);
    } catch {
      day = { water: 0 };
    }
    if (disposed || my !== seq) return;
    water = Number(day.water) || 0;
    renderWater();
  }

  // ── module cards (summarizeDay) ───────────────────────────────────────────────────────────────
  const cardSlots = new Map(); // module id → slot element
  function summaryModules() {
    return getModules().filter((m) => m && m.id !== ID && typeof m.summarizeDay === 'function');
  }

  function skeletonCard(mod) {
    return h(
      'section.card.today-mod.is-loading',
      { style: { '--accent': colorVar(mod.color || '--primary') }, 'aria-busy': 'true', 'aria-label': `${mod.title || mod.id} loading` },
      h('div.card-header', iconChip(mod.icon || 'circle', { accent: mod.color }), h('div.card-header-text', h('h2.card-title', mod.title || mod.id), skeleton({ width: 120, height: 12 }))),
      h('div.today-mod-skel', skeleton({ lines: 3, height: 14 }))
    );
  }

  function errorCard(mod, retry) {
    return card({
      title: mod.title || mod.id,
      subtitle: 'Couldn’t load this summary',
      icon: 'alert',
      accent: '--warning',
      class: 'today-mod is-error',
      children: h(
        'div.row',
        button({ label: 'Try again', icon: 'refresh', size: 'sm', onClick: retry, 'data-fk': `retry-${mod.id}` }),
        button({ label: `Open ${mod.title || mod.id}`, variant: 'ghost', size: 'sm', onClick: () => ctx.navigate(`/${mod.id}`) })
      ),
    });
  }

  function itemRow(mod, item, i) {
    const t = fmtTime(item.time);
    const meta = [];
    for (const m of [t, ...toList(item.meta)]) {
      const s = typeof m === 'string' || typeof m === 'number' ? String(m) : '';
      if (s && !meta.includes(s)) meta.push(s);
    }
    const open = typeof item.onOpen === 'function';
    return h(
      open ? 'button.today-item' : 'div.today-item',
      {
        type: open ? 'button' : null,
        dataset: { fk: `item-${mod.id}-${item.id ?? i}` },
        onClick: open ? () => safeRun(() => item.onOpen(), `open ${mod.id} item`) : null,
      },
      h('span.today-item-dot', { 'aria-hidden': 'true' }),
      h('span.today-item-main', h('span.today-item-title', String(item.title ?? '')), meta.length ? h('span.today-item-meta', meta.join(' · ')) : null),
      open ? icon('chevron-right', { size: 16, class: 'today-item-chev' }) : null
    );
  }

  function moduleCard(mod, s) {
    const sum = s && typeof s === 'object' ? s : {};
    const accent = sum.color || mod.color || '--primary';
    const items = Array.isArray(sum.items) ? sum.items : [];
    const shown = items.slice(0, 4);
    const more = items.length - shown.length;
    const titleText = sum.title || mod.title || mod.id;
    const canAdd = typeof sum.onAdd === 'function';
    const add = () => safeRun(() => sum.onAdd(), `add ${mod.id}`);
    const actions = [];
    if (canAdd && items.length) actions.push(button({ label: sum.addLabel || 'Add', icon: 'plus', iconOnly: true, variant: 'ghost', size: 'sm', onClick: add, 'data-fk': `add-${mod.id}` }));
    actions.push(button({ label: `Open ${titleText}`, icon: 'chevron-right', iconOnly: true, variant: 'ghost', size: 'sm', onClick: () => ctx.navigate(`/${mod.id}`), 'data-fk': `open-${mod.id}` }));
    const body = items.length
      ? [
          h('div.today-items', shown.map((it, i) => itemRow(mod, it, i))),
          more > 0 ? h('button.today-more', { type: 'button', onClick: () => ctx.navigate(`/${mod.id}`), dataset: { fk: `more-${mod.id}` } }, `+${more} more`, icon('arrow-right', { size: 14 })) : null,
        ]
      : [
          h('p.today-mod-empty', sum.empty || 'Nothing logged yet'),
          canAdd ? h('button.today-mod-add', { type: 'button', onClick: add, dataset: { fk: `add-${mod.id}` } }, icon('plus', { size: 16 }), h('span', sum.addLabel || 'Add')) : null,
        ];
    return card({
      title: titleText,
      subtitle: items.length ? sum.headline || plural(items.length, 'entry', 'entries') : null,
      icon: sum.icon || mod.icon || 'circle',
      accent,
      class: ['today-mod', !items.length && 'is-empty'],
      actions,
      children: body,
    });
  }

  async function loadCard(mod, slot, my) {
    try {
      const s = await Promise.resolve().then(() => mod.summarizeDay(date));
      if (disposed || my !== seq) return;
      remount(slot, moduleCard(mod, s));
    } catch (err) {
      if (disposed || my !== seq) return;
      console.error(`[today] summarizeDay of "${mod.id}" failed`, err);
      remount(slot, errorCard(mod, () => {
        remount(slot, skeletonCard(mod));
        loadCard(mod, slot, seq);
      }));
    }
  }

  function drawCards(withSkeletons) {
    const mods = summaryModules();
    const my = seq;
    if (!mods.length) {
      mount(cardsBox, h('h2.section-title', 'Your day'), emptyState({ icon: 'notebook', compact: true, title: 'Your journal sections are on their way', message: 'Food, learning, training, money and trades will show up here as soon as they’re ready.' }));
      cardSlots.clear();
      return Promise.resolve();
    }
    const ids = mods.map((m) => m.id).join('|');
    if (withSkeletons || cardsBox.dataset.ids !== ids) {
      cardSlots.clear();
      const slots = mods.map((m) => {
        const slot = h('div.today-mod-slot', skeletonCard(m));
        cardSlots.set(m.id, slot);
        return slot;
      });
      mount(cardsBox, h('h2.section-title', 'Your day'), h('div.today-mod-grid', slots));
      cardsBox.dataset.ids = ids;
    }
    return Promise.allSettled(mods.map((m) => loadCard(m, cardSlots.get(m.id), my)));
  }

  // ── reflection (built once per date; autosaves) ───────────────────────────────────────────────
  let pend = null; // {date, patch}
  let status = null;
  let statusTimer = 0;
  let controls = null; // {mood, energy, sleep, intention, wins, reflection, gratitude}

  function setStatus(kind) {
    if (!status) return;
    clearTimeout(statusTimer);
    status.dataset.state = kind;
    mount(
      status,
      kind === 'saving' ? [h('span.today-save-dot', { 'aria-hidden': 'true' }), 'Saving…'] : kind === 'saved' ? [icon('check', { size: 14, strokeWidth: 2.5 }), 'Saved'] : kind === 'error' ? [icon('alert', { size: 14 }), 'Not saved'] : ''
    );
    if (kind === 'saved') statusTimer = setTimeout(() => status && (status.dataset.state = 'idle'), 2400);
  }

  async function flushSave() {
    if (!pend) return;
    const { date: d, patch } = pend;
    pend = null;
    const p = { ...patch };
    ownPatches.add(p);
    try {
      await db.patchDay(d, p);
      if (!pend) setStatus('saved');
    } catch (err) {
      console.error('[today] reflection save failed', err);
      setStatus('error');
      toast('Couldn’t save your reflection. Try again.', { type: 'error' });
    }
  }
  const saveSoon = debounce(flushSave, 600);

  function queue(patch, now = false) {
    if (pend && pend.date !== date) {
      saveSoon.cancel();
      flushSave();
    }
    if (!pend) pend = { date, patch: {} };
    Object.assign(pend.patch, patch);
    setStatus('saving');
    if (now) {
      saveSoon.cancel();
      flushSave();
    } else saveSoon();
  }

  function buildReflection(day) {
    const isToday = date === todayKey();
    status = h('span.today-save', { role: 'status', 'aria-live': 'polite', dataset: { state: 'idle' } });
    const mood = moodPicker(day.mood, (v) => queue({ mood: v }, true), { ariaLabel: 'Mood' });
    const energy = ratingInput(day.energy, (v) => queue({ energy: v }, true), { icon: 'zap', labels: ENERGY_LABELS, ariaLabel: 'Energy' });
    const sleep = stepper(day.sleep, (v) => queue({ sleep: v }), { min: 0, max: 24, step: 0.5, label: 'Sleep', unit: 'h' });
    // An empty sleep value starts at 7 h on the first "+", not 0.5 h.
    const plus = sleep.querySelector('.stepper-btn:last-of-type');
    if (plus) {
      const seed = () => {
        if (sleep.getValue() === null) sleep.setValue(6.5);
      };
      plus.addEventListener('pointerdown', seed, true);
      plus.addEventListener('click', (e) => e.detail === 0 && seed(), true);
    }
    const ta = (key, placeholder, rows = 2) =>
      textarea({ value: day[key] || '', rows, placeholder, class: rows < 3 ? 'today-ta-sm' : null, onInput: (e) => queue({ [key]: e.target.value }) });
    const intention = ta('intention', isToday ? 'One thing that would make today great…' : 'What was the focus?');
    const wins = ta('wins', 'What went well? Big or small.');
    const reflection = ta('reflection', 'Thoughts, lessons, how the day felt…', 3);
    const gratitude = ta('gratitude', 'Three small things you’re grateful for…');
    controls = { mood, energy, sleep, intention, wins, reflection, gratitude };

    const el = card({
      title: 'Reflection',
      subtitle: isToday ? 'How’s today going?' : 'How was this day?',
      icon: 'notebook',
      accent: '--mood',
      class: 'today-reflect',
      actions: [status],
      children: [
        field('Mood', mood),
        h('div.today-reflect-row', h('div.today-energy', { style: { '--accent': 'var(--goals)' } }, field('Energy', energy)), field('Sleep', sleep, { hint: 'Hours last night' })),
        field(isToday ? 'Today’s intention' : 'Intention', intention),
        field('Wins', wins),
        field('Reflection', reflection),
        field('Grateful for', gratitude),
      ],
    });
    el.id = 'today-reflection';
    mount(reflectBox, el);
    requestAnimationFrame(() => [intention, wins, reflection, gratitude].forEach((t) => t.autogrow && t.autogrow()));
  }

  /** Someone else (another tab, import, quick-add) changed this day: update fields that aren't being edited. */
  function syncReflection(day) {
    if (!controls || pend) return;
    const active = document.activeElement;
    for (const k of ['intention', 'wins', 'reflection', 'gratitude']) {
      const t = controls[k];
      if (t !== active && t.value !== (day[k] || '')) {
        t.value = day[k] || '';
        if (t.autogrow) t.autogrow();
      }
    }
    if (!controls.mood.contains(active)) controls.mood.setValue(day.mood);
    if (!controls.energy.contains(active)) controls.energy.setValue(day.energy);
    if (!controls.sleep.contains(active)) controls.sleep.setValue(day.sleep);
  }

  async function drawReflection(sync = false) {
    const my = seq;
    let day;
    try {
      day = await db.getDay(date);
    } catch (err) {
      console.error('[today] day load failed', err);
      day = {};
    }
    if (disposed || my !== seq) return;
    if (sync) syncReflection(day);
    else buildReflection(day);
  }

  // ── resurface ─────────────────────────────────────────────────────────────────────────────────
  async function drawResurface() {
    const my = seq;
    let pick = null;
    let label = '';
    let due = [];
    try {
      const found = await Promise.all(RESURFACE.map(([n]) => db.byDate('learning', addDays(date, -n))));
      const cands = [];
      found.forEach((list, i) => list.forEach((r) => cands.push({ r, label: RESURFACE[i][1] })));
      if (cands.length) {
        const starred = cands.filter((c) => c.r.starred);
        const pool = starred.length ? starred : cands;
        const seed = Number(date.replace(/-/g, '')) % pool.length;
        ({ r: pick, label } = pool[seed]);
      }
      if (date === todayKey()) {
        due = await db.byIndex('learning', 'nextReview', IDBKeyRange.upperBound(date));
        due = due.filter((r) => r && r.nextReview);
        due.sort((a, b) => String(a.nextReview).localeCompare(String(b.nextReview)));
      }
    } catch (err) {
      console.warn('[today] resurface failed', err);
    }
    if (disposed || my !== seq) return;
    if (!pick && due.length) {
      pick = due[0];
      label = 'Due for review';
    }
    if (!pick) {
      mount(resurfaceBox);
      return;
    }
    const cat = learningCategory(pick.category);
    const learning = getModule('learning');
    const openIt = () => (learning && typeof learning.openEditor === 'function' ? safeRun(() => learning.openEditor(pick), 'open learning') : ctx.navigate('/learning'));
    remount(
      resurfaceBox,
      card({
        title: 'Remember this?',
        subtitle: label === 'Due for review' ? `Learned ${relativeDay(pick.date)}` : `From ${label}`,
        icon: 'history',
        accent: '--learning',
        class: 'today-resurface',
        children: [
          h(
            'button.today-resurface-body',
            { type: 'button', onClick: openIt, dataset: { fk: 'resurface-open' } },
            h('span.emoji-chip', { 'aria-hidden': 'true', style: { '--accent': cat.color || 'var(--learning)' } }, cat.emoji || '✨'),
            h('span.today-resurface-text', h('span.today-resurface-title', pick.title || 'Untitled'), pick.takeaway ? h('span.today-resurface-quote', pick.takeaway) : null, h('span.today-resurface-meta', [cat.name, pick.sourceName].filter(Boolean).join(' · ')))
          ),
          due.length
            ? h(
                'div.today-resurface-foot',
                h('span.today-muted', `${plural(due.length, 'learning')} due for review`),
                button({ label: 'Review now', iconEnd: 'arrow-right', size: 'sm', variant: 'secondary', onClick: () => ctx.navigate('/learning/review'),'data-fk': 'resurface-review' })
              )
            : h('div.today-resurface-foot', button({ label: 'Open learning', iconEnd: 'arrow-right', size: 'sm', variant: 'ghost', onClick: () => ctx.navigate('/learning'), 'data-fk': 'resurface-review' })),
        ],
      })
    );
  }

  // ── backup reminder ───────────────────────────────────────────────────────────────────────────
  async function drawBanner() {
    const s = getSettings();
    const every = Number(s.backupReminderDays ?? 7);
    const t = todayKey();
    let text = '';
    if (every > 0 && ssGet(BACKUP_DISMISS_KEY) !== t) {
      if (s.lastBackupAt) {
        const last = toKey(s.lastBackupAt);
        const age = last ? diffDays(last, t) : 0;
        if (age >= every) text = `Your last backup was ${plural(age, 'day')} ago.`;
      } else {
        try {
          const counts = await Promise.all(COUNT_STORES.map((st) => db.count(st)));
          const total = counts.reduce((a, b) => a + b, 0);
          if (total >= 20) text = `You have ${fmtNumber(total)} entries and no backup yet.`;
        } catch {
          /* ignore */
        }
      }
    }
    if (disposed) return;
    if (!text) {
      mount(banner);
      return;
    }
    remount(
      banner,
      h(
        'div.callout.today-banner',
        { role: 'status', style: { '--accent': 'var(--warning)' } },
        icon('shield', { size: 20 }),
        h('div.today-banner-text', h('strong', 'Back up your journal'), h('span', ` ${text} Everything lives on this device — a backup keeps it safe.`)),
        h(
          'div.today-banner-actions',
          button({ label: 'Back up', icon: 'download', size: 'sm', variant: 'primary', onClick: () => ctx.navigate('/settings'), 'data-fk': 'backup-go' }),
          button({
            label: 'Not now',
            icon: 'x',
            iconOnly: true,
            size: 'sm',
            variant: 'ghost',
            onClick: () => {
              ssSet(BACKUP_DISMISS_KEY, t);
              mount(banner);
            },
          })
        )
      )
    );
  }

  // ── orchestration ─────────────────────────────────────────────────────────────────────────────
  function drawAll(first) {
    drawHeader();
    if (first) {
      heroSkeleton();
      goalsSkeleton();
    }
    drawQuick();
    return Promise.allSettled([drawScore(), drawWater(), drawCards(first), drawReflection(false), drawResurface(), drawBanner()]);
  }

  function setDate(d, fromOutside) {
    if (!d || d === date) return;
    const t = todayKey();
    if (d > t) d = t;
    // Save what was typed for the previous day first.
    saveSoon.cancel();
    flushSave();
    date = d;
    onToday = d === t;
    seq++;
    setWorkingDate(date);
    ctx.navigate(date === t ? '/today' : `/today/${date}`, { silent: true });
    if (fromOutside) nav.setDate(date);
    drawAll(true);
  }

  // Give fast data a moment to land (no skeleton flash), but never let a slow module hold up the page.
  await Promise.race([drawAll(true), new Promise((r) => setTimeout(r, 350))]);

  // Re-draw on changes.
  let dirty = { score: false, water: false, cards: false, reflect: false, resurface: false, banner: false };
  const flushRefresh = debounce(() => {
    if (disposed) return;
    const d = dirty;
    dirty = { score: false, water: false, cards: false, reflect: false, resurface: false, banner: false };
    if (d.header) drawHeader();
    if (d.quick) drawQuick();
    if (d.score) drawScore();
    if (d.water) drawWater();
    if (d.cards) drawCards(false);
    if (d.reflect) drawReflection(true);
    if (d.resurface) drawResurface();
    if (d.banner) drawBanner();
  }, 90);
  const mark = (...keys) => {
    keys.forEach((k) => (dirty[k] = true));
    flushRefresh();
  };

  offs.push(
    on('db:change', (e) => {
      const store = e && e.store;
      if (store === '*') return mark('score', 'water', 'cards', 'reflect', 'resurface', 'banner');
      if (store === 'goals') return mark('score');
      if (store === 'meta') return;
      if (store === 'days') {
        if (e.key && e.key !== date) return mark('score', 'banner'); // other days only move the streak / week strip
        const keys = e.patch ? Object.keys(e.patch) : null;
        if (e.patch && ownPatches.has(e.patch)) return mark('score');
        if (keys && keys.length && keys.every((k) => REFLECTION_KEYS.includes(k))) return mark('score', 'reflect');
        if (keys && keys.length === 1 && keys[0] === 'checks') return mark('score');
        return mark('score', 'water', 'cards', 'reflect', 'banner');
      }
      mark('score', 'cards', 'banner');
      if (store === 'learning') mark('resurface');
    }),
    on('settings:change', () => mark('header', 'quick', 'score', 'water', 'cards', 'banner'))
  );

  // Flush typing when the page is hidden / unloaded; follow midnight.
  const onHide = () => {
    saveSoon.cancel();
    flushSave();
  };
  const onVis = () => {
    if (document.visibilityState === 'hidden') onHide();
    else if (onToday && date !== todayKey()) setDate(todayKey(), true);
  };
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onVis);
  offs.push(() => {
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onVis);
  });

  return () => {
    disposed = true;
    flushRefresh.cancel();
    clearTimeout(statusTimer);
    saveSoon.cancel();
    flushSave();
    offs.forEach((off) => {
      try {
        off();
      } catch {
        /* ignore */
      }
    });
  };
}

export default {
  id: ID,
  title: 'Today',
  icon: 'today',
  color: '--primary',
  render,
};
