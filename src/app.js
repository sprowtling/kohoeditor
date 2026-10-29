// The page shell: opening a world, switching views, and saving changes.

import { h, clear, toast, confirmBox, formatBytes, fmt, DIM_NAMES, nickname } from './ui.js';
import { PlayersView } from './views/players.js';
import { MapView } from './views/map.js';
import { RecordsView } from './views/records.js';
import { WorldView } from './views/world.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Talking to the worker

let worker = null;
let nextId = 1;
const waiting = new Map();

function startWorker() {
  worker?.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, result, error, progress, label } = e.data;
    const w = waiting.get(id);
    if (!w) return;
    if (progress !== undefined) { w.onProgress?.(progress, label); return; }
    waiting.delete(id);
    if (error) w.reject(new Error(error)); else w.resolve(result);
  };
  worker.onerror = (e) => {
    const msg = e.message || 'The background reader stopped unexpectedly.';
    for (const w of waiting.values()) w.reject(new Error(msg));
    waiting.clear();
  };
}

// What to say while something slow is happening. Anything not listed here
// either has its own progress screen (opening, saving) or is always quick.
const BUSY_LABELS = {
  copyChunks: 'Copying chunks',
  pasteChunks: 'Pasting chunks',
  deleteChunks: 'Marking chunks to regenerate',
  restoreChunks: 'Putting chunks back',
  undoOperation: 'Undoing',
  loadClipboard: 'Opening the chunk file',
  clipboardFile: 'Saving the chunk file',
  chunkList: 'Updating the map',
  players: 'Reading players',
  setItem: 'Saving', editRecord: 'Saving', editLevelDat: 'Saving', deleteRecord: 'Saving', revertRecord: 'Undoing',
};

// A screen-covering "working on it" panel for slow calls. It appears only if a
// call takes more than a moment, shows progress when the worker reports it,
// and blocks clicks meanwhile so nothing gets queued up twice by accident.
const busy = {
  calls: new Map(),
  el: null,
  start(id, label) {
    this.calls.set(id, { label, progress: null, since: performance.now() });
    setTimeout(() => this.render(), 250);
  },
  progress(id, value) {
    const c = this.calls.get(id);
    if (c) { c.progress = value; this.render(); }
  },
  end(id) {
    this.calls.delete(id);
    this.render();
  },
  render() {
    const shown = [...this.calls.values()].filter((c) => performance.now() - c.since >= 240);
    if (!shown.length) { this.el?.remove(); this.el = null; return; }
    const c = shown[shown.length - 1];
    if (!this.el) {
      this.el = h('div', { class: 'busy-back' }, h('div', { class: 'busy' },
        h('div', { class: 'busy-label' }), h('div', { class: 'bar' }, h('div', { class: 'bar-fill' })), h('div', { class: 'busy-note muted small-text' })));
      document.body.append(this.el);
    }
    this.el.querySelector('.busy-label').textContent = `${c.label}…`;
    const fill = this.el.querySelector('.bar-fill');
    const bar = this.el.querySelector('.bar');
    bar.classList.toggle('indeterminate', c.progress == null);
    if (c.progress != null) fill.style.width = `${Math.round(c.progress * 100)}%`;
    this.el.querySelector('.busy-note').textContent = c.progress != null ? `${Math.round(c.progress * 100)}%` : 'This can take a little while on a big world.';
  },
};

function call(method, args, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const label = BUSY_LABELS[method];
    if (label) busy.start(id, label);
    const done = (fn) => (v) => { if (label) busy.end(id); fn(v); };
    const progress = (v, l) => { if (label) busy.progress(id, v); onProgress?.(v, l); };
    waiting.set(id, { resolve: done(resolve), reject: done(reject), onProgress: progress });
    worker.postMessage({ id, method, args });
  });
}

// ---------------------------------------------------------------------------
// Shared app context for the views

const app = {
  call,
  info: null,
  players: [],
  views: {},
  current: null,
  async refreshPending() {
    const p = await call('pending');
    app.pendingState = p;
    const count = p.count;
    $('pending-count').textContent = fmt(count);
    $('pending-word').textContent = count === 1 ? 'change' : 'changes';
    $('save-world').disabled = p.total === 0;
    if (!$('pending-drawer').hidden) renderPending();
    for (const v of Object.values(app.views)) v.onPendingChanged?.(p);
  },
  async reloadPlayers() {
    app.players = await call('players');
    return app.players;
  },
  show(tab, opts) {
    for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const name of Object.keys(app.views)) $('view-' + name).hidden = name !== tab;
    app.current = tab;
    app.views[tab].onShow?.(opts);
  },
  showRecord(key) { app.show('records', { key }); },
  showChunk(dim, x, z) { app.show('map', { dim, x, z }); },
  showPlayer(key) { app.show('players', { key }); },
};

// ---------------------------------------------------------------------------
// Opening a world

function setLoading(label, value, detail = '') {
  $('landing').hidden = true;
  $('app').hidden = true;
  $('loading').hidden = false;
  $('loading-label').textContent = label;
  $('loading-bar').style.width = `${Math.round((value ?? 0) * 100)}%`;
  $('loading-detail').textContent = detail;
}

async function openWorld(source) {
  startWorker();
  try {
    setLoading('Opening the world', 0.02, source.mcworld ? source.mcworld.name : `${fmt(source.files.length)} files`);
    let opened = await call('open', source);
    if (opened.info.roots.length > 1) {
      const root = await chooseRoot(opened.info.roots);
      if (root == null) { backToLanding(); return; }
      opened = await call('open', { ...source, root });
    }
    app.info = opened.info;
    const sizeNote = `${formatBytes(app.info.tableBytes)} of world data in ${fmt(app.info.tableCount)} files`;
    setLoading('Reading the world', 0.03, sizeNote);
    const scan = await call('scan', null, (p) => setLoading('Reading the world', p, sizeNote));
    app.stats = scan.stats;
    console.info(`Scanned ${fmt(scan.stats.keys)} records in ${(scan.ms / 1000).toFixed(1)} s${scan.parallel ? ` using several threads (final pass ${(scan.mergeMs / 1000).toFixed(1)} s)` : ''}`);
    setLoading('Reading players', 1, '');
    await app.reloadPlayers();
    showApp();
  } catch (e) {
    console.error(e);
    backToLanding();
    toast(e.message, true);
  }
}

function chooseRoot(roots) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' },
      h('div', { class: 'modal' },
        h('h2', {}, 'This folder has more than one world'),
        h('p', {}, 'Which one would you like to open?'),
        h('div', { style: { display: 'grid', gap: '6px' } },
          roots.map((r) => h('button', { onclick: () => { back.remove(); resolve(r); } }, r || '(the folder itself)'))),
        h('div', { class: 'row' }, h('button', { onclick: () => { back.remove(); resolve(null); } }, 'Cancel'))));
    document.body.append(back);
  });
}

function backToLanding() {
  $('loading').hidden = true;
  $('app').hidden = true;
  $('tabs').hidden = true;
  $('pending-button').hidden = true;
  $('landing').hidden = false;
}

function showApp() {
  $('loading').hidden = true;
  $('landing').hidden = true;
  $('app').hidden = false;
  $('tabs').hidden = false;
  $('pending-button').hidden = false;
  $('world-title').textContent = app.info.levelName ?? '';
  document.title = `${app.info.levelName ?? 'World'} · Koho Editor`;
  for (const [name, View] of Object.entries({ players: PlayersView, map: MapView, records: RecordsView, world: WorldView })) {
    app.views[name] = new View($('view-' + name), app);
  }
  app.refreshPending();
  app.show('players');
}

$('pick-mcworld').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openWorld({ mcworld: f });
});

$('pick-folder').addEventListener('change', (e) => {
  const files = [...e.target.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
  e.target.value = '';
  if (files.length) openWorld({ files });
});

const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const items = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (items.length === 1 && items[0].isFile) {
    items[0].file((f) => openWorld({ mcworld: f }));
    return;
  }
  setLoading('Collecting files', 0, '');
  try {
    const files = [];
    for (const entry of items) await collectEntry(entry, '', files);
    openWorld({ files });
  } catch (err) {
    backToLanding();
    toast(`Could not read the dropped folder: ${err.message}`, true);
  }
});

async function collectEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: prefix + entry.name, file });
    return;
  }
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const child of batch) await collectEntry(child, prefix + entry.name + '/', out);
  }
}

// ---------------------------------------------------------------------------
// Tabs, pending changes, saving

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) app.show(b.dataset.tab);
});

$('open-pending').addEventListener('click', () => { $('pending-drawer').hidden = false; renderPending(); });
$('close-pending').addEventListener('click', () => { $('pending-drawer').hidden = true; });

function renderPending() {
  const p = app.pendingState;
  const body = $('pending-body');
  if (!p || p.total === 0) {
    clear(body, h('p', { class: 'muted' }, 'Nothing has been changed yet.'));
    return;
  }
  const go = (fn) => () => { $('pending-drawer').hidden = true; fn(); };
  const undo = (o) => async () => {
    await call('undoOperation', { id: o.id });
    await app.reloadPlayers();
    await app.refreshPending();
    toast('Undone.');
  };
  const view = (o) => {
    if (o.type === 'delete') return h('button', { class: 'small', onclick: go(() => app.show('map', { dim: o.dim })) }, 'Map');
    if (o.type === 'paste') return h('button', { class: 'small', onclick: go(() => app.showChunk(o.dim, o.at[0], o.at[1])) }, 'Map');
    if (o.type === 'leveldat') return h('button', { class: 'small', onclick: go(() => app.show('world')) }, 'View');
    return h('button', { class: 'small', onclick: go(() => app.showRecord(o.key)) }, 'View');
  };
  // Player records read better under the names you've given them.
  const label = (o) => {
    const player = o.type === 'record' && app.players.find((x) => x.key === o.key);
    return player ? o.label.replace(/:.*$/, `: ${nickname(player)}`) : o.label;
  };
  clear(body,
    h('div', { class: 'card' },
      p.operations.map((o) => h('div', { class: 'change' },
        h('span', { class: 'what', title: o.label }, label(o)),
        view(o),
        h('button', { class: 'small', onclick: undo(o) }, 'Undo')))),
    h('p', { class: 'muted small-text' }, `${fmt(p.total)} database entr${p.total === 1 ? 'y' : 'ies'} will be written in total. Undo works on each change by itself, newest or oldest.`));
}

$('save-world').addEventListener('click', async () => {
  const p = app.pendingState;
  if (!p || p.total === 0) { toast('There are no changes to save yet.'); return; }
  const chunkCount = p.chunks.reduce((a, b) => a + b, 0);
  const pastedCount = p.pasted.reduce((a, b) => a + b, 0);
  const ok = await confirmBox({
    title: 'Save the edited world',
    body: [
      'This builds a new .mcworld file with your changes in it. Your original files stay exactly as they are.',
      chunkCount ? `${fmt(chunkCount)} chunk${chunkCount === 1 ? '' : 's'} will regenerate from the seed the next time someone goes near them.` : null,
      pastedCount ? `${fmt(pastedCount)} pasted chunk${pastedCount === 1 ? '' : 's'} will be written in.` : null,
      'Open the new file in Minecraft once before uploading it, to check everything looks right.',
    ].filter(Boolean),
    ok: 'Build .mcworld',
  });
  if (!ok) return;
  const overlay = h('div', { class: 'modal-back' }, h('div', { class: 'modal' },
    h('h2', {}, 'Building your world file'),
    h('div', { class: 'bar' }, h('div', { class: 'bar-fill' })),
    h('p', { class: 'muted save-step' }, 'This can take a minute for a big world.')));
  document.body.append(overlay);
  const fill = overlay.querySelector('.bar-fill');
  const step = overlay.querySelector('.save-step');
  try {
    const bar = overlay.querySelector('.bar');
    const out = await call('exportWorld', null, (v, label) => {
      // Writing the changes is one step with no progress to report; packing reports as it goes.
      const measured = label !== 'Writing your changes';
      bar.classList.toggle('indeterminate', !measured);
      fill.style.width = `${Math.round(v * 100)}%`;
      if (label) step.textContent = measured ? `${label}… ${Math.round(v * 100)}%` : `${label}…`;
    });
    const url = URL.createObjectURL(out.blob);
    const name = `${(app.info.levelName || 'world').replace(/[\\/:*?"<>|]+/g, '_')} (edited).mcworld`;
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    overlay.remove();
    toast(`Saved ${name} (${formatBytes(out.blob.size)}).`);
  } catch (e) {
    overlay.remove();
    toast(`Saving failed: ${e.message}`, true);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (app.pendingState?.total) { e.preventDefault(); e.returnValue = ''; }
});

// Handy for poking at things from the browser console (and for the browser tests).
window.__kohoApp = app;

export { app };
