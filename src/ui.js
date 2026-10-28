// Small DOM helpers shared by the views.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

let toastTimer = null;
export function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 3500);
}

export function confirmBox({ title, body, ok = 'OK', danger = false, cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    const close = (v) => { back.remove(); resolve(v); };
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(false); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('h2', {}, title),
        ...(Array.isArray(body) ? body : [body]).map((b) => (typeof b === 'string' ? h('p', {}, b) : b)),
        h('div', { class: 'row' },
          cancel ? h('button', { onclick: () => close(false) }, cancel) : null,
          h('button', { class: danger ? 'danger' : 'primary', onclick: () => close(true) }, ok))));
    document.body.append(back);
    back.querySelector('.modal .row button:last-child').focus();
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(false); });
  });
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const fmt = (n) => Number(n).toLocaleString();

export const DIM_NAMES = ['Overworld', 'Nether', 'The End'];

export function coords(pos) {
  if (!pos) return '—';
  return pos.map((v) => Math.floor(v)).join(', ');
}

// Per-viewer notes (player nicknames) kept in this browser only.
export const notes = {
  get(key) {
    try { return JSON.parse(localStorage.getItem('koho:' + key) ?? 'null'); } catch { return null; }
  },
  set(key, value) {
    try {
      if (value == null || value === '') localStorage.removeItem('koho:' + key);
      else localStorage.setItem('koho:' + key, JSON.stringify(value));
    } catch { /* storage may be unavailable; nicknames just won't persist */ }
  },
};
