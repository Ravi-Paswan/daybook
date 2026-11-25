// Delete with an "Undo" toast (SPEC 3.6).
//
// Extras beyond the spec:
//   - options.files: file-store ids (photos/screenshots) that belong to the record. They are only deleted once
//     the undo window has closed without Undo, so undoing restores the record *and* its images.
//   - options.duration (default 6000 ms) controls how long Undo is offered.
//   - Resolves to { record, undo(), undone: Promise<boolean> } (null when record is missing).

import { db, keyPathOf } from './db.js';
import { toast } from './ui.js';

export async function removeWithUndo(store, record, { label = 'Entry deleted', onUndo, files = [], duration = 6000 } = {}) {
  if (!record) return null;
  const key = record[keyPathOf(store)];
  if (key === undefined || key === null || key === '') throw new Error(`removeWithUndo("${store}"): record has no key`);
  const snapshot = { ...record };
  await db.delete(store, key);

  let settled = false;
  let resolveUndone;
  const undone = new Promise((r) => {
    resolveUndone = r;
  });

  const finish = (wasUndone) => {
    if (settled) return;
    settled = true;
    resolveUndone(wasUndone);
    if (!wasUndone && files && files.length) {
      import('./images.js')
        .then((m) => Promise.all(files.filter(Boolean).map((id) => m.deleteImage(id))))
        .catch((err) => console.warn('[daybook] could not clean up images', err));
    }
  };

  async function undo() {
    if (settled) return false;
    settled = true;
    try {
      await db.put(store, snapshot, { touch: false });
      resolveUndone(true);
      toast('Restored', { type: 'success', duration: 1800 });
      if (typeof onUndo === 'function') await onUndo(snapshot);
      return true;
    } catch (err) {
      console.error('[daybook] undo failed', err);
      toast('Couldn’t restore that entry.', { type: 'error' });
      resolveUndone(false);
      return false;
    }
  }

  toast(label, {
    type: 'info',
    duration,
    action: { label: 'Undo', onClick: undo },
    onClose: (reason) => {
      if (reason !== 'action') finish(false);
    },
  });

  return { record: snapshot, undo, undone };
}
