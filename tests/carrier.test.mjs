// The pet carrier: moving pets within a world, and carrying them to another.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { World } from '../src/lib/world.js';
import { pickUp, setDown, encodeCarrier, decodeCarrier, findOwner } from '../src/lib/carrier.js';
import { digpKey } from '../src/lib/keys.js';
import { toHex, fromHex, utf8 } from '../src/lib/bytes.js';
import { parse, val, child } from '../src/lib/nbt.js';
import { FIXTURE, folderFiles, copyFixture, saveInPlace } from './helpers.mjs';

const open = (dir = FIXTURE) => { const w = new World(folderFiles(dir)); w.scan(); return w; };
const P1 = toHex(utf8('player_server_11111111-2222-4333-8444-555555555555'));
const P2 = toHex(utf8('player_server_66666666-7777-4888-8999-000000000000'));

test('a pet moves within its world, keeps its owner, and leaves no copy behind', () => {
  const dir = copyFixture();
  const w = open(dir);
  const biscuit = w.mobs().find((m) => m.name === 'Biscuit');
  const pets = pickUp(w, [biscuit]);
  assert.equal(pets[0].owner.playerId, '11111111-2222-4333-8444-555555555555');
  const r = setDown(w, pets, { mode: 'coords', dim: 0, pos: [10, 70, 20] }, [findOwner(w, pets[0])]);
  assert.deepEqual(r.problems, []);
  assert.equal(w.pending().operations.at(-1).label, 'Set down Biscuit at 10, 70, 20');
  saveInPlace(w, dir);

  const w2 = open(dir);
  const all = w2.mobs().filter((m) => m.name === 'Biscuit');
  assert.equal(all.length, 1, 'exactly one Biscuit');
  assert.deepEqual(all[0].pos, [10, 70, 20]);
  assert.equal(all[0].owner, P1);
  assert.equal(all[0].sitting, true, 'everything else about it is kept');
  // Its old chunk no longer lists it; its new chunk does.
  assert.equal(w2.chunkDetail(0, 5, 5).entities.some((e) => e.key === biscuit.recordKey), false);
  assert.equal(w2.chunkDetail(0, 0, 1).entities.length >= 1, true);
  // The new record's storage key matches its database key.
  const rec = parse(w2.get(fromHex(all[0].recordKey)));
  const sk = child(child(child(rec, 'internalComponents'), 'EntityStorageKeyComponent'), 'StorageKey');
  assert.equal(toHex(sk.raw ?? utf8(sk.v)), all[0].recordKey.slice(-16));
  fs.rmSync(dir, { recursive: true });
});

test('a mob kept the older way (inside its chunk) can be moved too', () => {
  const w = open();
  const bob = w.mobs().find((m) => m.name === 'Bob');
  const r = setDown(w, pickUp(w, [bob]), { mode: 'coords', dim: 0, pos: [-40, 64, -40] }, [null]);
  assert.deepEqual(r.problems, []);
  const now = w.mobs().filter((m) => m.name === 'Bob');
  assert.equal(now.length, 1);
  assert.deepEqual(now[0].pos, [-40, 64, -40]);
  assert.notEqual(now[0].recordKey, bob.recordKey, 'it now has a record of its own');
});

test('pets travel to another world in a carrier file and find their owners there', () => {
  const w = open();
  const ned = w.mobs().find((m) => m.name === 'Ned');
  const file = encodeCarrier(pickUp(w, [ned]), 'Old Koholint');
  // Pretend the file is opened in a different world (the same players have joined it).
  const pets = decodeCarrier(file).map((p) => ({ ...p, from: { ...p.from, world: 'another world' } }));
  assert.equal(pets[0].name, 'Ned');
  const target = open();
  const owner = findOwner(target, pets[0]);
  assert.equal(owner, P2, 'matched by Microsoft account id');
  const r = setDown(target, pets, { mode: 'owner' }, [owner]);
  assert.deepEqual(r.problems, []);
  // Set down next to its owner, who is in the Nether; the original stays put (it's a copy now).
  const neds = target.mobs().filter((m) => m.name === 'Ned');
  assert.equal(neds.length, 2);
  const arrived = neds.find((m) => m.dim === 1);
  assert.deepEqual(arrived.pos, [-19, 40, 10]);
  assert.equal(arrived.owner, P2);
  assert.equal(arrived.chest[0].name, 'Diamond', 'still carrying its things');
});

test('a pet can\'t be set down where the world hasn\'t been generated', () => {
  const w = open();
  const cat = w.mobs().find((m) => m.kind === 'Cat');
  const r = setDown(w, pickUp(w, [cat]), { mode: 'coords', dim: 0, pos: [100000, 64, 100000] }, [null]);
  assert.equal(r.op, null);
  assert.match(r.problems[0], /hasn't been generated/);
  assert.equal(w.edits.size, 0, 'nothing changed');
});
