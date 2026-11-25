// Deterministic demo data generator (SPEC 4.13).
//
// - Seeded PRNG (mulberry32) with one independent stream per (generator, day index), so the data for a given
//   run is fully reproducible and one generator never shifts another. Dates are relative to todayKey(), so
//   the data always ends today. Today is "partial": only entries whose time has already passed are created.
// - Every record carries `sample: true` and an id prefixed 'sample-' (reviews use the spec id 'week:<isoWeek>'
//   and days are keyed by date). Existing non-sample records are never overwritten: a day / review is only
//   written when nothing is stored for it or the stored one is itself sample data.
// - Re-running is idempotent: same ids are rewritten, and stale sample records from an earlier run (e.g. one
//   made on another day) are deleted first.
// - Goals: when the goals store is empty, metrics.defaultGoals() are created WITHOUT the sample flag (they
//   are the user's goals and survive removeSampleData()).
// - Amounts follow the app currency: INR-scale amounts for INR, scaled by an approximate FX factor for other
//   currencies (default ÷80, USD-like). Trades use Indian instruments when the trading currency is INR and
//   US instruments otherwise, so P&L is in the right unit.
// - Units follow settings.units (kg/lb, km/mi).
// - Trade outcomes are generated as R-multiples first, then gently balanced so the whole set lands at a
//   ~52% win rate / profit factor ~1.4–1.8 with a positive last-30-days P&L, then turned into prices.
//   Every trade goes through prepareTrade().

import { db, runTransaction, STORES } from '../core/db.js';
import { getSettings } from '../core/settings.js';
import { todayKey, addDays, weekday, isoWeek, weekRange, nowTime, monthOf, fmtMonth } from '../core/dates.js';
import { defaultGoals } from '../core/metrics.js';
import { prepareTrade, tradeNet } from './trades/calc.js';

const SEED = 0x0dab00c5;
const ID_STORES = ['food', 'learning', 'workouts', 'expenses', 'trades', 'reviews', 'files'];

// ---------------------------------------------------------------------------------------------------
// PRNG helpers

function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** murmur3 finalizer — decorrelates neighbouring seeds ('food:1', 'food:2', …). */
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function rng(name) {
  const next = mulberry32(fmix32((SEED ^ hashStr(String(name))) >>> 0));
  next();
  next();
  const r = {
    next,
    float: (a, b) => a + (b - a) * next(),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** list of [item, weight] */
    weighted(list) {
      const total = list.reduce((s, x) => s + Math.max(0, x[1]), 0);
      let u = next() * total;
      for (const [item, w] of list) {
        u -= Math.max(0, w);
        if (u <= 0) return item;
      }
      return list[list.length - 1][0];
    },
    normal(mean = 0, sd = 1) {
      const u = Math.max(1e-9, next());
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    shuffle(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
  return r;
}

/** Returns items of `pool` in a shuffled order without repeats until the pool is exhausted. */
function cycler(pool, name) {
  const r = rng(`cycle:${name}`);
  let queue = [];
  let last = null;
  return () => {
    if (!queue.length) {
      queue = r.shuffle(pool);
      if (queue.length > 1 && queue[0] === last) queue.push(queue.shift());
    }
    last = queue.shift();
    return last;
  };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const stepDecimals = (step) => (String(step).split('.')[1] || '').length;
/** Round to a multiple of `step` without binary float noise (round(72.6, 0.1) → 72.6, not 72.60000000000001). */
const round = (v, step = 1) => Number((Math.round(v / step) * step).toFixed(stepDecimals(step)));
const fix = (v, d = 2) => Number(v.toFixed(d));
const pad = (n) => String(n).padStart(2, '0');
const toMin = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};
const toTime = (mins) => {
  const m = clamp(Math.round(mins), 0, 23 * 60 + 59);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
const randTime = (r, from, to, step = 5) => toTime(round(r.float(toMin(from), toMin(to)), step));

/** Local date key + 'HH:MM' → ISO timestamp (for createdAt; never used to derive a date key). */
function stamp(date, time = '12:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = String(time || '12:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0).toISOString();
}

// ---------------------------------------------------------------------------------------------------
// Currency / units context

// Approximate value of ₹1 in other currencies (only the order of magnitude matters for demo data).
const FX_FROM_INR = {
  INR: 1, NPR: 1.6, PKR: 3.3, LKR: 3.5, BDT: 1.4, JPY: 1.75, KRW: 16, IDR: 190, VND: 300, PHP: 0.67,
  THB: 0.39, CNY: 0.085, HKD: 0.092, TWD: 0.37, SGD: 0.016, MYR: 0.053, AED: 0.044, SAR: 0.045,
  RUB: 1.1, TRY: 0.45, ZAR: 0.21, MXN: 0.21, BRL: 0.065, NGN: 18, KES: 1.55, EGP: 0.58,
};

function makeContext(settings) {
  const currency = String(settings.currency || 'USD').toUpperCase();
  const tradeCurrency = String((settings.trading && settings.trading.currency) || currency).toUpperCase();
  const fx = FX_FROM_INR[currency] ?? 1 / 80;
  const units = settings.units || {};
  const methods = Array.isArray(settings.paymentMethods) && settings.paymentMethods.length ? settings.paymentMethods : ['UPI'];
  const rules = ((settings.trading && settings.trading.rules) || []).filter((x) => x && x.id);
  return {
    currency,
    india: tradeCurrency === 'INR',
    fx,
    /** Scale an INR amount to the app currency and round it to a natural price. */
    money(inr) {
      const v = inr * fx;
      if (fx === 1) return v >= 100 ? round(v, 1) : round(v, 1);
      if (v < 10) return fix(round(v, 0.05));
      if (v < 100) return fix(round(v, 0.5));
      return round(v, 1);
    },
    method(preferred) {
      if (methods.includes(preferred)) return preferred;
      const ci = methods.find((m) => String(m).toLowerCase() === String(preferred).toLowerCase());
      return ci || (methods.includes('UPI') ? 'UPI' : methods[0]);
    },
    lb: units.weight === 'lb',
    mi: units.distance === 'mi',
    weight(kg, step) {
      return this.lb ? round(kg * 2.20462, step ?? 0.1) : round(kg, step ?? 0.1);
    },
    liftWeight(kg) {
      return this.lb ? round(kg * 2.20462, 5) : round(kg, 1.25);
    },
    distance(km) {
      return fix(this.mi ? km / 1.60934 : km, 2);
    },
    rules,
    accountId: (settings.trading && settings.trading.defaultAccountId) || 'main',
  };
}

// ---------------------------------------------------------------------------------------------------
// Content pools

// [title, kcal, protein, carbs, fat, quality, weight(frequency)]
const FOOD = {
  breakfast: [
    ['Poha with peanuts', 360, 9, 58, 11, 'great', 6],
    ['Idli sambar', 380, 13, 66, 6, 'great', 4],
    ['Masala oats', 320, 11, 48, 8, 'great', 3],
    ['Eggs & toast', 420, 24, 32, 20, 'great', 6],
    ['Greek yogurt bowl', 380, 26, 44, 10, 'great', 5],
    ['Oats with banana & peanut butter', 480, 17, 64, 17, 'great', 3],
    ['Besan chilla with mint chutney', 340, 17, 36, 13, 'great', 2],
    ['Upma', 330, 8, 50, 10, 'ok', 2],
    ['Aloo paratha with curd', 560, 13, 70, 24, 'ok', 2],
    ['Masala dosa', 480, 10, 68, 17, 'ok', 1],
  ],
  lunch: [
    ['Dal chawal', 600, 20, 96, 12, 'great', 6],
    ['Rajma rice', 640, 22, 100, 13, 'great', 4],
    ['Roti sabzi with dal', 560, 19, 78, 17, 'great', 5],
    ['Grilled chicken salad', 460, 42, 20, 21, 'great', 5],
    ['Chicken biryani', 760, 34, 88, 28, 'ok', 2],
    ['Paneer tikka wrap', 590, 30, 54, 26, 'ok', 2],
    ['Curd rice with pickle', 430, 12, 70, 10, 'ok', 2],
    ['Office thali', 700, 22, 96, 23, 'ok', 3],
    ['Chicken curry & rice', 690, 38, 74, 23, 'ok', 2],
    ['Chole bhature', 880, 20, 98, 44, 'poor', 1],
  ],
  dinner: [
    ['Paneer tikka with salad', 480, 30, 16, 32, 'great', 4],
    ['Moong dal khichdi', 450, 17, 70, 10, 'great', 4],
    ['Chicken tikka & roti', 560, 46, 40, 20, 'great', 4],
    ['Palak paneer with roti', 600, 26, 50, 31, 'ok', 3],
    ['Egg curry & rice', 620, 26, 74, 22, 'ok', 3],
    ['Fish curry rice', 640, 36, 68, 20, 'great', 2],
    ['Pasta arrabbiata', 560, 18, 86, 15, 'ok', 2],
    ['Pizza slice ×2', 600, 24, 68, 25, 'poor', 2],
    ['Burger & fries', 880, 30, 92, 42, 'poor', 1],
    ['Veg pulao with raita', 520, 14, 82, 14, 'ok', 2],
  ],
  snack: [
    ['Protein shake', 220, 30, 12, 4, 'great', 7],
    ['Banana', 105, 1, 27, 0, 'great', 5],
    ['Mixed nuts', 190, 6, 7, 16, 'great', 4],
    ['Samosa', 260, 4, 30, 14, 'poor', 2],
    ['Masala chai & biscuits', 180, 3, 27, 7, 'poor', 3],
    ['Apple with peanut butter', 260, 7, 30, 13, 'great', 2],
    ['Roasted chana', 160, 9, 24, 3, 'great', 2],
    ['Sprouts chaat', 190, 11, 29, 2, 'great', 2],
    ['Dark chocolate', 170, 2, 13, 12, 'ok', 1],
  ],
};

const FOOD_NOTES = ['Home-cooked', 'Office canteen', 'Ordered on Swiggy', 'Mom’s recipe', 'Extra veggies', 'Ate too fast', 'Meal-prepped on Sunday', 'Post-workout'];

// [category, source, sourceName, title, takeaway, minutes, tags, notes?, link?]
const LEARNINGS = [
  ['tech', 'article', 'MDN Web Docs', 'IndexedDB transactions auto-commit', 'A transaction commits as soon as no requests are pending — never await a fetch inside one.', 20, ['javascript', 'indexeddb'], 'Hit this in the side project: awaited a network call between two puts and got TransactionInactiveError.\nFix: gather data first, then open the transaction.'],
  ['tech', 'article', 'web.dev', 'CSS container queries', 'Components can respond to their container’s width, not the viewport — perfect for cards in sidebars.', 25, ['css', 'frontend']],
  ['tech', 'video', 'Hussein Nasser', 'Reading EXPLAIN ANALYZE in Postgres', 'A seq scan on a big table usually means a missing index — compare estimated vs actual rows.', 35, ['sql', 'performance']],
  ['tech', 'practice', '', 'Git bisect to find a regression', 'Mark one good and one bad commit and git binary-searches the culprit in log₂(n) steps.', 15, ['git']],
  ['tech', 'article', 'Stripe engineering blog', 'Designing idempotent APIs', 'Accept an idempotency key so retries never double-charge; store and replay the first response.', 20, ['api', 'backend']],
  ['tech', 'practice', '', 'Python generators for big files', 'Yielding rows keeps memory flat — a 2 GB CSV processed in ~60 MB.', 30, ['python']],
  ['tech', 'article', 'web.dev', 'Service worker update lifecycle', 'A new worker waits until every tab closes unless you skipWaiting — show an “update ready” prompt instead.', 25, ['pwa', 'javascript']],
  ['tech', 'video', 'Fireship', 'Hidden O(n²) in array code', 'includes() inside a loop is quadratic; build a Set first and the job drops from 9 s to 40 ms.', 12, ['javascript', 'performance']],
  ['tech', 'course', 'Docker Mastery', 'Docker multi-stage builds', 'Build in one stage, copy only the output into a slim image — 900 MB down to 40 MB.', 45, ['docker', 'devops']],
  ['tech', 'article', 'The A11y Project', 'Focus management in dialogs', 'Trap focus inside, restore it to the opener on close, and Esc must always work.', 20, ['a11y', 'frontend']],
  ['trading', 'book', 'Trade Your Way to Financial Freedom — Van K. Tharp', 'Size from the stop, not the account', 'Decide the stop first, then size so hitting it costs exactly 1% — never the other way round.', 40, ['risk', 'sizing'], 'Position size = (account × 1%) ÷ (entry − stop).\nIf the size feels too small, the stop is too wide for this setup.'],
  ['trading', 'video', 'Market webinar', 'Opening range breakout rules', 'The first 15-minute range on NIFTY sets the battle lines; trade the break only with volume.', 30, ['nifty', 'orb']],
  ['trading', 'experience', '', 'Why I stop after 3 losses', 'Three losses in a row is when tilt starts — the fourth trade is almost always revenge.', 10, ['psychology', 'rules']],
  ['trading', 'course', 'Zerodha Varsity', 'Theta decay accelerates near expiry', 'On expiry day ATM premiums can lose half their value by lunch even if spot barely moves.', 35, ['options', 'theta']],
  ['trading', 'article', 'Zerodha Varsity', 'IV crush after events', 'Buying options before results means paying for volatility that collapses after the announcement.', 25, ['options', 'iv']],
  ['trading', 'book', 'Trading in the Zone — Mark Douglas', 'Expectancy beats win rate', 'A 40% win rate with 2.5R winners beats 60% with 0.8R winners — think in sets of 20 trades.', 30, ['expectancy', 'psychology'], 'Each trade is just one sample from my edge. The outcome of any single trade is random; the distribution is not.'],
  ['trading', 'practice', '', 'VWAP as a trend filter', 'Only longs above VWAP and shorts below it — it would have removed half of last month’s losers.', 20, ['vwap', 'intraday']],
  ['trading', 'person', 'Trading mentor', 'Mark the chart before the exit', 'Screenshot the thesis before the outcome so I can judge the idea separately from the P&L.', 15, ['journal', 'process']],
  ['trading', 'article', 'NSE learning', 'Reading open interest build-up', 'Price up + OI up = long build-up; price up + OI down = short covering.', 30, ['options', 'oi']],
  ['trading', 'experience', '', 'The cost of moving a stop', 'Every time I moved a stop this month the loss doubled — the original stop was right 4 out of 5 times.', 10, ['risk', 'stops']],
  ['finance', 'book', 'The Little Book of Common Sense Investing — John Bogle', 'Index funds vs active funds', 'Over 10+ years most large-cap active funds lag the index once fees are counted.', 40, ['investing']],
  ['finance', 'podcast', 'Paisa Vaisa', 'Emergency fund first', 'Six months of expenses, kept boring and liquid — a sweep FD or liquid fund, not equity.', 30, ['personal-finance']],
  ['finance', 'article', 'ClearTax', 'Old vs new tax regime', 'With few deductions the new regime wins — run both numbers every April before declaring.', 20, ['tax']],
  ['finance', 'book', 'The Psychology of Money — Morgan Housel', 'Compounding needs time, not genius', 'Starting five years earlier beat a 2% higher return in my spreadsheet.', 35, ['investing', 'compounding'], 'Saving rate > returns early on. The biggest lever is not interrupting compounding.'],
  ['finance', 'practice', '', 'SIP step-up', 'Raising the SIP 10% a year roughly doubles the 20-year corpus versus a flat SIP.', 15, ['sip', 'investing']],
  ['finance', 'article', '', 'How credit card interest really works', 'Miss the full payment and interest applies to the whole balance from the purchase date, not just the unpaid part.', 15, ['credit']],
  ['health', 'podcast', 'Huberman Lab', 'Total protein beats timing', 'Hitting ~1.6 g/kg per day matters far more than the 30-minute “anabolic window”.', 45, ['nutrition', 'protein']],
  ['health', 'podcast', 'The Drive — Peter Attia', 'Zone 2 cardio', 'Conversational pace for ~150 min a week builds the aerobic base — most of my runs were too fast.', 50, ['cardio', 'running'], 'Test: can I speak full sentences? If not, slow down. Nose-breathing is a decent proxy.'],
  ['health', 'book', 'Why We Sleep — Matthew Walker', 'Caffeine after 2 pm hurts deep sleep', 'Half-life is 5–6 hours: the 4 pm coffee is still half there at 10 pm.', 30, ['sleep', 'caffeine']],
  ['health', 'video', 'Jeff Nippard', 'Progressive overload, simply', 'Add a rep or 2.5 kg each week; when a lift stalls for three sessions, deload 10%.', 20, ['strength', 'training']],
  ['health', 'podcast', 'Huberman Lab', 'Morning sunlight sets the body clock', '10 minutes of outdoor light soon after waking makes falling asleep at night noticeably easier.', 25, ['sleep', 'circadian']],
  ['health', 'article', '', 'Walking after meals', 'A 10-minute walk after dinner flattens the glucose spike — easy win.', 10, ['glucose', 'walking']],
  ['health', 'person', 'Coach at the gym', 'Deadlift hinge cues', 'Push the floor away, keep the bar on the shins, lats tight “like squeezing oranges in the armpits”.', 15, ['strength', 'technique']],
  ['business', 'article', 'Paul Graham', 'Maker’s schedule, manager’s schedule', 'One meeting in the middle of the afternoon can wreck a maker’s whole half-day.', 15, ['productivity', 'work'], '', 'https://paulgraham.com/makersschedule.html'],
  ['business', 'book', 'The Mom Test — Rob Fitzpatrick', 'Talk to users without leading them', 'Ask about the last time they had the problem, not whether they’d use your idea.', 40, ['startups', 'customers'], 'Bad: “Would you pay for X?”\nGood: “How did you handle this last week? What did it cost you?”'],
  ['business', 'podcast', 'My First Million', 'Most products are underpriced', 'A higher price also filters for serious customers — test it before discounting.', 40, ['pricing']],
  ['business', 'book', 'Working Backwards', 'Write the press release first', 'Amazon’s working-backwards doc forces clarity on the customer before a line of code.', 35, ['product']],
  ['business', 'article', 'Paul Graham', 'Default alive or default dead?', 'Project current growth and burn — do you reach profitability before the money runs out?', 15, ['startups']],
  ['language', 'practice', 'Duolingo', 'Spanish: ser vs estar', 'Ser for what something is, estar for how or where it is right now.', 15, ['spanish']],
  ['language', 'course', 'Duolingo', 'Spanish: preterite vs imperfect', 'Preterite for finished events, imperfect for background and habits — “llovía cuando llegué”.', 20, ['spanish', 'grammar']],
  ['language', 'video', 'Tokini Andy', 'Japanese: は vs が', 'は marks the topic, が marks the subject — が introduces new information.', 20, ['japanese']],
  ['science', 'video', 'Veritasium', 'Why the sky is blue', 'Rayleigh scattering goes with 1/λ⁴, so blue light scatters about 5× more than red.', 15, ['physics']],
  ['science', 'article', '', 'mRNA vaccines in three steps', 'mRNA → cells build the spike protein → the immune system learns it; the mRNA itself degrades in days.', 20, ['biology']],
  ['science', 'video', '3Blue1Brown', 'Base rates and Bayes', 'A 99% accurate test for a 1-in-1000 condition is still wrong most of the times it says “positive”.', 25, ['math', 'probability']],
  ['science', 'video', '3Blue1Brown', 'How attention works in transformers', 'Each token makes query, key and value vectors; attention is a weighted average of values by query·key similarity.', 30, ['ai', 'ml'], 'Multi-head = several of these in parallel, each free to look for a different kind of relationship.'],
  ['growth', 'book', 'Atomic Habits — James Clear', 'Habit stacking', 'Attach a new habit to an old one: “after I pour my chai, I write one line in the journal”.', 30, ['habits']],
  ['growth', 'book', 'Atomic Habits — James Clear', 'The two-minute rule', 'Shrink a habit until it takes two minutes — showing up matters more than the size.', 20, ['habits']],
  ['growth', 'book', 'Eat That Frog — Brian Tracy', 'Eat the frog', 'Doing the hardest task first made the rest of the day feel light.', 20, ['productivity']],
  ['growth', 'book', 'Thinking in Bets — Annie Duke', 'Process over outcome', 'Judge a decision by the information I had, not by how it turned out.', 35, ['decisions', 'psychology']],
  ['growth', 'book', 'Deep Work — Cal Newport', 'Deep work blocks', 'Two 90-minute phone-free blocks beat a whole day of half-attention.', 30, ['focus'], 'Phone in another room, one tab, a written goal for the block. Stop at 90 min even if it is going well.'],
  ['growth', 'experience', '', 'Say no to protect the yes', 'Declined two optional calls and finally finished the spec — every yes is a no to something else.', 10, ['focus', 'boundaries']],
  ['growth', 'practice', '', 'One question each morning', '“What would make today great?” — one concrete line gives the day a spine.', 5, ['journaling']],
  ['skills', 'practice', 'keybr.com', 'Touch-typing drills', '10 minutes a day took me from 55 to 68 wpm in three weeks.', 15, ['typing']],
  ['skills', 'video', '', 'Excel XLOOKUP', 'XLOOKUP replaces VLOOKUP and INDEX/MATCH and doesn’t break when columns move.', 15, ['excel']],
  ['skills', 'person', 'Toastmasters club', 'Pause instead of “um”', 'A two-second pause sounds confident to the audience even though it feels endless to me.', 20, ['speaking']],
  ['skills', 'experience', 'Mom', 'Bloom spices in hot oil', 'Tempering jeera and mustard seeds first releases the flavour; adding them later doesn’t.', 20, ['cooking']],
  ['other', 'video', '', 'Folding a fitted sheet', 'Tuck the corners into each other first — then it folds like a normal sheet.', 5, ['life']],
];

const INTENTIONS = [
  'Deep work on the API refactor before lunch',
  'Max 3 trades, only A+ setups',
  'Get all 8 glasses of water in',
  'Finish chapter 4 of Atomic Habits',
  'Leg day — no skipping',
  'Call Mom in the evening',
  'Ship the onboarding fix',
  'Inbox zero by 11, then phone in the drawer',
  'No sugar today',
  'Walk 10 minutes after every meal',
  'Prep slides for Thursday’s review',
  'Be patient at the open — nothing before 9:30',
  'In bed by 11',
  'Practice Spanish for 15 minutes',
  'Protein with every meal',
  'Finish the tax paperwork I keep postponing',
  'One focused block on the side project',
  'Stay calm in the stand-up, listen more',
  'Cook dinner instead of ordering',
  'Review last week’s trades before the market opens',
  'Clear the three oldest tasks on my list',
  'Read 20 pages before bed',
  'Stretch for 10 minutes after work',
  'Respond, don’t react',
  'Stick to the stop-loss, whatever happens',
  'Pay the electricity bill and book the dentist',
];

const WINS = [
  'Hit my protein target without a shake',
  'Let the winner run to target instead of booking early',
  'Ran 6 km without stopping',
  'Fixed the flaky test that’s bugged the team for a week',
  'Said no to an extra meeting and kept my focus block',
  'Cooked dal and rice at home, no delivery',
  'Bench 3×5 felt light today',
  'Finished the book chapter on the metro',
  'Stopped trading after two losses — rule followed',
  'Got positive feedback on the design doc',
  'Woke up without snoozing',
  'Walked to the market instead of taking an auto',
  'Cleared the inbox before lunch',
  'Helped a junior debug their first PR',
  'Skipped the first 15 minutes of the open and it saved me',
  'Drank water all day without reminders',
  'Long call with an old friend',
  'Paid every bill on time this month',
  'PR on squats',
  'Finished the slides a day early',
  'Took a proper lunch break away from the screen',
  'Journaled every trade with screenshots',
  'No phone in bed',
  'Meal-prepped for three days',
];

const REFLECTIONS = {
  tradeGood: [
    'Waited for my levels and it paid. Boring trading is good trading.',
    'Took only the setups from the plan. The green day came from patience, not from more trades.',
    'Sized correctly and didn’t touch the stop. Felt calm the whole session.',
    'Good day on the screen, but I still wanted one more trade after the target — noticed it and closed the terminal.',
  ],
  tradeBad: [
    'Red day. The first loss was fine; the second was me trying to win it back. Need to walk away after one bad trade.',
    'Chased the move at 10:15 instead of waiting for the pullback. Same mistake as last week — writing it on a sticky note.',
    'Lost within the max-loss limit, so the system worked. Mood dipped anyway; a walk helped.',
    'Overtraded a choppy market. If the first hour is a range, I should just watch.',
  ],
  trained: [
    'Workout before work makes everything else easier. Energy stayed high till evening.',
    'Legs are sore but the session was worth it. Need more sleep to recover properly.',
    'Kept the run in zone 2 even though it felt slow. Trusting the process.',
    'Gym was crowded, adapted the order of exercises and still finished in 55 minutes.',
  ],
  rest: [
    'Rest day — did some stretching and felt better for it.',
    'Quiet day. Not every day needs to be productive; recharged a bit.',
    'Body felt heavy. Took it easy and went to bed early.',
  ],
  weekend: [
    'Slow Saturday morning with chai and the newspaper. Needed it.',
    'Spent the afternoon with family, phone mostly away. Best part of the week.',
    'Did the weekly review and planned meals for the week. Sunday-me is a gift to Monday-me.',
    'Went out with friends, ate too much, zero regrets.',
  ],
  generic: [
    'Work was intense but I stayed on the important task. Small win.',
    'Too much screen time today. Tomorrow: phone in the drawer during deep work.',
    'Felt scattered in the afternoon. A 10-minute walk reset my focus.',
    'Good conversations at work. Writing things down helped me speak clearly.',
    'Procrastinated on the big task until 4 pm, then did it in an hour. Classic.',
    'Ate well, drank enough water — the basics make a difference.',
    'Noticed I get irritable when I skip lunch. Note to self: eat on time.',
    'Learned something useful and actually applied it the same day.',
  ],
};

const GRATITUDE = [
  'Chai with Papa on the balcony',
  'Rain after a hot week',
  'A friend who checks in without a reason',
  'My body being able to lift and run',
  'A quiet hour with a good book',
  'Mom’s rajma',
  'A teammate who covered for me in the meeting',
  'The cool morning breeze on my run',
  'Health of my family',
  'A clean desk and a clear plan',
  'Being able to learn something new every day',
  'The street vendor who always saves me the last samosa',
  'A good night’s sleep',
  'Getting home before the traffic',
  'Video call with my sister',
  'Sunlight in the kitchen this morning',
  'Fresh mangoes from the market',
  'Having a job I mostly enjoy',
  'My neighbour’s dog greeting me every evening',
  'Laughing hard at a silly video with friends',
];

const TRADE_PLANS = [
  'Wait for the first 15-minute range, trade the break with volume. Two trades max.',
  'Gap up expected — no chasing. Look for a pullback to VWAP before going long.',
  'Range day likely before the event. Small size, take profits at the edges.',
  'Trend day setup if we hold above yesterday’s high. Trail stops on the 5m.',
  'Only trade levels from the watchlist. If nothing sets up by 11, done for the day.',
  'Expiry day — avoid buying options after 1 pm, theta eats everything.',
  'Weak global cues; bias short below the opening range low.',
  'Focus on banks — HDFCBANK and ICICIBANK leading. Pullbacks only.',
];

const US_TRADE_PLANS = [
  'Wait for the opening range, trade the break with volume. Two trades max.',
  'CPI at 8:30 — no trades until 10. Then pullbacks to VWAP only.',
  'Range day likely ahead of the Fed. Small size, take profits at the edges.',
  'Trend day setup if SPY holds above yesterday’s high. Trail stops on the 5m.',
  'Only trade levels from the watchlist. If nothing sets up by 11, done for the day.',
  'Semis leading — NVDA and AMD pullbacks only.',
];

const DAY_REVIEWS = {
  good: [
    'Followed the plan. Both entries were at planned levels, exits at targets.',
    'Patient start, one clean trend trade made the day. Didn’t give it back.',
    'Kept size small in the chop and pressed only when the trend was clear.',
  ],
  bad: [
    'First trade was fine, then I forced two more in chop. Should have stopped.',
    'Entered too early twice before confirmation. The plan was right, execution wasn’t.',
    'Respected the max loss, but I took a revenge trade after the second stop.',
  ],
  flat: [
    'Choppy day, scratched most trades. Fine — preserving capital is a win.',
    'Mixed session. One good trade, one sloppy one. Net flat.',
  ],
};

const DAY_LESSONS = [
  'No trades in the first 15 minutes — it keeps proving itself.',
  'After two losses, step away for 30 minutes.',
  'Let the target do the work; my early exits cost more than my stops.',
  'If I have to talk myself into a trade, it’s not an A setup.',
  'Respect the higher timeframe trend.',
  'Size down on expiry days.',
  'Write the stop before entering, every time.',
];

const WORKOUT_NOTES = {
  strength: ['Felt strong today', 'Last set was a grind', 'Form check on video — back stayed neutral', 'Short rest times, good pump', 'Shoulder a bit tight, went lighter on press', 'New PR on the main lift!'],
  cardio: ['Kept it conversational', 'Humid morning, slower pace', 'Negative split — last km fastest', 'Knees felt good', 'Ran the lake loop'],
  yoga: ['Hips opened up nicely', 'Focused on breathing', 'Followed a 30-min flow video'],
  walk: ['After-dinner walk', 'Walked with headphones, podcast episode done', 'Evening walk in the park'],
  sports: ['Doubles with office friends', 'Lost 2 of 3 games, great workout though'],
  hiit: ['Tabata circuit — brutal', 'Burpees and kettlebell swings'],
};

// ---------------------------------------------------------------------------------------------------
// Instruments

function instrumentsIndia() {
  return [
    { sym: 'NIFTY', market: 'options', w: 30, kind: 'index-option', under: 'NIFTY', mult: 75, prem: [90, 230], tick: 0.05 },
    { sym: 'BANKNIFTY', market: 'options', w: 16, kind: 'index-option', under: 'BANKNIFTY', mult: 35, prem: [180, 420], tick: 0.05 },
    { sym: 'SENSEX', market: 'options', w: 4, kind: 'index-option', under: 'SENSEX', mult: 20, prem: [150, 380], tick: 0.05 },
    { sym: 'NIFTY', market: 'futures', w: 4, kind: 'future', under: 'NIFTY', mult: 75, tick: 0.05 },
    { sym: 'RELIANCE', market: 'stocks', w: 6, kind: 'stock', base: 1420, tick: 0.05 },
    { sym: 'HDFCBANK', market: 'stocks', w: 6, kind: 'stock', base: 985, tick: 0.05 },
    { sym: 'ICICIBANK', market: 'stocks', w: 4, kind: 'stock', base: 1380, tick: 0.05 },
    { sym: 'TCS', market: 'stocks', w: 5, kind: 'stock', base: 3150, tick: 0.05 },
    { sym: 'INFY', market: 'stocks', w: 5, kind: 'stock', base: 1560, tick: 0.05 },
    { sym: 'SBIN', market: 'stocks', w: 3, kind: 'stock', base: 870, tick: 0.05 },
    { sym: 'BHARTIARTL', market: 'stocks', w: 3, kind: 'stock', base: 1990, tick: 0.05 },
    { sym: 'BTCINR', market: 'crypto', w: 4, kind: 'crypto', base: 8200000, tick: 100, qtyStep: 0.001 },
    { sym: 'ETHINR', market: 'crypto', w: 2, kind: 'crypto', base: 310000, tick: 5, qtyStep: 0.01 },
    { sym: 'USDINR', market: 'forex', w: 4, kind: 'fx', base: 88.4, tick: 0.0025, mult: 1000 },
  ];
}

function instrumentsUS() {
  return [
    { sym: 'SPY', market: 'options', w: 22, kind: 'index-option', under: 'SPY', mult: 100, prem: [1.8, 5.5], tick: 0.01 },
    { sym: 'QQQ', market: 'options', w: 12, kind: 'index-option', under: 'QQQ', mult: 100, prem: [1.8, 5.5], tick: 0.01 },
    { sym: 'MES', market: 'futures', w: 6, kind: 'future', under: 'ES', mult: 5, tick: 0.25 },
    { sym: 'AAPL', market: 'stocks', w: 7, kind: 'stock', base: 232, tick: 0.01 },
    { sym: 'NVDA', market: 'stocks', w: 8, kind: 'stock', base: 182, tick: 0.01 },
    { sym: 'TSLA', market: 'stocks', w: 6, kind: 'stock', base: 352, tick: 0.01 },
    { sym: 'MSFT', market: 'stocks', w: 5, kind: 'stock', base: 455, tick: 0.01 },
    { sym: 'AMD', market: 'stocks', w: 4, kind: 'stock', base: 168, tick: 0.01 },
    { sym: 'BTCUSD', market: 'crypto', w: 5, kind: 'crypto', base: 96000, tick: 1, qtyStep: 0.001 },
    { sym: 'EURUSD', market: 'forex', w: 5, kind: 'fx', base: 1.085, tick: 0.0001, mult: 1, qtyStep: 1000 },
  ];
}

// Index / underlying levels (random walks shared by plans, watchlists and trades).
function underlyingSeries(names, nDays, india) {
  const start = india
    ? { NIFTY: 24350, BANKNIFTY: 55200, SENSEX: 80100 }
    : { SPY: 598, QQQ: 522, ES: 6010 };
  const vol = india ? { NIFTY: 0.007, BANKNIFTY: 0.008, SENSEX: 0.007 } : { SPY: 0.008, QQQ: 0.01, ES: 0.008 };
  const out = {};
  for (const n of names) {
    const r = rng(`under:${n}`);
    let p = start[n] || 100;
    const arr = [];
    const s0 = p;
    for (let i = 0; i < nDays; i++) {
      p *= 1 + r.normal(0.0003, vol[n] || 0.01);
      p += (s0 * (1 + i * 0.0004) - p) * 0.06; // gentle pull to a slow uptrend: stays within a believable band
      arr.push(p);
    }
    out[n] = arr;
  }
  return out;
}

function stockSeries(insts, nDays) {
  const out = {};
  for (const inst of insts) {
    if (inst.kind === 'index-option' || inst.kind === 'future') continue;
    const r = rng(`price:${inst.sym}`);
    let p = inst.base;
    const vol = inst.kind === 'crypto' ? 0.022 : inst.kind === 'fx' ? 0.002 : 0.012;
    const arr = [];
    for (let i = 0; i < nDays; i++) {
      p *= 1 + r.normal(0.0002, vol);
      p += (inst.base - p) * 0.05;
      arr.push(p);
    }
    out[inst.sym] = arr;
  }
  return out;
}

const fmtLevel = (n, india) => new Intl.NumberFormat(india ? 'en-IN' : 'en-US', { maximumFractionDigits: 0 }).format(n);

// ---------------------------------------------------------------------------------------------------
// Generators

function genFood(ctx, dates, i, isToday, nowMin, trainedEarly) {
  const date = dates[i];
  const r = rng(`food:${i}`);
  const wd = weekday(date);
  const weekend = wd === 0 || wd === 6;
  const out = [];
  const slots = [];
  if (!r.chance(0.06)) slots.push(['breakfast', weekend ? randTime(r, '08:45', '10:15') : randTime(r, '07:30', '09:15')]);
  slots.push(['lunch', randTime(r, '12:50', '14:15')]);
  if (r.chance(0.85)) {
    const morning = trainedEarly && r.chance(0.5);
    slots.push(['snack', morning ? randTime(r, '10:30', '11:30') : randTime(r, '16:20', '17:50')]);
  }
  slots.push(['dinner', weekend ? randTime(r, '20:00', '21:45') : randTime(r, '19:40', '21:15')]);
  if (slots.length < 3) slots.splice(1, 0, ['snack', randTime(r, '10:45', '11:30')]);

  let n = 0;
  for (const [meal, time] of slots) {
    if (isToday && toMin(time) > nowMin) continue;
    const list = FOOD[meal].map((f) => {
      let w = f[6];
      if (weekend && f[5] === 'poor') w *= 2.5;
      if (meal === 'snack' && f[0] === 'Protein shake' && trainedEarly) w *= 2;
      return [f, w];
    });
    const f = r.weighted(list);
    const portion = r.float(1, 1.3);
    let quality = f[5];
    if (quality === 'ok' && r.chance(0.12)) quality = 'great';
    const note = r.chance(0.18) ? r.pick(FOOD_NOTES) : '';
    out.push({
      id: `sample-food-${date}-${n++}`,
      date,
      time,
      meal,
      title: f[0],
      calories: round(f[1] * portion, 5),
      protein: Math.round(f[2] * portion),
      carbs: Math.round(f[3] * portion),
      fat: Math.round(f[4] * portion),
      quality,
      photoId: null,
      note,
      sample: true,
      createdAt: stamp(date, time),
    });
  }
  return out;
}

// Weekly template by weekday (0 Sun..6 Sat); w = how likely that slot survives a busy week.
const WORKOUT_PLAN = {
  1: { kind: 'push', w: 9 },
  2: { kind: 'run', w: 6 },
  3: { kind: 'pull', w: 8 },
  4: { kind: 'yoga', w: 2 },
  5: { kind: 'legs', w: 7 },
  6: { kind: 'weekend', w: 6 },
  0: { kind: 'walk', w: 1.5 },
};

/** Picks 4–5 training days per ISO week (weighted by the template) → Set of date keys. */
function trainingDays(dates) {
  const weeks = new Map();
  for (const d of dates) {
    const wk = isoWeek(d);
    if (!weeks.has(wk)) weeks.set(wk, []);
    weeks.get(wk).push(d);
  }
  const out = new Set();
  for (const [wk, list] of weeks) {
    const r = rng(`train-week:${wk}`);
    // Partial weeks (first / current) get a proportional share.
    const want = Math.round((r.chance(0.55) ? 4 : 5) * (list.length / 7));
    const pool = list.map((d) => [d, WORKOUT_PLAN[weekday(d)].w]);
    for (let k = 0; k < want && pool.length; k++) {
      const d = r.weighted(pool);
      out.add(d);
      pool.splice(pool.findIndex((x) => x[0] === d), 1);
    }
  }
  return out;
}

const LIFTS = {
  push: [
    ['Bench press', 60, 2.5, 14, [4, 5, 8]],
    ['Overhead press', 37.5, 1.25, 14, [3, 6, 8]],
    ['Incline dumbbell press', 22, 2, 21, [3, 8, 12]],
    ['Triceps pushdown', 25, 2.5, 21, [3, 10, 15]],
    ['Lateral raise', 8, 1, 28, [3, 12, 15]],
  ],
  pull: [
    ['Deadlift', 100, 5, 14, [3, 3, 5]],
    ['Barbell row', 55, 2.5, 14, [4, 6, 10]],
    ['Pull-ups', 0, 0, 0, [4, 5, 9]],
    ['Lat pulldown', 50, 2.5, 21, [3, 8, 12]],
    ['Biceps curl', 12, 1, 21, [3, 10, 12]],
  ],
  legs: [
    ['Squat', 80, 2.5, 10, [4, 5, 6]],
    ['Romanian deadlift', 70, 2.5, 14, [3, 8, 10]],
    ['Leg press', 140, 5, 14, [3, 10, 12]],
    ['Walking lunges', 12, 2, 21, [3, 10, 12]],
    ['Calf raise', 40, 5, 21, [3, 12, 15]],
  ],
};

function genWorkouts(ctx, dates, i, isToday, nowMin, nDays, training) {
  const date = dates[i];
  const r = rng(`workout:${i}`);
  const wd = weekday(date);
  const plan = WORKOUT_PLAN[wd];
  const out = [];
  if (!training.has(date)) return out;
  const progress = i / Math.max(1, nDays - 1);
  const weekend = wd === 0 || wd === 6;
  let w;
  const base = { date, sample: true, calories: null, distance: null, exercises: [], intensity: null };

  if (plan.kind === 'push' || plan.kind === 'pull' || plan.kind === 'legs') {
    const title = { push: 'Push day', pull: 'Pull day', legs: 'Leg day' }[plan.kind];
    const lifts = LIFTS[plan.kind];
    const chosen = lifts.slice(0, r.chance(0.3) ? 4 : 5);
    const exercises = chosen.map(([name, startKg, step, every, [sets, lo, hi]]) => {
      const reps0 = r.int(lo, hi);
      const kg = startKg ? startKg + step * Math.floor(i / every) : 0;
      const setList = [];
      for (let s = 0; s < sets; s++) {
        const reps = name === 'Pull-ups' ? clamp(Math.round(5 + progress * 3 + r.float(-1, 1)) - (s > 1 ? 1 : 0), 3, 12) : Math.max(lo - 1, reps0 - (s === sets - 1 && r.chance(0.4) ? 1 : 0));
        setList.push({ reps, weight: kg ? ctx.liftWeight(kg) : 0 });
      }
      return { name, sets: setList };
    });
    const time = weekend ? randTime(r, '08:00', '10:00') : r.chance(0.65) ? randTime(r, '06:30', '07:30') : randTime(r, '18:30', '19:30');
    const duration = round(r.float(48, 72), 5);
    w = { ...base, time, type: 'strength', title, duration, intensity: r.int(7, 9), calories: round(duration * r.float(5.2, 6.5), 5), exercises };
  } else if (plan.kind === 'run' || (plan.kind === 'weekend' && r.chance(0.6))) {
    const long = plan.kind === 'weekend';
    const kind = long ? 'Long run' : r.weighted([['Easy run', 5], ['Tempo run', 2], ['Intervals', 1]]);
    const km = long ? r.float(8, 12) + progress * 2 : kind === 'Intervals' ? r.float(4, 5.5) : r.float(4.5, 7);
    const pace = (long ? 6.4 : kind === 'Tempo run' ? 5.4 : kind === 'Intervals' ? 5.6 : 6.1) - progress * 0.35 + r.float(-0.15, 0.15);
    const duration = Math.round(km * pace);
    const time = long ? randTime(r, '06:15', '07:15') : r.chance(0.5) ? randTime(r, '06:15', '07:00') : randTime(r, '18:30', '19:15');
    w = { ...base, time, type: 'cardio', title: kind, duration, intensity: kind === 'Easy run' || long ? r.int(5, 7) : r.int(7, 9), calories: round(km * 64, 5), distance: ctx.distance(km) };
  } else if (plan.kind === 'weekend') {
    if (r.chance(0.55)) {
      const duration = round(r.float(50, 80), 5);
      w = { ...base, time: randTime(r, '17:00', '18:30'), type: 'sports', title: 'Badminton', duration, intensity: r.int(6, 8), calories: round(duration * 6.5, 5) };
    } else {
      const duration = round(r.float(25, 35), 5);
      w = { ...base, time: randTime(r, '07:30', '08:30'), type: 'hiit', title: 'HIIT circuit', duration, intensity: r.int(8, 9), calories: round(duration * 9, 5), exercises: [
        { name: 'Kettlebell swing', sets: [{ reps: 20, weight: ctx.liftWeight(16) }, { reps: 20, weight: ctx.liftWeight(16) }, { reps: 20, weight: ctx.liftWeight(16) }] },
        { name: 'Burpees', sets: [{ reps: 12, weight: 0 }, { reps: 12, weight: 0 }, { reps: 10, weight: 0 }] },
        { name: 'Goblet squat', sets: [{ reps: 15, weight: ctx.liftWeight(16) }, { reps: 15, weight: ctx.liftWeight(16) }] },
      ] };
    }
  } else if (plan.kind === 'yoga') {
    const duration = round(r.float(20, 45), 5);
    w = { ...base, time: randTime(r, '06:30', '07:15'), type: 'yoga', title: r.pick(['Morning yoga', 'Yoga flow', 'Hatha yoga']), duration, intensity: r.int(3, 4), calories: round(duration * 3, 5) };
  } else {
    const km = r.float(3, 5);
    const duration = Math.round(km * r.float(11, 13));
    w = { ...base, time: randTime(r, '18:00', '19:30'), type: 'walk', title: 'Evening walk', duration, intensity: r.int(2, 3), calories: round(km * 50, 5), distance: ctx.distance(km) };
  }
  if (isToday && toMin(w.time) + w.duration > nowMin) return out;
  const notesPool = WORKOUT_NOTES[w.type] || WORKOUT_NOTES.strength;
  w.feeling = clamp(Math.round(r.normal(3.9, 0.8)), 2, 5);
  w.notes = r.chance(0.45) ? r.pick(notesPool) : '';
  w.id = `sample-workout-${date}-0`;
  w.createdAt = stamp(date, toTime(toMin(w.time) + w.duration));
  out.push(w);
  // Occasional after-dinner walk on a training day.
  if (w.type !== 'walk' && !weekend && r.chance(0.08)) {
    const km = r.float(2, 3.2);
    const walk = { ...base, id: `sample-workout-${date}-1`, time: randTime(r, '21:15', '21:45'), type: 'walk', title: 'After-dinner walk', duration: Math.round(km * 12), intensity: 2, calories: round(km * 50, 5), distance: ctx.distance(km), feeling: 4, notes: '' };
    if (!(isToday && toMin(walk.time) + walk.duration > nowMin)) {
      walk.createdAt = stamp(date, walk.time);
      out.push(walk);
    }
  }
  return out;
}

// [note, category, minINR, maxINR, method, from, to, weight, rule]
const DAILY_SPENDS = [
  ['Swiggy dinner', 'food', 320, 680, 'UPI', '20:00', '21:30', 5],
  ['Zomato lunch', 'food', 240, 460, 'UPI', '12:45', '13:45', 3, 'weekday'],
  ['Chai & samosa', 'food', 40, 90, 'Cash', '16:30', '17:30', 5],
  ['Office canteen', 'food', 110, 180, 'UPI', '13:00', '13:45', 4, 'weekday'],
  ['Coffee at Third Wave', 'food', 220, 340, 'Card', '10:30', '16:00', 2],
  ['Dinner with friends', 'food', 1200, 2600, 'Card', '20:30', '22:30', 3, 'weekend'],
  ['Blinkit — milk, eggs & bread', 'groceries', 260, 620, 'UPI', '08:00', '20:00', 4],
  ['Vegetables & fruits', 'groceries', 160, 420, 'Cash', '18:00', '20:00', 3],
  ['BigBasket weekly order', 'groceries', 1800, 3300, 'UPI', '10:00', '12:00', 4, 'saturday'],
  ['Zepto — snacks', 'groceries', 180, 450, 'UPI', '21:00', '22:30', 1],
  ['Uber to office', 'transport', 210, 390, 'UPI', '08:45', '09:30', 3, 'weekday'],
  ['Auto rickshaw', 'transport', 60, 160, 'Cash', '18:00', '19:30', 3],
  ['Rapido bike', 'transport', 55, 120, 'UPI', '09:00', '19:00', 2],
  ['Metro card recharge', 'transport', 500, 500, 'UPI', '08:30', '09:15', 1.2, 'weekday'],
  ['Petrol', 'transport', 600, 1100, 'Card', '10:00', '19:00', 0.8],
  ['Amazon — phone case', 'shopping', 299, 699, 'Card', '21:00', '23:00', 0.5],
  ['Myntra — t-shirts', 'shopping', 999, 2499, 'Card', '21:00', '23:00', 0.5],
  ['Pharmacy — vitamins', 'health', 380, 950, 'UPI', '18:00', '20:30', 0.6],
  ['Movie — BookMyShow', 'entertainment', 450, 850, 'UPI', '15:00', '19:00', 1.2, 'weekend'],
  ['Kindle book', 'education', 149, 449, 'Card', '22:00', '23:00', 0.6],
  ['Laundry', 'other', 150, 300, 'UPI', '09:00', '19:00', 0.8],
];

// Recurring: [dayOfMonth, note, category, INR, method, time, type]
const MONTHLY = [
  [1, 'Salary', 'salary', 125000, 'Bank', '09:00', 'income'],
  [2, 'Rent', 'rent', 18000, 'Bank', '10:00', 'expense'],
  [4, 'Gym membership', 'fitness', 1499, 'Card', '07:45', 'expense'],
  [7, 'Netflix', 'subscriptions', 649, 'Card', '06:00', 'expense'],
  [10, 'Electricity bill', 'bills', 1650, 'UPI', '19:30', 'expense'],
  [12, 'Spotify', 'subscriptions', 119, 'UPI', '06:00', 'expense'],
  [15, 'Broadband', 'bills', 799, 'UPI', '20:00', 'expense'],
  [18, 'YouTube Premium', 'subscriptions', 149, 'Card', '06:00', 'expense'],
  [20, 'Mobile recharge', 'bills', 349, 'UPI', '21:00', 'expense'],
  [22, 'iCloud storage', 'subscriptions', 75, 'Card', '06:00', 'expense'],
  [28, 'Interest credited', 'interest', 412, 'Bank', '08:00', 'income'],
];

// Occasional one-offs by day offset from the start: [offsetFraction, note, category, INR, method, time, type]
const ONE_OFFS = [
  [0.16, 'Running shoes', 'shopping', 7999, 'Card', '19:30', 'expense'],
  [0.3, 'Freelance — landing page for a café', 'freelance', 18000, 'Bank', '11:00', 'income'],
  [0.42, 'Birthday gift for Riya', 'gifts', 2200, 'UPI', '18:00', 'expense'],
  [0.55, 'Train tickets to Jaipur', 'travel', 1850, 'UPI', '22:00', 'expense'],
  [0.58, 'Hotel — Jaipur weekend', 'travel', 4600, 'Card', '14:00', 'expense'],
  [0.66, 'Doctor consultation', 'health', 700, 'UPI', '17:30', 'expense'],
  [0.72, 'Udemy — system design course', 'education', 499, 'Card', '22:15', 'expense'],
  [0.8, 'Noise-cancelling headphones', 'shopping', 14990, 'Card', '20:45', 'expense'],
  [0.88, 'Freelance — dashboard fixes', 'freelance', 12000, 'Bank', '12:00', 'income'],
];

function genExpenses(ctx, dates, i, isToday, nowMin, nDays) {
  const date = dates[i];
  const r = rng(`expense:${i}`);
  const wd = weekday(date);
  const weekend = wd === 0 || wd === 6;
  const dom = Number(date.slice(8, 10));
  const items = [];
  for (const [d, note, category, inr, method, time, type] of MONTHLY) {
    if (dom !== d) continue;
    let amount = inr;
    if (category === 'bills' && note === 'Electricity bill') amount = round(r.float(1300, 2200), 10);
    const label = type === 'income' && category === 'salary' ? `Salary — ${fmtMonth(monthOf(date))}` : note === 'Rent' ? `Rent — ${fmtMonth(monthOf(date))}` : note;
    items.push({ type, category, amount: ctx.money(amount), method: ctx.method(method), time, note: label, tags: category === 'subscriptions' ? ['recurring'] : [] });
  }
  for (const [frac, note, category, inr, method, time, type] of ONE_OFFS) {
    if (Math.round(frac * (nDays - 1)) === i) items.push({ type, category, amount: ctx.money(inr), method: ctx.method(method), time, note, tags: category === 'travel' ? ['jaipur-trip'] : [] });
  }
  const variable = Math.max(0, r.int(weekend ? 3 : 2, weekend ? 5 : 4) - items.filter((x) => x.type === 'expense').length);
  const pool = DAILY_SPENDS.filter((s) => {
    const rule = s[8];
    if (rule === 'weekday') return !weekend;
    if (rule === 'weekend') return weekend;
    if (rule === 'saturday') return wd === 6;
    return true;
  }).map((s) => [s, s[7] * (s[8] === 'saturday' ? 6 : 1)]);
  const used = new Set();
  for (let k = 0; k < variable && pool.length; k++) {
    const s = r.weighted(pool.filter(([x]) => !used.has(x[0])));
    used.add(s[0]);
    const amount = s[2] === s[3] ? s[2] : round(r.float(s[2], s[3]), s[3] > 1000 ? 10 : 1);
    items.push({ type: 'expense', category: s[1], amount: ctx.money(amount), method: ctx.method(r.chance(0.12) && s[4] === 'UPI' ? 'Wallet' : s[4]), time: randTime(r, s[5], s[6]), note: s[0], tags: [] });
  }
  return items
    .filter((x) => !(isToday && toMin(x.time) > nowMin))
    .map((x, n) => ({ id: `sample-expense-${date}-${n}`, date, ...x, sample: true, createdAt: stamp(date, x.time) }));
}

function genLearning(ctx, dates, i, isToday, nowMin, nextEntry) {
  const date = dates[i];
  const r = rng(`learning:${i}`);
  const count = r.weighted([[0, 0.38], [1, 0.47], [2, 0.15]]);
  const out = [];
  for (let n = 0; n < count; n++) {
    const time = n === 0 ? randTime(r, '21:00', '22:45') : randTime(r, '07:30', '08:30');
    if (isToday && toMin(time) > nowMin) continue;
    const [category, source, sourceName, title, takeaway, minutes, tags, notes = '', link = ''] = nextEntry();
    out.push({
      id: `sample-learning-${date}-${n}`,
      date,
      time,
      title,
      takeaway,
      notes,
      category,
      source,
      sourceName,
      link,
      minutes: round(minutes * r.float(0.8, 1.3), 5),
      tags: [...tags],
      starred: r.chance(0.16),
      interval: 1,
      nextReview: addDays(date, 1),
      reviews: [],
      sample: true,
      createdAt: stamp(date, time),
    });
  }
  return out;
}

/** Simulates a spaced-repetition history so ~6 entries are due today. */
function scheduleReviews(entries, today) {
  const r = rng('reviews');
  const states = new Map(); // id → history of {interval, nextReview, reviews}
  for (const e of entries) {
    let interval = 1;
    let next = addDays(e.date, 1);
    const reviews = [];
    const hist = [{ interval, nextReview: next, reviews: [] }];
    while (next < today) {
      const late = r.weighted([[0, 6], [1, 3], [2, 1]]);
      const when = addDays(next, late) < today ? addDays(next, late) : next;
      const result = r.weighted([['good', 7], ['hard', 2], ['again', 1]]);
      if (result === 'again') interval = 1;
      else if (result === 'hard') interval = Math.max(1, Math.round(interval * 1.2));
      else interval = Math.max(2, Math.round(interval * 2.5));
      reviews.push({ date: when, result });
      next = addDays(when, interval);
      hist.push({ interval, nextReview: next, reviews: [...reviews] });
    }
    states.set(e.id, hist);
    Object.assign(e, hist[hist.length - 1]);
  }
  const target = 6;
  const due = () => entries.filter((e) => e.nextReview <= today);
  // Too few due: undo the most recent review of entries due soon (they become overdue again).
  const soon = entries
    .filter((e) => e.nextReview > today && states.get(e.id).length > 1)
    .sort((a, b) => (a.nextReview < b.nextReview ? -1 : 1));
  while (due().length < target && soon.length) {
    const e = soon.shift();
    const hist = states.get(e.id);
    Object.assign(e, hist[hist.length - 2]);
  }
  // Too many due: the oldest-created ones got reviewed yesterday instead.
  const yesterday = addDays(today, -1);
  const extra = due().sort((a, b) => (a.date < b.date ? -1 : 1));
  while (extra.length > target + 1) {
    const e = extra.shift();
    if (e.date >= yesterday) continue;
    const reviews = [...e.reviews, { date: yesterday, result: 'good' }];
    const interval = Math.max(2, Math.round(e.interval * 2.5));
    Object.assign(e, { reviews, interval, nextReview: addDays(yesterday, interval) });
  }
  for (const e of entries) e.reviews = e.reviews.map((x) => ({ ...x }));
}

// --- trades -----------------------------------------------------------------------------------------

const SETUPS = [
  ['Breakout', 20, 0],
  ['Pullback', 20, 0.06],
  ['Trend follow', 15, 0.04],
  ['Reversal', 10, -0.07],
  ['Range', 8, 0],
  ['Gap & go', 8, -0.02],
  ['News', 4, -0.08],
  ['Scalp', 15, -0.04],
];

const THESIS = {
  Breakout: ['{sym} coiling under {lvl} for two sessions — buying the break with volume, stop below the range.', 'Clean break of the opening range on {sym}, volume 2× average. Target the next level.'],
  Pullback: ['{sym} trending, first pullback to VWAP / 20 EMA near {lvl}. Entry on the bounce candle.', 'Higher lows on the 15m; waiting for the pullback into {lvl} instead of chasing.'],
  'Trend follow': ['{sym} holding above yesterday’s high, strong breadth. Riding the trend with a trailing stop.', 'All timeframes aligned on {sym}; adding on the flag continuation.'],
  Reversal: ['{sym} rejected {lvl} twice with long wicks — fading the move back to VWAP.', 'Exhaustion after a big gap; looking for a double top near {lvl}.'],
  Range: ['{sym} stuck between two levels all week. Buying the bottom of the range, target the top.', 'Low volatility day; trading the edges of the {lvl} range.'],
  'Gap & go': ['Gap above {lvl} on strong cues — buying the first 5-minute high break.', '{sym} gapped up on news, holding the gap; momentum entry.'],
  News: ['Reacting to the {sym} headline; small size, tight stop.', 'Event volatility — straddle-like idea on {sym}, defined risk.'],
  Scalp: ['Quick scalp at {lvl} on order-flow imbalance.', 'Momentum burst on {sym}; in and out within minutes.'],
};

const REVIEW_TEXT = {
  target: ['Hit target. Let it work and didn’t touch it.', 'Textbook — plan, entry, target. More of these.', 'Patience paid; held through the pullback to target.'],
  partial: ['Booked partial near the level; good trade but left some on the table.', 'Exited on a weak candle before target. Fine, but trust the plan more.'],
  scratch: ['No follow-through, scratched it near entry.', 'Choppy — got out flat. Good discipline.'],
  cleanLoss: ['Stopped out, but the setup was valid. Good loss.', 'Market didn’t agree; stop did its job.', 'Risk was defined and the loss stayed within plan. Nothing to fix.'],
  mistake: {
    'FOMO entry': 'Jumped in without confirmation because it was moving. FOMO again.',
    'Moved stop': 'Moved the stop “just a bit” and the loss got bigger. Never again.',
    Oversized: 'Size was too big for the stop — the loss hurt more than it should.',
    'Revenge trade': 'Took it to win back the earlier loss. Should have walked away.',
    'Early exit': 'Panicked out early; it hit the target later without me.',
    'Late entry': 'Entered late, after the move had already happened. Bad R:R.',
    Overtrading: 'Fourth trade of the day — I was bored, not seeing a setup.',
    'Ignored plan': 'Not on the watchlist, not in the plan. Shouldn’t have taken it.',
    'Chased price': 'Chased the candle instead of waiting for the retest.',
  },
};

function genTradeSpecs(ctx, dates, i, isToday, nowMin, insts, plans) {
  const date = dates[i];
  const wd = weekday(date);
  if (wd === 0 || wd === 6) return [];
  const r = rng(`trades:${i}`);
  const n = r.weighted([[0, 0.14], [1, 0.3], [2, 0.3], [3, 0.18], [4, 0.08]]);
  const specs = [];
  let t = toMin(ctx.india ? '09:17' : '09:31');
  const close = toMin(ctx.india ? '15:25' : '15:55');
  for (let k = 0; k < n; k++) {
    const inst = r.weighted(insts.map((x) => [x, x.w]));
    const setup = r.weighted(SETUPS.map((s) => [s, s[1]]));
    const fx = inst.kind === 'crypto' || inst.kind === 'fx';
    let entryMin;
    if (inst.kind === 'crypto') entryMin = round(r.float(toMin('19:00'), toMin('22:30')), 1);
    else {
      t += k === 0 ? r.float(0, 60) : r.float(15, 70);
      entryMin = Math.round(t);
    }
    if (!fx && entryMin > close - 30) break;
    const scalp = setup[0] === 'Scalp';
    const hold = scalp ? r.float(3, 14) : r.float(12, 140);
    let exitMin = entryMin + hold;
    if (inst.kind !== 'crypto') exitMin = Math.min(exitMin, close);
    else exitMin = Math.min(exitMin, toMin('23:55'));
    t = Math.max(t, exitMin - r.float(0, 20));
    const swing = inst.kind === 'stock' && r.chance(0.1);
    let exitDate = date;
    if (swing) {
      let d = date;
      const days = r.int(1, 4);
      for (let s = 0; s < days; s++) {
        d = addDays(d, 1);
        while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, 1);
      }
      exitDate = d;
      exitMin = round(r.float(toMin('10:00'), toMin('15:10')), 1);
    }
    const lastDate = dates[dates.length - 1];
    if (exitDate > lastDate) continue;
    if (exitDate === lastDate && exitMin > nowMin) continue;
    if (isToday && entryMin > nowMin) continue;
    const plan = plans[date];
    let pWin = 0.5 + setup[2];
    if (plan && plan.sleep >= 7.25) pWin += 0.05;
    if (plan && plan.sleep < 6.5) pWin -= 0.08;
    if (plan && plan.planned) pWin += 0.03;
    else pWin -= 0.03;
    const rPlanned = fix(r.weighted([[1.5, 3], [2, 5], [2.5, 3], [3, 2]]), 2);
    const win = r.chance(clamp(pWin, 0.25, 0.8));
    specs.push({
      date, dayIndex: i, k, inst, setup: setup[0], swing, exitDate,
      entryTime: toTime(entryMin), exitTime: toTime(exitMin),
      rPlanned, win, rOutcome: 0,
      riskINR: round(r.float(1600, 3200), 50) * (r.chance(0.08) ? 1.8 : 1),
      firstMinutes: !fx && entryMin < toMin(ctx.india ? '09:30' : '09:45'),
      seed: `${i}:${k}`,
    });
  }
  return specs;
}

function rollOutcome(spec, r) {
  if (spec.win) {
    if (r.chance(0.42)) spec.rOutcome = spec.rPlanned;
    else spec.rOutcome = fix(clamp(0.25 + r.next() ** 1.4 * (spec.rPlanned - 0.25), 0.2, 3), 2);
  } else {
    spec.rOutcome = -fix(clamp(r.chance(0.55) ? 1 : 0.3 + r.next() ** 0.7 * 0.75, 0.3, 1.05), 2);
  }
}

/** Nudges outcomes so the set tells a believable "slightly profitable trader" story. */
function balanceSpecs(specs, today) {
  const r = rng('balance');
  const stats = (list) => {
    let wins = 0, gp = 0, gl = 0, net = 0;
    for (const s of list) {
      const v = s.rOutcome * s.riskINR - s.riskINR * 0.04;
      net += v;
      if (v > 0) { wins++; gp += v; } else gl -= v;
    }
    return { winRate: list.length ? wins / list.length : 0, pf: gl > 0 ? gp / gl : 99, net };
  };
  const flip = (s, toWin) => {
    s.win = toWin;
    rollOutcome(s, r);
  };
  for (let guard = 0; guard < 400; guard++) {
    const st = stats(specs);
    if (st.winRate < 0.49) {
      const losers = specs.filter((s) => !s.win);
      if (!losers.length) break;
      flip(r.pick(losers), true);
    } else if (st.winRate > 0.55) {
      const winners = specs.filter((s) => s.win);
      if (!winners.length) break;
      flip(r.pick(winners), false);
    } else if (st.pf < 1.35) {
      const small = specs.filter((s) => s.win && s.rOutcome < s.rPlanned);
      if (!small.length) break;
      const s = r.pick(small);
      s.rOutcome = s.rPlanned;
    } else if (st.pf > 1.85) {
      const big = specs.filter((s) => s.win && s.rOutcome > 1);
      if (!big.length) break;
      const s = r.pick(big);
      s.rOutcome = fix(Math.max(0.3, s.rOutcome * 0.6), 2);
    } else break;
  }
  // Recent month should be green (it's what the home screen and insights show first).
  const recentFrom = addDays(today, -29);
  for (let guard = 0; guard < 60; guard++) {
    const recent = specs.filter((s) => s.exitDate >= recentFrom);
    const margin = recent.reduce((a, s) => a + s.riskINR, 0) * 0.15; // ≈ +0.15R per trade, survives fee/tick rounding
    if (!recent.length || stats(recent).net > margin) break;
    const losers = recent.filter((s) => !s.win);
    if (!losers.length) break;
    flip(r.pick(losers), true);
    // Keep the overall win rate where it was: an older winner becomes a loser instead.
    const older = specs.filter((s) => s.win && s.exitDate < recentFrom);
    if (older.length) flip(r.pick(older), false);
  }
}

function materializeTrade(ctx, spec, priceAt, underAt, dayTrades) {
  const r = rng(`trade:${spec.seed}`);
  const { inst } = spec;
  const i = spec.dayIndex;
  let direction;
  let entry;
  let stopDist;
  let mult = inst.mult || 1;
  let qtyStep = inst.qtyStep || 1;
  let lvl;
  let optionSide = '';
  if (inst.kind === 'index-option') {
    const spot = underAt(inst.under, i);
    lvl = spot;
    direction = r.chance(0.12) ? 'short' : 'long';
    entry = r.float(inst.prem[0], inst.prem[1]);
    stopDist = entry * r.float(0.16, 0.3);
    const strikeStep = inst.under === 'BANKNIFTY' || inst.under === 'SENSEX' ? 100 : inst.under === 'NIFTY' ? 50 : 1;
    const callSide = r.chance(0.55);
    optionSide = `${fmtLevel(round(spot, strikeStep), ctx.india)} ${callSide ? (ctx.india ? 'CE' : 'call') : ctx.india ? 'PE' : 'put'}`;
  } else if (inst.kind === 'future') {
    const spot = underAt(inst.under, i);
    lvl = spot;
    direction = r.chance(0.58) ? 'long' : 'short';
    entry = spot * (1 + r.float(0.0005, 0.002));
    stopDist = ctx.india ? r.float(35, 65) : r.float(6, 12);
  } else {
    const p = priceAt(inst.sym, i);
    lvl = p;
    direction = r.chance(0.6) ? 'long' : 'short';
    entry = p * (1 + r.float(-0.004, 0.004));
    const pct = spec.swing ? r.float(0.018, 0.032) : inst.kind === 'crypto' ? r.float(0.008, 0.016) : inst.kind === 'fx' ? r.float(0.0006, 0.0012) : r.float(0.004, 0.009);
    stopDist = entry * pct;
  }
  const tick = inst.tick;
  const rt = (v) => fix(round(v, tick), tick < 0.01 ? 4 : tick < 1 ? 2 : 0);
  entry = rt(entry);
  stopDist = Math.max(tick * 2, stopDist);
  const sign = direction === 'long' ? 1 : -1;
  const stop = rt(entry - sign * stopDist);
  const realStop = Math.abs(entry - stop);
  const riskLocal = ctx.india ? spec.riskINR : spec.riskINR / 80 * 1.6;
  let qty = riskLocal / (realStop * mult);
  if (inst.kind === 'index-option' || inst.kind === 'future') qty = Math.max(1, Math.round(qty));
  else if (qtyStep < 1) qty = Math.max(qtyStep, fix(round(qty, qtyStep), 3));
  else qty = Math.max(qtyStep, round(qty, qtyStep));
  const target = rt(entry + sign * realStop * spec.rPlanned);
  let exit = rt(entry + sign * realStop * spec.rOutcome);
  if (exit <= 0) exit = tick;
  const notional = entry * qty * mult;
  let fees;
  if (ctx.india) {
    if (inst.kind === 'index-option') fees = 40 + notional * 0.0012 + qty * 6;
    else if (inst.kind === 'future') fees = 40 + notional * 0.00012;
    else if (inst.kind === 'crypto') fees = notional * 0.002;
    else if (inst.kind === 'fx') fees = 40 + qty * 1.2;
    else fees = 30 + notional * 0.00035;
  } else if (inst.kind === 'index-option') fees = qty * 1.3;
  else if (inst.kind === 'future') fees = qty * 1.24;
  else if (inst.kind === 'crypto') fees = notional * 0.0012;
  else fees = inst.kind === 'fx' ? qty * 0.00004 : Math.max(1, qty * 0.005);
  fees = fix(fees, 2);

  // Psychology
  const outcomeType = spec.win ? (spec.rOutcome >= spec.rPlanned - 1e-9 ? 'target' : spec.rOutcome < 0.35 ? 'scratch' : 'partial') : 'loss';
  const priorLosses = dayTrades.filter((x) => !x.win).length;
  const mistakes = [];
  const pool = [];
  if (spec.firstMinutes) pool.push(['FOMO entry', 3]);
  if (!spec.win) {
    pool.push(['FOMO entry', 2], ['Chased price', 2], ['Late entry', 1.5], ['Ignored plan', 1.2], ['Moved stop', spec.rOutcome <= -0.95 ? 2 : 0.2]);
    if (priorLosses > 0) pool.push(['Revenge trade', 3]);
    if (spec.k >= 2) pool.push(['Overtrading', 2.5]);
    if (spec.riskINR > 3500) pool.push(['Oversized', 4]);
  } else {
    if (outcomeType === 'partial' || outcomeType === 'scratch') pool.push(['Early exit', 3]);
    pool.push(['Late entry', 0.6], ['Chased price', 0.5]);
  }
  const mistakeChance = spec.win ? (outcomeType === 'target' ? 0.04 : 0.25) : spec.firstMinutes || priorLosses > 0 ? 0.75 : 0.42;
  if (pool.length && r.chance(mistakeChance)) {
    mistakes.push(r.weighted(pool));
    if (!spec.win && r.chance(0.25)) {
      const second = r.weighted(pool);
      if (!mistakes.includes(second)) mistakes.push(second);
    }
  }
  const emotions = [];
  const goodEm = [['Calm', 4], ['Focused', 4], ['Confident', 3]];
  const badEm = [['Anxious', 3], ['Impatient', 3], ['Frustrated', 2], ['Fearful', 1.5], ['Greedy', 1.5], ['Bored', 1]];
  emotions.push(r.weighted(mistakes.length ? badEm : spec.win ? goodEm : [...goodEm, ['Anxious', 2]]));
  if (r.chance(0.35)) {
    const e2 = r.weighted(mistakes.length ? [...badEm, ['Euphoric', spec.win ? 2 : 0]] : goodEm);
    if (!emotions.includes(e2)) emotions.push(e2);
  }
  const badPlan = mistakes.some((m) => ['Ignored plan', 'Revenge trade', 'FOMO entry', 'Oversized', 'Moved stop', 'Overtrading'].includes(m));
  const followedPlan = badPlan ? r.chance(0.2) : r.chance(0.94);
  let rating;
  if (mistakes.length) rating = r.int(1, 3);
  else if (spec.win) rating = r.int(4, 5);
  else rating = r.int(3, 4);
  const confidence = clamp(Math.round(r.normal(spec.win ? 3.7 : 3.3, 0.8)), 1, 5);

  const lvlText = fmtLevel(inst.kind === 'stock' || inst.kind === 'crypto' || inst.kind === 'fx' ? entry : round(lvl, 10), ctx.india);
  const symText = inst.kind === 'index-option' ? `${inst.sym} ${optionSide}` : inst.sym;
  let thesis = r.pick(THESIS[spec.setup]).replace('{sym}', symText).replace('{lvl}', lvlText);
  if (inst.kind === 'index-option' && !thesis.includes(optionSide)) thesis = `${direction === 'short' ? 'Sold' : 'Bought'} ${optionSide}. ${thesis}`;
  let review;
  if (mistakes.length && REVIEW_TEXT.mistake[mistakes[0]]) review = REVIEW_TEXT.mistake[mistakes[0]];
  else if (outcomeType === 'loss') review = r.pick(REVIEW_TEXT.cleanLoss);
  else review = r.pick(REVIEW_TEXT[outcomeType]);

  const tags = [spec.swing ? 'swing' : 'intraday'];
  if (inst.kind === 'index-option' && ctx.india && weekday(spec.date) === 2 && inst.under === 'NIFTY') tags.push('expiry-day');
  if (spec.riskINR > 3500) tags.push('size-up');

  const timeframe = spec.swing ? r.pick(['1h', '1D']) : spec.setup === 'Scalp' ? r.pick(['1m', '5m']) : r.weighted([['5m', 5], ['15m', 3], ['1h', 1]]);
  return prepareTrade({
    id: `sample-trade-${spec.date}-${spec.k}`,
    accountId: ctx.accountId,
    symbol: inst.sym,
    market: inst.market,
    direction,
    status: 'closed',
    entryDate: spec.date,
    entryTime: spec.entryTime,
    exitDate: spec.exitDate,
    exitTime: spec.exitTime,
    entryPrice: entry,
    exitPrice: exit,
    quantity: qty,
    multiplier: mult,
    fees,
    stopLoss: stop,
    target,
    pnlOverride: null,
    setup: spec.setup,
    timeframe,
    confidence,
    rating,
    followedPlan,
    emotions,
    mistakes,
    tags,
    thesis,
    review,
    screenshots: [],
    sample: true,
    createdAt: stamp(spec.date, spec.entryTime),
  });
}

function genOpenTrades(ctx, dates, nowMin, priceAt, underAt, insts) {
  const r = rng('open-trades');
  const out = [];
  const n = dates.length;
  const today = dates[n - 1];
  const weekdaysBack = (k) => {
    let d = today;
    let left = k;
    while (left > 0 || weekday(d) === 0 || weekday(d) === 6) {
      d = addDays(d, -1);
      if (weekday(d) !== 0 && weekday(d) !== 6) left--;
    }
    return d;
  };
  const idxOf = (d) => Math.max(0, dates.indexOf(d));
  const mk = (inst, date, time, direction, stopPct, rr, qty, setup, thesis, tags) => {
    const i = idxOf(date);
    const base = inst.kind === 'stock' || inst.kind === 'crypto' || inst.kind === 'fx' ? priceAt(inst.sym, i) : r.float(inst.prem[0], inst.prem[1]);
    const tick = inst.tick;
    const rt = (v) => fix(round(v, tick), tick < 0.01 ? 4 : tick < 1 ? 2 : 0);
    const entry = rt(base);
    const sign = direction === 'long' ? 1 : -1;
    const stop = rt(entry * (1 - sign * stopPct));
    const target = rt(entry + sign * Math.abs(entry - stop) * rr);
    return prepareTrade({
      id: `sample-trade-open-${out.length}`,
      accountId: ctx.accountId, symbol: inst.sym, market: inst.market, direction, status: 'open',
      entryDate: date, entryTime: time, exitDate: null, exitTime: null,
      entryPrice: entry, exitPrice: null, quantity: qty, multiplier: inst.mult || 1, fees: 0,
      stopLoss: stop, target, pnlOverride: null, setup, timeframe: tags.includes('swing') ? '1D' : '15m',
      confidence: 4, rating: null, followedPlan: true, emotions: ['Calm'], mistakes: [], tags, thesis, review: '',
      screenshots: [], sample: true, createdAt: stamp(date, time),
    });
  };
  const find = (sym) => insts.find((x) => x.sym === sym);
  if (ctx.india) {
    const swingDate = weekdaysBack(3);
    const infy = find('INFY');
    const qty = Math.max(1, Math.round(2400 / (priceAt('INFY', idxOf(swingDate)) * 0.025)));
    out.push(mk(infy, swingDate, '14:40', 'long', 0.025, 2.5, qty, 'Pullback', 'Daily pullback to the 20 EMA after a strong IT rally; holding for the breakout retest. Stop below the swing low.', ['swing']));
    const cryptoDate = addDays(today, -1);
    out.push(mk(find('BTCINR'), cryptoDate, '21:35', 'long', 0.02, 2, 0.015, 'Breakout', 'BTC reclaimed the weekly level; swing long with a stop under the breakout candle.', ['swing', 'crypto']));
    const wd = weekday(today);
    if (wd !== 0 && wd !== 6 && nowMin >= toMin('10:05')) {
      out.push(mk(find('NIFTY'), today, '10:05', 'long', 0.25, 2, 1, 'Trend follow', `Bought ${fmtLevel(round(underAt('NIFTY', n - 1), 50), true)} CE — holding above the opening range high with strong breadth.`, ['intraday']));
    }
  } else {
    const swingDate = weekdaysBack(3);
    const nvda = find('NVDA');
    const qty = Math.max(1, Math.round(150 / (priceAt('NVDA', idxOf(swingDate)) * 0.03)));
    out.push(mk(nvda, swingDate, '15:40', 'long', 0.03, 2.5, qty, 'Pullback', 'Daily pullback to the 20 EMA in a strong semis trend; stop below the swing low.', ['swing']));
    out.push(mk(find('BTCUSD'), addDays(today, -1), '21:35', 'long', 0.02, 2, 0.02, 'Breakout', 'BTC reclaimed the weekly level; swing long with a stop under the breakout candle.', ['swing', 'crypto']));
    const wd = weekday(today);
    if (wd !== 0 && wd !== 6 && nowMin >= toMin('10:15')) {
      out.push(mk(find('SPY'), today, '10:15', 'long', 0.25, 2, 2, 'Trend follow', `Bought ${fmtLevel(round(underAt('SPY', n - 1), 1), false)} calls — holding above the opening range high.`, ['intraday']));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Days

function genDayPlans(dates, nDays) {
  // Base per-day state that other generators correlate with.
  const plans = {};
  dates.forEach((date, i) => {
    const r = rng(`dayplan:${i}`);
    const wd = weekday(date);
    const weekend = wd === 0 || wd === 6;
    const sleep = clamp(round(r.normal(weekend ? 7.6 : 7.0, 0.65), 0.25), 5.5, 8.5);
    plans[date] = { sleep, planned: !weekend && r.chance(0.6) };
  });
  return plans;
}

function genDay(ctx, dates, i, isToday, nowMin, plan, info, nDays, textFns, goalsCheck) {
  const date = dates[i];
  const r = rng(`day:${i}`);
  const wd = weekday(date);
  const weekend = wd === 0 || wd === 6;
  const trained = info.workouts.length > 0;
  const hardTraining = info.workouts.some((w) => w.type === 'strength' || w.type === 'cardio');
  const tradePnl = info.tradePnl;
  const sleep = plan.sleep;

  const mood = clamp(Math.round(3.3 + (sleep - 7) * 0.55 + (trained ? 0.35 : -0.1) + (tradePnl > 0 ? 0.3 : tradePnl < 0 ? -0.45 : 0) + (weekend ? 0.2 : 0) + r.normal(0, 0.6)), 2, 5);
  const energy = clamp(Math.round(3.2 + (sleep - 7) * 0.8 + (trained ? 0.3 : 0) + r.normal(0, 0.6)), 2, 5);
  let water = clamp(Math.round(r.normal(7, 1.4) + (hardTraining ? 1 : 0)), 4, 10);
  let steps = Math.round(clamp(r.normal(weekend ? 7800 : 6400, 1800) + info.workouts.reduce((s, w) => s + (w.type === 'cardio' || w.type === 'walk' ? (w.distance || 0) * (ctx.mi ? 1.609 : 1) * 1300 : w.type === 'sports' ? 3500 : 0), 0), 3000, 13000));
  const progress = i / Math.max(1, nDays - 1);
  const weight = r.chance(0.68) || i === nDays - 1 ? ctx.weight(74 - 1.5 * progress + r.normal(0, 0.22)) : null;

  if (isToday) {
    const frac = clamp((nowMin - 7 * 60) / (15 * 60), 0.1, 1);
    water = Math.max(1, Math.round(water * frac));
    steps = Math.max(300, Math.round(steps * frac));
  }

  const evening = !isToday || nowMin >= toMin('20:30');
  const day = {
    date,
    water,
    mood,
    energy,
    sleep,
    weight,
    steps,
    intention: isToday || r.chance(0.86) ? textFns.intention() : '',
    wins: evening && r.chance(0.74) ? textFns.win() : '',
    reflection: '',
    gratitude: evening && r.chance(0.62) ? textFns.gratitude() : '',
    checks: {},
    trading: { bias: '', watchlist: '', plan: '', maxLoss: null, moodBefore: null, rulesChecked: {}, review: '', lessons: '', grade: '' },
    sample: true,
  };
  if (evening && r.chance(0.8)) {
    let key = 'generic';
    if (info.trades.length && tradePnl > 0 && r.chance(0.45)) key = 'tradeGood';
    else if (info.trades.length && tradePnl < 0 && r.chance(0.55)) key = 'tradeBad';
    else if (weekend && r.chance(0.6)) key = 'weekend';
    else if (trained && r.chance(0.45)) key = 'trained';
    else if (!trained && r.chance(0.25)) key = 'rest';
    day.reflection = textFns.reflection(key);
  }
  for (const g of goalsCheck) if (!isToday || evening ? r.chance(0.72) : false) day.checks[g.id] = true;

  if (plan.planned) {
    const tr = day.trading;
    const spotA = info.underA;
    const levels = ctx.india
      ? `NIFTY ${fmtLevel(round(spotA * 0.997, 50), true)} / ${fmtLevel(round(spotA * 1.006, 50), true)} · BANKNIFTY ${fmtLevel(round(info.underB, 100), true)} pivot`
      : `SPY ${fmtLevel(round(spotA * 0.997, 1), false)} / ${fmtLevel(round(spotA * 1.006, 1), false)} · QQQ ${fmtLevel(round(info.underB, 1), false)} pivot`;
    const extra = r.chance(0.5) ? (ctx.india ? r.pick([' · RELIANCE above 1,450', ' · HDFCBANK pullback zone', ' · INFY results week', ' · USDINR 88.6 resistance']) : r.pick([' · NVDA 185 breakout', ' · TSLA range 340–360', ' · AAPL above 235'])) : '';
    tr.bias = r.weighted([['bullish', 4], ['bearish', 3], ['neutral', 3]]);
    tr.watchlist = levels + extra;
    tr.plan = r.pick(ctx.india ? TRADE_PLANS : US_TRADE_PLANS);
    tr.maxLoss = ctx.india ? 5000 : 300;
    tr.moodBefore = clamp(Math.round(3 + (sleep - 7) * 0.6 + r.normal(0, 0.6)), 1, 5);
    const firstMinuteTrade = info.trades.some((t) => t.firstMinutes);
    const losses = info.trades.filter((t) => !t.win).length;
    for (const rule of ctx.rules) {
      let ok = r.chance(0.86);
      if (rule.id === 'r3' && firstMinuteTrade) ok = false;
      if (rule.id === 'r4' && losses >= 3) ok = false;
      if (ok) tr.rulesChecked[rule.id] = true;
    }
    const marketClosed = !isToday || nowMin >= toMin(ctx.india ? '15:45' : '16:15');
    if (marketClosed && info.trades.length) {
      const mistakes = info.closed.reduce((s, t) => s + t.mistakes.length, 0);
      const pnlR = info.closed.reduce((s, t) => s + (tradeNet(t) || 0), 0) / (ctx.india ? 2000 : 50);
      const kind = pnlR > 0.4 ? 'good' : pnlR < -0.4 ? 'bad' : 'flat';
      tr.review = r.pick(DAY_REVIEWS[kind]);
      tr.lessons = r.chance(0.7) ? r.pick(DAY_LESSONS) : '';
      tr.grade = kind === 'good' ? (mistakes ? 'B' : 'A') : kind === 'flat' ? (mistakes ? 'C' : 'B') : mistakes >= 2 ? r.pick(['D', 'F']) : 'C';
    } else if (marketClosed && !isToday) {
      tr.review = 'No setups matched the plan — sat on my hands. That counts.';
      tr.grade = 'A';
    }
  }
  return day;
}

// ---------------------------------------------------------------------------------------------------
// Public API

function sampleKeysQuery(store) {
  return runTransaction(store, 'readonly', (tx) => {
    const req = tx.objectStore(store).getAllKeys(IDBKeyRange.bound('sample-', 'sample-￿'));
    return () => req.result || [];
  });
}

/** True when any sample record exists (fast key-range check first, then a scan of days/reviews). */
export async function hasSampleData() {
  for (const store of ['food', 'expenses', 'trades', 'learning', 'workouts']) {
    const keys = await sampleKeysQuery(store);
    if (keys.length) return true;
  }
  for (const store of ['days', 'reviews', 'files']) {
    const rows = await db.all(store);
    if (rows.some((x) => x && x.sample === true)) return true;
  }
  return false;
}

/**
 * Writes ~2.5 months of realistic, deterministic demo data ending today.
 * → { counts: {store: n}, skippedDays, goalsCreated, ms }
 */
export async function loadSampleData({ days = 75 } = {}) {
  const t0 = performance.now();
  const nDays = clamp(Math.round(Number(days) || 75), 7, 400);
  const settings = getSettings();
  const ctx = makeContext(settings);
  const today = todayKey();
  const nowMin = toMin(nowTime());
  const start = addDays(today, -(nDays - 1));
  const dates = [];
  for (let i = 0; i < nDays; i++) dates.push(addDays(start, i));

  // Existing state (to never overwrite user data, and to clean up stale sample records).
  const [storedDays, goals, ...existing] = await Promise.all([
    db.all('days'),
    db.all('goals'),
    ...ID_STORES.map((s) => db.all(s)),
  ]);
  const existingByStore = {};
  ID_STORES.forEach((s, k) => (existingByStore[s] = existing[k]));
  const dayMap = new Map(storedDays.map((d) => [d.date, d]));

  // Goals first (check goals feed day.checks).
  let goalsCreated = 0;
  let goalList = goals;
  if (!goals.length) {
    goalList = defaultGoals(settings);
    await db.bulkPut('goals', goalList);
    goalsCreated = goalList.length;
  }
  const goalsCheck = goalList.filter((g) => g && g.kind === 'check' && g.active !== false);

  const insts = ctx.india ? instrumentsIndia() : instrumentsUS();
  const unders = underlyingSeries(ctx.india ? ['NIFTY', 'BANKNIFTY', 'SENSEX'] : ['SPY', 'QQQ', 'ES'], nDays, ctx.india);
  const prices = stockSeries(insts, nDays);
  const underAt = (name, i) => unders[name][clamp(i, 0, nDays - 1)];
  const priceAt = (sym, i) => prices[sym][clamp(i, 0, nDays - 1)];
  const plans = genDayPlans(dates, nDays);

  const food = [];
  const workouts = [];
  const expenses = [];
  const learning = [];
  const nextLearning = cycler(LEARNINGS, 'learning');
  const perDayWorkouts = {};
  const training = trainingDays(dates);
  let specs = [];

  dates.forEach((date, i) => {
    const isToday = date === today;
    const w = genWorkouts(ctx, dates, i, isToday, nowMin, nDays, training);
    perDayWorkouts[date] = w;
    workouts.push(...w);
    const trainedEarly = w.some((x) => toMin(x.time) < 12 * 60 && x.type !== 'walk' && x.type !== 'yoga');
    food.push(...genFood(ctx, dates, i, isToday, nowMin, trainedEarly));
    expenses.push(...genExpenses(ctx, dates, i, isToday, nowMin, nDays));
    learning.push(...genLearning(ctx, dates, i, isToday, nowMin, nextLearning));
    specs.push(...genTradeSpecs(ctx, dates, i, isToday, nowMin, insts, plans));
  });
  for (const s of specs) rollOutcome(s, rng(`outcome:${s.seed}`));
  balanceSpecs(specs, today);
  scheduleReviews(learning, today);

  const trades = [];
  const specsByDay = {};
  for (const s of specs) (specsByDay[s.date] ||= []).push(s);
  for (const date of Object.keys(specsByDay)) {
    const list = specsByDay[date];
    list.forEach((s, k) => trades.push(materializeTrade(ctx, s, priceAt, underAt, list.slice(0, k))));
  }
  trades.push(...genOpenTrades(ctx, dates, nowMin, priceAt, underAt, insts));

  // Days
  const textFns = {
    intention: cycler(INTENTIONS, 'intention'),
    win: cycler(WINS, 'wins'),
    gratitude: cycler(GRATITUDE, 'gratitude'),
    reflection: (() => {
      const c = {};
      for (const k of Object.keys(REFLECTIONS)) c[k] = cycler(REFLECTIONS[k], `reflection:${k}`);
      return (k) => c[k]();
    })(),
  };
  const tradesByEntry = {};
  for (const s of specs) (tradesByEntry[s.date] ||= []).push(s);
  const closedByDate = {};
  for (const t of trades) if (t.status === 'closed') (closedByDate[t.date] ||= []).push(t);
  const dayRecords = [];
  let skippedDays = 0;
  dates.forEach((date, i) => {
    const prev = dayMap.get(date);
    if (prev && prev.sample !== true) {
      skippedDays++;
      return;
    }
    const closed = closedByDate[date] || [];
    const info = {
      workouts: perDayWorkouts[date] || [],
      trades: tradesByEntry[date] || [],
      closed,
      tradePnl: closed.reduce((s, t) => s + (tradeNet(t) || 0), 0),
      underA: underAt(ctx.india ? 'NIFTY' : 'SPY', i),
      underB: underAt(ctx.india ? 'BANKNIFTY' : 'QQQ', i),
    };
    dayRecords.push(genDay(ctx, dates, i, date === today, nowMin, plans[date], info, nDays, textFns, goalsCheck));
  });

  // Weekly reviews for the two most recent completed ISO weeks.
  const reviews = [];
  for (const back of [7, 14]) {
    const period = isoWeek(addDays(today, -back));
    const id = `week:${period}`;
    const prev = existingByStore.reviews.find((x) => x.id === id);
    if (prev && prev.sample !== true) continue;
    const { from, to } = weekRange(period);
    const wk = trades.filter((t) => t.status === 'closed' && t.date >= from && t.date <= to);
    const wins = wk.filter((t) => tradeNet(t) > 0).length;
    const net = wk.reduce((s, t) => s + (tradeNet(t) || 0), 0);
    const wo = workouts.filter((w) => w.date >= from && w.date <= to).length;
    const le = learning.filter((l) => l.date >= from && l.date <= to).length;
    const good = net > 0;
    reviews.push({
      id,
      type: 'week',
      period,
      rating: good ? 4 : 3,
      wentWell: `${wo} workouts and ${le} things learned. ${wk.length ? `Trading: ${wins}/${wk.length} winners${good ? ', a green week' : ''}.` : ''} ${back === 7 ? 'Kept the morning routine going all week.' : 'Cooked at home most days.'}`.trim(),
      improve: good ? 'Still booking winners too early on some trades. Sleep slipped mid-week.' : 'Two revenge trades after losses — stop after the second loss. Too much delivery food.',
      focus: back === 7 ? 'In bed by 11 on weeknights; max 3 trades a day.' : 'Hit protein every day and log every trade with a screenshot.',
      sample: true,
      createdAt: stamp(addDays(to, 0), '20:30'),
    });
  }

  // Remove stale sample records from earlier runs that this run does not rewrite.
  const fresh = { food, learning, workouts, expenses, trades, reviews, files: [] };
  const staleDeletes = [];
  for (const store of ID_STORES) {
    const keep = new Set(fresh[store].map((x) => x.id));
    const stale = existingByStore[store].filter((x) => x.sample === true && !keep.has(x.id)).map((x) => x.id);
    if (stale.length) staleDeletes.push(db.bulkDelete(store, stale));
  }
  const keepDays = new Set(dayRecords.map((d) => d.date));
  const staleDays = storedDays.filter((d) => d.sample === true && !keepDays.has(d.date)).map((d) => d.date);
  if (staleDays.length) staleDeletes.push(db.bulkDelete('days', staleDays));
  await Promise.all(staleDeletes);

  await Promise.all([
    db.bulkPut('food', food),
    db.bulkPut('learning', learning),
    db.bulkPut('workouts', workouts),
    db.bulkPut('expenses', expenses),
    db.bulkPut('trades', trades),
    db.bulkPut('reviews', reviews),
    db.bulkPut('days', dayRecords),
  ]);

  const counts = { days: dayRecords.length, food: food.length, learning: learning.length, workouts: workouts.length, expenses: expenses.length, trades: trades.length, reviews: reviews.length };
  return { counts, skippedDays, goalsCreated, ms: Math.round(performance.now() - t0) };
}

/** Deletes every record flagged sample:true in every store (+ images they reference). → {store: n} */
export async function removeSampleData() {
  const stores = STORES.filter((s) => s !== 'meta');
  const rows = await Promise.all(stores.map((s) => db.all(s)));
  const counts = {};
  const fileIds = new Set();
  const deletes = [];
  stores.forEach((store, k) => {
    const sample = rows[k].filter((x) => x && x.sample === true);
    if (store !== 'files') {
      for (const x of sample) {
        if (x.photoId) fileIds.add(x.photoId);
        if (Array.isArray(x.screenshots)) x.screenshots.forEach((id) => id && fileIds.add(id));
      }
    }
    counts[store] = sample.length;
    if (store === 'files') return;
    const key = store === 'days' ? 'date' : 'id';
    if (sample.length) deletes.push(db.bulkDelete(store, sample.map((x) => x[key])));
  });
  await Promise.all(deletes);
  // Files: sample-flagged ones + those referenced by sample records (only if no non-sample record uses them).
  const filesIdx = stores.indexOf('files');
  const used = new Set();
  stores.forEach((store, k) => {
    if (store === 'files') return;
    for (const x of rows[k]) {
      if (!x || x.sample === true) continue;
      if (x.photoId) used.add(x.photoId);
      if (Array.isArray(x.screenshots)) x.screenshots.forEach((id) => used.add(id));
    }
  });
  const fileDeletes = rows[filesIdx].filter((f) => f && (f.sample === true || (fileIds.has(f.id) && !used.has(f.id)))).map((f) => f.id);
  counts.files = fileDeletes.length;
  if (fileDeletes.length) await db.bulkDelete('files', fileDeletes);
  return counts;
}
