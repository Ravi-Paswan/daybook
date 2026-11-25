// Images (SPEC 3.10): compress → store in the 'files' store → lazy thumbnails → full-screen lightbox.
//
// Choices beyond the spec:
//   - Records are { id, blob, type, size, width, height, name, createdAt, updatedAt }.
//   - thumb()/openLightbox()/imageURL() also accept direct sources (a 'blob:'/'data:'/'http(s):'/relative URL or
//     {src}) so previews can be shown before anything is saved (and the style guide never writes to the DB).
//   - thumb(id, {size, onClick, ids, index, alt, onRemove}) — by default opens the lightbox on [ids || id];
//     onRemove adds a small × button (returns a wrapper element in that case).
//   - imagePicker() does not force `capture` (that would hide the gallery on phones; the OS chooser already
//     offers "Take photo"). Pass capture:true for camera-first. onAdd(id, file) is called once per image.
//   - compressImage keeps the original file when it is already small enough and re-encoding would not help;
//     GIF/SVG are stored as-is. WebP is preferred; browsers that can't encode WebP get JPEG (white background).

import { db, uid } from './db.js';
import { on } from './bus.js';
import { h, icon, toast, spinner, pushEscape, lockScroll, unlockScroll, isolate } from './ui.js';

const urlCache = new Map(); // id → object URL
const pending = new Map(); // id → Promise<url|null>

function isDirect(src) {
  if (src && typeof src === 'object' && typeof src.src === 'string') return true;
  return typeof src === 'string' && /^(blob:|data:|https?:|\.{0,2}\/)/i.test(src);
}
const directURL = (src) => (typeof src === 'object' ? src.src : src);

// Revoke cached URLs when files disappear (delete, clear, import).
on('db:change', (p) => {
  if (!p) return;
  if (p.store === '*' || (p.store === 'files' && (p.op === 'clear' || p.op === 'import'))) {
    for (const url of urlCache.values()) URL.revokeObjectURL(url);
    urlCache.clear();
  } else if (p.store === 'files' && p.op === 'delete') {
    for (const k of p.keys || [p.key]) forget(k);
  }
});

function forget(id) {
  const url = urlCache.get(id);
  if (url) URL.revokeObjectURL(url);
  urlCache.delete(id);
  pending.delete(id);
}

// ──────────────────────────────────────────────────────────────────────────── compression

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close && bmp.close() };
    } catch {
      /* fall back to <img> (older Safari, unusual formats) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    if (img.decode) await img.decode();
    else await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('This image couldn’t be read — try a JPEG or PNG.');
  }
}

function makeCanvas(w, hgt) {
  if (typeof OffscreenCanvas === 'function') {
    try {
      const c = new OffscreenCanvas(w, hgt);
      if (typeof c.convertToBlob === 'function' && c.getContext('2d')) return c;
    } catch {
      /* fall through */
    }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  return c;
}

function encode(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((res) => {
    try {
      canvas.toBlob((b) => res(b), type, quality);
    } catch {
      res(null);
    }
  });
}

async function compress(file, { maxSize = 1600, quality = 0.8 } = {}) {
  if (!(file instanceof Blob)) throw new TypeError('Expected an image file');
  if (/^image\/(svg\+xml|gif)$/i.test(file.type)) return { blob: file, width: null, height: null };
  const src = await decode(file);
  try {
    const { width, height } = src;
    if (!width || !height) throw new Error('This image looks empty.');
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const ht = Math.max(1, Math.round(height * scale));
    const canvas = makeCanvas(w, ht);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.source, 0, 0, w, ht);
    let blob = await encode(canvas, 'image/webp', quality);
    if (!blob || blob.type !== 'image/webp') {
      ctx.globalCompositeOperation = 'destination-over'; // JPEG has no alpha: put white behind transparent pixels
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, ht);
      ctx.globalCompositeOperation = 'source-over';
      blob = await encode(canvas, 'image/jpeg', quality);
    }
    if (!blob) return { blob: file, width, height };
    if (scale === 1 && file.size <= blob.size && /^image\/(jpeg|webp|png)$/i.test(file.type)) return { blob: file, width, height };
    return { blob, width: w, height: ht };
  } finally {
    src.close();
  }
}

/** → Blob (WebP, or JPEG where WebP encoding is unavailable), longest side ≤ maxSize. */
export async function compressImage(file, opts = {}) {
  return (await compress(file, opts)).blob;
}

/** Compress + store in 'files' → id. */
export async function saveImage(file, opts = {}) {
  const { blob, width, height } = await compress(file, opts);
  const rec = await db.put('files', {
    id: uid(),
    blob,
    type: blob.type || file.type || 'image/jpeg',
    size: blob.size,
    width,
    height,
    name: (file && file.name) || '',
  });
  return rec.id;
}

/** → object URL for a stored image (cached), or null when it doesn't exist. */
export async function imageURL(id) {
  if (!id) return null;
  if (isDirect(id)) return directURL(id);
  if (urlCache.has(id)) return urlCache.get(id);
  if (pending.has(id)) return pending.get(id);
  const p = db
    .get('files', id)
    .then((rec) => {
      if (pending.get(id) !== p) return urlCache.get(id) || null;
      pending.delete(id);
      if (!rec) return null;
      if (typeof rec.dataUrl === 'string' && !rec.blob) return rec.dataUrl;
      if (!(rec.blob instanceof Blob)) return null;
      const url = URL.createObjectURL(rec.blob);
      urlCache.set(id, url);
      return url;
    })
    .catch((err) => {
      pending.delete(id);
      console.warn('[daybook] could not load image', id, err);
      return null;
    });
  pending.set(id, p);
  return p;
}

export async function deleteImage(id) {
  if (!id || isDirect(id)) return;
  forget(id);
  await db.delete('files', id);
}

// ──────────────────────────────────────────────────────────────────────────── thumbnails

const loaders = new WeakMap();
const io =
  typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            const fn = loaders.get(e.target);
            loaders.delete(e.target);
            if (fn) fn();
          }
        },
        { rootMargin: '240px' }
      )
    : null;

/** thumb(id, {size=72, onClick, ids, index, alt, onRemove}) → <button class="thumb"><img></button> (lazy). */
export function thumb(id, { size = 72, onClick, ids, index, alt = 'Photo', onRemove, label = 'Open photo' } = {}) {
  const img = h('img', { alt, decoding: 'async', draggable: 'false' });
  const btn = h(
    'button.thumb.is-loading',
    {
      type: 'button',
      'aria-label': label,
      style: { '--thumb-size': typeof size === 'number' ? size + 'px' : size },
      onClick: () => {
        if (btn.classList.contains('is-missing')) return;
        if (typeof onClick === 'function') onClick(id);
        else {
          const list = Array.isArray(ids) && ids.length ? ids : [id];
          const at = Number.isInteger(index) ? index : Math.max(0, list.indexOf(id));
          openLightbox(list, at);
        }
      },
    },
    img
  );
  const load = async () => {
    const url = await imageURL(id);
    if (!url) {
      btn.classList.remove('is-loading');
      btn.classList.add('is-missing');
      btn.setAttribute('aria-label', 'Photo unavailable');
      btn.replaceChildren(icon('image', { size: Math.min(24, Math.round((typeof size === 'number' ? size : 72) / 3)) }));
      return;
    }
    img.addEventListener(
      'load',
      () => {
        btn.classList.remove('is-loading');
        btn.classList.add('is-loaded');
      },
      { once: true }
    );
    img.addEventListener('error', () => {
      btn.classList.remove('is-loading');
      btn.classList.add('is-missing');
    }, { once: true });
    img.src = url;
  };
  if (io) {
    loaders.set(btn, load);
    io.observe(btn);
  } else {
    load();
  }
  if (typeof onRemove !== 'function') return btn;
  return h(
    'span.thumb-wrap',
    btn,
    h(
      'button.thumb-remove',
      { type: 'button', 'aria-label': 'Remove photo', onClick: (e) => { e.stopPropagation(); onRemove(id); } },
      icon('x', { size: 14, strokeWidth: 2.5 })
    )
  );
}

// ──────────────────────────────────────────────────────────────────────────── lightbox

/** openLightbox(ids, startIndex=0) — full-screen viewer; ←/→, swipe, Esc, tap backdrop to close. → {close} */
export function openLightbox(ids, startIndex = 0) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return null;
  let i = Math.min(list.length - 1, Math.max(0, Number(startIndex) || 0));
  let token = 0;
  let closed = false;
  const opener = document.activeElement;
  const many = list.length > 1;

  const img = h('img.lightbox-img.is-loading', { alt: '', draggable: 'false' });
  const spin = spinner({ size: 28, class: 'lightbox-spinner' });
  const counter = h('span.lightbox-counter', { 'aria-live': 'polite', hidden: !many });
  const closeBtn = h('button.lightbox-btn', { type: 'button', 'aria-label': 'Close viewer', onClick: () => close() }, icon('x', { size: 22 }));
  const prev = h('button.lightbox-btn.lightbox-nav.lightbox-prev', { type: 'button', 'aria-label': 'Previous photo', onClick: () => go(-1) }, icon('chevron-left', { size: 26 }));
  const next = h('button.lightbox-btn.lightbox-nav.lightbox-next', { type: 'button', 'aria-label': 'Next photo', onClick: () => go(1) }, icon('chevron-right', { size: 26 }));
  const stage = h('div.lightbox-stage', img, spin);
  const el = h(
    'div.lightbox',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo viewer', tabindex: '-1' },
    h('div.lightbox-top', counter, h('span', { style: { flex: '1' } }), closeBtn),
    stage,
    many ? [prev, next] : null
  );

  async function show(dir = 0) {
    const t = ++token;
    counter.textContent = `${i + 1} / ${list.length}`;
    prev.disabled = i === 0;
    next.disabled = i === list.length - 1;
    img.classList.add('is-loading');
    spin.hidden = false;
    const url = await imageURL(list[i]);
    if (t !== token || closed) return;
    if (!url) {
      spin.hidden = true;
      img.removeAttribute('src');
      img.alt = 'This photo is no longer available';
      return;
    }
    img.alt = many ? `Photo ${i + 1} of ${list.length}` : 'Photo';
    const done = () => {
      if (t !== token) return;
      spin.hidden = true;
      img.classList.remove('is-loading', 'from-left', 'from-right');
      if (dir) {
        void img.offsetWidth;
        img.classList.add(dir > 0 ? 'from-right' : 'from-left');
      }
    };
    img.onload = done;
    img.onerror = () => {
      if (t === token) spin.hidden = true;
    };
    img.src = url;
    if (img.complete && img.naturalWidth) done();
  }
  function go(d) {
    const n = i + d;
    if (n < 0 || n >= list.length) return;
    i = n;
    show(d);
  }

  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(1);
    } else if (e.key === 'Tab') {
      const items = [closeBtn, many && !prev.disabled && prev, many && !next.disabled && next].filter(Boolean);
      const at = items.indexOf(document.activeElement);
      e.preventDefault();
      const n = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1) % items.length;
      items[n].focus();
    }
  });
  stage.addEventListener('click', (e) => {
    if (e.target === stage && !moved) close();
  });

  // Swipe: horizontal → prev/next, down → close.
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  let dragging = false;
  let moved = false;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    moved = false;
    sx = e.clientX;
    sy = e.clientY;
    dx = dy = 0;
    img.classList.add('is-dragging');
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - sx;
    dy = e.clientY - sy;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
    const vertical = Math.abs(dy) > Math.abs(dx);
    if (vertical && dy > 0) {
      img.style.transform = `translateY(${dy}px) scale(${Math.max(0.85, 1 - dy / 1200)})`;
      el.style.backgroundColor = `rgba(6, 8, 12, ${Math.max(0.35, 0.94 - dy / 500)})`;
    } else if (!vertical) {
      const edge = (dx > 0 && i === 0) || (dx < 0 && i === list.length - 1);
      img.style.transform = `translateX(${edge ? dx * 0.3 : dx}px)`;
    }
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    img.classList.remove('is-dragging');
    img.style.transform = '';
    el.style.backgroundColor = '';
    if (Math.abs(dy) > Math.abs(dx) && dy > 110) close();
    else if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    setTimeout(() => {
      moved = false;
    }, 0);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  document.body.appendChild(el);
  const restoreInert = isolate(el);
  lockScroll();
  const popEsc = pushEscape(() => close());
  closeBtn.focus({ preventScroll: true });
  show(0);

  function close() {
    if (closed) return;
    closed = true;
    popEsc();
    restoreInert();
    unlockScroll();
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    el.classList.add('is-leaving');
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      el.remove();
    };
    el.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 260);
  }
  return { el, close, go };
}

// ──────────────────────────────────────────────────────────────────────────── picker

/**
 * imagePicker({onAdd(id, file), label='Add photo', multiple=false, capture, variant='secondary', size, icon})
 * → <label class="btn image-picker"> wrapping a visually-hidden file input (keyboard focusable).
 */
export function imagePicker({ onAdd, label = 'Add photo', multiple = false, capture = false, variant = 'secondary', size, icon: iconName = 'camera', accept = 'image/*' } = {}) {
  const inp = h('input.sr-only', {
    type: 'file',
    accept,
    multiple,
    capture: capture === true ? 'environment' : capture || null,
  });
  const ic = icon(iconName, { size: size === 'sm' ? 16 : 18 });
  const text = h('span', label);
  const el = h('label.btn.image-picker', { class: [`btn-${variant}`, size && `btn-${size}`] }, ic, text, inp);
  let busy = false;
  inp.addEventListener('change', async () => {
    const files = Array.from(inp.files || []);
    inp.value = '';
    if (!files.length || busy) return;
    busy = true;
    el.classList.add('is-busy');
    el.setAttribute('aria-busy', 'true');
    const sp = spinner({ size: 16 });
    ic.replaceWith(sp);
    text.textContent = files.length > 1 ? `Adding ${files.length}…` : 'Adding…';
    let added = 0;
    for (const f of files) {
      if (f.type && !f.type.startsWith('image/')) {
        toast('That file isn’t an image.', { type: 'error' });
        continue;
      }
      try {
        const id = await saveImage(f);
        added += 1;
        if (typeof onAdd === 'function') await onAdd(id, f);
      } catch (err) {
        console.error('[daybook] could not add image', err);
        toast((err && err.message) || 'Couldn’t add that photo.', { type: 'error' });
      }
    }
    busy = false;
    el.classList.remove('is-busy');
    el.removeAttribute('aria-busy');
    sp.replaceWith(ic);
    text.textContent = label;
    if (added > 1) toast(`${added} photos added`, { type: 'success', duration: 2000 });
  });
  el.input = inp;
  return el;
}
