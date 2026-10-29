// Biomes, item editing, level.dat editing, copy and paste, and undo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { World, parseMetaDictionary, encodeMetaDictionary, encodeClipboard, decodeClipboard, CHUNK_PASTED, CHUNK_DELETED } from '../src/lib/world.js';
import { Table, summarizeTable } from '../src/lib/leveldb.js';
import { extractSurface, biomeName } from '../src/lib/biomes.js';
import { chunkKey, digpKey, actorKey } from '../src/lib/keys.js';
import { parse, parseAll, serialize, toPlain, val, T } from '../src/lib/nbt.js';
import { toHex, fromHex, utf8, equalBytes } from '../src/lib/bytes.js';
import { FIXTURE, folderFiles, copyFixture, saveInPlace } from './helpers.mjs';

const P1 = toHex(utf8('player_server_11111111-2222-4333-8444-555555555555'));

function open(dir = FIXTURE) {
  const w = new World(folderFiles(dir));
  w.scan();
  return w;
}

const biomesOf = (w, dim, x, z) => [...w.chunks[dim].get(`${x},${z}`).surface.subarray(0, 16)];
const heightsOf = (w, dim, x, z) => { const s = w.chunks[dim].get(`${x},${z}`).surface; return [...new Uint16Array(s.slice(16, 48).buffer)]; };

test('the scan samples surface biomes from new and old chunk formats', () => {
  const w = open();
  assert.deepEqual(biomesOf(w, 0, -1, 0), Array(16).fill(1), 'plains');
  assert.deepEqual(biomesOf(w, 0, 3, 0), Array(16).fill(4), 'forest');
  // Chunk 2,2 is split at x = 8: forest to the west, river to the east.
  assert.deepEqual(biomesOf(w, 0, 2, 2), Array(4).fill([4, 4, 7, 7]).flat());
  assert.deepEqual(heightsOf(w, 0, 2, 2), Array(16).fill(80));
  // The old-format chunk: desert, with its height moved onto the same scale.
  assert.deepEqual(biomesOf(w, 0, 20, 20), Array(16).fill(2));
  assert.deepEqual(heightsOf(w, 0, 20, 20), Array(16).fill(134));
  assert.deepEqual(biomesOf(w, 1, 0, 0), Array(16).fill(8));
  assert.equal(biomeName(8), 'Nether Wastes');
  // The parallel scan path carries the same samples.
  const w2 = new World(folderFiles(FIXTURE));
  const sums = new Map(w2.tableJobs().map((j) => [j.number, summarizeTable(new Table(w2.files.open(j.path), j.number), extractSurface)]));
  w2.scan(null, sums);
  for (const [id, c] of w.chunks[0]) assert.deepEqual(w2.chunks[0].get(id).surface, c.surface, id);
  const { list, surface } = w.chunkList(0);
  assert.equal(surface.length, (list.length / 4) * 48);
});

test('items can be added, changed and removed, and survive saving', () => {
  const dir = copyFixture();
  const w = open(dir);
  w.setItem(P1, 'Inventory', 5, { id: 'minecraft:diamond_sword', count: 1, damage: 0, customName: 'Prize', enchants: [{ id: 9, level: 3 }, { id: 17, level: 3 }] });
  w.setItem(P1, 'Inventory', 9, { id: 'minecraft:tnt', count: 32, damage: 0 }); // was 64
  w.setItem(P1, 'Inventory', 0, null); // the netherite sword
  w.setItem(P1, 'Armor', 1, { id: 'minecraft:iron_chestplate', count: 1, damage: 10 });
  w.setItem(P1, 'EnderChestInventory', 3, { id: 'minecraft:emerald', count: 64, damage: 0 });
  assert.throws(() => w.setItem(P1, 'Inventory', 6, { id: 'diamond', count: 1 }), /minecraft:diamond_sword/);
  assert.throws(() => w.setItem(P1, 'Inventory', 6, { id: 'minecraft:dirt', count: 100 }), /1 to 64/);
  saveInPlace(w, dir);

  const p = open(dir).players().find((x) => x.key === P1).summary;
  const at = (list, slot) => list.find((i) => i.slot === slot);
  const sword = at(p.inventory, 5);
  assert.equal(sword.name, 'Diamond Sword');
  assert.equal(sword.customName, 'Prize');
  assert.deepEqual(sword.enchants.map((e) => e.name), ['Sharpness III', 'Unbreaking III']);
  assert.equal(at(p.inventory, 9).count, 32);
  assert.equal(at(p.inventory, 0), undefined, 'slot 0 is empty');
  assert.equal(at(p.armor, 1).name, 'Iron Chestplate');
  assert.equal(at(p.armor, 0).name, 'Diamond Helmet', 'other armor untouched');
  assert.equal(at(p.enderChest, 3).count, 64);
  assert.equal(at(p.enderChest, 0).name, 'Elytra');
  // Inventory still has exactly one entry per slot.
  const root = parse(open(dir).get(fromHex(P1)));
  const slots = val(root, 'Inventory').map((e) => val(e, 'Slot'));
  assert.equal(new Set(slots).size, slots.length);
  fs.rmSync(dir, { recursive: true });
});

test('changing an item to a different one drops the old item\'s extra data', () => {
  const w = open();
  // Slot 0 holds a named, enchanted netherite sword.
  w.setItem(P1, 'Inventory', 0, { id: 'minecraft:stick', count: 3, damage: 0 });
  const stick = w.players().find((x) => x.key === P1).summary.inventory.find((i) => i.slot === 0);
  assert.equal(stick.name, 'Stick');
  assert.equal(stick.customName, null);
  assert.equal(stick.enchants.length, 0);
  // Keeping the same item keeps its name unless it is changed.
  w.setItem(P1, 'Inventory', 9, { id: 'minecraft:tnt', count: 5, damage: 0, customName: 'Boom' });
  w.setItem(P1, 'Inventory', 9, { id: 'minecraft:tnt', count: 6, damage: 0, customName: 'Boom' });
  const tnt = w.players().find((x) => x.key === P1).summary.inventory.find((i) => i.slot === 9);
  assert.equal(tnt.count, 6);
  assert.equal(tnt.customName, 'Boom');
});

test('level.dat edits are saved, renaming the world too, and can be undone', () => {
  const dir = copyFixture();
  const w = open(dir);
  const tag = w.currentLevelDat();
  const nameAt = tag.v.findIndex((c) => c.n === 'LevelName');
  const seedAt = tag.v.findIndex((c) => c.n === 'RandomSeed');
  w.editLevelDat([{ path: [0, nameAt], action: 'set', value: 'Koho Season 2' }, { path: [0, seedAt], action: 'set', value: '777' }]);
  assert.throws(() => w.editLevelDat([{ path: [0, seedAt], action: 'set', value: 'abc' }]), /whole number/);
  assert.equal(w.pending().operations.length, 1);
  saveInPlace(w, dir);
  const w2 = open(dir);
  assert.equal(w2.levelName, 'Koho Season 2');
  assert.equal(w2.info().seed, '777');
  // Undo takes it out of what will be saved.
  const op = w.pending().operations[0];
  w.undoOperation(op.id);
  assert.deepEqual(w.changedFiles(), []);
  fs.rmSync(dir, { recursive: true });
});

test('copied chunks paste elsewhere with their chests and mobs moved along', () => {
  const dir = copyFixture();
  const w = open(dir);
  // Chunk 0,0 has a chest and two entities (a zombie, and a cow leashed to it).
  const src = w.chunkDetail(0, 0, 0);
  assert.equal(src.entities.length, 2);
  const info = w.copyChunks(0, [[0, 0], [1, 0]]);
  assert.equal(info.count, 2);
  const res = w.pasteChunks(0, 30, 40);
  assert.equal(res.count, 2);
  // Also paste over an existing chunk, which must be replaced completely.
  const before = w.chunkDetail(0, -4, 0);
  assert.equal(before.entities.length, 2);
  w.copyChunks(0, [[1, 1]]); // no chest, two different entities
  w.pasteChunks(0, -4, 0);
  saveInPlace(w, dir);

  const w2 = open(dir);
  // The original is still there.
  assert.equal(w2.chunkDetail(0, 0, 0).entities.length, 2);
  // The copy: every record present, with block positions moved by 30 and 40 chunks.
  const keysOf = (x, z) => w2.chunkKeys(0, x, z).filter((k) => k.length <= 10).map((k) => toHex(k).slice(16)).sort();
  assert.deepEqual(keysOf(30, 40), keysOf(0, 0));
  const chest = toPlain(parseAll(w2.get(chunkKey(30, 40, 0, 0x31))).roots[0]);
  assert.deepEqual([chest.x, chest.y, chest.z], [30 * 16 + 3, 64, 40 * 16 + 5]);
  assert.equal(chest.Items[1].tag.Items[0].Name, 'minecraft:emerald', 'shulker contents come along');
  // Subchunk block data is copied byte for byte.
  assert.ok(equalBytes(w2.get(chunkKey(30, 40, 0, 0x2f, 0)), w2.get(chunkKey(0, 0, 0, 0x2f, 0))));
  // Entities: new ids, moved, storage key matching, leash pointing at the new zombie.
  const moved = w2.chunkDetail(0, 30, 40).entities;
  assert.equal(moved.length, 2);
  const ents = moved.map((e) => ({ key: e.key, nbt: parse(w2.get(fromHex(e.key))) }));
  const orig = new Set(src.entities.map((e) => e.key));
  for (const e of ents) {
    assert.ok(!orig.has(e.key), 'entity got a new key');
    const pos = val(e.nbt, 'Pos').map((p) => p.v);
    assert.deepEqual([pos[0], pos[2]], [30 * 16 + 8, 40 * 16 + 8]);
    const sk = e.nbt.v.find((c) => c.n === 'internalComponents').v[0].v[0];
    assert.equal(toHex(sk.raw ?? utf8(sk.v)), e.key.slice(-16), 'storage key matches');
  }
  const zombie = ents.find((e) => val(e.nbt, 'identifier') === 'minecraft:zombie');
  const cow = ents.find((e) => val(e.nbt, 'identifier') === 'minecraft:cow');
  assert.equal(val(cow.nbt, 'LeasherID'), val(zombie.nbt, 'UniqueID'));
  assert.ok(val(zombie.nbt, 'UniqueID') < 0n, 'ids come from the reserved range');
  // The overwritten chunk lost its old entities and records, and has the pasted ones instead.
  const replaced = w2.chunkDetail(0, -4, 0).entities;
  assert.equal(replaced.length, 2);
  for (const e of before.entities) {
    assert.equal(w2.get(fromHex(e.key)), null);
    assert.ok(!replaced.some((r) => r.key === e.key));
  }
  assert.deepEqual(keysOf(-4, 0), keysOf(1, 1));
  assert.deepEqual(w2.stats.chunks, [147, 36, 16]);
  fs.rmSync(dir, { recursive: true });
});

test('pastes, deletes and edits undo cleanly, even when they overlap', () => {
  const w = open();
  const snapshot = () => [...w.edits.keys()].sort().join();
  w.copyChunks(0, [[0, 0]]);
  const paste = w.pasteChunks(0, 2, 2);
  assert.ok(w.chunkList(0).list.some((v, i) => i % 4 === 3 && v & CHUNK_PASTED));
  // Regenerating the pasted chunk, then undoing that, gives back the pasted chunk.
  const afterPaste = snapshot();
  w.deleteChunks(0, [[2, 2]]);
  assert.equal(w.get(chunkKey(2, 2, 0, 0x2b)), null);
  w.restoreChunks(0, [[2, 2]]);
  assert.equal(snapshot(), afterPaste);
  assert.ok(w.get(chunkKey(2, 2, 0, 0x31)), 'pasted chest is back');
  // Undoing the paste brings back the original chunk and its biome split.
  w.undoOperation(paste.id);
  assert.equal(w.edits.size, 0);
  assert.deepEqual(biomesOf(w, 0, 2, 2), Array(4).fill([4, 4, 7, 7]).flat());
  // Pasting over a chunk marked to regenerate replaces that, and undo puts the mark back.
  w.deleteChunks(0, [[3, 3]]);
  const p2 = w.pasteChunks(0, 3, 3);
  assert.equal(w.chunkList(0).list.some((v, i) => i % 4 === 3 && v & CHUNK_DELETED), false);
  w.undoOperation(p2.id);
  assert.equal(w.deleted[0].has('3,3'), true);
  assert.equal(w.get(chunkKey(3, 3, 0, 0x2b)), null);
  // Record edits merge into one undoable change per record.
  w.setItem(P1, 'Inventory', 1, { id: 'minecraft:apple', count: 2, damage: 0 });
  w.setItem(P1, 'Inventory', 2, { id: 'minecraft:apple', count: 3, damage: 0 });
  const recOps = w.pending().operations.filter((o) => o.type === 'record');
  assert.equal(recOps.length, 1);
  w.undoOperation(recOps[0].id);
  assert.equal(w.edits.has(P1), false);
});

test('copied chunks travel between worlds in a .kohochunks file', () => {
  const a = open();
  a.copyChunks(0, [[0, 0], [1, 1], [20, 20]]);
  const file = encodeClipboard(a.clipboard);
  const back = decodeClipboard(file);
  assert.equal(back.chunks.length, 3);
  assert.deepEqual(back.bounds, { x0: 0, z0: 0, x1: 20, z1: 20 });
  for (let i = 0; i < 3; i++) {
    assert.equal(back.chunks[i].records.length, a.clipboard.chunks[i].records.length);
    back.chunks[i].records.forEach((r, j) => assert.ok(equalBytes(r.value, a.clipboard.chunks[i].records[j].value)));
  }
  assert.throws(() => decodeClipboard(utf8('not a chunk file at all')), /kohochunks/);

  // Pasting into a world that lacks the chunks' settings entry adds it.
  const b = open();
  const info = b.loadClipboard(file);
  assert.equal(info.count, 3);
  const nbt = serialize({ n: '', t: T.Compound, v: [{ n: 'DimensionName', t: T.String, v: 'Overworld' }] });
  b.clipboard.meta.set('0102030405060708', nbt);
  b.pasteChunks(0, 100, 100);
  const dict = parseMetaDictionary(b.get(utf8('LevelChunkMetaDataDictionary')));
  assert.ok(equalBytes(dict.get('0102030405060708'), nbt));
  assert.ok(equalBytes(encodeMetaDictionary(dict), b.get(utf8('LevelChunkMetaDataDictionary'))));
  // The old-format chunk pasted along with the rest.
  assert.ok(b.get(chunkKey(120, 120, 0, 0x2d)));
});
