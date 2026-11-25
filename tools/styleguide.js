// Daybook UI kit / style guide — renders every ui.js component and shared class from components.css.
// Dev tool only: it never writes to the journal database (image demos use generated in-memory pictures).
// URL: tools/styleguide.html  (?theme=light|dark to force a theme)

import { openDB } from '../js/core/db.js';
import { loadSettings, getSettings } from '../js/core/settings.js';
import { todayKey, addDays, currentMonth } from '../js/core/dates.js';
import { fmtMoney, fmtNumber, fmtPercent } from '../js/core/format.js';
import * as ui from '../js/core/ui.js';
import { thumb, openLightbox, compressImage } from '../js/core/images.js';

const {
  h, mount, icon, toast, openSheet, confirmDialog, promptDialog, field, input, textarea, select, segmented, chips,
  tagInput, ratingInput, moodPicker, stepper, toggle, checkbox, range, emptyState, pageHeader, card, statTile,
  progressRing, progressBar, dateNav, monthNav, menu, moneyInput, button, iconChip, badge, listItem, listGroupHeader,
  kv, table, skeleton, section, debounce,
} = ui;

const ACCENTS = ['--primary', '--food', '--water', '--learning', '--training', '--expenses', '--trades', '--mood', '--goals'];
const ACCENT_ICONS = { '--primary': 'sparkles', '--food': 'food', '--water': 'water', '--learning': 'learning', '--training': 'training', '--expenses': 'expenses', '--trades': 'trades', '--mood': 'smile', '--goals': 'goals' };

// ───────────────────────────────────────────────────────────── helpers

const demo = (label, ...children) => h('div.sg-demo', label ? h('p.sg-label', label) : null, children);
const group = (id, title, ...children) => h('section.section.sg-group', { id }, h('h2.section-title', title), children);
const say = (msg) => toast(msg, { duration: 1800 });

function swatch(name) {
  return h('div.sg-swatch', h('div.sg-chip', { style: { background: `var(${name})` } }), h('code', name));
}

// Generated pictures for lightbox/thumb demos (never stored).
function makePicture(i) {
  const c = document.createElement('canvas');
  c.width = 960;
  c.height = 640;
  const x = c.getContext('2d');
  const palettes = [['#4f46e5', '#22d3ee'], ['#f97316', '#e11d48'], ['#12a660', '#0ea5e9'], ['#8b5cf6', '#ec4899']];
  const [a, b] = palettes[i % palettes.length];
  const g = x.createLinearGradient(0, 0, 960, 640);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  x.fillStyle = g;
  x.fillRect(0, 0, 960, 640);
  x.fillStyle = 'rgba(255,255,255,.14)';
  for (let k = 0; k < 7; k++) {
    x.beginPath();
    x.arc(120 + k * 130, 460 - (k % 3) * 90, 70 + (k % 4) * 20, 0, Math.PI * 2);
    x.fill();
  }
  x.fillStyle = '#fff';
  x.font = '700 64px system-ui, sans-serif';
  x.fillText(`Screenshot ${i + 1}`, 64, 120);
  x.font = '500 30px system-ui, sans-serif';
  x.fillText('Generated in the browser · never saved', 64, 172);
  return new Promise((res) => c.toBlob((blob) => res(URL.createObjectURL(blob)), 'image/png'));
}

// ───────────────────────────────────────────────────────────── sections

function foundations() {
  const surfaces = ['--bg', '--surface', '--surface-2', '--surface-3', '--surface-raised', '--border', '--border-strong', '--text', '--text-2', '--text-3', '--overlay'];
  const brand = ['--primary', '--primary-soft', '--focus', '--success', '--warning', '--danger', '--profit', '--loss', '--neutral'];
  const charts = ['--chart-grid', '--chart-axis', '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8'];
  const sizes = [['--fs-3xl', 32, 'Big confident numbers'], ['--fs-2xl', 24, 'Page heading'], ['--fs-xl', 20, 'Section title'], ['--fs-lg', 17, 'Card & sheet titles'], ['--fs-md', 15, 'Body copy — calm and readable'], ['--fs-sm', 13, 'Secondary text and labels'], ['--fs-xs', 12, 'Captions, hints, overlines']];
  return group(
    'foundations',
    'Foundations',
    h(
      'div.grid.grid-2',
      card({ title: 'Surfaces & text', subtitle: 'Hairline borders, layered soft shadows', children: h('div.sg-swatches', surfaces.map(swatch)) }),
      card({ title: 'Brand & status', subtitle: 'P&L always pairs colour with a sign', children: h('div.sg-swatches', brand.map(swatch)) })
    ),
    card({
      title: 'Module accents',
      subtitle: 'Accents tint icon chips, rings and chart series — never big fills',
      children: h(
        'div.sg-accents',
        ACCENTS.map((a) => h('div.sg-accent', { style: { '--accent': `var(${a})` } }, iconChip(ACCENT_ICONS[a], { accent: a }), h('div', a.slice(2).replace(/^./, (c) => c.toUpperCase()), h('small', a))))
      ),
    }),
    h(
      'div.grid.grid-2',
      card({
        title: 'Type scale',
        subtitle: 'System UI stack · tabular figures for numbers',
        children: h(
          'div.sg-type',
          sizes.map(([v, px, text]) => h('div.row-between', h('p', { style: { fontSize: `var(${v})`, fontWeight: px >= 20 ? 700 : 500, letterSpacing: px >= 20 ? '-0.02em' : 0 } }, text), h('code', `${v} · ${px}px`))),
          h('div.row-between', h('p.num', { style: { fontSize: 'var(--fs-3xl)', fontWeight: 720, letterSpacing: '-0.03em' } }, fmtMoney(124530.5)), h('code', '.num tabular'))
        ),
      }),
      card({
        title: 'Charts palette',
        subtitle: 'Categorical order is CVD-checked — keep it',
        children: h('div.sg-swatches', charts.map(swatch)),
      })
    ),
    h(
      'div.grid.grid-2',
      card({
        title: 'Radii & elevation',
        children: h(
          'div.stack',
          h('div.sg-boxes', ['--r-sm', '--r', '--r-lg', '--r-xl'].map((r) => h('div.sg-box', { style: { borderRadius: `var(${r})` } }, r))),
          h('div.sg-boxes', ['--shadow-sm', '--shadow', '--shadow-lg'].map((s) => h('div.sg-box', { style: { borderRadius: 'var(--r-lg)', boxShadow: `var(${s})`, border: 0 } }, s)))
        ),
      }),
      card({
        title: 'Spacing scale',
        children: h('div.sg-space', [4, 8, 12, 16, 20, 24, 32, 48].map((px, i) => h('figure', h('span', { style: { width: px + 'px', height: px + 'px' } }), `--s-${i + 1}`))),
      })
    )
  );
}

function buttonsSection() {
  const variants = ['primary', 'secondary', 'ghost', 'danger', 'success'];
  return group(
    'buttons',
    'Buttons',
    card({
      children: h(
        'div.stack-lg',
        demo('Variants', h('div.row', variants.map((v) => button({ label: v[0].toUpperCase() + v.slice(1), variant: v, onClick: () => say(`${v} pressed`) })), h('button.btn.btn-danger.btn-danger-solid', { type: 'button' }, 'Delete forever'))),
        demo('With icons', h('div.row', button({ label: 'New entry', icon: 'plus', variant: 'primary' }), button({ label: 'Export CSV', icon: 'download' }), button({ label: 'Share', icon: 'share', variant: 'ghost' }), button({ label: 'Delete', icon: 'trash', variant: 'danger' }), button({ label: 'Continue', iconEnd: 'arrow-right', variant: 'secondary' }))),
        demo('Sizes', h('div.row', button({ label: 'Small', size: 'sm', variant: 'primary' }), button({ label: 'Medium', variant: 'primary' }), button({ label: 'Large', size: 'lg', variant: 'primary' }), button({ label: 'Pill', pill: true, icon: 'calendar' }), button({ label: 'Small pill', size: 'sm', pill: true, variant: 'ghost', icon: 'filter' }))),
        demo(
          'Icon buttons (always aria-labelled)',
          h('div.row', button({ icon: 'edit', label: 'Edit', iconOnly: true, variant: 'ghost' }), button({ icon: 'more', label: 'More', iconOnly: true }), button({ icon: 'plus', label: 'Add', iconOnly: true, variant: 'primary' }), button({ icon: 'trash', label: 'Delete', iconOnly: true, variant: 'danger' }), button({ icon: 'x', label: 'Close', iconOnly: true, size: 'sm', variant: 'ghost' }), button({ icon: 'search', label: 'Search', iconOnly: true, size: 'lg', pill: true }))
        ),
        demo('States', h('div.row', button({ label: 'Disabled', variant: 'primary', disabled: true }), button({ label: 'Disabled', disabled: true }), h('button.btn.btn-primary.is-busy', { type: 'button', disabled: true }, ui.spinner({ size: 16 }), h('span', 'Saving…')), h('button.link-btn', { type: 'button', onClick: () => say('Link button') }, 'Link button', icon('chevron-right', { size: 16 })))),
        demo('Block', button({ label: 'Save & add another', variant: 'secondary', block: true, icon: 'repeat' }))
      ),
    })
  );
}

function formsSection() {
  const title = input({ placeholder: 'Oats with banana & peanut butter' });
  const titleField = field('What did you eat?', title, { required: true, hint: 'Short and specific works best.' });
  const errField = field('Symbol', input({ value: '', placeholder: 'NIFTY' }), { required: true, error: 'Add a symbol to save this trade' });
  const amount = moneyInput(1240, () => {}, { size: 'lg', 'aria-label': 'Amount' });
  const price = moneyInput(null, () => {}, { placeholder: '0.00' });
  const unit = h('div.input-affix', input({ type: 'number', value: 72.4 }), h('span.affix', 'kg'));
  const search = h('div.input-affix', icon('search', { size: 18 }), input({ type: 'search', placeholder: 'Search entries' }));
  const s = getSettings();
  return group(
    'forms',
    'Forms',
    h(
      'div.grid.grid-2',
      card({
        title: 'Fields',
        subtitle: 'Label ↔ control ids are generated; hints & errors are described-by',
        children: h(
          'div.stack',
          titleField,
          errField,
          field('Amount', amount, { hint: 'Big amount input with the currency symbol' }),
          h('div.form-grid', field('Entry price', price), field('Body weight', unit, { aside: 'Optional' })),
          field('Search', search)
        ),
      }),
      card({
        title: 'More controls',
        children: h(
          'div.stack',
          field('Currency', select(s.currencyOptions || ['INR', 'USD', 'EUR', 'GBP', 'JPY'], s.currency, (v) => say(`Currency → ${v}`))),
          field('Category', select(s.expenseCategories.map((c) => ({ value: c.id, label: `${c.emoji}  ${c.name}` })), 'food', () => {})),
          field('Reflection', textarea({ placeholder: 'What went well today? It grows as you type…', value: 'Kept my stop loss on every trade.\nWalked 9k steps.' })),
          h('div.field-row', field('Date', input({ type: 'date', value: todayKey() })), field('Time', input({ type: 'time', value: '18:30' }))),
          field('Intensity (RPE)', range(7, () => {}, { min: 1, max: 10, step: 1, accent: '--training' }), { hint: '1 easy · 10 all-out' })
        ),
      })
    ),
    card({
      title: 'Switches & checkboxes',
      children: h(
        'div.grid.grid-2',
        h('div.stack-sm', toggle(true, (v) => say(v ? 'On' : 'Off'), { label: 'Starred' }), toggle(false, () => {}, { label: 'Followed my plan', hint: 'Turn on when you stuck to the rules', end: true }), toggle(true, () => {}, { label: 'Disabled switch', disabled: true })),
        h('div.stack-sm', checkbox(true, () => {}, { label: 'Always place a stop loss', strike: true }), checkbox(false, () => {}, { label: 'Risk at most 1% per trade', strike: true }), checkbox(true, () => {}, { label: 'Accent checkbox', accent: '--training' }))
      ),
    })
  );
}

function controlsSection() {
  const s = getSettings();
  const seg = segmented(
    [{ value: 'feed', label: 'Feed' }, { value: 'review', label: 'Review' }, { value: 'library', label: 'Library' }],
    'feed',
    (v) => say(`Tab → ${v}`),
    { ariaLabel: 'Learning view' }
  );
  return group(
    'controls',
    'Controls',
    h(
      'div.grid.grid-2',
      card({
        title: 'Segmented',
        subtitle: 'Radiogroup · arrow keys · sliding thumb',
        children: h(
          'div.stack',
          demo('Medium', seg),
          demo('Small, with icons', segmented([{ value: 'week', label: 'Week', icon: 'calendar' }, { value: 'month', label: 'Month', icon: 'grid' }, { value: 'year', label: 'Year', icon: 'bar-chart' }], 'month', () => {}, { size: 'sm', ariaLabel: 'Period' })),
          demo('Large, block', segmented([{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }], 'expense', () => {}, { size: 'lg', block: true, ariaLabel: 'Type' })),
          demo('Icon only', segmented([{ value: 'light', icon: 'sun', ariaLabel: 'Light' }, { value: 'dark', icon: 'moon', ariaLabel: 'Dark' }, { value: 'system', icon: 'monitor', ariaLabel: 'System' }], 'system', () => {}, { size: 'sm', ariaLabel: 'Theme' }))
        ),
      }),
      card({
        title: 'Chips',
        subtitle: 'aria-pressed · single, multi and add-your-own',
        children: h(
          'div.stack',
          demo('Single (tap again to clear)', chips([{ value: 'great', label: 'Great', emoji: '🥗', color: '--training' }, { value: 'ok', label: 'Okay', emoji: '🍝', color: '--goals' }, { value: 'poor', label: 'Poor', emoji: '🍩', color: '--loss' }], 'great', (v) => say(`Quality → ${v ?? 'none'}`), { ariaLabel: 'Meal quality' })),
          demo('Multiple', chips(s.trading.emotions.slice(0, 7), ['Calm', 'Focused'], (v) => say(`${v.length} selected`), { multiple: true, ariaLabel: 'Emotions' })),
          demo('Categories with colours', chips(s.expenseCategories.slice(0, 6), 'transport', () => {}, { ariaLabel: 'Category', size: 'sm' })),
          demo('allowAdd', chips(s.trading.setups.slice(0, 4), 'Breakout', () => {}, { allowAdd: true, onAdd: (t) => { say(`Added “${t}”`); return t; }, ariaLabel: 'Setup' }))
        ),
      })
    ),
    h(
      'div.grid.grid-2',
      card({
        title: 'Tags, rating & mood',
        children: h(
          'div.stack',
          field('Tags', tagInput(['habits', 'focus'], (t) => {}, { suggestions: ['deep-work', 'reading', 'sleep', 'trading', 'health', 'money'] }), { hint: 'Enter or comma adds · Backspace removes' }),
          field('Execution', ratingInput(4, (v) => say(`Rating → ${v ?? 'none'}`), { labels: ['Poor', 'Fair', 'Good', 'Great', 'Flawless'] })),
          field('Confidence', ratingInput(2, () => {}, { icon: 'flame', size: 'sm' })),
          field('How do you feel?', moodPicker(4, (v) => say(`Mood → ${v ?? 'none'}`)))
        ),
      }),
      card({
        title: 'Steppers',
        subtitle: 'Hold to repeat · type a value',
        children: h(
          'div.stack',
          field('Water', stepper(5, () => {}, { min: 0, max: 20, label: 'Water', unit: 'glasses' })),
          field('Sleep', stepper(7.5, () => {}, { min: 0, max: 16, step: 0.5, label: 'Sleep', unit: 'h' })),
          field('Duration', stepper(45, () => {}, { min: 5, max: 600, step: 5, label: 'Duration', unit: 'min' }))
        ),
      })
    )
  );
}

function dataSection() {
  const today = todayKey();
  return group(
    'data',
    'Data display',
    demo(
      'Stat tiles',
      h(
        'div.stat-grid',
        statTile({ label: 'Net P&L', value: fmtMoney(18450, { sign: true }), tone: 'profit', delta: 0.124, sub: 'vs last month', icon: 'trades', accent: '--trades' }),
        statTile({ label: 'Spent this month', value: fmtMoney(32480), delta: 0.082, deltaGood: 'down', sub: 'of ₹40,000 budget', icon: 'expenses', accent: '--expenses' }),
        statTile({ label: 'Worst day', value: fmtMoney(-2300, { sign: true }), tone: 'loss', sub: 'Tue, 18 Nov' }),
        statTile({ label: 'Win rate', value: fmtPercent(0.563), delta: -0.031, sub: '48 trades', icon: 'target', accent: '--goals' }),
        statTile({ label: 'Avg sleep', value: '7.4', unit: 'h', delta: 0, sub: 'steady', icon: 'moon', accent: '--mood' }),
        statTile({ label: 'Learnings', value: 23, sub: 'this month', icon: 'learning', accent: '--learning', onClick: () => say('Stat tiles can be buttons') })
      )
    ),
    h(
      'div.grid.grid-3',
      card({
        title: 'Progress rings',
        icon: 'goals',
        accent: '--goals',
        children: h(
          'div.row',
          { style: { gap: '20px' } },
          progressRing(0.72, { size: 96, stroke: 9, accent: '--primary', label: '72%', sublabel: '5 of 7' }),
          progressRing(0.45, { size: 72, stroke: 7, accent: '--food', label: '1,020', sublabel: 'kcal' }),
          progressRing(1.18, { size: 72, stroke: 7, accent: '--water', label: '10', sublabel: 'of 8' }),
          progressRing(1.12, { size: 56, stroke: 6, accent: '--expenses', label: '112%', over: true })
        ),
      }),
      card({
        title: 'Progress bars',
        icon: 'activity',
        accent: '--training',
        children: h(
          'div.stack',
          h('div.stack-sm', h('div.row-between.text-sm', h('span', 'Protein'), h('span.num.muted', '64 / 100 g')), progressBar(0.64, { accent: '--food', label: 'Protein' })),
          h('div.stack-sm', h('div.row-between.text-sm', h('span', 'Training'), h('span.num.muted', '30 / 30 min')), progressBar(1, { accent: '--training', label: 'Training' })),
          h('div.stack-sm', h('div.row-between.text-sm', h('span', 'Spending'), h('span.num.text-warning', '₹1,480 / ₹1,200')), progressBar(1.23, { over: true, label: 'Spending', accent: '--expenses' })),
          progressBar(0.3, { height: 4, accent: '--learning', label: 'Thin' })
        ),
      }),
      card({
        title: 'Badges & tags',
        icon: 'tag',
        children: h(
          'div.stack',
          h('div.row', badge('+₹1,200', 'profit'), badge('−₹300', 'loss'), badge('Flat', 'neutral'), badge('Long', 'long', { icon: 'arrow-up-right' }), badge('Short', 'short', { icon: 'arrow-down-right' }), badge('Open', 'open', { dot: true }), badge('Due', 'accent', { accent: '--learning' }), badge('A+', 'accent', { size: 'lg' })),
          h('div.row', h('span.tag', h('span.tag-hash', '#'), 'deep-work'), h('span.tag', h('span.tag-hash', '#'), 'reading'), h('span.tag', 'Breakout'))
        ),
      })
    ),
    h(
      'div.grid.grid-2',
      card({
        title: 'List (flush card)',
        subtitle: 'Grouped by day with totals',
        icon: 'list',
        flush: true,
        actions: [{ icon: 'more', label: 'More', iconOnly: true, onClick: (e) => menu(e.currentTarget, [{ label: 'Edit', icon: 'edit' }, { label: 'Delete', icon: 'trash', danger: true }]) }],
        children: [
          listGroupHeader('Today', fmtMoney(1240)),
          h(
            'div.list',
            listItem({ emoji: '🍽️', accent: '#f97316', title: 'Lunch with team', meta: ['UPI', '1:30 pm'], trail: fmtMoney(640), onClick: () => say('Open') }),
            listItem({ emoji: '🚕', accent: '#0ea5e9', title: 'Cab to office', meta: ['Card', '9:10 am'], trail: fmtMoney(380), onClick: () => {} }),
            listItem({ emoji: '💼', accent: '#16a34a', title: 'Freelance invoice', meta: 'Bank', trail: h('span.text-profit', fmtMoney(12000, { sign: true })), trailMeta: 'Income', onClick: () => {} })
          ),
          listGroupHeader('Yesterday', fmtMoney(220)),
          h('div.list', listItem({ icon: 'trades', accent: '--trades', title: 'NIFTY · Breakout', meta: [badge('Long', 'long'), '+1.8R'], trail: h('span.text-profit', fmtMoney(4200, { sign: true })), chevron: true, onClick: () => {} })),
        ],
      }),
      card({
        title: 'Table',
        subtitle: 'Sticky header · numeric columns right-aligned',
        icon: 'grid',
        children: table({
          caption: 'Mistakes cost',
          columns: [
            { key: 'name', label: 'Mistake' },
            { key: 'count', label: 'Count', num: true },
            { key: 'pnl', label: 'Total P&L', num: true, render: (r) => h('span', { class: r.pnl < 0 ? 'text-loss' : 'text-profit' }, fmtMoney(r.pnl, { sign: true })) },
            { key: 'avg', label: 'Avg', num: true, format: (v) => fmtMoney(v, { sign: true }) },
          ],
          rows: [
            { name: 'FOMO entry', count: 6, pnl: -8400, avg: -1400 },
            { name: 'Moved stop', count: 3, pnl: -5100, avg: -1700 },
            { name: 'Early exit', count: 5, pnl: 2300, avg: 460 },
            { name: 'Oversized', count: 2, pnl: -3900, avg: -1950 },
          ],
          footer: ['Total', '16', h('span.text-loss', fmtMoney(-15100, { sign: true })), ''],
        }),
      })
    ),
    h(
      'div.grid.grid-3',
      card({ title: 'Key / value', icon: 'list-checks', children: kv([['Entry', '22,140.50'], ['Exit', '22,198.00'], ['Quantity', '50'], { label: 'Net P&L', value: fmtMoney(2875, { sign: true }), tone: 'profit' }]) }),
      card({ title: 'Key / value grid', icon: 'layers', children: kv([['Gross', fmtMoney(3100)], ['Fees', fmtMoney(225)], ['R multiple', '+1.6R'], ['Return', '+0.26%'], ['Held', '2h 15m'], ['Setup', 'Breakout']], { grid: true }) }),
      card({
        title: 'Icon chips',
        subtitle: 'Every module accent',
        children: h(
          'div.stack',
          h('div.row', ACCENTS.map((a) => iconChip(ACCENT_ICONS[a], { accent: a }))),
          h('div.row', ACCENTS.slice(1, 6).map((a) => iconChip(ACCENT_ICONS[a], { accent: a, size: 'sm' })), ACCENTS.slice(6).map((a) => iconChip(ACCENT_ICONS[a], { accent: a, size: 'lg' }))),
          h('div.row', iconChip(null, { emoji: '🍽️', accent: '#f97316' }), iconChip(null, { emoji: '📈', accent: '#16a34a', size: 'lg' }), iconChip(null, { emoji: '🧘', size: 'sm' }), iconChip('zap', { accent: '--goals', solid: true }))
        ),
      })
    ),
    h(
      'div.grid.grid-3',
      card({
        title: 'Accent card',
        subtitle: 'class card-accent + --accent',
        icon: 'food',
        accent: '--food',
        class: 'card-accent',
        actions: [{ label: 'Add', icon: 'plus' }],
        children: [h('p.stat-value.num', '1,850', h('span.stat-value-unit', 'kcal')), h('p.muted.text-sm', '96 g protein · 3 meals')],
      }),
      card({ title: 'Interactive card', subtitle: 'Hover lift · press scale', icon: 'learning', accent: '--learning', onClick: () => say('Card tapped'), children: h('p.clamp-2.subtle', 'Spaced repetition beats rereading: test yourself on what you learned yesterday before adding anything new today.') }),
      card({
        title: 'Loading skeleton',
        children: h('div.stack', h('div.row', skeleton({ circle: true, height: 40 }), h('div', { style: { flex: '1' } }, skeleton({ lines: 2 }))), skeleton({ height: 88, radius: '12px' })),
      })
    ),
    h(
      'div.grid.grid-2',
      card({ children: emptyState({ icon: 'food', accent: '--food', title: 'No meals yet', message: 'Log what you eat — it takes ten seconds and the patterns show up fast.', action: { label: 'Add a meal', icon: 'plus', onClick: () => say('Next action') }, actions: [{ label: 'Use a frequent food' }] }) }),
      card({
        title: 'Text utilities & callout',
        children: h(
          'div.stack',
          h('div.callout', { style: { '--accent': 'var(--goals)' } }, icon('lightbulb', { size: 20 }), h('div', h('strong', 'Insight · '), 'You win 64% of trades on days you slept 7h+, vs 41% otherwise.')),
          h('p', 'Default text, ', h('span.subtle', '.subtle'), ', ', h('span.muted', '.muted'), ', ', h('span.text-profit.num', '+₹1,200'), ' and ', h('span.text-loss.num', '−₹300'), '.'),
          h('p.text-sm.truncate', '.truncate — a very long line that would otherwise wrap onto a second line and push the layout around on narrow phones'),
          h('hr.divider'),
          h('p.text-xs.muted', '.text-xs · .text-sm · .text-lg · .num · .clamp-2 · .sr-only · .hide-mobile · .hide-desktop'),
          h('mark', 'Search highlight')
        ),
      })
    )
  );
}

function navigationSection() {
  const out = h('span.num.muted');
  const dn = dateNav(todayKey(), (d) => (out.textContent = d));
  const dn2 = dateNav(addDays(todayKey(), -9), () => {});
  const mn = monthNav(currentMonth(), (m) => (out.textContent = m));
  return group(
    'navigation',
    'Navigation',
    card({
      children: h(
        'div.stack-lg',
        demo('Page header', pageHeader({ title: 'Expenses', subtitle: 'November · 42 transactions', back: () => say('Back'), actions: [{ label: 'Export', icon: 'download', variant: 'secondary' }, { label: 'Add', icon: 'plus', variant: 'primary' }] })),
        demo('Date nav (today, then 9 days ago)', h('div.row', dn, dn2, out)),
        demo('Month nav (opens a month picker)', mn),
        demo('Section title with link', section({ title: 'Recent trades', action: { label: 'See all', onClick: () => say('See all') }, children: h('p.muted.text-sm', 'Sections stack with a calm 12px rhythm.') }))
      ),
    })
  );
}

function overlaysSection(pictures) {
  const s = getSettings();
  const openEditor = (e) => {
    let amount = 640;
    const titleInp = input({ placeholder: 'Lunch with team' });
    const titleF = field('Note', titleInp, { required: true });
    titleInp.addEventListener('input', () => titleF.setError(null));
    return openSheet({
      title: 'Edit expense',
      subtitle: 'Today · 1:30 pm',
      icon: 'expenses',
      accent: '--expenses',
      content: () =>
        h(
          'form.stack',
          segmented([{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }], 'expense', () => {}, { block: true, ariaLabel: 'Type' }),
          field('Amount', moneyInput(amount, (v) => (amount = v), { size: 'lg' }), { required: true }),
          titleF,
          field('Category', chips(s.expenseCategories.slice(0, 8), 'food', () => {}, { ariaLabel: 'Category' })),
          field('Method', chips(s.paymentMethods, 'UPI', () => {}, { ariaLabel: 'Method' })),
          h('div.form-grid', field('Date', input({ type: 'date', value: todayKey() })), field('Time', input({ type: 'time', value: '13:30' }))),
          field('Tags', tagInput([], () => {}, { suggestions: ['work', 'team', 'travel'] })),
          field('Note', textarea({ placeholder: 'Anything to remember?' }))
        ),
      actions: [
        {
          label: 'Delete',
          icon: 'trash',
          variant: 'danger',
          onClick: async () => {
            const yes = await confirmDialog({ title: 'Delete this expense?', message: 'You can undo this for a few seconds after deleting.' });
            if (!yes) return false;
            toast('Expense deleted', { action: { label: 'Undo', onClick: () => say('Restored') } });
            return 'deleted';
          },
        },
        { label: 'Cancel' },
        {
          label: 'Save',
          variant: 'primary',
          onClick: async () => {
            if (!titleInp.value.trim()) {
              titleF.setError('Add a short note so you recognise it later');
              titleInp.focus();
              return false;
            }
            await new Promise((r) => setTimeout(r, 500));
            toast('Saved', { type: 'success' });
            return { amount };
          },
        },
      ],
    });
  };

  const sheetSizes = (size) => () =>
    openSheet({
      title: size === 'lg' ? 'Large sheet' : 'Full sheet',
      subtitle: `size: '${size}'`,
      size,
      accent: '--learning',
      icon: 'book',
      content: h('div.stack', Array.from({ length: 14 }, (_, i) => h('p.subtle', `Paragraph ${i + 1}. Sheets keep a sticky header and footer while the body scrolls. On phones they slide up from the bottom with a grab handle; on desktop they scale and fade in as a centred dialog.`))),
      actions: [{ label: 'Close', variant: 'primary' }],
    });

  const thumbs = h('div.thumbs', pictures.map((src, i) => thumb(src, { ids: pictures, index: i, size: 88 })));
  const compressOut = h('span.text-sm.muted', 'Click to compress a generated 960×640 PNG');

  return group(
    'overlays',
    'Overlays',
    h(
      'div.grid.grid-2',
      card({
        title: 'Sheets & dialogs',
        subtitle: 'Bottom sheet on phones, dialog on desktop · Esc, backdrop, swipe',
        icon: 'layers',
        children: h(
          'div.row',
          button({ label: 'Open editor sheet', icon: 'edit', variant: 'primary', id: 'sg-open-sheet', onClick: openEditor }),
          button({ label: 'Large', onClick: sheetSizes('lg') }),
          button({ label: 'Full', onClick: sheetSizes('full') }),
          button({ label: 'Confirm', id: 'sg-confirm', onClick: async () => say((await confirmDialog({ title: 'Remove sample data?', message: 'Your own entries stay exactly as they are.', confirmLabel: 'Remove' })) ? 'Confirmed' : 'Cancelled') }),
          button({ label: 'Non-danger confirm', onClick: async () => say((await confirmDialog({ title: 'Start a new week?', message: 'We’ll save this week’s review first.', confirmLabel: 'Continue', danger: false })) ? 'Continue' : 'Cancelled') }),
          button({ label: 'Prompt', onClick: async () => { const v = await promptDialog({ title: 'New setup', label: 'Setup name', placeholder: 'e.g. Opening range breakout' }); if (v) say(`Added “${v}”`); } })
        ),
      }),
      card({
        title: 'Toasts & menu',
        subtitle: 'Bottom-centre stack, max 3, polite live region',
        icon: 'bell',
        children: h(
          'div.row',
          button({ label: 'Info', id: 'sg-toast', onClick: () => toast('💧 5/8 glasses — nice!') }),
          button({ label: 'Success', icon: 'check-circle', onClick: () => toast('Saved', { type: 'success' }) }),
          button({ label: 'Error', icon: 'alert', onClick: () => toast('Couldn’t save — storage is full.', { type: 'error' }) }),
          button({ label: 'With Undo', icon: 'rotate-ccw', id: 'sg-toast-undo', onClick: () => toast('Entry deleted', { action: { label: 'Undo', onClick: () => toast('Restored', { type: 'success' }) } }) }),
          button({
            label: 'Menu',
            icon: 'more',
            iconEnd: 'chevron-down',
            id: 'sg-menu',
            onClick: (e) =>
              menu(e.currentTarget, [
                { heading: 'Trade' },
                { label: 'Edit', icon: 'edit', hint: 'E', onClick: () => say('Edit') },
                { label: 'Duplicate', icon: 'copy', onClick: () => say('Duplicate') },
                { label: 'Share', icon: 'share', disabled: true },
                { label: 'Show fees', checked: true, onClick: () => say('Toggled') },
                { divider: true },
                { label: 'Delete', icon: 'trash', danger: true, onClick: () => say('Delete') },
              ]),
          })
        ),
      })
    ),
    card({
      title: 'Images',
      subtitle: 'Lazy thumbnails · lightbox with swipe, arrows, counter · WebP compression',
      icon: 'image',
      children: h(
        'div.stack',
        thumbs,
        h(
          'div.row',
          button({ label: 'Open lightbox', icon: 'image', id: 'sg-lightbox', onClick: () => openLightbox(pictures, 1) }),
          button({
            label: 'Compress',
            icon: 'zap',
            onClick: async () => {
              const blob = await (await fetch(pictures[0])).blob();
              const out = await compressImage(blob, { maxSize: 640 });
              compressOut.textContent = `${blob.type} ${fmtNumber(blob.size / 1024, { decimals: 0 })} KB → ${out.type} ${fmtNumber(out.size / 1024, { decimals: 0 })} KB`;
            },
          }),
          compressOut
        ),
        h('p.text-xs.muted', 'imagePicker() saves to the journal database, so it is not mounted here.')
      ),
    })
  );
}

// ───────────────────────────────────────────────────────────── boot

async function main() {
  await openDB();
  await loadSettings();

  // Theme switch (session only — never touches the user's settings).
  const root = document.documentElement;
  const current = root.getAttribute('data-theme') || 'system';
  const themeSeg = segmented(
    [{ value: 'system', icon: 'monitor', ariaLabel: 'System theme' }, { value: 'light', icon: 'sun', ariaLabel: 'Light theme' }, { value: 'dark', icon: 'moon', ariaLabel: 'Dark theme' }],
    current,
    (v) => {
      root.classList.add('theme-changing');
      if (v === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', v);
      try {
        sessionStorage.setItem('daybook.sg.theme', v);
      } catch {
        /* ignore */
      }
      setTimeout(() => root.classList.remove('theme-changing'), 320);
    },
    { size: 'sm', ariaLabel: 'Theme' }
  );
  mount(document.getElementById('sg-theme'), themeSeg);

  const pictures = await Promise.all([0, 1, 2, 3].map(makePicture));
  const jump = chips(
    [['foundations', 'Foundations'], ['buttons', 'Buttons'], ['forms', 'Forms'], ['controls', 'Controls'], ['data', 'Data'], ['navigation', 'Navigation'], ['overlays', 'Overlays']].map(([value, label]) => ({ value, label })),
    null,
    (v) => {
      if (v) document.getElementById(v)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      jump.setValue(null);
    },
    { scroll: true, ariaLabel: 'Jump to section', size: 'sm' }
  );

  const main = document.getElementById('sg-main');
  mount(
    main,
    h(
      'div.page',
      h('div', pageHeader({ title: 'Daybook UI kit', subtitle: 'Every shared component from ui.js and components.css — light & dark, phone & desktop.' }), h('div.sg-jump', jump)),
      foundations(),
      buttonsSection(),
      formsSection(),
      controlsSection(),
      dataSection(),
      navigationSection(),
      overlaysSection(pictures)
    )
  );
  window.__sgReady = true;
  window.dispatchEvent(new Event('sg:ready'));
}

main().catch((err) => {
  console.error('[styleguide] failed', err);
  mount(document.getElementById('sg-main'), h('div.callout', { style: { '--accent': 'var(--danger)' } }, icon('alert'), h('span', `Style guide failed: ${err.message}`)));
});

void debounce; // (exported helper, listed for completeness)
