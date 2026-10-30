// Art: every map in the world as a picture, with names, notes and tags,
// where each copy is, PNG export, and murals (walls of maps in item frames)
// put back together.

import { h, clear, toast, confirmBox, fmt, notes, DIM_NAMES } from '../ui.js';
import { whereRow, whereText } from './where.js';
import { buildZip } from '../lib/zip.js';
import { crc32 } from '../lib/crc.js';

const FILTERS = [
  ['all', 'All maps'],
  ['likely', 'Likely art (locked, drawn on)'],
  ['art', 'Tagged: art'],
  ['keep', 'Tagged: keep'],
  ['discard', 'Tagged: discard'],
  ['untagged', 'Not tagged yet'],
  ['unlocked', 'Unlocked (exploration maps)'],
  ['blank', 'Blank or nearly blank'],
  ['dupes', 'Has duplicates'],
  ['loose', 'Not held anywhere'],
];
const TAGS = [['art', 'Art'], ['keep', 'Keep'], ['discard', 'Discard']];
const FACING = ['ceiling', 'floor', 'wall facing north', 'wall facing south', 'wall facing west', 'wall facing east'];

const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

function imageCanvas(rgba, w = 128, h = 128, scale = 1) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  if (scale === 1) return c;
  const big = document.createElement('canvas');
  big.width = w * scale; big.height = h * scale;
  const ctx = big.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, 0, 0, big.width, big.height);
  return big;
}

const pngBytes = (canvas) => new Promise((resolve) => canvas.toBlob(async (b) => resolve(new Uint8Array(await b.arrayBuffer())), 'image/png'));

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function askScale(title) {
  return new Promise((resolve) => {
    const close = (v) => { back.remove(); resolve(v); };
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(null); } },
      h('div', { class: 'modal' },
        h('h2', {}, title),
        h('p', {}, 'Maps are 128 × 128 pixels. Bigger copies keep every pixel crisp, which looks better on a screen or in print.'),
        h('div', { class: 'row' },
          h('button', { onclick: () => close(null) }, 'Cancel'),
          [1, 4, 8].map((s) => h('button', { class: s === 4 ? 'primary' : '', onclick: () => close(s) }, s === 1 ? 'Original size' : `${s}× bigger`)))));
    document.body.append(back);
  });
}

export class ArtView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.sub = 'maps';
    this.filter = notes.get('art:filter') ?? 'all';
    this.query = '';
    this.selected = null;
    this.images = new Map(); // id -> RGBA bytes
    this.labels = notes.get('maps') ?? {};
    this.content = h('div', { class: 'content art-content' });
    this.side = h('div', { class: 'map-side art-side' });
    clear(el, this.content, this.side);
    clear(this.content, h('div', { class: 'empty' }, 'Open this tab to look through the maps in this world.'));
    this.observer = new IntersectionObserver((entries) => this.onVisible(entries), { root: this.content, rootMargin: '400px' });
  }

  async onShow() {
    if (!this.maps) await this.load();
    else this.render();
  }

  async onPendingChanged() {
    if (this.maps && !this.el.hidden) await this.load();
    else this.maps = null; // reload next time the tab is opened
  }

  async load() {
    try {
      const [maps, items] = [await this.app.call('mapList'), await this.app.call('items')];
      this.maps = maps;
      this.refs = items.maps;
      this.byHash = new Map();
      for (const m of maps) if (m.hash) { if (!this.byHash.has(m.hash)) this.byHash.set(m.hash, []); this.byHash.get(m.hash).push(m.id); }
      this.murals = null;
      this.render();
    } catch (e) {
      clear(this.content, h('div', { class: 'card' }, `Couldn't read the maps: ${e.message}`));
    }
  }

  label(id) { return this.labels[id] ?? {}; }
  setLabel(id, fields) {
    const next = { ...this.label(id), ...fields };
    for (const k of Object.keys(next)) if (!next[k]) delete next[k];
    if (Object.keys(next).length) this.labels[id] = next; else delete this.labels[id];
    notes.set('maps', this.labels);
  }
  title(m) { return this.label(m.id).name || `Map ${m.id}`; }

  shown() {
    const q = this.query;
    return this.maps.filter((m) => {
      const l = this.label(m.id);
      if (q && !`${l.name ?? ''} ${l.notes ?? ''} ${m.id}`.toLowerCase().includes(q)) return false;
      switch (this.filter) {
        case 'likely': return m.locked && m.drawn > 0.05;
        case 'art': case 'keep': case 'discard': return l.tag === this.filter;
        case 'untagged': return !l.tag;
        case 'unlocked': return !m.locked;
        case 'blank': return m.drawn < 0.02;
        case 'dupes': return (this.byHash.get(m.hash)?.length ?? 0) > 1;
        case 'loose': return !(this.refs[m.id]?.length);
        default: return true;
      }
    }).sort((a, b) => (this.label(b.id).tag === 'art') - (this.label(a.id).tag === 'art') || b.locked - a.locked || b.drawn - a.drawn);
  }

  render() {
    if (!this.maps) return;
    const tabs = h('div', { class: 'seg' },
      h('button', { class: this.sub === 'maps' ? 'active' : '', onclick: () => { this.sub = 'maps'; this.render(); } }, `Maps (${fmt(this.maps.length)})`),
      h('button', { class: this.sub === 'murals' ? 'active' : '', onclick: () => { this.sub = 'murals'; this.render(); } }, 'Murals'));
    if (this.sub === 'murals') { this.renderMurals(tabs); return; }
    const list = this.shown();
    const filter = h('select', { onchange: (e) => { this.filter = e.target.value; notes.set('art:filter', this.filter); this.render(); } },
      FILTERS.map(([v, t]) => h('option', { value: v, selected: v === this.filter }, t)));
    const search = h('input', { type: 'search', placeholder: 'Search names and notes', value: this.query, oninput: (e) => { this.query = e.target.value.toLowerCase(); this.renderGrid(); } });
    this.grid = h('div', { class: 'art-grid' });
    clear(this.content,
      h('div', { class: 'row art-bar' }, tabs, filter, search, h('span', { class: 'spacer' }),
        h('span', { class: 'muted small-text', id: 'art-count' }),
        h('button', { onclick: () => this.exportZip(this.shown()) }, 'Download shown as PNGs'),
        h('button', { onclick: () => this.exportLabels() }, 'Download list (CSV)'),
        h('button', { class: 'danger', onclick: () => this.deleteShown() }, 'Delete shown…')),
      this.grid);
    this.renderGrid(list);
    this.renderSide();
  }

  renderGrid(list = this.shown()) {
    this.observer.disconnect();
    const count = this.content.querySelector('#art-count');
    if (count) count.textContent = `${fmt(list.length)} shown`;
    if (!list.length) { clear(this.grid, h('div', { class: 'empty' }, this.maps.length ? 'No maps match.' : 'This world has no maps.')); return; }
    clear(this.grid, list.map((m) => {
      const canvas = this.images.has(m.id) ? imageCanvas(this.images.get(m.id)) : imageCanvas(m.thumb, 32, 32);
      canvas.dataset.id = m.id;
      if (!this.images.has(m.id)) this.observer.observe(canvas);
      const l = this.label(m.id);
      const held = this.refs[m.id]?.length ?? 0;
      const dupes = (this.byHash.get(m.hash)?.length ?? 1) - 1;
      return h('button', { class: 'art-card' + (this.selected === m.id ? ' active' : '') + (l.tag ? ' tag-' + l.tag : ''), onclick: () => { this.selected = m.id; this.renderGrid(); this.renderSide(); } },
        canvas,
        h('div', { class: 'art-name' }, this.title(m)),
        h('div', { class: 'art-badges' },
          m.locked ? h('span', { class: 'badge' }, 'locked') : null,
          l.tag ? h('span', { class: 'badge ok' }, l.tag) : null,
          held ? h('span', { class: 'badge' }, `${held} held`) : h('span', { class: 'badge warn' }, 'not held'),
          dupes ? h('span', { class: 'badge' }, `+${dupes} copies`) : null));
    }));
  }

  // Full pictures for cards as they scroll into view, a batch at a time.
  onVisible(entries) {
    for (const e of entries) if (e.isIntersecting) { (this.want ??= new Set()).add(e.target.dataset.id); this.observer.unobserve(e.target); }
    if (this.loadingImages || !this.want?.size) return;
    this.loadingImages = true;
    const ids = [...this.want].slice(0, 48);
    ids.forEach((id) => this.want.delete(id));
    this.app.call('mapImages', { ids }).then((imgs) => {
      ids.forEach((id, i) => {
        if (!imgs[i]) return;
        this.images.set(id, imgs[i]);
        const old = this.grid?.querySelector(`canvas[data-id="${CSS.escape(id)}"]`);
        if (old) { const c = imageCanvas(imgs[i]); c.dataset.id = id; old.replaceWith(c); }
      });
    }).finally(() => { this.loadingImages = false; if (this.want.size) this.onVisible([]); });
  }

  async imageOf(id) {
    if (!this.images.has(id)) {
      const [img] = await this.app.call('mapImages', { ids: [id] });
      if (img) this.images.set(id, img);
    }
    return this.images.get(id);
  }

  async renderSide() {
    const m = this.maps.find((x) => x.id === this.selected);
    if (!m) {
      const counts = { locked: this.maps.filter((x) => x.locked).length, loose: this.maps.filter((x) => !(this.refs[x.id]?.length)).length };
      clear(this.side, h('div', { class: 'card' },
        h('h3', {}, 'Maps in this world'),
        h('p', { class: 'small-text', style: { marginTop: 0 } }, `${fmt(this.maps.length)} maps: ${fmt(counts.locked)} locked (map art is usually locked), ${fmt(counts.loose)} not held anywhere.`),
        h('p', { class: 'muted small-text' }, 'Click a map to see it full size, name it, tag it, and see where every copy is. Names, notes and tags are kept in this browser (Download list keeps a copy).'),
        h('p', { class: 'muted small-text', style: { marginBottom: 0 } }, '"Held" counts copies in item frames, chests and inventories. Deleting a map that is still held leaves those copies blank, so clear out maps that aren\'t held, or that you\'re sure are junk.')));
      return;
    }
    const l = this.label(m.id);
    const big = h('div', { class: 'art-big' });
    const name = h('input', { type: 'text', value: l.name ?? '', placeholder: `Map ${m.id}`, onchange: (e) => { this.setLabel(m.id, { name: e.target.value.trim() }); this.renderGrid(); } });
    const noteBox = h('textarea', { rows: 3, placeholder: 'Notes: who made it, what it shows, where it should go…', onchange: (e) => this.setLabel(m.id, { notes: e.target.value.trim() }) });
    noteBox.value = l.notes ?? '';
    const refs = this.refs[m.id] ?? [];
    const dupes = (this.byHash.get(m.hash) ?? []).filter((id) => id !== m.id);
    clear(this.side,
      h('div', { class: 'card' },
        big,
        h('label', { class: 'field' }, h('span', { class: 'k' }, 'Name'), name),
        h('label', { class: 'field', style: { marginTop: '8px' } }, h('span', { class: 'k' }, 'Notes'), noteBox),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          TAGS.map(([t, label]) => h('button', { class: 'small' + (l.tag === t ? ' primary' : ''), onclick: () => { this.setLabel(m.id, { tag: l.tag === t ? null : t }); this.renderGrid(); this.renderSide(); } }, label))),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { onclick: async () => { const s = await askScale('Download this map'); if (s) download(new Blob([await pngBytes(imageCanvas(await this.imageOf(m.id), 128, 128, s))]), `${safeName(this.title(m))}.png`); } }, 'Download PNG'),
          h('button', { onclick: () => this.app.showRecord(m.key) }, 'Raw NBT'))),
      h('div', { class: 'card' },
        h('h3', {}, refs.length ? `Where it is (${refs.length})` : 'Where it is'),
        refs.length ? refs.map((loc) => whereRow(loc, this.app)) : h('p', { class: 'muted small-text', style: { margin: 0 } }, 'No item frame, chest or inventory holds this map.'),
        dupes.length ? [h('h3', { style: { marginTop: '12px' } }, `Same picture (${dupes.length})`),
          h('div', { class: 'row' }, dupes.map((id) => h('button', { class: 'small', onclick: () => { this.selected = id; this.renderGrid(); this.renderSide(); } }, this.title({ id }))))] : null),
      h('div', { class: 'card small-text' },
        h('table', { class: 'kv' },
          h('tr', {}, h('td', {}, 'Map id'), h('td', { class: 'mono' }, m.id)),
          h('tr', {}, h('td', {}, 'Locked'), h('td', {}, m.locked ? 'Yes' : 'No')),
          h('tr', {}, h('td', {}, 'Drawn on'), h('td', {}, `${Math.round(m.drawn * 100)}%`)),
          h('tr', {}, h('td', {}, 'Made at'), h('td', {}, `${m.center.join(', ')} (${DIM_NAMES[m.dim] ?? m.dim}), zoom ${m.scale}`))),
        h('button', { class: 'danger small', style: { marginTop: '10px' }, onclick: () => this.deleteMaps([m]) }, 'Delete this map…')));
    big.append(imageCanvas(await this.imageOf(m.id) ?? m.thumb, this.images.has(m.id) ? 128 : 32, this.images.has(m.id) ? 128 : 32));
  }

  async deleteMaps(list) {
    if (!list.length) { toast('No maps to delete.'); return; }
    const held = list.filter((m) => this.refs[m.id]?.length);
    const tagged = list.filter((m) => ['art', 'keep'].includes(this.label(m.id).tag));
    const ok = await confirmBox({
      title: `Delete ${fmt(list.length)} map${list.length === 1 ? '' : 's'}?`,
      body: [
        held.length ? `${fmt(held.length)} of these are still held somewhere (in frames, chests or inventories); those copies will turn blank.` : 'None of these are held anywhere.',
        tagged.length ? `${fmt(tagged.length)} are tagged art or keep.` : null,
        'Nothing changes until you save the world, and you can undo this before then.',
      ].filter(Boolean),
      ok: 'Delete', danger: true,
    });
    if (!ok) return;
    await this.app.call('deleteRecords', { keys: list.map((m) => m.key), label: `${fmt(list.length)} map${list.length === 1 ? '' : 's'}` });
    if (list.some((m) => m.id === this.selected)) this.selected = null;
    await this.app.refreshPending();
    toast(`${fmt(list.length)} map${list.length === 1 ? '' : 's'} will be deleted when you save.`);
  }

  deleteShown() { return this.deleteMaps(this.shown()); }

  async exportZip(list) {
    if (!list.length) { toast('No maps to download.'); return; }
    const scale = await askScale(`Download ${fmt(list.length)} map${list.length === 1 ? '' : 's'}`);
    if (!scale) return;
    const entries = [];
    const used = new Set();
    for (let i = 0; i < list.length; i += 48) {
      const batch = list.slice(i, i + 48);
      const imgs = await this.app.call('mapImages', { ids: batch.map((m) => m.id) });
      for (let k = 0; k < batch.length; k++) {
        if (!imgs[k]) continue;
        let name = safeName(this.title(batch[k]));
        if (used.has(name)) name += ` (${batch[k].id})`;
        used.add(name);
        const png = await pngBytes(imageCanvas(imgs[k], 128, 128, scale));
        entries.push({ name: `${name}.png`, method: 0, crc: crc32(png), compSize: png.length, size: png.length, data: png });
      }
    }
    download(new Blob(buildZip(entries), { type: 'application/zip' }), `${safeName(this.app.info.levelName || 'world')} maps.zip`);
    toast(`Downloaded ${fmt(entries.length)} pictures.`);
  }

  exportLabels() {
    const esc = (s) => (/[",\n]/.test(String(s ?? '')) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? ''));
    const rows = [['map id', 'name', 'tag', 'notes', 'locked', 'drawn %', 'held', 'where'].join(',')];
    for (const m of this.maps) {
      const l = this.label(m.id);
      const refs = this.refs[m.id] ?? [];
      rows.push([m.id, l.name ?? '', l.tag ?? '', l.notes ?? '', m.locked ? 'yes' : 'no', Math.round(m.drawn * 100), refs.length, refs.map((r) => whereText(r, this.app)).join(' | ')].map(esc).join(','));
    }
    download(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), `${safeName(this.app.info.levelName || 'world')} maps.csv`);
  }

  // ---- Murals

  async renderMurals(tabs) {
    clear(this.content, h('div', { class: 'row art-bar' }, tabs), h('div', { class: 'empty' }, 'Looking for walls of maps…'));
    if (!this.murals) this.murals = await this.app.call('murals');
    const ids = [...new Set(this.murals.flatMap((m) => m.tiles.map((t) => t.mapId)))].filter((id) => !this.images.has(id));
    for (let i = 0; i < ids.length; i += 48) {
      const batch = ids.slice(i, i + 48);
      const imgs = await this.app.call('mapImages', { ids: batch });
      batch.forEach((id, k) => { if (imgs[k]) this.images.set(id, imgs[k]); });
    }
    const muralKey = (m) => `${m.dim}:${m.pos.join(',')}`;
    clear(this.content,
      h('div', { class: 'row art-bar' }, tabs, h('span', { class: 'muted small-text' }, this.murals.length ? `${fmt(this.murals.length)} wall${this.murals.length === 1 ? '' : 's'} of two or more maps in item frames, put back together.` : '')),
      this.murals.length ? h('div', { class: 'mural-list' }, this.murals.map((m) => {
        const l = this.labels['mural:' + muralKey(m)] ?? {};
        const name = h('input', { type: 'text', value: l.name ?? '', placeholder: `Mural at ${m.pos.join(', ')}`, onchange: (e) => this.setLabel('mural:' + muralKey(m), { name: e.target.value.trim() }) });
        return h('div', { class: 'card mural' },
          this.muralCanvas(m, 1, true),
          h('div', { class: 'mural-info' },
            name,
            h('div', { class: 'muted small-text' }, `${m.width} × ${m.height} maps, ${FACING[m.facing] ?? 'wall'}, at ${m.pos.join(', ')} (${DIM_NAMES[m.dim]})`),
            m.tiles.length < m.width * m.height ? h('div', { class: 'muted small-text' }, `${m.width * m.height - m.tiles.length} gaps in the wall`) : null,
            h('div', { class: 'row', style: { marginTop: '6px' } },
              h('button', { class: 'small', onclick: () => this.app.showChunk(m.dim, Math.floor(m.pos[0] / 16), Math.floor(m.pos[2] / 16)) }, 'Map'),
              h('button', { class: 'small', onclick: async () => { const s = await askScale('Download this mural'); if (s) download(new Blob([await pngBytes(this.muralCanvas(m, s))]), `${safeName(l.name || `Mural at ${m.pos.join(' ')}`)}.png`); } }, 'Download PNG'),
              h('button', { class: 'small', onclick: () => { this.sub = 'maps'; this.query = ''; this.filter = 'all'; this.selected = m.tiles[0].mapId; this.render(); } }, 'Its maps'))));
      })) : h('div', { class: 'empty' }, 'No walls of maps found. Murals are found from maps hung side by side in item frames.'));
    clear(this.side, h('div', { class: 'card small-text' },
      h('h3', {}, 'Murals'),
      h('p', { style: { marginTop: 0 } }, 'Maps hung next to each other in item frames, on the same wall, are put back together as one picture, the way it looks standing in front of it.'),
      h('p', { class: 'muted', style: { marginBottom: 0 } }, 'Each map\'s turn in its frame is followed. If a mural looks scrambled, tell Claude which one; walls with unusual frames can need a tweak.')));
  }

  muralCanvas(m, scale = 1, display = false) {
    const c = document.createElement('canvas');
    c.width = m.width * 128 * scale; c.height = m.height * 128 * scale;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    for (const t of m.tiles) {
      const img = this.images.get(t.mapId);
      if (!img) continue;
      const s = 128 * scale;
      ctx.save();
      ctx.translate(t.u * s + s / 2, t.v * s + s / 2);
      ctx.rotate((t.rotation * Math.PI) / 2);
      ctx.drawImage(imageCanvas(img), -s / 2, -s / 2, s, s);
      ctx.restore();
    }
    if (display) c.className = 'mural-img';
    return c;
  }
}
