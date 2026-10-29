// Turns Bedrock item NBT into something readable.

import { T, child, val } from './nbt.js';

export const ENCHANTMENTS = [
  'Protection', 'Fire Protection', 'Feather Falling', 'Blast Protection', 'Projectile Protection',
  'Thorns', 'Respiration', 'Depth Strider', 'Aqua Affinity', 'Sharpness', 'Smite',
  'Bane of Arthropods', 'Knockback', 'Fire Aspect', 'Looting', 'Efficiency', 'Silk Touch',
  'Unbreaking', 'Fortune', 'Power', 'Punch', 'Flame', 'Infinity', 'Luck of the Sea', 'Lure',
  'Frost Walker', 'Mending', 'Curse of Binding', 'Curse of Vanishing', 'Impaling', 'Riptide',
  'Loyalty', 'Channeling', 'Multishot', 'Piercing', 'Quick Charge', 'Soul Speed', 'Swift Sneak',
  'Wind Burst', 'Density', 'Breach',
];

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
export const roman = (n) => ROMAN[n] ?? String(n);

const SPECIAL_NAMES = { tnt: 'TNT', tnt_minecart: 'Minecart with TNT', totem_of_undying: 'Totem of Undying' };
const SMALL_WORDS = new Set(['of', 'and', 'the', 'on', 'a', 'with']);

export function prettyName(id) {
  if (!id) return '';
  const bare = id.replace(/^minecraft:/, '');
  if (SPECIAL_NAMES[bare]) return SPECIAL_NAMES[bare];
  return bare.split(/[_:]/).filter(Boolean).map((w, i) => (i && SMALL_WORDS.has(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
}

// Bedrock text uses § codes for colour and style; strip them for display.
export const stripFormatting = (s) => (typeof s === 'string' ? s.replace(/§./g, '') : s);

function itemList(tag) {
  if (!tag || tag.t !== T.List) return null;
  if (tag.v.length && tag.v[0].t !== T.Compound) return null;
  return tag.v;
}

// item: an NBT compound for one item stack. Returns null for empty slots.
export function readItem(item, depth = 0) {
  if (!item || item.t !== T.Compound) return null;
  const name = val(item, 'Name');
  const count = val(item, 'Count') ?? 0;
  if (!name || count === 0) return null;
  const extra = child(item, 'tag');
  const out = {
    id: name,
    name: prettyName(name),
    count,
    damage: val(item, 'Damage') ?? 0,
    slot: val(item, 'Slot'),
    enchants: [],
    customName: null,
    lore: null,
    contents: null,
    book: null,
  };
  if (extra) {
    for (const e of itemList(child(extra, 'ench')) ?? []) {
      const id = val(e, 'id'), lvl = val(e, 'lvl');
      out.enchants.push({ id, level: lvl, name: `${ENCHANTMENTS[id] ?? 'Enchantment #' + id} ${roman(lvl)}` });
    }
    const display = child(extra, 'display');
    if (display) {
      const cn = val(display, 'Name');
      if (cn) out.customName = stripFormatting(cn);
      const lore = child(display, 'Lore');
      if (lore && lore.t === T.List) out.lore = lore.v.map((l) => stripFormatting(l.v));
    }
    const repair = val(extra, 'RepairCost');
    if (repair) out.repairCost = repair;
    const author = val(extra, 'author');
    const title = val(extra, 'title');
    if (author || title) out.book = { author: author ?? null, title: title ?? null };
    // Shulker boxes and other containers carry their contents in tag.Items.
    const inner = itemList(child(extra, 'Items'));
    if (inner && depth < 8) out.contents = inner.map((i) => readItem(i, depth + 1)).filter(Boolean);
  }
  return out;
}

// byIndex: the slot is the item's position in the list (armor, offhand)
// rather than its Slot field.
export function readItems(listTag, byIndex = false) {
  const list = itemList(listTag);
  if (!list) return [];
  return list.map((i, index) => {
    const it = readItem(i);
    if (it && (byIndex || it.slot === undefined)) it.slot = index;
    return it;
  }).filter(Boolean);
}

// Every item in a list, including items inside containers, flattened.
export function* walkItems(items, path = []) {
  for (const it of items) {
    yield { item: it, path };
    if (it.contents) yield* walkItems(it.contents, [...path, it.customName ?? it.name]);
  }
}

// Pulls out what a moderator wants to see from a player record.
export function summarizePlayer(root) {
  const pos = child(root, 'Pos');
  const p = pos && pos.t === T.List ? pos.v.map((x) => x.v) : null;
  const dim = val(root, 'DimensionId') ?? 0;
  const abilities = child(root, 'abilities');
  return {
    pos: p,
    dim,
    level: val(root, 'PlayerLevel') ?? 0,
    gameMode: val(root, 'PlayerGameMode'),
    permissions: val(root, 'permissionsLevel') ?? val(root, 'playerPermissionsLevel'),
    op: abilities ? val(abilities, 'op') : undefined,
    uniqueId: val(root, 'UniqueID'),
    spawn: val(root, 'SpawnX') !== undefined && val(root, 'SpawnX') !== -2147483648
      ? [val(root, 'SpawnX'), val(root, 'SpawnY'), val(root, 'SpawnZ'), val(root, 'SpawnDimension') ?? 0] : null,
    dead: !!val(root, 'Dead'),
    inventory: readItems(child(root, 'Inventory')),
    armor: readItems(child(root, 'Armor'), true),
    offhand: readItems(child(root, 'Offhand'), true),
    mainhand: readItems(child(root, 'Mainhand'), true),
    enderChest: readItems(child(root, 'EnderChestInventory')),
  };
}

export const GAME_MODES = ['Survival', 'Creative', 'Adventure', 'Spectator'];
