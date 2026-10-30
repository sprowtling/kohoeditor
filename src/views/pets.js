// Pets: every named mob and every tamed animal in the world, who it belongs
// to, and where it is.

import { h, clear, fmt, nickname, DIM_NAMES, toast, confirmBox } from '../ui.js';

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
          h('div', { class: 'row' }, this.filterSelect, h('button', { class: 'small', onclick: () => this.exportCsv() }, 'Download list')),
          this.carrierButton = h('button', { class: 'carrier-button', onclick: () => { this.selected = null; this.showCarrier = true; this.renderList(); this.renderPet(); } }, '🐾 Pet carrier')),
        this.list),
      this.content);
    clear(this.content, h('div', { class: 'empty' }, 'Open this tab to find every named mob and pet.'));
  }

  async onShow(opts = {}) {
    if (!this.app.mobs) await this.load();
    if (!this.carrier) this.carrier = await this.app.call('carrierInfo');
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
      shown.length > 1 ? h('div', { style: { padding: '0 12px 8px' } }, h('button', { class: 'small', onclick: () => this.carry(shown) }, `Put all ${fmt(shown.length)} shown in the carrier`)) : null,
      shown.map((m, i) => h('button', {
        class: 'list-item' + (this.selected === m ? ' active' : ''),
        onclick: () => { this.selected = m; this.showCarrier = false; this.renderList(); this.renderPet(); },
      },
      h('div', { class: 'title' }, h('span', {}, petTitle(m)), h('span', { class: 'badge' }, m.kind), m.tamed ? null : h('span', { class: 'badge' }, 'wild')),
      h('div', { class: 'sub' }, this.ownerName(m) ? `${this.ownerName(m)}'s · ` : '', petWhere(m)))));
  }

  async carry(mobs) {
    this.carrier = await this.app.call('carrierAdd', { picks: mobs.map((m) => ({ recordKey: m.recordKey, index: m.index })) });
    this.updateCarrierButton();
    toast(`${mobs.length === 1 ? petTitle(mobs[0]) + ' is' : fmt(mobs.length) + ' pets are'} in the carrier. Open the carrier to set ${mobs.length === 1 ? 'it' : 'them'} down.`);
    if (this.showCarrier) this.renderPet();
  }

  updateCarrierButton() {
    const n = this.carrier?.pets.length ?? 0;
    this.carrierButton.textContent = n ? `🐾 Pet carrier (${n})` : '🐾 Pet carrier';
    this.carrierButton.classList.toggle('primary', n > 0);
  }

  // The carrier: pets picked up here or brought in a carrier file, and where to set them down.
  renderCarrier() {
    const c = this.carrier;
    this.updateCarrierButton();
    const ownerName = (key) => { const p = this.app.players.find((x) => x.key === key); return p ? nickname(p) : 'a player'; };
    const selects = [];
    const fileInput = h('input', { type: 'file', accept: '.kohopets', hidden: true, onchange: async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try { this.carrier = await this.app.call('carrierLoad', { file: f }); toast('Pets unpacked into the carrier.'); this.renderCarrier(); } catch (err) { toast(err.message, true); }
    } });
    const mode = h('select', {}, h('option', { value: 'owner' }, 'Next to each pet\'s owner'), h('option', { value: 'coords' }, 'At these coordinates'));
    const xyz = ['x', 'y', 'z'].map((a) => h('input', { type: 'number', placeholder: a, style: { width: '90px' } }));
    const dim = h('select', {}, DIM_NAMES.map((n, i) => h('option', { value: i }, n)));
    const coordsRow = h('div', { class: 'row', hidden: true }, xyz, dim);
    mode.onchange = () => { coordsRow.hidden = mode.value !== 'coords'; };
    clear(this.content,
      h('div', { class: 'card' },
        h('h2', {}, '🐾 Pet carrier'),
        h('p', { class: 'muted small-text', style: { marginTop: 0 } },
          'Pick pets up from the list ("Put in carrier"), then set them down somewhere else. In this world they move; to take them to another world, save the carrier as a file and open it there. Each pet keeps its name, looks, health and anything it\'s carrying, and still belongs to its owner: owners are found again by their Microsoft account, so it works across worlds once they\'ve joined.'),
        h('div', { class: 'row' },
          h('button', { disabled: !c.pets.length, onclick: async () => {
            const blob = await this.app.call('carrierFile');
            const url = URL.createObjectURL(blob);
            const a = h('a', { href: url, download: `${(this.app.info.levelName || 'world').replace(/[\\/:*?"<>|]+/g, '_')} pets.kohopets` });
            document.body.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
          } }, 'Save carrier file'),
          h('label', { class: 'button' }, 'Open carrier file…', fileInput),
          c.pets.length ? h('button', { class: 'ghost', onclick: async () => { this.carrier = await this.app.call('carrierClear'); this.renderCarrier(); } }, 'Empty the carrier') : null)),
      c.pets.length ? h('div', { class: 'card' },
        h('h3', {}, `In the carrier (${c.pets.length})`),
        c.pets.map((p, i) => {
          const sel = h('select', {},
            h('option', { value: '' }, 'No owner'),
            c.owners.map((o) => h('option', { value: o.key, selected: o.key === p.here }, ownerName(o.key))));
          if (!p.here) sel.value = '';
          selects.push(sel);
          const hint = p.owner ? (p.here ? 'owner found here' : 'its owner hasn\'t joined this world yet') : 'never had an owner';
          return h('div', { class: 'change carrier-row' },
            h('span', { class: 'what' }, h('b', {}, p.name || `Unnamed ${p.kind.toLowerCase()}`), ` · ${p.kind}`, h('span', { class: 'muted small-text' }, ` · ${hint}`)),
            h('span', { class: 'muted small-text' }, 'belongs to'), sel,
            h('button', { class: 'small ghost', title: 'Take out of the carrier', onclick: async () => { this.carrier = await this.app.call('carrierRemove', { index: i }); this.renderCarrier(); } }, '×'));
        }),
        h('h3', { style: { marginTop: '14px' } }, 'Set them down'),
        h('div', { class: 'row' }, mode),
        coordsRow,
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { class: 'primary', onclick: async () => {
            const where = { mode: mode.value };
            if (mode.value === 'coords') {
              const nums = xyz.map((i) => i.value.trim());
              if (nums.some((v) => v === '' || Number.isNaN(Number(v)))) { toast('Type the x, y and z to set them down at.', true); return; }
              where.pos = nums.map(Number); where.dim = Number(dim.value);
            }
            const owners = selects.map((s) => s.value || null);
            if (where.mode === 'owner' && owners.some((o) => !o)) {
              const ok = await confirmBox({ title: 'Some pets have no owner chosen', body: 'Pets without an owner can\'t be set down next to one, so they\'ll stay in the carrier. Choose an owner for them, or set them down at coordinates.', ok: 'Set down the others' });
              if (!ok) return;
            }
            try {
              const r = await this.app.call('carrierSetDown', { where, owners });
              this.carrier = r.carrier;
              await this.app.refreshPending();
              if (r.placed.length) toast(`Set down ${r.placed.length === 1 ? r.placed[0].name : fmt(r.placed.length) + ' pets'}. Save the world to keep this.`);
              if (r.problems.length) await confirmBox({ title: 'Some pets stayed in the carrier', body: r.problems, ok: 'OK', cancel: null });
              this.renderCarrier();
            } catch (e) { toast(e.message, true); }
          } }, 'Set down'),
          h('span', { class: 'muted small-text' }, 'The ground there must already be generated (somewhere a player has been).'))) : h('div', { class: 'card muted' }, 'The carrier is empty. Choose a pet on the left and press "Put in carrier", or open a carrier file.'));
  }

  renderPet() {
    if (this.showCarrier) { this.renderCarrier(); return; }
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
          h('button', { onclick: () => this.carry([m]) }, '🐾 Put in carrier'),
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
