// Records: every non-chunk entry in the world database, and any record opened
// from elsewhere (a player, a chunk's block entities, an entity...).

import { h, clear, toast, confirmBox, fmt, formatBytes, DIM_NAMES } from '../ui.js';
import { nbtTree } from './nbtview.js';

const GROUPS = [
  ['player', 'Players'],
  ['playerid', 'Player id links'],
  ['village', 'Villages'],
  ['map', 'Maps'],
  ['structure', 'Structures & ticking areas'],
  ['text', 'World data'],
  ['other', 'Other'],
];

function groupOf(o) {
  if (o.kind === 'player' || o.kind === 'playerid') return o.kind;
  if (o.kind === 'text') {
    if (o.label.startsWith('VILLAGE_')) return 'village';
    if (o.label.startsWith('map_')) return 'map';
    if (o.label.startsWith('structuretemplate') || o.label.startsWith('tickingarea')) return 'structure';
    return 'text';
  }
  return 'other';
}

function hexDump(hex, max = 2048) {
  const lines = [];
  const n = Math.min(hex.length / 2, max);
  for (let o = 0; o < n; o += 16) {
    const bytes = [];
    let ascii = '';
    for (let i = o; i < Math.min(o + 16, n); i++) {
      const b = parseInt(hex.substr(i * 2, 2), 16);
      bytes.push(hex.substr(i * 2, 2));
      ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
    }
    lines.push(`${o.toString(16).padStart(6, '0')}  ${bytes.join(' ').padEnd(47)}  ${ascii}`);
  }
  return lines.join('\n');
}

export class RecordsView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.filter = '';
    this.key = null;
    this.list = h('div', { class: 'sidebar-list' });
    this.content = h('div', { class: 'content' });
    const filter = h('input', { type: 'search', placeholder: 'Filter records', oninput: (e) => { this.filter = e.target.value.toLowerCase(); this.renderList(); } });
    const dim = h('select', {}, DIM_NAMES.map((n, i) => h('option', { value: i }, n)));
    const bx = h('input', { type: 'number', placeholder: 'block X', style: { width: '90px' } });
    const bz = h('input', { type: 'number', placeholder: 'block Z', style: { width: '90px' } });
    const go = () => {
      if (bx.value === '' || bz.value === '') { toast('Enter block X and Z coordinates.', true); return; }
      app.showChunk(Number(dim.value), Math.floor(Number(bx.value) / 16), Math.floor(Number(bz.value) / 16));
    };
    clear(el,
      h('div', { class: 'sidebar' },
        h('div', { class: 'sidebar-head' },
          filter,
          h('div', { class: 'row' }, dim, bx, bz, h('button', { onclick: go }, 'Find chunk')),
          h('div', { class: 'muted small-text' }, 'Chunk data lives on the Map tab. Find a chunk by its block coordinates to see what\'s inside it.')),
        this.list),
      this.content);
    this.app.call('otherKeys').then((keys) => { this.keys = keys; this.renderList(); });
    this.renderRecord();
  }

  // Remembers which parts of each record's tree are open, so editing doesn't fold everything up.
  expandedFor(key) {
    this.expanded ??= new Map();
    if (!this.expanded.has(key)) this.expanded.set(key, new Map());
    return this.expanded.get(key);
  }

  onShow(opts = {}) {
    if (opts.key) { this.key = opts.key; this.renderRecord(); this.renderList(); }
  }

  renderList() {
    if (!this.keys) return;
    const f = this.filter;
    const groups = new Map(GROUPS.map(([g]) => [g, []]));
    for (const o of this.keys) {
      if (f && !o.label.toLowerCase().includes(f) && !o.key.includes(f)) continue;
      groups.get(groupOf(o)).push(o);
    }
    const LIMIT = 400;
    clear(this.list, GROUPS.map(([g, title]) => {
      const items = groups.get(g);
      if (!items.length) return null;
      const details = h('details', { open: f !== '' || g === 'player' || g === 'text' },
        h('summary', { class: 'list-item', style: { cursor: 'pointer', fontWeight: 600 } }, `${title} `, h('span', { class: 'badge' }, fmt(items.length))),
        items.slice(0, LIMIT).map((o) => h('button', {
          class: 'list-item' + (o.key === this.key ? ' active' : ''),
          onclick: () => { this.key = o.key; this.renderRecord(); this.renderList(); },
        }, h('div', { class: 'title' }, h('span', {}, o.label)), h('div', { class: 'sub' }, formatBytes(o.size)))),
        items.length > LIMIT ? h('div', { class: 'muted small-text', style: { padding: '8px 12px' } }, `Showing ${LIMIT} of ${fmt(items.length)}. Type in the filter to narrow it down.`) : null);
      return details;
    }));
  }

  async renderRecord() {
    if (!this.key) {
      clear(this.content, h('div', { class: 'empty' }, 'Choose a record on the left to read it.'));
      return;
    }
    const key = this.key;
    let rec;
    try { rec = await this.app.call('record', { key }); } catch (e) { clear(this.content, h('div', { class: 'card' }, e.message)); return; }
    if (this.key !== key) return;
    const onEdit = async (ops, question) => {
      if (question && !(await confirmBox({ title: question, body: 'Nothing changes until you save the world.', ok: 'Delete', danger: true }))) return false;
      try {
        await this.app.call('editRecord', { key, ops });
        await this.afterChange();
        return true;
      } catch (e) {
        toast(e.message, true);
        return false;
      }
    };
    clear(this.content,
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('h2', { style: { wordBreak: 'break-all' } }, rec.desc.label),
            h('div', { class: 'muted mono small-text', style: { wordBreak: 'break-all' } }, rec.printable)),
          rec.edited ? h('span', { class: 'badge warn' }, rec.deleted ? 'will be deleted' : 'edited') : null),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('span', { class: 'muted' }, rec.deleted ? 'Not present' : formatBytes(rec.size)),
          h('span', { class: 'spacer' }),
          rec.desc.kind === 'chunk' || rec.desc.kind === 'digp' ? h('button', { onclick: () => this.app.showChunk(rec.desc.dim, rec.desc.x, rec.desc.z) }, 'Show chunk on map') : null,
          rec.edited ? h('button', { onclick: async () => { await this.app.call('revertRecord', { key }); await this.afterChange(); } }, 'Undo changes') : null,
          !rec.deleted ? h('button', {
            class: 'danger',
            onclick: async () => {
              const ok = await confirmBox({ title: 'Delete this record?', body: ['The whole record will be removed from the world when you save.', rec.desc.kind === 'player' ? 'For a player this resets them completely: inventory, position, XP and ender chest. They start fresh at world spawn next time they join.' : null].filter(Boolean), ok: 'Delete record', danger: true });
              if (!ok) return;
              await this.app.call('deleteRecord', { key });
              await this.afterChange();
            },
          }, 'Delete record') : null)),
      rec.nbt ? h('div', { class: 'card' },
        h('div', { class: 'muted small-text', style: { marginBottom: '8px' } }, 'Click a value to change it. Hover over an entry to delete it.'),
        nbtTree(rec.nbt, { editable: true, onEdit, open: 1, expanded: this.expandedFor(key) }),
        rec.restHex ? [h('h3', { style: { marginTop: '12px' } }, 'Extra bytes after the NBT'), h('div', { class: 'hex' }, hexDump(rec.restHex))] : null) : null,
      rec.actorIds ? h('div', { class: 'card' },
        h('h3', {}, `${rec.actorIds.length} entit${rec.actorIds.length === 1 ? 'y' : 'ies'} in this chunk`),
        rec.actorIds.map((k) => h('div', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.key = k; this.renderRecord(); } }, 'Open entity ' + k.slice(-16))))) : null,
      rec.text != null ? h('div', { class: 'card' }, h('h3', {}, 'Text'), h('div', { class: 'hex' }, rec.text)) : null,
      rec.hex != null && !rec.actorIds ? h('div', { class: 'card' },
        h('h3', {}, rec.desc.kind === 'chunk' && rec.desc.tag === 0x2f ? 'Block data (binary)' : 'Binary data'),
        rec.nbtError ? h('p', { class: 'muted' }, `Not readable as NBT: ${rec.nbtError}`) : null,
        h('div', { class: 'hex' }, hexDump(rec.hex)),
        rec.size > 2048 ? h('p', { class: 'muted small-text' }, `Showing the first 2 KB of ${formatBytes(rec.size)}.`) : null) : null);
  }

  async afterChange() {
    await this.app.reloadPlayers();
    await this.app.refreshPending();
    this.renderRecord();
  }
}
