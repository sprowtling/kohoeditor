// Makes player records for a test world: copies of the world's local player
// with different inventories. Prints JSON {hexKey: hexValue} for put.py.
import fs from 'node:fs';
import { parse, serialize, T } from '../../src/lib/nbt.js';
import { toHex, fromHex } from '../../src/lib/bytes.js';

const [localHex] = [fs.readFileSync(0, 'utf8').trim()];
const base = () => parse(fromHex(localHex));
const S = (n, v) => ({ n, t: T.String, v });
const B = (n, v) => ({ n, t: T.Byte, v });
const Sh = (n, v) => ({ n, t: T.Short, v });
const I = (n, v) => ({ n, t: T.Int, v });
const C = (n, v) => ({ n, t: T.Compound, v });
const L = (n, et, v) => ({ n, t: T.List, et, v });
const ench = (list) => C('tag', [L('ench', T.Compound, list.map(([id, lvl]) => ({ t: T.Compound, v: [Sh('id', id), Sh('lvl', lvl)] })))]);
const item = (slot, name, count, extra = []) => ({ t: T.Compound, v: [B('Count', count), Sh('Damage', 0), S('Name', name), B('Slot', slot), B('WasPickedUp', 0), ...extra] });
const empty = (slot) => item(slot, '', 0);

function set(root, name, tag) {
  const i = root.v.findIndex((c) => c.n === name);
  tag.n = name;
  if (i >= 0) root.v[i] = tag; else root.v.push(tag);
}
function inv(items, size = 36) {
  const bySlot = new Map(items.map((i) => [i.v.find((c) => c.n === 'Slot').v, i]));
  return L(null, T.Compound, Array.from({ length: size }, (_, s) => bySlot.get(s) ?? empty(s)));
}

const players = [
  { id: '6d1e3a90-1c2b-4f6e-9a77-0b1c2d3e4f50', pos: [120.5, 70, -340.2], dim: 0, lvl: 31, items: [
    item(0, 'minecraft:netherite_sword', 1, [ench([[9, 5], [17, 3], [26, 1], [14, 3]])]),
    item(1, 'minecraft:diamond_pickaxe', 1, [ench([[15, 5], [18, 3]])]),
    item(2, 'minecraft:cooked_beef', 48), item(8, 'minecraft:totem_of_undying', 1),
    item(10, 'minecraft:shulker_box', 1, [C('tag', [L('Items', T.Compound, [item(0, 'minecraft:diamond_block', 64), item(1, 'minecraft:diamond_block', 64), item(2, 'minecraft:netherite_ingot', 12), item(3, 'minecraft:enchanted_golden_apple', 5)])])]),
    item(20, 'minecraft:elytra', 1, [C('tag', [C('display', [S('Name', '§6Wings of Koho')])])]),
    item(21, 'minecraft:written_book', 1, [C('tag', [S('author', 'SprowtlingFan'), S('title', 'Rules of the Server')])]),
  ], ender: [item(0, 'minecraft:diamond', 64), item(1, 'minecraft:tnt', 64)] },
  { id: 'a4b5c6d7-e8f9-4a0b-8c1d-2e3f40516273', pos: [-15.2, 34, 88.9], dim: 1, lvl: 4, items: [
    item(0, 'minecraft:stone_pickaxe', 1), item(1, 'minecraft:torch', 23), item(5, 'minecraft:bread', 7),
  ], ender: [] },
  { id: '0f9e8d7c-6b5a-4433-9211-00aa11bb22cc', pos: [3000.0, 64, 3000.0], dim: 0, lvl: 12, items: [
    item(0, 'minecraft:tnt', 64), item(1, 'minecraft:tnt', 64), item(2, 'minecraft:flint_and_steel', 1), item(3, 'minecraft:lava_bucket', 1),
  ], ender: [item(5, 'minecraft:tnt', 64)] },
];
const out = {};
for (const p of players) {
  const r = base();
  set(r, 'Pos', L(null, T.Float, p.pos.map((v) => ({ t: T.Float, v }))));
  set(r, 'DimensionId', { t: T.Int, v: p.dim });
  set(r, 'PlayerLevel', { t: T.Int, v: p.lvl });
  set(r, 'Inventory', inv(p.items));
  set(r, 'EnderChestInventory', inv(p.ender, 27));
  out[toHex(new TextEncoder().encode('player_server_' + p.id))] = toHex(serialize(r));
  const link = { n: '', t: T.Compound, v: [S('MsaId', String(1000 + Object.keys(out).length)), S('SelfSignedId', p.id), S('ServerId', 'player_server_' + p.id)] };
  out[toHex(new TextEncoder().encode('player_' + p.id.replace(/-/g, '').slice(0, 16)))] = toHex(serialize(link));
}
process.stdout.write(JSON.stringify(out));
