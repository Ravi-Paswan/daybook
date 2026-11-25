// Onboarding (SPEC 4.12) — route 'welcome', full-screen (the shell hides its chrome via html.is-fullscreen).
// 4 steps with progress dots, Back/Next, Enter = next (each step is one <form>): (1) welcome + name,
// (2) currency + units + week start (pre-selected from navigator.language), (3) daily goals from presets with
// editable targets, (4) start fresh or explore with sample data.
// Finish: saves settings, creates the chosen goals (existing ids are kept), optionally loads sample data, asks for
// persistent storage (result ignored), sets onboarded:true and goes to Today.
// Already onboarded → a "You're all set" screen with Go to Today, or "Run setup again" (prefilled from the current
// settings; never wipes data — goals that already exist are left as they are).
// Desktop (≥ 960px): split screen — brand panel on the left, the step card on the right.

import { db } from '../core/db.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { defaultGoals } from '../core/metrics.js';
import { CURRENCIES, currencySymbol, fmtMoney, fmtNumber, fmtDuration, guessCurrency } from '../core/format.js';
import { navigate } from '../core/router.js';
import { h, mount, icon, button, iconChip, field, input, select, segmented, stepper, toast } from '../core/ui.js';

const ID = 'welcome';
const STEPS = ['Welcome', 'Your region', 'Daily goals', 'Get started'];

// Rough "a typical day's spending" default per currency (only used to pre-fill the optional spending goal).
const SPEND_DEFAULT = {
  INR: 1000, PKR: 3000, BDT: 2000, LKR: 5000, NPR: 1500, JPY: 5000, KRW: 50000, IDR: 300000, VND: 1000000, PHP: 2000,
  THB: 1500, MYR: 150, CNY: 300, HKD: 300, TWD: 1500, RUB: 3000, TRY: 1500, NGN: 20000, KES: 3000, BRL: 200, MXN: 800,
  ZAR: 800, SEK: 400, NOK: 400, DKK: 300, PLN: 200, CZK: 1000, HUF: 15000, AED: 150, SAR: 150, EGP: 1500, ILS: 150,
};

function localeRegion() {
  try {
    const l = new Intl.Locale(navigator.language || 'en-US');
    return l.region || (l.maximize ? l.maximize().region : null) || null;
  } catch {
    return null;
  }
}

function guessWeekStart() {
  try {
    const l = new Intl.Locale(navigator.language || 'en-US');
    const info = typeof l.getWeekInfo === 'function' ? l.getWeekInfo() : l.weekInfo;
    if (info && info.firstDay) return info.firstDay === 7 ? 0 : 1;
  } catch {
    /* ignore */
  }
  return ['US', 'CA', 'JP', 'BR', 'MX', 'IL', 'PH', 'KR', 'TW', 'HK', 'ZA', 'SA'].includes(localeRegion()) ? 0 : 1;
}

function guessUnits() {
  const r = localeRegion();
  if (['US', 'LR', 'MM'].includes(r)) return { weight: 'lb', distance: 'mi' };
  if (r === 'GB') return { weight: 'kg', distance: 'mi' };
  return { weight: 'kg', distance: 'km' };
}

const reduceMotion = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

function brandMark(cls) {
  const src = document.querySelector('.sidebar .brand-mark, .brand-mark');
  if (src) {
    const el = src.cloneNode(true);
    el.classList.remove('boot-mark');
    el.classList.add(cls);
    return el;
  }
  return h('span', { class: cls }, icon('notebook', { size: 28 }));
}

/** Goal presets. target = editable value (null → fixed goal). key = settings.targets key it also saves. */
function presets(s, currency) {
  const t = s.targets || {};
  return [
    { id: 'water', metric: 'water', comparator: 'gte', icon: 'water', color: '--water', key: 'water', target: t.water || 8, step: 1, min: 1, max: 30, unit: 'glasses', on: true,
      title: (n) => `Drink ${fmtNumber(n)} glasses of water` },
    { id: 'protein', metric: 'protein', comparator: 'gte', icon: 'food', color: '--food', key: 'protein', target: t.protein || 100, step: 5, min: 5, max: 400, unit: 'g', on: true,
      title: (n) => `Eat ${fmtNumber(n)} g protein` },
    { id: 'calories', metric: 'calories', comparator: 'lte', icon: 'flame', color: '--food', key: 'calories', target: t.calories || 2200, step: 50, min: 500, max: 8000, unit: 'kcal', on: false,
      title: (n) => `Stay under ${fmtNumber(n)} kcal` },
    { id: 'training', metric: 'trainingMinutes', comparator: 'gte', icon: 'training', color: '--training', key: 'trainingMinutes', target: t.trainingMinutes || 30, step: 5, min: 5, max: 300, unit: 'min', on: true,
      title: (n) => `Train for ${fmtDuration(n)}` },
    { id: 'learn', metric: 'learnings', comparator: 'gte', icon: 'lightbulb', color: '--learning', target: null, on: true, title: () => 'Learn one new thing' },
    { id: 'spend', metric: 'spend', comparator: 'lte', icon: 'wallet', color: '--expenses', key: 'dailySpend', money: true,
      target: t.dailySpend > 0 ? t.dailySpend : SPEND_DEFAULT[currency] || 50, step: 1, min: 1, on: t.dailySpend > 0,
      title: (n, cur) => `Spend at most ${fmtMoney(n, { currency: cur })}` },
    { id: 'sleep', metric: 'sleep', comparator: 'gte', icon: 'moon', color: '--mood', key: 'sleep', target: t.sleep || 8, step: 0.5, min: 4, max: 12, unit: 'h', on: true,
      title: (n) => `Sleep ${fmtNumber(n, { maxDecimals: 1 })} hours` },
    { id: 'reflect', metric: 'reflection', comparator: 'gte', icon: 'note', color: '--mood', target: null, on: true, title: () => 'Write a reflection' },
    { id: 'steps', metric: 'steps', comparator: 'gte', icon: 'footprints', color: '--training', key: 'steps', target: t.steps || 8000, step: 500, min: 500, max: 50000, unit: 'steps', on: false,
      title: (n) => `Walk ${fmtNumber(n)} steps` },
  ];
}

function render(root) {
  let disposed = false;
  const s0 = getSettings();
  const draft = {
    name: s0.name || '',
    currency: s0.onboarded ? s0.currency : guessCurrency(),
    units: s0.onboarded ? { ...s0.units } : guessUnits(),
    weekStart: s0.onboarded ? (Number(s0.weekStart) === 0 ? 0 : 1) : guessWeekStart(),
    sample: false,
  };
  if (!CURRENCIES.some((c) => c.code === draft.currency) && !draft.currency) draft.currency = 'USD';
  const goals = presets(s0, draft.currency);
  let step = 0;
  let maxStep = 0;
  let busy = false;
  let rerun = false;

  const page = h('div.onboarding-page');
  const aside = h('aside.ob-aside', { 'aria-hidden': 'true' },
    h('div.ob-aside-inner',
      h('div.ob-aside-brand', brandMark('ob-mark-sm'), h('span', 'Daybook')),
      h('div.ob-mosaic',
        [['food', '--food'], ['water', '--water'], ['learning', '--learning'], ['training', '--training'],
          ['expenses', '--expenses'], ['candlestick', '--trades'], ['smile', '--mood'], ['target', '--goals'], ['trophy', '--goals']]
          .map(([n, c], i) => h('span.ob-tile', { style: { '--accent': `var(${c})`, '--i': i } }, icon(n, { size: 26 })))),
      h('p.ob-aside-quote', 'Small daily notes add up to a clear picture of your life — and your edge.'),
      h('div.ob-aside-foot', icon('lock', { size: 16 }), h('span', 'Private · Works offline · No account'))));
  const panel = h('main.ob-panel');
  mount(root, h('div.onboarding-page-wrap', page));
  page.append(aside, panel);

  // ------------------------------------------------------------------ already onboarded
  if (s0.onboarded) {
    mount(panel, h('div.ob-card.ob-done',
      brandMark('ob-mark'),
      h('h1.ob-title', { tabindex: '-1' }, s0.name ? `You’re all set, ${s0.name}` : 'You’re all set'),
      h('p.ob-lead', 'Daybook is ready. Your journal, goals and trades are waiting on Today.'),
      h('div.ob-done-actions',
        button({ label: 'Go to Today', icon: 'arrow-right', variant: 'primary', size: 'lg', onClick: () => navigate('/today', { replace: true }) }),
        button({ label: 'Run setup again', icon: 'refresh', variant: 'ghost', onClick: () => { rerun = true; showStep(0, 0); } })),
      h('p.ob-note', 'Running setup again keeps all your data.')));
    return () => { disposed = true; };
  }
  showStep(0, 0);

  // ------------------------------------------------------------------ steps
  function dots() {
    return h('div.ob-progress',
      h('span.sr-only', `Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`),
      h('div.ob-dots', STEPS.map((label, i) => h('button.ob-dot', {
        type: 'button',
        class: { 'is-current': i === step, 'is-done': i < step },
        'aria-label': `Step ${i + 1}: ${label}${i < step ? ' (done)' : ''}`,
        'aria-current': i === step ? 'step' : null,
        disabled: i > maxStep || busy,
        onClick: () => i !== step && showStep(i, i < step ? -1 : 1),
      }))),
      h('span.ob-step-label', { 'aria-hidden': 'true' }, `${step + 1} / ${STEPS.length}`));
  }

  function stepWelcome() {
    const nameIn = input({ value: draft.name, placeholder: 'Your first name', autocomplete: 'given-name', maxlength: 60, enterkeyhint: 'next', onInput: (e) => { draft.name = e.target.value; } });
    const feature = (iconName, color, title, text) => h('li.ob-feature', iconChip(iconName, { accent: color }), h('div', h('div.ob-feature-title', title), h('div.ob-feature-text', text)));
    return [
      h('div.ob-hero', brandMark('ob-mark')),
      h('p.ob-eyebrow', 'Welcome to Daybook'),
      h('h1.ob-title', { tabindex: '-1' }, 'Your day, your trades — one calm journal.'),
      h('ul.ob-features',
        feature('today', '--primary', 'Your whole day in one place', 'Meals, water, workouts, what you learned, money and mood — logged in seconds.'),
        feature('candlestick', '--trades', 'A pro trading journal', 'Plans, reviews and analytics that show what actually works for you.'),
        feature('lock', '--training', 'Private by design', 'Everything stays on this device and works offline. No account needed.')),
      field('What should we call you?', nameIn, { hint: 'Optional — used for your greeting.' }),
      rerun ? null : h('p.ob-note', 'Already use Daybook on another device? ',
        h('button.link-btn', { type: 'button', 'data-testid': 'ob-signin', onClick: () => navigate('/settings/sync') }, 'Sign in to sync'),
        ' · ',
        h('button.link-btn', { type: 'button', onClick: () => navigate('/settings/data') }, 'Restore a backup')),
    ];
  }

  function stepRegion() {
    const preview = h('strong.num');
    const sync = () => preview.replaceChildren(fmtMoney(1234.5, { currency: draft.currency }));
    sync();
    const opts = CURRENCIES.map((c) => ({ value: c.code, label: `${c.code} · ${c.name} (${currencySymbol(c.code)})` }));
    if (!CURRENCIES.some((c) => c.code === draft.currency)) opts.unshift({ value: draft.currency, label: draft.currency });
    return [
      h('p.ob-eyebrow', 'Make it yours'),
      h('h1.ob-title', { tabindex: '-1' }, 'Money, units and your week'),
      h('p.ob-lead', 'We guessed from your device — change anything that’s off.'),
      h('div.ob-fields',
        field('Currency', select(opts, draft.currency, (v) => {
          draft.currency = v;
          sync();
          const sp = goals.find((g) => g.id === 'spend');
          if (sp && !sp.touched) sp.target = SPEND_DEFAULT[v] || 50;
        }), { hint: h('span', 'Amounts will look like ', preview) }),
        h('div.ob-grid-2',
          field('Weight', segmented([{ value: 'kg', label: 'kg' }, { value: 'lb', label: 'lb' }], draft.units.weight, (v) => { draft.units.weight = v; }, { block: true, ariaLabel: 'Weight unit' })),
          field('Distance', segmented([{ value: 'km', label: 'km' }, { value: 'mi', label: 'mi' }], draft.units.distance, (v) => { draft.units.distance = v; }, { block: true, ariaLabel: 'Distance unit' }))),
        field('Week starts on', segmented([{ value: 1, label: 'Monday' }, { value: 0, label: 'Sunday' }], draft.weekStart, (v) => { draft.weekStart = v; }, { block: true, ariaLabel: 'Week starts on' }))),
    ];
  }

  function stepGoals() {
    const count = h('span.ob-count');
    const syncCount = () => {
      const n = goals.filter((g) => g.on).length;
      count.textContent = n ? `${n} selected` : 'None selected — you can add goals later';
    };
    syncCount();
    const rows = goals.map((g) => {
      const titleEl = h('span.ob-goal-title', g.title(g.target, draft.currency));
      const cb = h('input.ob-goal-check', {
        type: 'checkbox', checked: g.on, 'data-goal': g.id,
        onChange: (e) => { g.on = e.target.checked; row.classList.toggle('is-on', g.on); if (ctl) ctl.classList.toggle('is-off', !g.on); syncCount(); },
      });
      let ctl = null;
      if (g.target !== null) {
        const onVal = (v) => {
          if (v === null || !(v > 0)) return;
          g.target = v;
          g.touched = true;
          titleEl.textContent = g.title(v, draft.currency);
        };
        ctl = g.money
          ? h('div.ob-goal-money', h('span.ob-affix', { 'aria-hidden': 'true' }, currencySymbol(draft.currency)),
            input({ type: 'number', min: '1', value: String(g.target), 'aria-label': `${g.title(g.target, draft.currency)} — daily limit`, class: 'ob-money-input', onInput: (e) => onVal(e.target.value === '' ? null : Number(e.target.value)) }))
          : stepper(g.target, onVal, { min: g.min, max: g.max, step: g.step, unit: g.unit, label: `Target for ${g.title(g.target)}` });
        ctl.classList.add('ob-goal-ctl');
        if (!g.on) ctl.classList.add('is-off');
      }
      const row = h('div.ob-goal', { class: { 'is-on': g.on }, style: { '--accent': `var(${g.color})` } },
        h('label.ob-goal-label', cb, h('span.ob-goal-box', { 'aria-hidden': 'true' }, icon('check', { size: 14 })), iconChip(g.icon, { accent: g.color, size: 'sm' }), titleEl),
        ctl);
      return row;
    });
    return [
      h('p.ob-eyebrow', 'What a good day looks like'),
      h('h1.ob-title', { tabindex: '-1' }, 'Pick your daily goals'),
      h('p.ob-lead', 'They’re checked automatically from what you log. Adjust targets now or anytime later.'),
      h('div.ob-goals', { role: 'group', 'aria-label': 'Daily goals' }, rows),
      h('p.ob-note', count),
    ];
  }

  function stepStart() {
    const opt = (value, iconName, color, title, text) => h('label.ob-choice', { class: { 'is-selected': draft.sample === value }, style: { '--accent': `var(${color})` } },
      h('input', { type: 'radio', name: 'ob-start', value: String(value), checked: draft.sample === value, onChange: () => { draft.sample = value; sync(); } }),
      iconChip(iconName, { accent: color, size: 'lg' }),
      h('span.ob-choice-text', h('span.ob-choice-title', title), h('span.ob-choice-sub', text)));
    const choices = h('div.ob-choices', { role: 'radiogroup', 'aria-label': 'How do you want to start?' },
      opt(false, 'pen', '--primary', rerun ? 'Keep my data as it is' : 'Start fresh', rerun ? 'Just save the changes from this setup.' : 'An empty journal, ready for today’s first entry.'),
      opt(true, 'sparkles', '--goals', 'Explore with sample data', 'See every chart and insight filled with ~2½ months of realistic demo entries.'));
    const note = h('div.ob-sample-note', { role: 'note', hidden: !draft.sample }, icon('info', { size: 16 }), h('span', 'Sample entries are marked as samples. Remove them anytime in Settings → Data.'));
    function sync() {
      choices.querySelectorAll('.ob-choice').forEach((l) => l.classList.toggle('is-selected', l.querySelector('input').value === String(draft.sample)));
      note.hidden = !draft.sample;
      const go = panel.querySelector('.ob-next span');
      if (go) go.textContent = draft.sample ? 'Explore Daybook' : rerun ? 'Save & finish' : 'Start my journal';
    }
    return [
      h('p.ob-eyebrow', 'Almost there'),
      h('h1.ob-title', { tabindex: '-1' }, draft.name.trim() ? `Ready when you are, ${draft.name.trim()}` : 'Ready when you are'),
      h('p.ob-lead', 'How would you like to begin?'),
      choices, note,
    ];
  }

  function showStep(i, dir) {
    if (disposed) return;
    step = i;
    maxStep = Math.max(maxStep, i);
    const content = [stepWelcome, stepRegion, stepGoals, stepStart][i]();
    const last = i === STEPS.length - 1;
    const nextLabel = i === 0 ? 'Get started' : last ? (draft.sample ? 'Explore Daybook' : rerun ? 'Save & finish' : 'Start my journal') : 'Continue';
    const body = h('div.ob-step', { class: dir && !reduceMotion() ? (dir < 0 ? 'ob-enter-back' : 'ob-enter') : null }, content);
    const form = h('form.ob-card', {
      novalidate: true,
      onSubmit: (e) => { e.preventDefault(); next(); },
      onKeydown: (e) => {
        // Enter on non-field elements (e.g. the heading) also moves on; buttons/checkboxes keep their own Enter.
        if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
        const t = e.target;
        if (t.closest('button, a, select, textarea, input')) return;
        e.preventDefault();
        next();
      },
    },
    h('div.ob-top', h('div.ob-top-brand', brandMark('ob-mark-xs'), h('span', 'Daybook')), dots()),
    body,
    h('div.ob-footer',
      i > 0 ? button({ label: 'Back', icon: 'arrow-left', variant: 'ghost', class: 'ob-back', disabled: busy, onClick: () => showStep(i - 1, -1) }) : h('span'),
      button({ label: nextLabel, iconEnd: last ? 'check' : 'arrow-right', variant: 'primary', size: 'lg', type: 'submit', class: 'ob-next' })));
    mount(panel, form);
    if (dir !== 0 || rerun) {
      const t = form.querySelector('.ob-title');
      if (t) t.focus({ preventScroll: true });
      panel.scrollTop = 0;
      window.scrollTo(0, 0);
    }
  }

  function next() {
    if (busy) return;
    if (step < STEPS.length - 1) showStep(step + 1, 1);
    else finish();
  }

  async function finish() {
    busy = true;
    const btn = panel.querySelector('.ob-next');
    const back = panel.querySelector('.ob-back');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.querySelector('span').textContent = draft.sample ? 'Creating sample data…' : 'Setting up…'; }
    if (back) back.disabled = true;
    try {
      const cur = getSettings();
      const targets = {};
      for (const g of goals) if (g.key && g.target > 0 && (g.key !== 'dailySpend' || g.on)) targets[g.key] = g.target;
      if (!goals.find((g) => g.id === 'spend').on && !(cur.targets && cur.targets.dailySpend > 0)) targets.dailySpend = 0;
      const name = draft.name.trim();
      const saved = await updateSettings({ name, currency: draft.currency, units: { ...draft.units }, weekStart: draft.weekStart, targets });

      // Goals: defaultGoals() gives the canonical records (ids/titles/icons); extra presets are built the same way.
      const base = new Map(defaultGoals({ ...saved, targets: { ...saved.targets, dailySpend: goals.find((g) => g.id === 'spend').target } }).map((g) => [g.id, g]));
      const existing = await db.all('goals');
      const have = new Set(existing.map((g) => g.id));
      let order = existing.length;
      const records = goals.filter((g) => g.on && !have.has(`goal-${g.id}`)).map((g) => {
        const b = base.get(`goal-${g.id}`) || {};
        return {
          ...b,
          id: `goal-${g.id}`,
          title: g.title(g.target ?? 1, draft.currency),
          kind: 'metric',
          metric: g.metric,
          comparator: g.comparator,
          target: g.target ?? 1,
          icon: g.icon,
          color: g.color,
          weekdays: null,
          active: true,
          order: order++,
        };
      });
      if (records.length) await db.bulkPut('goals', records);

      if (draft.sample) {
        const m = await import('./sample-data.js');
        await m.loadSampleData();
      }
      try {
        if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
      } catch {
        /* ignored */
      }
      await updateSettings({ onboarded: true });
      if (disposed) return;
      toast(draft.sample ? 'Sample data loaded — have a look around!' : name ? `Welcome, ${name}! Your journal is ready.` : 'Your journal is ready.', { type: 'success' });
      navigate('/today', { replace: true });
    } catch (err) {
      console.error('[daybook] onboarding failed', err);
      busy = false;
      toast('Something went wrong while setting up. Please try again.', { type: 'error' });
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.querySelector('span').textContent = 'Try again'; }
      if (back) back.disabled = false;
    }
  }

  return () => { disposed = true; };
}

export default {
  id: ID,
  title: 'Welcome',
  icon: 'sparkles',
  color: '--primary',
  render,
};
