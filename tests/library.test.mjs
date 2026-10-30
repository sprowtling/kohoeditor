// Books and maps: finding every copy, listing maps, and putting murals together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/lib/world.js';
import { FIXTURE, folderFiles } from './helpers.mjs';

const open = () => { const w = new World(folderFiles(FIXTURE)); w.scan(); return w; };

test('every copy of every book is found, wherever it is', () => {
  const w = open();
  assert.ok(w.stats.itemRecords >= 2, 'the scan noted records holding books or maps');
  const { books } = w.items();
  const lore = books.filter((b) => b.title === 'Koholint Lore');
  assert.equal(lore.length, 4);
  assert.equal(new Set(lore.map((b) => b.content)).size, 1, 'copies share their content id');
  const where = (b) => `${b.location.kind}:${b.location.container ?? b.location.list}:${b.location.path.join('>')}`;
  const original = lore.find((b) => b.generation === 0);
  assert.equal(original.location.kind, 'player');
  assert.equal(original.location.list, 'inventory');
  assert.deepEqual(lore.map(where).sort(), [
    'block:Chest:Shulker Box “Archive”', 'block:Lectern:', 'player:ender chest:', 'player:inventory:',
  ].sort());
  assert.equal(original.author, 'SprowtlingFan');
  assert.equal(original.pages.length, 2);
  // A writable book in a minecart chest, in the Overworld.
  const draft = books.find((b) => b.kind === 'writable');
  assert.equal(draft.location.kind, 'entity');
  assert.equal(draft.location.container, 'Chest Minecart');
  assert.equal(draft.location.dim, 0);
  assert.equal(draft.pages[0], 'Draft: quest ideas');
  assert.ok(books.some((b) => b.title === 'Quest: The Egg'));
});

test('maps are listed with their pictures and details', () => {
  const w = open();
  const maps = w.mapList();
  assert.equal(maps.length, 8);
  const by = Object.fromEntries(maps.map((m) => [m.id, m]));
  assert.equal(by['-100'].locked, true);
  assert.equal(by['-101'].locked, false);
  assert.equal(by['-100'].drawn, 1);
  assert.equal(by['-107'].drawn, 0, 'a blank map');
  assert.equal(by['-101'].drawn, 0.5);
  assert.equal(by['-100'].hash, by['-102'].hash, 'duplicates share a picture hash');
  assert.notEqual(by['-100'].hash, by['-101'].hash);
  assert.equal(by['-100'].thumb.length, 32 * 32 * 4);
  const full = w.readMap('-104');
  assert.equal(full.colors.length, 128 * 128 * 4);
  assert.deepEqual([...full.colors.subarray(127 * 4, 127 * 4 + 4)], [40, 200, 40, 255]);
});

test('map items are found in frames, chests and inventories', () => {
  const { maps } = open().items();
  const kinds = (id) => (maps.get(id) ?? []).map((l) => `${l.kind}:${l.container ?? l.list}`).sort();
  assert.deepEqual(kinds('-100'), ['block:Item Frame', 'player:inventory']);
  assert.deepEqual(kinds('-101'), ['block:Chest']);
  assert.equal(maps.get('-101')[0].path[0], 'Shulker Box “Archive”');
  assert.equal(maps.has('-107'), false, 'nothing holds the blank map');
});

test('a wall of framed maps comes back together the right way round', () => {
  const murals = open().murals();
  assert.equal(murals.length, 1, 'one mural (the single framed map is not one)');
  const m = murals[0];
  assert.equal(m.facing, 3);
  assert.deepEqual([m.width, m.height], [2, 2]);
  const at = Object.fromEntries(m.tiles.map((t) => [`${t.u},${t.v}`, t.mapId]));
  // Facing south, so seen from the south: x grows to the right, y grows upward.
  assert.deepEqual(at, { '0,0': '-103', '1,0': '-104', '0,1': '-105', '1,1': '-106' });
});

test('junk maps can be deleted together, and undone together', () => {
  const w = open();
  const junk = w.mapList().filter((m) => m.drawn < 0.02);
  assert.equal(junk.length, 1);
  w.deleteRecords(junk.map((m) => m.key), '1 map');
  assert.equal(w.mapList().length, 7);
  const op = w.pending().operations.find((o) => o.type === 'records');
  assert.equal(op.label, 'Deleted: 1 map');
  // The book and map lists notice the change.
  assert.equal(w.items().maps.has('-107'), false);
  w.undoOperation(op.id);
  assert.equal(w.mapList().length, 8);
});
