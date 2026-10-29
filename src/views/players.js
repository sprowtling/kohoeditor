// Players: everyone who has joined the world, with their inventories.

import { h, clear, toast, confirmBox, coords, fmt, DIM_NAMES, names, nickname, parseCsv } from '../ui.js';
import { ENCHANTMENTS } from '../lib/items.js';

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

// Suggestions for the item id box, on top of everything already in players' inventories.
const COMMON_ITEMS = [
  'diamond', 'diamond_block', 'emerald', 'gold_ingot', 'iron_ingot', 'netherite_ingot', 'netherite_scrap', 'coal', 'redstone', 'lapis_lazuli',
  'diamond_sword', 'diamond_pickaxe', 'diamond_axe', 'diamond_shovel', 'diamond_hoe', 'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
  'netherite_sword', 'netherite_pickaxe', 'netherite_axe', 'netherite_shovel', 'netherite_hoe', 'netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots',
  'iron_sword', 'iron_pickaxe', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'bow', 'crossbow', 'trident', 'mace', 'shield', 'arrow',
  'elytra', 'totem_of_undying', 'enchanted_book', 'golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'bread', 'golden_carrot', 'firework_rocket',
  'ender_pearl', 'ender_eye', 'experience_bottle', 'name_tag', 'saddle', 'lead', 'torch', 'oak_log', 'cobblestone', 'stone', 'dirt', 'obsidian', 'tnt',
  'shulker_box', 'chest', 'ender_chest', 'crafting_table', 'furnace', 'bed', 'water_bucket', 'lava_bucket', 'bucket', 'flint_and_steel', 'compass', 'clock', 'map',
];

const LISTS = {
  Inventory: { title: 'inventory', slots: 36 },
  Armor: { title: 'armor', slots: 4, labels: ['Head', 'Chest', 'Legs', 'Feet'] },
  Offhand: { title: 'offhand', slots: 1, labels: ['Offhand'] },
  EnderChestInventory: { title: 'ender chest', slots: 27 },
};

function totalItems(s) {
  return [...s.inventory, ...s.armor, ...s.offhand, ...s.enderChest];
}

function itemsOf(s, list) {
  return { Inventory: s.inventory, Armor: s.armor, Offhand: s.offhand, EnderChestInventory: s.enderChest }[list];
}

export class PlayersView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.selected = null;
    this.slot = null; // { list, slot } that is open in the item panel
    this.query = '';
    this.search = '';
    this.sidebarList = h('div', { class: 'sidebar-list' });
    this.content = h('div', { class: 'content' });
    const filter = h('input', { type: 'search', placeholder: 'Filter players by nickname, notes or id', oninput: (e) => { this.query = e.target.value.toLowerCase(); this.renderList(); } });
    const itemSearch = h('input', {
      type: 'search', placeholder: 'Find an item on every player (e.g. netherite, elytra)',
      onkeydown: (e) => { if (e.key === 'Enter') { this.search = e.target.value.trim().toLowerCase(); this.renderSearch(); } },
    });
    this.itemIds = h('datalist', { id: 'item-ids' });
    clear(el,
      h('div', { class: 'sidebar' },
        h('div', { class: 'sidebar-head' }, filter, itemSearch,
          h('div', { class: 'row' },
            h('button', { class: 'small', onclick: () => this.namesDialog() }, 'Names list…'),
            h('span', { class: 'muted small-text', style: { flex: 1 } }, 'Bedrock doesn\'t save gamertags, so give players nicknames, or import your spreadsheet.'))),
        this.sidebarList),
      this.content, this.itemIds);
    if (app.players.length) this.selected = app.players.find((p) => p.id !== 'local')?.key ?? app.players[0].key;
    this.renderList();
    this.renderPlayer();
  }

  onShow(opts = {}) {
    if (opts.key) { this.selected = opts.key; this.search = ''; this.slot = null; }
    this.renderList();
    this.renderPlayer();
    if (opts.key) this.sidebarList.querySelector('.list-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  visiblePlayers() {
    const q = this.query;
    const list = this.app.players.filter((p) => {
      if (!q) return true;
      const n = names.lookup(p);
      return nickname(p).toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || (n?.notes ?? '').toLowerCase().includes(q) || (p.link?.msaId ?? '').includes(q);
    });
    return list.sort((a, b) => (a.id === 'local') - (b.id === 'local') || (!names.lookup(a)) - (!names.lookup(b)) || nickname(a).localeCompare(nickname(b)));
  }

  renderList() {
    const players = this.visiblePlayers();
    if (!this.app.players.length) {
      clear(this.sidebarList, h('div', { class: 'empty' }, 'No player records were found in this world.'));
      return;
    }
    clear(this.sidebarList, players.map((p) => {
      const s = p.summary;
      const n = names.lookup(p);
      return h('button', {
        class: 'list-item' + (p.key === this.selected ? ' active' : ''),
        onclick: () => { this.selected = p.key; this.slot = null; this.search = ''; this.renderList(); this.renderPlayer(); },
      },
      h('div', { class: 'title' }, h('span', { class: n ? '' : 'muted' }, nickname(p)), p.edited ? h('span', { class: 'badge warn' }, 'edited') : null, s?.dead ? h('span', { class: 'badge' }, 'dead') : null),
      h('div', { class: 'sub' }, s ? `${DIM_NAMES[s.dim] ?? 'Dim ' + s.dim} · ${coords(s.pos)} · level ${s.level}` : p.error ? 'Could not read this player' : ''),
      n?.notes ? h('div', { class: 'sub' }, n.notes) : null);
    }));
  }

  // -------------------------------------------------------------------------
  // The names list: import from and export to a spreadsheet

  namesDialog() {
    const count = () => Object.keys(names.all()).length;
    const matched = () => this.app.players.filter((p) => names.lookup(p)).length;
    const status = h('p', {});
    const refresh = () => { status.textContent = `${fmt(count())} names saved in this browser. ${fmt(matched())} of the ${fmt(this.app.players.length)} players in this world have one.`; };
    refresh();
    const fileInput = h('input', {
      type: 'file', accept: '.csv,.tsv,.txt', hidden: true,
      onchange: async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        const r = names.importRows(parseCsv(await f.text()));
        refresh();
        this.renderList();
        this.renderPlayer();
        toast(`Imported ${fmt(r.added)} new name${r.added === 1 ? '' : 's'}${r.updated ? ` and updated ${fmt(r.updated)}` : ''}${r.skipped ? ` (${fmt(r.skipped)} rows skipped: no id or name found)` : ''}.`);
      },
    });
    const exportCsv = () => {
      const url = URL.createObjectURL(new Blob([names.toCsv()], { type: 'text/csv' }));
      const a = h('a', { href: url, download: 'koho player names.csv' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) back.remove(); } },
      h('div', { class: 'modal' },
        h('h2', {}, 'Player names'),
        status,
        h('p', { class: 'muted small-text' }, 'Names and notes are remembered in this browser and work in every world you open here. They are never written into the world.'),
        h('h3', { style: { marginTop: '14px' } }, 'Import a spreadsheet'),
        h('p', { class: 'small-text' }, 'Save your spreadsheet as CSV (in Excel or Google Sheets: File → Download / Save As → CSV). Each row needs a player id and a name; a notes column comes along if there is one. Ids can be the player_server_… tag, just the long id after it, or the Microsoft account id.'),
        h('label', { class: 'button primary' }, 'Choose CSV file…', fileInput),
        h('h3', { style: { marginTop: '14px' } }, 'Back up'),
        h('p', { class: 'small-text' }, 'Download everything as a CSV, to keep somewhere safe or open on another computer.'),
        h('button', { onclick: exportCsv }, 'Download names as CSV'),
        h('div', { class: 'row' }, h('button', { onclick: () => back.remove() }, 'Done'))));
    document.body.append(back);
  }

  // -------------------------------------------------------------------------
  // Searching every player

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
            h('div', { class: 'row' }, h('b', {}, nickname(p)), h('span', { class: 'badge' }, `${fmt(total)} total`)),
            h('div', { class: 'muted small-text' }, list.slice(0, 8).map((x) => `${x.it.customName ? `“${x.it.customName}” ` : ''}${x.it.name} ×${x.it.count} (${x.where})`).join(' · '), list.length > 8 ? ` · and ${list.length - 8} more` : ''));
        })));
  }

  // -------------------------------------------------------------------------
  // One player

  renderPlayer() {
    if (this.search) { this.renderSearch(); return; }
    const p = this.app.players.find((x) => x.key === this.selected);
    if (!p) { clear(this.content, h('div', { class: 'empty' }, 'Choose a player on the left.')); return; }
    const saved = names.lookup(p);
    const nick = h('input', {
      class: 'nick', value: saved?.name ?? '', placeholder: nickname(p) + ' (click to name)',
      title: 'Type a nickname to remember who this is',
      onchange: (e) => { names.set(p, { name: e.target.value.trim() }); this.renderList(); },
    });
    const noteBox = h('textarea', {
      class: 'player-notes', rows: 2, placeholder: 'Notes about this player (only in this browser)',
      onchange: (e) => { names.set(p, { notes: e.target.value.trim() }); this.renderList(); },
    });
    noteBox.value = saved?.notes ?? '';
    if (!p.summary) {
      clear(this.content, h('div', { class: 'card' }, nick, noteBox, h('p', {}, p.deleted ? 'This player record is marked for deletion.' : `This player record could not be read: ${p.error}`),
        h('button', { onclick: () => this.app.showRecord(p.key) }, 'Open raw record')));
      return;
    }
    const s = p.summary;
    const fact = (k, v) => h('div', { class: 'fact' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    const items = totalItems(s);
    const enchanted = items.filter((i) => i.enchants.length).length;
    this.fillItemIds();
    clear(this.content,
      h('div', { class: 'card' },
        h('div', { class: 'player-head' },
          h('div', { style: { flex: 1, minWidth: '260px' } },
            nick,
            h('div', { class: 'muted small-text mono' }, p.text)),
          h('div', { class: 'row' },
            h('button', { onclick: () => this.app.showChunk(s.dim, Math.floor(s.pos[0] / 16), Math.floor(s.pos[2] / 16)) }, 'Show on map'),
            h('button', { onclick: () => this.app.showRecord(p.key) }, 'Raw NBT'))),
        noteBox,
        h('div', { class: 'facts' },
          fact('Position', `${coords(s.pos)}`),
          fact('Dimension', DIM_NAMES[s.dim] ?? s.dim),
          fact('XP level', s.level),
          fact('Game mode', GAME_MODES[s.gameMode] ?? s.gameMode ?? '—'),
          fact('Spawn point', s.spawn ? `${s.spawn.slice(0, 3).join(', ')} (${DIM_NAMES[s.spawn[3]] ?? s.spawn[3]})` : 'World spawn'),
          fact('Permissions', ['Visitor', 'Member', 'Operator', 'Custom'][s.permissions] ?? '—'),
          fact('Items carried', `${fmt(items.reduce((n, i) => n + i.count, 0))} (${enchanted} enchanted)`),
          p.link?.msaId ? fact('Microsoft account id', h('span', { class: 'mono small-text' }, p.link.msaId)) : null)),
      this.inventorySection('Inventory', s.inventory, 'Inventory', true),
      h('div', { class: 'inv-section card' },
        h('div', { class: 'inv-wrap' },
          h('div', {}, h('h3', {}, 'Armor'), this.grid(LISTS.Armor.labels.map((label, i) => ({ slot: i, item: s.armor.find((x) => x.slot === i), label })), 'col', 'Armor')),
          h('div', {}, h('h3', {}, 'Offhand'), this.grid([{ slot: 0, item: s.offhand[0], label: 'Offhand' }], 'col', 'Offhand')))),
      this.inventorySection('Ender chest', s.enderChest, 'EnderChestInventory', false),
      this.itemPanel(p));
  }

  fillItemIds() {
    const ids = new Set(COMMON_ITEMS.map((i) => 'minecraft:' + i));
    for (const p of this.app.players) if (p.summary) for (const it of totalItems(p.summary)) ids.add(it.id);
    clear(this.itemIds, [...ids].sort().map((id) => h('option', { value: id })));
  }

  inventorySection(title, items, listName, hotbar) {
    const bySlot = new Map(items.map((i) => [i.slot, i]));
    const cells = (from, to) => Array.from({ length: to - from }, (_, k) => ({ slot: from + k, item: bySlot.get(from + k) }));
    return h('div', { class: 'inv-section card' },
      h('h3', {}, title, h('span', { class: 'badge' }, `${items.length} stack${items.length === 1 ? '' : 's'}`)),
      hotbar
        ? [this.grid(cells(9, 36), '', listName), this.grid(cells(0, 9), 'hotbar', listName)]
        : this.grid(cells(0, 27), '', listName));
  }

  grid(cells, cls, listName) {
    return h('div', { class: 'grid ' + cls }, cells.map(({ slot, item, label }) => {
      const sel = this.slot && this.slot.list === listName && this.slot.slot === slot;
      const open = () => {
        this.slot = { list: listName, slot };
        this.renderPlayer();
        this.content.querySelector('.item-panel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };
      if (!item) {
        return h('div', { class: 'slot empty-slot' + (sel ? ' selected' : ''), title: 'Empty: click to put an item here', onclick: open },
          label ? h('span', { class: 'slot-empty-label' }, label) : '');
      }
      const c = swatch(item.id);
      return h('div', {
        class: 'slot filled' + (item.enchants.length ? ' enchanted' : '') + (item.customName ? ' named' : '') + (item.contents?.length ? ' container' : '') + (sel ? ' selected' : ''),
        title: `${item.customName ? `“${item.customName}” ` : ''}${item.name} ×${item.count}${item.enchants.length ? '\n' + item.enchants.map((e) => e.name).join('\n') : ''}`,
        onclick: open,
      },
      c ? h('span', { class: 'swatch', style: { background: c } }) : null,
      h('span', { class: 'label' }, item.customName ?? item.name),
      item.count > 1 ? h('span', { class: 'count' }, item.count) : null);
    }));
  }

  // The panel under the inventories: details and editing for the chosen slot.
  itemPanel(p) {
    if (!this.slot) return h('div', { class: 'item-panel muted small-text' }, 'Click any slot to see its item, change it, or put a new item there. A purple outline means enchanted; an orange dot means it holds other items.');
    const { list, slot } = this.slot;
    const it = itemsOf(p.summary, list).find((i) => i.slot === slot) ?? null;
    const where = `${LISTS[list].title}${LISTS[list].labels ? ` (${LISTS[list].labels[slot]})` : `, slot ${slot}`}`;

    const id = h('input', { type: 'text', list: 'item-ids', value: it?.id ?? 'minecraft:', placeholder: 'minecraft:diamond_sword', class: 'mono', style: { width: '100%' } });
    const count = h('input', { type: 'number', min: 1, max: 64, value: it?.count ?? 1, style: { width: '80px' } });
    const damage = h('input', { type: 'number', min: 0, max: 32767, value: it?.damage ?? 0, style: { width: '90px' }, title: 'Wear on tools and armor, or the variant for some items (like potion type)' });
    const customName = h('input', { type: 'text', value: it?.customName ?? '', placeholder: 'No custom name', style: { width: '100%' } });
    const enchRows = h('div', { class: 'ench-rows' });
    const addEnchRow = (e = { id: '', level: 1 }) => {
      const sel = h('select', {}, h('option', { value: '' }, 'Choose…'), ENCHANTMENTS.map((name, i) => h('option', { value: i, selected: Number(e.id) === i && e.id !== '' }, name)));
      const lvl = h('input', { type: 'number', min: 1, max: 255, value: e.level ?? 1, style: { width: '70px' } });
      const row = h('div', { class: 'row ench-row' }, sel, lvl, h('button', { class: 'small ghost', onclick: () => row.remove(), title: 'Remove this enchantment' }, '×'));
      enchRows.append(row);
    };
    for (const e of it?.enchants ?? []) addEnchRow({ id: e.id, level: e.level });

    const save = async () => {
      const enchants = [...enchRows.querySelectorAll('.ench-row')].map((r) => ({ id: r.querySelector('select').value, level: r.querySelector('input').value }))
        .filter((e) => e.id !== '').map((e) => ({ id: Number(e.id), level: Number(e.level) }));
      const item = { id: id.value.trim(), count: Number(count.value), damage: Number(damage.value), customName: customName.value, enchants };
      try {
        await this.app.call('setItem', { key: p.key, list, slot, item });
        await this.afterEdit(`${it ? 'Updated' : 'Added'} ${item.id.replace(/^minecraft:/, '')} in ${nickname(p)}'s ${where}.`);
      } catch (e) { toast(e.message, true); }
    };
    const remove = async () => {
      const ok = await confirmBox({
        title: 'Remove this item?',
        body: `${it.customName ? `“${it.customName}” ` : ''}${it.name} ×${it.count} will be removed from ${nickname(p)}'s ${where}. Nothing changes until you save the world.`,
        ok: 'Remove item', danger: true,
      });
      if (!ok) return;
      try {
        await this.app.call('setItem', { key: p.key, list, slot, item: null });
        await this.afterEdit('Item removed. Save the world to keep this change.');
      } catch (e) { toast(e.message, true); }
    };

    const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'k' }, label), input, hint ? h('span', { class: 'muted small-text' }, hint) : null);
    return h('div', { class: 'item-panel card' },
      h('div', { class: 'row' },
        h('h3', { style: { margin: 0, flex: 1 } }, it ? `${it.customName ? `“${it.customName}” ` : ''}${it.name} ×${it.count}` : 'Empty slot', h('span', { class: 'muted', style: { fontWeight: 400 } }, ` · ${where}`)),
        h('button', { class: 'ghost small', onclick: () => { this.slot = null; this.renderPlayer(); } }, 'Close')),
      it?.book ? h('div', { class: 'small-text' }, it.book.title ? `Book “${it.book.title}”` : 'Book', it.book.author ? ` signed by ${it.book.author}` : '') : null,
      it?.lore ? h('ul', { class: 'small-text' }, it.lore.map((l) => h('li', { class: 'muted' }, l))) : null,
      it?.contents ? h('div', { class: 'contents' },
        h('div', { class: 'k' }, `Inside (${it.contents.length} stack${it.contents.length === 1 ? '' : 's'})`),
        it.contents.length ? h('ul', {}, it.contents.map((c) => h('li', {},
          `${c.customName ? `“${c.customName}” ` : ''}${c.name} ×${c.count}`,
          c.enchants.length ? h('span', { class: 'ench' }, ` · ${c.enchants.map((e) => e.name).join(', ')}`) : '',
          c.contents ? h('span', { class: 'muted' }, ` · holds ${c.contents.length} more stacks`) : ''))) : h('p', { class: 'muted' }, 'Empty.'),
        h('p', { class: 'muted small-text' }, 'To change what\'s inside, use Raw NBT for now.')) : null,
      h('div', { class: 'item-form' },
        field('Item id', id),
        h('div', { class: 'row' }, field('Count', count), field('Damage / data', damage)),
        field('Custom name', customName),
        h('div', { class: 'field' }, h('span', { class: 'k' }, 'Enchantments'), enchRows,
          h('button', { class: 'small', onclick: () => addEnchRow() }, '+ Add enchantment'))),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { class: 'primary', onclick: save }, it ? 'Save changes' : 'Put item in slot'),
        it ? h('button', { class: 'danger', onclick: remove }, 'Remove item') : null,
        h('span', { class: 'muted small-text' }, 'Nothing changes in the world until you save it.')));
  }

  async afterEdit(message) {
    await this.app.reloadPlayers();
    await this.app.refreshPending();
    this.renderList();
    this.renderPlayer();
    toast(message);
  }

  onPendingChanged() {}
}
