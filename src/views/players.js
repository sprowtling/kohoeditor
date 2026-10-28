// Players: everyone who has joined the world, with their inventories.

import { h, clear, toast, confirmBox, coords, fmt, DIM_NAMES, notes } from '../ui.js';

const GAME_MODES = ['Survival', 'Creative', 'Adventure', '', '', 'Default', 'Spectator'];

// A hint of colour on each slot, so a full inventory is easier to scan.
const MATERIAL_COLOURS = [
  [/netherite/, '#4d4246'], [/diamond/, '#4ad6c8'], [/emerald/, '#2ecc71'], [/gold/, '#e8c33a'],
  [/iron/, '#c9c9c9'], [/copper/, '#d07a4f'], [/shulker_box/, '#9b6fb3'], [/elytra/, '#8c8fa8'],
  [/totem/, '#e8c33a'], [/redstone/, '#d23a2a'], [/lapis/, '#2c55c8'], [/tnt/, '#d23a2a'],
  [/obsidian|crying/, '#3b2a55'], [/beacon|nether_star/, '#a6f0f0'], [/enchanted_book/, '#8a4fd6'],
];
function swatch(id) {
  for (const [re, c] of MATERIAL_COLOURS) if (re.test(id)) return c;
  return null;
}

function displayName(p) {
  const nick = notes.get('nick:' + p.id);
  if (nick) return nick;
  if (p.id === 'local') return 'Local player';
  return `Player ${p.id.slice(0, 8)}`;
}

function totalItems(s) {
  return [...s.inventory, ...s.armor, ...s.offhand, ...s.enderChest];
}

export class PlayersView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.selected = null;
    this.selectedItem = null;
    this.query = '';
    this.search = '';
    this.sidebarList = h('div', { class: 'sidebar-list' });
    this.content = h('div', { class: 'content' });
    const filter = h('input', { type: 'search', placeholder: 'Filter players by nickname or id', oninput: (e) => { this.query = e.target.value.toLowerCase(); this.renderList(); } });
    const itemSearch = h('input', {
      type: 'search', placeholder: 'Find an item on every player (e.g. netherite, elytra)',
      onkeydown: (e) => { if (e.key === 'Enter') { this.search = e.target.value.trim().toLowerCase(); this.renderSearch(); } },
    });
    clear(el,
      h('div', { class: 'sidebar' },
        h('div', { class: 'sidebar-head' }, filter, itemSearch,
          h('div', { class: 'muted small-text' }, 'Bedrock doesn\'t store gamertags in the world, so players are listed by id. Click a name to give it a nickname. Nicknames stay in this browser only.')),
        this.sidebarList),
      this.content);
    if (app.players.length) this.selected = app.players.find((p) => p.id !== 'local')?.key ?? app.players[0].key;
    this.renderList();
    this.renderPlayer();
  }

  onShow() { this.renderList(); this.renderPlayer(); }

  visiblePlayers() {
    const q = this.query;
    const list = this.app.players.filter((p) => !q || displayName(p).toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    return list.sort((a, b) => (a.id === 'local') - (b.id === 'local') || displayName(a).localeCompare(displayName(b)));
  }

  renderList() {
    const players = this.visiblePlayers();
    if (!this.app.players.length) {
      clear(this.sidebarList, h('div', { class: 'empty' }, 'No player records were found in this world.'));
      return;
    }
    clear(this.sidebarList, players.map((p) => {
      const s = p.summary;
      return h('button', {
        class: 'list-item' + (p.key === this.selected ? ' active' : ''),
        onclick: () => { this.selected = p.key; this.selectedItem = null; this.search = ''; this.renderList(); this.renderPlayer(); },
      },
      h('div', { class: 'title' }, h('span', {}, displayName(p)), p.edited ? h('span', { class: 'badge warn' }, 'edited') : null, s?.dead ? h('span', { class: 'badge' }, 'dead') : null),
      h('div', { class: 'sub' }, s ? `${DIM_NAMES[s.dim] ?? 'Dim ' + s.dim} · ${coords(s.pos)} · level ${s.level}` : p.error ? 'Could not read this player' : ''));
    }));
  }

  renderSearch() {
    const q = this.search;
    if (!q) { this.renderPlayer(); return; }
    const hits = [];
    const visit = (p, where, items, path = []) => {
      for (const it of items) {
        const hay = `${it.id} ${it.name} ${it.customName ?? ''} ${it.enchants.map((e) => e.name).join(' ')} ${it.book?.title ?? ''} ${it.book?.author ?? ''}`.toLowerCase();
        if (hay.includes(q)) hits.push({ p, where: [where, ...path].join(' › '), it });
        if (it.contents) visit(p, where, it.contents, [...path, it.customName ?? it.name]);
      }
    };
    for (const p of this.app.players) {
      const s = p.summary;
      if (!s) continue;
      visit(p, 'Inventory', s.inventory);
      visit(p, 'Armor', s.armor);
      visit(p, 'Offhand', s.offhand);
      visit(p, 'Ender chest', s.enderChest);
    }
    const byPlayer = new Map();
    for (const hit of hits) {
      if (!byPlayer.has(hit.p.key)) byPlayer.set(hit.p.key, []);
      byPlayer.get(hit.p.key).push(hit);
    }
    clear(this.content,
      h('div', { class: 'row' },
        h('h2', {}, `Search: “${q}”`),
        h('span', { class: 'spacer' }),
        h('button', { onclick: () => { this.search = ''; this.renderPlayer(); } }, 'Back to player')),
      h('p', { class: 'muted' }, hits.length ? `Found on ${byPlayer.size} player${byPlayer.size === 1 ? '' : 's'}. Containers like shulker boxes are searched too.` : 'No player is carrying anything that matches.'),
      h('div', { class: 'search-results' },
        [...byPlayer.values()].map((list) => {
          const p = list[0].p;
          const total = list.reduce((n, x) => n + x.it.count, 0);
          return h('button', { class: 'hit', onclick: () => { this.selected = p.key; this.search = ''; this.renderList(); this.renderPlayer(); } },
            h('div', { class: 'row' }, h('b', {}, displayName(p)), h('span', { class: 'badge' }, `${fmt(total)} total`)),
            h('div', { class: 'muted small-text' }, list.slice(0, 8).map((x) => `${x.it.customName ? `“${x.it.customName}” ` : ''}${x.it.name} ×${x.it.count} (${x.where})`).join(' · '), list.length > 8 ? ` · and ${list.length - 8} more` : ''));
        })));
  }

  renderPlayer() {
    if (this.search) { this.renderSearch(); return; }
    const p = this.app.players.find((x) => x.key === this.selected);
    if (!p) { clear(this.content, h('div', { class: 'empty' }, 'Choose a player on the left.')); return; }
    if (!p.summary) {
      clear(this.content, h('div', { class: 'card' }, h('h2', {}, displayName(p)), h('p', {}, p.deleted ? 'This player record is marked for deletion.' : `This player record could not be read: ${p.error}`),
        h('button', { onclick: () => this.app.showRecord(p.key) }, 'Open raw record')));
      return;
    }
    const s = p.summary;
    const nick = h('input', {
      class: 'nick', value: notes.get('nick:' + p.id) ?? '', placeholder: displayName(p),
      title: 'Type a nickname to remember who this is',
      onchange: (e) => { notes.set('nick:' + p.id, e.target.value.trim()); this.renderList(); },
    });
    const fact = (k, v) => h('div', { class: 'fact' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    const items = totalItems(s);
    const enchanted = items.filter((i) => i.enchants.length).length;
    clear(this.content,
      h('div', { class: 'card' },
        h('div', { class: 'player-head' },
          h('div', { style: { flex: 1, minWidth: '260px' } },
            nick,
            h('div', { class: 'muted small-text mono' }, p.text)),
          h('div', { class: 'row' },
            h('button', { onclick: () => this.app.showChunk(s.dim, Math.floor(s.pos[0] / 16), Math.floor(s.pos[2] / 16)) }, 'Show on map'),
            h('button', { onclick: () => this.app.showRecord(p.key) }, 'Raw NBT'))),
        h('div', { class: 'facts' },
          fact('Position', `${coords(s.pos)}`),
          fact('Dimension', DIM_NAMES[s.dim] ?? s.dim),
          fact('XP level', s.level),
          fact('Game mode', GAME_MODES[s.gameMode] ?? s.gameMode ?? '—'),
          fact('Spawn point', s.spawn ? `${s.spawn.slice(0, 3).join(', ')} (${DIM_NAMES[s.spawn[3]] ?? s.spawn[3]})` : 'World spawn'),
          fact('Permissions', ['Visitor', 'Member', 'Operator', 'Custom'][s.permissions] ?? '—'),
          fact('Items carried', `${fmt(items.reduce((n, i) => n + i.count, 0))} (${enchanted} enchanted)`),
          p.link?.msaId ? fact('Microsoft account id', h('span', { class: 'mono small-text' }, p.link.msaId)) : null)),
      this.inventorySection('Inventory', s.inventory, p, 'Inventory', true),
      h('div', { class: 'inv-section card' },
        h('div', { class: 'inv-wrap' },
          h('div', {}, h('h3', {}, 'Armor'), this.grid(['Head', 'Chest', 'Legs', 'Feet'].map((label, i) => ({ item: s.armor.find((x) => x.slot === i), label })), 'col', p, 'Armor')),
          h('div', {}, h('h3', {}, 'Offhand'), this.grid([{ item: s.offhand[0], label: 'Offhand' }], 'col', p, 'Offhand')))),
      this.inventorySection('Ender chest', s.enderChest, p, 'EnderChestInventory', false),
      this.itemDetail(p));
  }

  inventorySection(title, items, p, listName, hotbar) {
    const bySlot = new Map(items.map((i) => [i.slot, i]));
    const cells = (from, to) => Array.from({ length: to - from }, (_, k) => ({ item: bySlot.get(from + k) }));
    return h('div', { class: 'inv-section card' },
      h('h3', {}, title, h('span', { class: 'badge' }, `${items.length} stack${items.length === 1 ? '' : 's'}`)),
      hotbar
        ? [this.grid(cells(9, 36), '', p, listName), this.grid(cells(0, 9), 'hotbar', p, listName)]
        : this.grid(cells(0, 27), '', p, listName));
  }

  grid(cells, cls, p, listName) {
    return h('div', { class: 'grid ' + cls }, cells.map(({ item, label }) => {
      if (!item) return h('div', { class: 'slot' }, label ? h('span', { class: 'slot-empty-label' }, label) : '');
      const sel = this.selectedItem && this.selectedItem.list === listName && this.selectedItem.item.slot === item.slot;
      const c = swatch(item.id);
      return h('div', {
        class: 'slot filled' + (item.enchants.length ? ' enchanted' : '') + (item.customName ? ' named' : '') + (item.contents?.length ? ' container' : '') + (sel ? ' selected' : ''),
        title: `${item.customName ? `“${item.customName}” ` : ''}${item.name} ×${item.count}${item.enchants.length ? '\n' + item.enchants.map((e) => e.name).join('\n') : ''}`,
        onclick: () => { this.selectedItem = { list: listName, item }; this.renderPlayer(); this.content.querySelector('.item-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); },
      },
      c ? h('span', { class: 'swatch', style: { background: c } }) : null,
      h('span', { class: 'label' }, item.customName ?? item.name),
      item.count > 1 ? h('span', { class: 'count' }, item.count) : null);
    }));
  }

  itemDetail(p) {
    const sel = this.selectedItem;
    if (!sel) return h('div', { class: 'item-detail muted small-text' }, 'Click any item for its details. A purple outline means enchanted; an orange dot means it holds other items.');
    const it = sel.item;
    const describe = (it) => [
      h('div', { class: 'name' }, it.customName ? `“${it.customName}”` : it.name, ' ', h('span', { class: 'muted' }, `×${it.count}`)),
      h('div', { class: 'muted mono small-text' }, it.id, it.damage ? ` · damage/data ${it.damage}` : ''),
      it.enchants.length ? h('ul', {}, it.enchants.map((e) => h('li', { class: 'ench' }, e.name))) : null,
      it.lore ? h('ul', {}, it.lore.map((l) => h('li', { class: 'muted' }, l))) : null,
      it.book ? h('div', {}, it.book.title ? `Book “${it.book.title}”` : 'Book', it.book.author ? ` signed by ${it.book.author}` : '') : null,
    ];
    return h('div', { class: 'item-detail card' },
      h('div', { class: 'row' },
        h('div', { style: { flex: 1 } }, describe(it)),
        h('button', { class: 'danger', onclick: () => this.clearSlot(p, sel.list, it) }, 'Remove this item')),
      it.contents ? h('div', { style: { marginTop: '10px' } },
        h('h3', {}, `Inside (${it.contents.length} stack${it.contents.length === 1 ? '' : 's'})`),
        it.contents.length ? h('ul', {}, it.contents.map((c) => h('li', {},
          `${c.customName ? `“${c.customName}” ` : ''}${c.name} ×${c.count}`,
          c.enchants.length ? h('span', { class: 'ench' }, ` · ${c.enchants.map((e) => e.name).join(', ')}`) : '',
          c.contents ? h('span', { class: 'muted' }, ` · holds ${c.contents.length} more stacks`) : ''))) : h('p', { class: 'muted' }, 'Empty.')) : null);
  }

  // Empties a slot the same way the game stores an empty slot.
  async clearSlot(p, listName, item) {
    const ok = await confirmBox({
      title: 'Remove this item?',
      body: `${item.customName ? `“${item.customName}” ` : ''}${item.name} ×${item.count} will be removed from ${displayName(p)}'s ${listName === 'EnderChestInventory' ? 'ender chest' : listName.toLowerCase()}. Nothing changes until you save the world.`,
      ok: 'Remove item', danger: true,
    });
    if (!ok) return;
    try {
      const rec = await this.app.call('record', { key: p.key });
      const root = rec.nbt[0];
      const li = root.v.findIndex((c) => c.n === listName);
      if (li < 0) throw new Error('Could not find that list in the player record.');
      const list = root.v[li];
      const idx = list.v.findIndex((c, i) => {
        const slot = c.v.find((x) => x.n === 'Slot')?.v ?? i;
        const name = c.v.find((x) => x.n === 'Name')?.v;
        return slot === item.slot && name === item.id;
      });
      if (idx < 0) throw new Error('Could not find that item in the player record.');
      const entry = list.v[idx];
      const ops = [];
      // Delete extra data from the end first, so earlier indexes stay valid.
      const removable = entry.v.map((c, i) => [c.n, i]).filter(([n]) => n === 'tag' || n === 'Block' || n === 'CanPlaceOn' || n === 'CanDestroy').map(([, i]) => i).sort((a, b) => b - a);
      for (const i of removable) ops.push({ path: [0, li, idx, i], action: 'delete' });
      const after = entry.v.filter((_, i) => !removable.includes(i));
      const at = (n) => after.findIndex((c) => c.n === n);
      if (at('Name') >= 0) ops.push({ path: [0, li, idx, at('Name')], action: 'set', value: '' });
      if (at('Count') >= 0) ops.push({ path: [0, li, idx, at('Count')], action: 'set', value: '0' });
      if (at('Damage') >= 0) ops.push({ path: [0, li, idx, at('Damage')], action: 'set', value: '0' });
      await this.app.call('editRecord', { key: p.key, ops });
      this.selectedItem = null;
      await this.app.reloadPlayers();
      await this.app.refreshPending();
      this.renderList();
      this.renderPlayer();
      toast('Item removed. Save the world to keep this change.');
    } catch (e) {
      toast(e.message, true);
    }
  }

  onPendingChanged() {}
}
