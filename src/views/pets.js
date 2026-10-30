// Pets: every named mob and every tamed animal in the world, who it belongs
// to, and where it is.

import { h, clear, fmt, nickname, DIM_NAMES, toast } from '../ui.js';

const DIMS = (m) => (m.dim != null ? DIM_NAMES[m.dim] ?? `dim ${m.dim}` : 'unknown dimension');

export function petTitle(m) { return m.name || `Unnamed ${m.kind.toLowerCase()}`; }

export function petWhere(m) {
  return m.pos?.length === 3 ? `${m.pos.join(', ')} (${DIMS(m)})` : 'somewhere unknown';
}

export class PetsView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.query = '';
    this.filter = 'all';
    this.selected = null;
    this.list = h('div', { class: 'sidebar-list' });
    this.content = h('div', { class: 'content' });
    this.filterSelect = h('select', { onchange: (e) => { this.filter = e.target.value; this.renderList(); } });
    clear(el,
      h('div', { class: 'sidebar' },
        h('div', { class: 'sidebar-head' },
          h('input', { type: 'search', placeholder: 'Search names, kinds and owners', oninput: (e) => { this.query = e.target.value.toLowerCase(); this.renderList(); } }),
          h('div', { class: 'row' }, this.filterSelect, h('button', { class: 'small', onclick: () => this.exportCsv() }, 'Download list'))),
        this.list),
      this.content);
    clear(this.content, h('div', { class: 'empty' }, 'Open this tab to find every named mob and pet.'));
  }

  async onShow(opts = {}) {
    if (!this.app.mobs) await this.load();
    if (opts.owner) { this.filter = 'owner:' + opts.owner; }
    if (opts.pet) this.selected = opts.pet;
    this.renderList();
    this.renderPet();
  }

  async onPendingChanged() {
    this.app.mobs = null;
    if (!this.el.hidden) { await this.load(); this.renderList(); this.renderPet(); }
  }

  async load() {
    this.app.mobs = await this.app.call('mobs');
  }

  ownerName(m) {
    if (!m.owner) return m.ownerId ? 'a player not in this world' : null;
    const p = this.app.players.find((x) => x.key === m.owner);
    return p ? nickname(p) : 'a player';
  }

  renderList() {
    const mobs = this.app.mobs ?? [];
    // Filter choices: kinds of mob, and each owner with pets.
    const owners = new Map();
    for (const m of mobs) if (m.owner) owners.set(m.owner, (owners.get(m.owner) ?? 0) + 1);
    clear(this.filterSelect,
      h('option', { value: 'all' }, `Everything (${fmt(mobs.length)})`),
      h('option', { value: 'tamed' }, 'Pets (tamed)'),
      h('option', { value: 'named' }, 'Named, not tamed'),
      h('option', { value: 'lost' }, 'Pets whose owner isn\'t in this world'),
      [...owners].map(([key, n]) => {
        const p = this.app.players.find((x) => x.key === key);
        return h('option', { value: 'owner:' + key }, `Owned by ${p ? nickname(p) : 'a player'} (${n})`);
      }));
    this.filterSelect.value = this.filter;
    const q = this.query;
    const shown = mobs.filter((m) => {
      if (this.filter === 'tamed' && !m.tamed) return false;
      if (this.filter === 'named' && (m.tamed || !m.name)) return false;
      if (this.filter === 'lost' && !(m.tamed && !m.owner)) return false;
      if (this.filter.startsWith('owner:') && m.owner !== this.filter.slice(6)) return false;
      return !q || `${m.name ?? ''} ${m.kind} ${this.ownerName(m) ?? ''}`.toLowerCase().includes(q);
    });
    clear(this.list,
      h('div', { class: 'muted small-text', style: { padding: '8px 12px' } }, mobs.length ? `${fmt(shown.length)} of ${fmt(mobs.length)} named mobs and pets` : 'No named mobs or tamed pets were found.'),
      shown.map((m, i) => h('button', {
        class: 'list-item' + (this.selected === m ? ' active' : ''),
        onclick: () => { this.selected = m; this.renderList(); this.renderPet(); },
      },
      h('div', { class: 'title' }, h('span', {}, petTitle(m)), h('span', { class: 'badge' }, m.kind), m.tamed ? null : h('span', { class: 'badge' }, 'wild')),
      h('div', { class: 'sub' }, this.ownerName(m) ? `${this.ownerName(m)}'s · ` : '', petWhere(m)))));
  }

  renderPet() {
    const m = this.selected;
    if (!m || !(this.app.mobs ?? []).includes(m)) {
      clear(this.content, h('div', { class: 'empty' }, 'Choose a mob on the left to see where it is.'));
      return;
    }
    const fact = (k, v) => (v == null ? null : h('div', { class: 'fact' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)));
    const ownerP = m.owner && this.app.players.find((x) => x.key === m.owner);
    const states = [m.sitting && 'sitting', m.baby && 'a baby', m.saddled && 'saddled', m.leashed && 'on a lead'].filter(Boolean);
    clear(this.content,
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('h2', {}, petTitle(m)),
            h('div', { class: 'muted' }, m.kind, m.tamed ? ', tamed' : ', wild', states.length ? ` · ${states.join(', ')}` : '')),
          m.pos?.length === 3 && m.dim != null ? h('button', { class: 'primary', onclick: () => this.app.showChunk(m.dim, Math.floor(m.pos[0] / 16), Math.floor(m.pos[2] / 16)) }, 'Show on map') : null,
          ownerP ? h('button', { onclick: () => this.app.showPlayer(ownerP.key) }, `Open ${nickname(ownerP)}`) : null,
          h('button', { onclick: () => this.app.showRecord(m.recordKey) }, 'Raw NBT')),
        h('div', { class: 'facts' },
          fact('Where', petWhere(m)),
          fact('Owner', this.ownerName(m) ?? (m.tamed ? 'nobody' : '—')),
          fact('Health', m.health ? `${Math.round(m.health.current)} of ${Math.round(m.health.max)}` : null),
          fact('Type', m.identifier))),
      m.chest ? h('div', { class: 'card' },
        h('h3', {}, 'Carrying'),
        m.chest.length ? h('ul', {}, m.chest.map((it) => h('li', {}, `${it.customName ? `“${it.customName}” ` : ''}${it.name} ×${it.count}`))) : h('p', { class: 'muted' }, 'Its chest is empty.')) : null,
      m.ownerId && !m.owner ? h('div', { class: 'card muted small-text' },
        'This pet\'s owner hasn\'t played in this world under the same id, so they can\'t be matched to a player here.') : null);
  }

  exportCsv() {
    const mobs = this.app.mobs ?? [];
    if (!mobs.length) { toast('There is nothing to download yet.'); return; }
    const esc = (s) => (/[",\n]/.test(String(s ?? '')) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? ''));
    const rows = ['name,kind,tamed,owner,x,y,z,dimension'];
    for (const m of mobs) rows.push([m.name ?? '', m.kind, m.tamed ? 'yes' : 'no', this.ownerName(m) ?? '', ...(m.pos.length === 3 ? m.pos : ['', '', '']), DIMS(m)].map(esc).join(','));
    const url = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }));
    const a = h('a', { href: url, download: `${(this.app.info.levelName || 'world').replace(/[\\/:*?"<>|]+/g, '_')} pets.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
