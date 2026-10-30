// Finding books and maps wherever they are: in players' inventories and ender
// chests, in chests and other block entities (and in shulker boxes inside
// those), and in entities (minecart chests, donkeys, dropped items...).
//
// Books have no list of their own in a Bedrock world: each book's title,
// author and pages live in the book item itself. Maps do have records
// (map_<id>), but the items pointing at them can be anywhere.

import { T, child, val, parseAll } from './nbt.js';
import { parseChunkKey, isActorKey } from './keys.js';
import { prettyName, stripFormatting } from './items.js';
import { fromHex, utf8 } from './bytes.js';
import { crc32 } from './crc.js';

const BOOKS = new Set(['minecraft:written_book', 'minecraft:writable_book']);
const MAP_ITEMS = new Set(['minecraft:filled_map']);
const FRAMES = new Set(['ItemFrame', 'GlowItemFrame']);

// A short, friendly name for a block entity's id ("Chest", "ShulkerBox"...).
function containerName(id) {
  return String(id ?? 'Block').replace(/([a-z])([A-Z])/g, '$1 $2');
}

function itemLabel(item) {
  const name = val(item, 'Name');
  const custom = val(child(item, 'tag'), 'display', 'Name');
  return custom ? `${prettyName(name)} “${stripFormatting(custom)}”` : prettyName(name);
}

function bookFrom(item, location) {
  const tag = child(item, 'tag');
  const pagesTag = child(tag, 'pages');
  const pages = pagesTag && pagesTag.t === T.List ? pagesTag.v.map((p) => (p.t === T.Compound ? val(p, 'text') ?? '' : p.t === T.String ? p.v : '')) : [];
  const written = val(item, 'Name') === 'minecraft:written_book';
  const title = written ? val(tag, 'title') ?? null : null;
  const author = written ? val(tag, 'author') ?? null : null;
  const generation = written ? val(tag, 'generation') ?? 0 : null;
  // Copies of the same book share their words; that's what groups them.
  const words = JSON.stringify([written, title, author, pages]);
  const content = `${crc32(utf8(words)).toString(16)}-${words.length}`;
  return { kind: written ? 'written' : 'writable', title, author, generation, pages, content, location };
}

// Walks an NBT tree, calling found(item, path) for each book or map item.
// path names the containers on the way down ("Shulker Box “Lore”", ...).
function walk(tag, path, found, depth = 0) {
  if (!tag || depth > 24) return;
  if (tag.t === T.Compound) {
    const name = val(tag, 'Name');
    if (typeof name === 'string' && (BOOKS.has(name) || MAP_ITEMS.has(name))) { found(tag, path); return; }
    const inside = typeof name === 'string' && name ? [...path, itemLabel(tag)] : path;
    for (const c of tag.v) if (c.t === T.Compound || c.t === T.List) walk(c, inside, found, depth + 1);
  } else if (tag.t === T.List) {
    for (const c of tag.v) if (c.t === T.Compound || c.t === T.List) walk(c, path, found, depth + 1);
  }
}

const PLAYER_LISTS = { Inventory: 'inventory', EnderChestInventory: 'ender chest', Armor: 'armor', Offhand: 'offhand', PlayerUIItems: 'crafting grid' };

// world: a World (scanned). Returns { books, maps: Map(mapId -> [location]), frames }.
export function collectItems(world) {
  const books = [];
  const maps = new Map();
  const frames = [];
  const found = (location) => (item, path) => {
    const where = { ...location, path };
    const name = val(item, 'Name');
    if (BOOKS.has(name)) books.push(bookFrom(item, where));
    else {
      const id = val(child(item, 'tag'), 'map_uuid');
      if (id === undefined) return;
      const key = String(id);
      if (!maps.has(key)) maps.set(key, []);
      maps.get(key).push(where);
    }
  };

  // Players
  for (const p of world.playerKeys ?? []) {
    const v = world.get(fromHex(p.key));
    if (!v) continue;
    let root;
    try { root = parseAll(v).roots[0]; } catch { continue; }
    const dim = val(root, 'DimensionId') ?? 0;
    const pos = (child(root, 'Pos')?.v ?? []).map((x) => x.v);
    for (const [list, label] of Object.entries(PLAYER_LISTS)) {
      walk(child(root, list), [], found({ kind: 'player', playerKey: p.key, list: label, dim, pos }));
    }
  }

  // Block entities and entities the scan found books or maps in
  for (const [hex] of world.itemRecords ?? []) {
    const key = fromHex(hex);
    const v = world.get(key);
    if (!v) continue;
    let roots;
    try { roots = parseAll(v).roots; } catch { continue; }
    const c = parseChunkKey(key);
    const dim = c ? c.dim : null;
    for (const root of roots) {
      const id = val(root, 'id');
      const identifier = val(root, 'identifier');
      if (c && c.tag === 0x31) {
        const pos = [val(root, 'x'), val(root, 'y'), val(root, 'z')];
        const loc = { kind: 'block', container: containerName(id), dim, pos, recordKey: hex };
        if (FRAMES.has(id)) {
          const item = child(root, 'Item');
          if (item && MAP_ITEMS.has(val(item, 'Name'))) {
            const mapId = val(child(item, 'tag'), 'map_uuid');
            if (mapId !== undefined) frames.push({ dim, pos, mapId: String(mapId), rotation: val(root, 'ItemRotation') ?? 0, glow: id === 'GlowItemFrame' });
          }
        }
        walk(root, [], found(loc));
      } else {
        // An entity: stored on its own (actorprefix) or, in older worlds, in its chunk.
        const p = (child(root, 'Pos')?.v ?? []).map((x) => x.v);
        const name = identifier ? prettyName(identifier) : containerName(id);
        const entDim = dim ?? (isActorKey(key) ? world.actorDimension(hex) : null);
        walk(root, [], found({ kind: 'entity', container: name, dim: entDim, pos: p.map((x) => Math.floor(x)), recordKey: hex }));
      }
    }
  }
  return { books, maps, frames };
}
