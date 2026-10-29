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

// Small per-viewer settings kept in this browser only.
export const notes = {
  get(key) {
    try { return JSON.parse(localStorage.getItem('koho:' + key) ?? 'null'); } catch { return null; }
  },
  set(key, value) {
    try {
      if (value == null || value === '') localStorage.removeItem('koho:' + key);
      else localStorage.setItem('koho:' + key, JSON.stringify(value));
    } catch { /* storage may be unavailable; this just won't be remembered */ }
  },
};

// ---------------------------------------------------------------------------
// Player names: who each player id belongs to, remembered in this browser and
// shared across every world opened here. Can be imported from and exported to
// a spreadsheet (CSV), so the list is never only in one place.

const normalizeId = (s) => String(s ?? '').trim().toLowerCase().replace(/^player_server_/, '').replace(/^player_/, '');

function loadNames() {
  const store = notes.get('names') ?? {};
  // Nicknames saved by the first version were kept one per key.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('koho:nick:')) {
        const id = normalizeId(k.slice('koho:nick:'.length));
        const name = JSON.parse(localStorage.getItem(k));
        if (name && !store[id]) store[id] = { name };
      }
    }
  } catch { /* nothing to bring over */ }
  return store;
}

let namesCache = null;
export const names = {
  all() { return (namesCache ??= loadNames()); },
  save() { notes.set('names', namesCache); },
  // The ids a player can be known by: their server id, Microsoft account id and self-signed id.
  idsOf(p) {
    const ids = [normalizeId(p.id)];
    if (p.link?.msaId) ids.push(normalizeId(p.link.msaId));
    if (p.link?.selfSignedId) ids.push(normalizeId(p.link.selfSignedId));
    return ids.filter(Boolean);
  },
  lookup(p) {
    const all = names.all();
    for (const id of names.idsOf(p)) if (all[id]) return all[id];
    return null;
  },
  set(p, fields) {
    const all = names.all();
    const id = names.idsOf(p).find((i) => all[i]) ?? normalizeId(p.id);
    const entry = { ...(all[id] ?? {}), ...fields };
    for (const k of Object.keys(entry)) if (entry[k] == null || entry[k] === '') delete entry[k];
    if (p.link?.msaId) entry.msa = p.link.msaId;
    if (Object.keys(entry).filter((k) => k !== 'msa').length) all[id] = entry; else delete all[id];
    names.save();
  },
  // rows: arrays of cells from a CSV. Returns { added, updated, skipped }.
  importRows(rows) {
    const all = names.all();
    let idCol = -1, nameCol = -1, notesCol = -1, start = 0;
    const head = (rows[0] ?? []).map((c) => c.toLowerCase());
    const find = (re) => head.findIndex((c) => re.test(c));
    if (head.some((c) => /name|nick|gamertag|who/.test(c)) && head.some((c) => /id|uuid|tag|xuid|msa|key/.test(c))) {
      nameCol = find(/nick|gamertag|name|who/);
      idCol = head.findIndex((c, i) => i !== nameCol && /id|uuid|tag|xuid|msa|key/.test(c));
      notesCol = find(/note|comment|reason|info/);
      start = 1;
    }
    const looksLikeId = (c) => /^(player_server_|player_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.trim()) || /^player_/i.test(c.trim()) || /^\d{10,20}$/.test(c.trim());
    let added = 0, updated = 0, skipped = 0;
    for (const row of rows.slice(start)) {
      const cells = row.map((c) => c.trim());
      let ic = idCol, nc = nameCol;
      if (ic < 0) ic = cells.findIndex(looksLikeId);
      if (nc < 0) nc = cells.findIndex((c, i) => i !== ic && c && !looksLikeId(c));
      const id = normalizeId(cells[ic]);
      const name = cells[nc];
      if (!id || !name) { skipped++; continue; }
      const note = notesCol >= 0 ? cells[notesCol] : idCol < 0 ? cells.filter((c, i) => i !== ic && i !== nc && c).join(' · ') : '';
      const entry = { ...(all[id] ?? {}), name };
      if (note) entry.notes = note;
      if (all[id]) updated++; else added++;
      all[id] = entry;
    }
    names.save();
    return { added, updated, skipped };
  },
  toCsv() {
    const esc = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? ''));
    const lines = ['id,nickname,notes,microsoft account id'];
    for (const [id, e] of Object.entries(names.all())) lines.push([id, e.name ?? '', e.notes ?? '', e.msa ?? ''].map(esc).join(','));
    return lines.join('\n') + '\n';
  },
};

export function nickname(p) {
  const n = names.lookup(p)?.name;
  if (n) return n;
  if (p.id === 'local') return 'Local player';
  return `Player ${p.id.slice(0, 8)}`;
}

// A forgiving CSV reader: quoted cells, commas or semicolons or tabs.
export function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].map((s) => [s, firstLine.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
