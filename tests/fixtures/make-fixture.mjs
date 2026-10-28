// Generates the contents of the test world in tests/fixtures/world:
// chunks in all three dimensions, separately stored entities, players and a
// few named records. Prints JSON { puts: {hexKey: hexValue}, deletes: [hexKey] }
// for build-fixture.py, and writes level.dat and levelname.txt.
// Usage: node make-fixture.mjs <world dir>
import fs from 'node:fs';
import path from 'node:path';
import { serialize, serializeLevelDat, T } from '../../src/lib/nbt.js';
import { toHex, utf8 } from '../../src/lib/bytes.js';
import { chunkKey, digpKey, actorKey } from '../../src/lib/keys.js';

const out = process.argv[2];
const S = (n, v) => ({ n, t: T.String, v });
const B = (n, v) => ({ n, t: T.Byte, v });
const Sh = (n, v) => ({ n, t: T.Short, v });
const I = (n, v) => ({ n, t: T.Int, v });
const Lg = (n, v) => ({ n, t: T.Long, v: BigInt(v) });
const F = (v) => ({ t: T.Float, v });
const C = (n, v) => ({ n, t: T.Compound, v });
const L = (n, et, v) => ({ n, t: T.List, et, v });
const item = (slot, name, count, extra = []) => ({ t: T.Compound, v: [B('Count', count), Sh('Damage', 0), S('Name', name), B('Slot', slot), B('WasPickedUp', 0), ...extra] });
const inv = (items, size) => {
  const by = new Map(items.map((i) => [i.v[3].v, i]));
  return Array.from({ length: size }, (_, s) => by.get(s) ?? item(s, '', 0));
};
const player = (pos, dim, level, items, ender = []) => C('', [
  L('Pos', T.Float, pos.map(F)), I('DimensionId', dim), I('PlayerLevel', level), I('PlayerGameMode', 0),
  L('Inventory', T.Compound, inv(items, 36)), L('EnderChestInventory', T.Compound, inv(ender, 27)),
  L('Armor', T.Compound, [item(0, 'minecraft:diamond_helmet', 1), item(0, '', 0), item(0, '', 0), item(0, '', 0)]),
  L('Offhand', T.Compound, [item(0, 'minecraft:shield', 1)]),
  Lg('UniqueID', -4294967295), I('permissionsLevel', 1),
]);

const puts = {};
const put = (k, v) => { puts[toHex(k)] = toHex(v); };
const deletes = [];

// Deterministic pseudo-random bytes that compress about as well as real block data.
let seed = 12345;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16; };
const blockData = (n) => { const b = new Uint8Array(n); let run = 0, v = 0; for (let i = 0; i < n; i++) { if (!run) { run = 1 + (rand() % 40); v = rand() & 0xff; } b[i] = v; run--; } return b; };

let actorId = 1;
for (const [dim, size] of [[0, 6], [1, 3], [2, 2]]) {
  for (let x = -size; x < size; x++) for (let z = -size; z < size; z++) {
    put(chunkKey(x, z, dim, 0x2c), Uint8Array.of(40));
    put(chunkKey(x, z, dim, 0x2b), blockData(300));
    for (let sub = -4; sub < (dim === 0 ? 4 : 2); sub++) put(chunkKey(x, z, dim, 0x2f, sub), Uint8Array.of(9, 1, sub & 0xff, ...blockData(100 + (rand() % 200))));
    put(chunkKey(x, z, dim, 0x36), Uint8Array.of(2, 0, 0, 0));
    if ((x + z) % 3 === 0) {
      put(chunkKey(x, z, dim, 0x31), serialize(C('', [S('id', 'Chest'), I('x', x * 16 + 3), I('y', 64), I('z', z * 16 + 5),
        L('Items', T.Compound, [item(0, 'minecraft:diamond', 12), item(1, 'minecraft:shulker_box', 1, [C('tag', [L('Items', T.Compound, [item(0, 'minecraft:emerald', 30)])])])])])));
    }
    const ids = [];
    if ((x * 7 + z) % 4 === 0) {
      for (let k = 0; k < 2; k++) {
        const id = new Uint8Array(8);
        new DataView(id.buffer).setUint32(4, actorId++, false);
        ids.push(id);
        put(actorKey(id), serialize(C('', [S('identifier', k ? 'minecraft:cow' : 'minecraft:zombie'), L('Pos', T.Float, [F(x * 16 + 8), F(70), F(z * 16 + 8)])])));
      }
    }
    const d = new Uint8Array(ids.length * 8);
    ids.forEach((id, i) => d.set(id, i * 8));
    put(digpKey(x, z, dim), d);
  }
}
// A chunk that existed once and was deleted, so the database holds deletion markers.
put(chunkKey(40, 40, 0, 0x2c), Uint8Array.of(40));
deletes.push(toHex(chunkKey(40, 40, 0, 0x2c)));

put(utf8('~local_player'), serialize(player([0.5, 70, 0.5], 0, 3, [item(0, 'minecraft:wooden_sword', 1)])));
const people = [
  ['11111111-2222-4333-8444-555555555555', [100, 64, -50], 0, 30, [
    item(0, 'minecraft:netherite_sword', 1, [C('tag', [L('ench', T.Compound, [{ t: T.Compound, v: [Sh('id', 9), Sh('lvl', 5)] }]), C('display', [S('Name', '§bExcalibur')])])]),
    item(9, 'minecraft:tnt', 64), item(10, 'minecraft:tnt', 64),
  ], [item(0, 'minecraft:elytra', 1)]],
  ['66666666-7777-4888-8999-000000000000', [-20, 40, 10], 1, 5, [item(0, 'minecraft:torch', 20)], []],
];
for (const [uuid, pos, dim, lvl, items, ender] of people) {
  put(utf8('player_server_' + uuid), serialize(player(pos, dim, lvl, items, ender)));
  put(utf8('player_' + uuid.slice(0, 8)), serialize(C('', [S('MsaId', '2535' + uuid.slice(0, 8)), S('SelfSignedId', uuid), S('ServerId', 'player_server_' + uuid)])));
}
put(utf8('scoreboard'), serialize(C('', [L('Objectives', T.End, []), Lg('LastUniqueID', 0)])));
put(utf8('portals'), serialize(C('', [C('data', [L('PortalRecords', T.End, [])])])));
put(utf8('mobevents'), serialize(C('', [B('events_enabled', 1)])));

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'levelname.txt'), 'Fixture World');
fs.writeFileSync(path.join(out, 'level.dat'), serializeLevelDat(10, C('', [
  S('LevelName', 'Fixture World'), Lg('RandomSeed', 424242), I('SpawnX', 0), I('SpawnY', 64), I('SpawnZ', 0), I('GameType', 0),
  L('lastOpenedWithVersion', T.Int, [1, 21, 50, 0, 0].map((v) => ({ t: T.Int, v }))),
])));
process.stdout.write(JSON.stringify({ puts, deletes }));
