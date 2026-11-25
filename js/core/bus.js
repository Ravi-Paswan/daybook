// Event bus + shared app state.
//
// Events (see SPEC 3.1):
//   'db:change'       {store, op:'put'|'delete'|'clear'|'import', key, record}   (store '*' after import / clear-all)
//   'settings:change' {settings, patch}
//   'route:change'    {route}
//   'state:date'      {date}
// Extra (not in spec, harmless): 'db:blocked', 'db:versionchange'; on('*', fn) receives (event, payload).
//
// Note: this file deliberately has NO imports (it computes today's key itself) so that
// bus → dates → settings → db → bus can never form an import cycle.

const listeners = new Map(); // event -> Set<fn>

function localTodayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Subscribe. Returns an `off()` function (idempotent). */
export function on(event, fn) {
  if (typeof fn !== 'function') return () => {};
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  // Wrap so the same fn can be registered twice and removed independently.
  const entry = { fn };
  set.add(entry);
  return function off() {
    set.delete(entry);
  };
}

/** Subscribe for a single call. Returns off(). */
export function once(event, fn) {
  const off = on(event, (payload, ev) => {
    off();
    fn(payload, ev);
  });
  return off;
}

/** Synchronously call every listener. A throwing listener is logged and never breaks the others. */
export function emit(event, payload) {
  const call = (set, args) => {
    if (!set || !set.size) return;
    for (const entry of [...set]) {
      try {
        entry.fn(...args);
      } catch (err) {
        console.error(`[daybook] listener for "${event}" failed:`, err);
      }
    }
  };
  call(listeners.get(event), [payload, event]);
  if (event !== '*') call(listeners.get('*'), [event, payload]);
}

/** Shared app state. `date` is the "working date" (Today sets it; quick-add uses it). */
export const state = { date: localTodayKey() };

/** Convenience: set the working date and emit 'state:date' (only when it changes). */
export function setWorkingDate(date) {
  if (!date || date === state.date) return;
  state.date = date;
  emit('state:date', { date });
}
