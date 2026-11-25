// Module registry — loads every module independently so one broken module can't take down the app.
// Order here = order of quick actions and Today cards.

const ENTRIES = [
  ['today', () => import('./today.js')],
  ['food', () => import('./food.js')],
  ['learning', () => import('./learning.js')],
  ['training', () => import('./training.js')],
  ['expenses', () => import('./expenses.js')],
  ['trades', () => import('./trades/index.js')],
  ['goals', () => import('./goals.js')],
  ['calendar', () => import('./calendar.js')],
  ['insights', () => import('./insights.js')],
  ['search', () => import('./search.js')],
  ['settings', () => import('./settings-view.js')],
  ['welcome', () => import('./onboarding.js')],
];

let modules = [];
let byId = new Map();
let errors = new Map();

export async function loadModules() {
  const results = await Promise.allSettled(ENTRIES.map(([, load]) => load()));
  modules = [];
  byId = new Map();
  errors = new Map();
  results.forEach((res, i) => {
    const id = ENTRIES[i][0];
    if (res.status === 'fulfilled' && res.value && res.value.default) {
      const mod = res.value.default;
      if (!mod.id) mod.id = id;
      modules.push(mod);
      byId.set(id, mod);
    } else {
      const err = res.status === 'rejected' ? res.reason : new Error('Module has no default export');
      errors.set(id, err);
      console.error(`[daybook] module "${id}" failed to load:`, err);
    }
  });
  return { modules, errors };
}

export function getModules() {
  return modules;
}

export function getModule(id) {
  return byId.get(id);
}

export function getModuleError(id) {
  return errors.get(id);
}

export function moduleIds() {
  return ENTRIES.map(([id]) => id);
}
