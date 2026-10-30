// Generates the contents of the test world in tests/fixtures/world:
// chunks in all three dimensions, separately stored entities, players and a
// few named records. Prints JSON { puts: {hexKey: hexValue}, deletes: [hexKey] }
// for build-fixture.py, and writes level.dat and levelname.txt.
// Usage: node make-fixture.mjs <world dir>
import fs from 'node:fs';
import path from 'node:path';
import { serialize, serializeAll, serializeLevelDat, T } from '../../src/lib/nbt.js';
import { toHex, utf8 } from '../../src/lib/bytes.js';
import { chunkKey, digpKey, actorKey } from '../../src/lib/keys.js';

const out = process.argv[2];
const S = (n, v) => ({ n, t: T.String, v });
const B = (n, v) => ({ n, t: T.Byte, v });
const Sh = (n, v) => ({ n, t: T.Short, v });
const I = (n, v) => ({ n, t: T.Int, v });
const Lg = (n, v) => ({ n, t: T.Long, v: BigInt(v) });
const Fl = (n, v) => ({ n, t: T.Float, v });
const BA = (n, bytes) => ({ n, t: T.ByteArray, v: new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length) });
const F = (v) => ({ t: T.Float, v });
const C = (n, v) => ({ n, t: T.Compound, v });
const L = (n, et, v) => ({ n, t: T.List, et, v });
const item = (slot, name, count, extra = []) => ({ t: T.Compound, v: [B('Count', count), Sh('Damage', 0), S('Name', name), B('Slot', slot), B('WasPickedUp', 0), ...extra] });
const inv = (items, size) => {
  const by = new Map(items.map((i) => [i.v[3].v, i]));
  return Array.from({ length: size }, (_, s) => by.get(s) ?? item(s, '', 0));
};
const player = (pos, dim, level, items, ender = [], uid = -4294967295) => C('', [
  L('Pos', T.Float, pos.map(F)), I('DimensionId', dim), I('PlayerLevel', level), I('PlayerGameMode', 0),
  L('Inventory', T.Compound, inv(items, 36)), L('EnderChestInventory', T.Compound, inv(ender, 27)),
  L('Armor', T.Compound, [item(0, 'minecraft:diamond_helmet', 1), item(0, '', 0), item(0, '', 0), item(0, '', 0)]),
  L('Offhand', T.Compound, [item(0, 'minecraft:shield', 1)]),
  Lg('UniqueID', uid), I('permissionsLevel', 1),
]);

// Maps: a map record holds its 128×128 picture as RGBA bytes.
function mapRecord(id, { locked = true, paint }) {
  const px = new Uint8Array(128 * 128 * 4);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const c = paint(x, y);
    if (c) px.set([...c, 255], (y * 128 + x) * 4);
  }
  return serialize(C('', [Lg('mapId', id), Lg('parentMapId', -1), B('dimension', 0), B('fullyExplored', 1), B('mapLocked', locked ? 1 : 0),
    B('scale', 0), Sh('height', 128), Sh('width', 128), B('unlimitedTracking', 0), I('xCenter', 64), I('zCenter', 64),
    L('decorations', T.End, []), BA('colors', px)]));
}
const mapItem = (slot, id) => item(slot, 'minecraft:filled_map', 1, [C('tag', [Lg('map_uuid', id)])]);
const book = (slot, title, author, generation, pages) => item(slot, 'minecraft:written_book', 1, [C('tag', [
  S('title', title), S('author', author), I('generation', generation),
  L('pages', T.Compound, pages.map((text) => ({ t: T.Compound, v: [S('text', text), S('photoname', '')] }))),
])]);
const LORE = ['In the beginning there was only the sea, and the Wind Fish slept.', 'Koholint rose from the waves, §6and the people came§r.'];

const puts = {};
const put = (k, v) => { puts[toHex(k)] = toHex(v); };
const deletes = [];

// Deterministic pseudo-random bytes that compress about as well as real block data.
let seed = 12345;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16; };
const blockData = (n) => { const b = new Uint8Array(n); let run = 0, v = 0; for (let i = 0; i < n; i++) { if (!run) { run = 1 + (rand() % 40); v = rand() & 0xff; } b[i] = v; run--; } return b; };

// Data3D: a heightmap (surface at y = 15, stored as height above y = -64), then
// biome sections. Section 0 is either one biome everywhere, or two biomes split
// at x = 8 (a 1-bit palette); every section above repeats the one below.
function data3d(biomeA, biomeB = null) {
  const w = [];
  const hm = new Uint8Array(512);
  const hv = new DataView(hm.buffer);
  for (let i = 0; i < 256; i++) hv.setInt16(i * 2, 80, true);
  w.push(hm);
  if (biomeB === null) {
    const s = new Uint8Array(5);
    s[0] = 0 << 1 | 1;
    new DataView(s.buffer).setInt32(1, biomeA, true);
    w.push(s);
  } else {
    const s = new Uint8Array(1 + 128 * 4 + 4 + 8);
    const dv = new DataView(s.buffer);
    s[0] = 1 << 1 | 1;
    for (let word = 64; word < 128; word++) dv.setUint32(1 + word * 4, 0xffffffff, true); // x >= 8
    dv.setInt32(1 + 512, 2, true);
    dv.setInt32(1 + 516, biomeA, true);
    dv.setInt32(1 + 520, biomeB, true);
    w.push(s);
  }
  for (let i = 1; i < 24; i++) w.push(Uint8Array.of(0xff));
  const out = new Uint8Array(w.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of w) { out.set(a, o); o += a.length; }
  return out;
}

let actorId = 1;
for (const [dim, size] of [[0, 6], [1, 3], [2, 2]]) {
  for (let x = -size; x < size; x++) for (let z = -size; z < size; z++) {
    put(chunkKey(x, z, dim, 0x2c), Uint8Array.of(40));
    const biome = dim === 1 ? 8 : dim === 2 ? 9 : x < 0 ? 1 : 4;
    put(chunkKey(x, z, dim, 0x2b), x === 2 && z === 2 && dim === 0 ? data3d(4, 7) : data3d(biome));
    for (let sub = -4; sub < (dim === 0 ? 4 : 2); sub++) put(chunkKey(x, z, dim, 0x2f, sub), Uint8Array.of(9, 1, sub & 0xff, ...blockData(100 + (rand() % 200))));
    put(chunkKey(x, z, dim, 0x36), Uint8Array.of(2, 0, 0, 0));
    if (dim === 0 && x === 4 && z === 4) continue; // made below: frames, a lectern and a chest
    if ((x + z) % 3 === 0) {
      put(chunkKey(x, z, dim, 0x31), serialize(C('', [S('id', 'Chest'), I('x', x * 16 + 3), I('y', 64), I('z', z * 16 + 5),
        L('Items', T.Compound, [item(0, 'minecraft:diamond', 12), item(1, 'minecraft:shulker_box', 1, [C('tag', [L('Items', T.Compound, [item(0, 'minecraft:emerald', 30)])])])])])));
    }
    const ids = [];
    if (dim === 0 && x === 5 && z === 5) {
      // A minecart chest holding a writable (unsigned) book.
      const id = new Uint8Array(8);
      new DataView(id.buffer).setUint32(4, 900, false);
      ids.push(id);
      put(actorKey(id), serialize(C('', [S('identifier', 'minecraft:chest_minecart'), L('Pos', T.Float, [F(88.5), F(65), F(88.5)]), Lg('UniqueID', 900),
        L('ChestItems', T.Compound, [item(0, 'minecraft:writable_book', 1, [C('tag', [L('pages', T.Compound, [{ t: T.Compound, v: [S('text', 'Draft: quest ideas'), S('photoname', '')] }])])])])])));
      // Pets: a named wolf (sitting), a named donkey with a chest, an unnamed cat, and a cow with an empty name.
      const health = (cur, max) => L('Attributes', T.Compound, [{ t: T.Compound, v: [S('Name', 'minecraft:health'), Fl('Current', cur), Fl('Max', max), Fl('Base', max)] }]);
      const pets = [
        [901, [S('identifier', 'minecraft:wolf'), S('CustomName', 'Biscuit'), B('IsTamed', 1), Lg('OwnerNew', -8589934001), B('Sitting', 1), health(20, 20)]],
        [902, [S('identifier', 'minecraft:donkey'), S('CustomName', '§6Ned'), B('IsTamed', 1), Lg('OwnerNew', -8589934002), B('Saddled', 1), B('Chested', 1), health(15, 22),
          L('ChestItems', T.Compound, [item(0, 'minecraft:diamond', 5)])]],
        [903, [S('identifier', 'minecraft:cat'), B('IsTamed', 1), Lg('OwnerNew', -8589934001), B('IsBaby', 1)]],
        [904, [S('identifier', 'minecraft:cow'), S('CustomName', ''), B('IsTamed', 0), Lg('OwnerNew', -1)]],
      ];
      for (const [n, fields] of pets) {
        const pid = new Uint8Array(8);
        new DataView(pid.buffer).setUint32(4, n, false);
        ids.push(pid);
        put(actorKey(pid), serialize(C('', [...fields, L('Pos', T.Float, [F(84.5), F(66), F(90.5)]), Lg('UniqueID', n), Lg('LeasherID', -1)])));
      }
    }
    if ((x * 7 + z) % 4 === 0) {
      let first = null;
      for (let k = 0; k < 2; k++) {
        const n = actorId++;
        const id = new Uint8Array(8);
        new DataView(id.buffer).setUint32(4, n, false);
        ids.push(id);
        // Like the game: the UniqueID and the storage key inside match the database key.
        put(actorKey(id), serialize(C('', [
          S('identifier', k ? 'minecraft:cow' : 'minecraft:zombie'), L('Pos', T.Float, [F(x * 16 + 8), F(70), F(z * 16 + 8)]),
          Lg('UniqueID', n), Lg('LeasherID', k ? first : -1),
          C('internalComponents', [C('EntityStorageKeyComponent', [S('StorageKey', String.fromCharCode(...id))])]),
        ])));
        first = n;
      }
    }
    const d = new Uint8Array(ids.length * 8);
    ids.forEach((id, i) => d.set(id, i * 8));
    put(digpKey(x, z, dim), d);
  }
}
// Chunk 4,4: a 2×2 wall of maps in item frames facing south (z 69, x 64-65,
// y 70-71), one more framed map, a lectern with the lore book, and a chest
// holding a shulker box with a copy of it and a map.
{
  const frame = (x, y, mapId, rot = 0) => C('', [S('id', 'ItemFrame'), I('x', x), I('y', y), I('z', 69), B('isMovable', 1),
    C('Item', mapItem(0, mapId).v.filter((c) => c.n !== 'Slot')), Fl('ItemRotation', rot), Fl('ItemDropChance', 1)]);
  const lectern = C('', [S('id', 'Lectern'), I('x', 70), I('y', 65), I('z', 70), B('hasBook', 1), I('page', 0),
    C('book', book(0, 'Koholint Lore', 'SprowtlingFan', 1, LORE).v.filter((c) => c.n !== 'Slot'))]);
  const shulker = item(0, 'minecraft:shulker_box', 1, [C('tag', [C('display', [S('Name', 'Archive')]), L('Items', T.Compound, [book(0, 'Koholint Lore', 'SprowtlingFan', 2, LORE), mapItem(1, -101)])])]);
  const chest = C('', [S('id', 'Chest'), I('x', 72), I('y', 65), I('z', 72), L('Items', T.Compound, [shulker])]);
  put(chunkKey(4, 4, 0, 0x31), serializeAll([frame(64, 71, -103), frame(65, 71, -104), frame(64, 70, -105), frame(65, 70, -106), frame(70, 70, -100, 90), lectern, chest]));
  // The subchunk for y 64-79 has the frame blocks, so their facing can be read.
  const air = serialize(C('', [S('name', 'minecraft:air'), C('states', []), I('version', 18100737)]));
  const fr = serialize(C('', [S('name', 'minecraft:frame'), C('states', [I('facing_direction', 3), B('item_frame_map_bit', 1)]), I('version', 18100737)]));
  const words = new Uint32Array(128);
  for (const [lx, ly] of [[0, 7], [1, 7], [0, 6], [1, 6], [6, 6]]) { const u = (lx << 8) | (5 << 4) | ly; words[u >> 5] |= 1 << (u & 31); }
  const head = Uint8Array.of(9, 1, 4, 1 << 1);
  const count = new Uint8Array(4); new DataView(count.buffer).setInt32(0, 2, true);
  const parts = [head, new Uint8Array(words.buffer), count, air, fr];
  const sc = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { sc.set(p, o); o += p.length; }
  put(chunkKey(4, 4, 0, 0x2f, 4), sc);
}
// Map records: art (and a duplicate), an exploration map, a blank one, and the four mural tiles.
put(utf8('map_-100'), mapRecord(-100, { paint: (x, y) => ((x >> 4) + (y >> 4)) % 2 ? [200, 30, 30] : [250, 250, 250] }));
put(utf8('map_-102'), mapRecord(-102, { paint: (x, y) => ((x >> 4) + (y >> 4)) % 2 ? [200, 30, 30] : [250, 250, 250] }));
put(utf8('map_-101'), mapRecord(-101, { locked: false, paint: (x, y) => (x < 64 ? [90, 140, 60] : null) }));
put(utf8('map_-107'), mapRecord(-107, { locked: false, paint: () => null }));
[[-103, [220, 40, 40]], [-104, [40, 200, 40]], [-105, [40, 40, 220]], [-106, [230, 220, 40]]].forEach(([id, c]) => {
  put(utf8('map_' + id), mapRecord(id, { paint: (x, y) => (x < 8 && y < 8 ? [0, 0, 0] : c) })); // black corner marks the top left
});

// An older-style entity record kept in its chunk: a named zombie.
put(chunkKey(3, 0, 0, 0x32), serializeAll([C('', [S('identifier', 'minecraft:zombie'), S('CustomName', 'Bob'), B('IsTamed', 0), L('Pos', T.Float, [F(50), F(64), F(5)]), Lg('UniqueID', 950)])]));

// An old (pre-1.18) chunk: Data2D holds a heightmap and one biome byte per column.
{
  const d2 = new Uint8Array(512 + 256);
  const dv = new DataView(d2.buffer);
  for (let i = 0; i < 256; i++) dv.setInt16(i * 2, 70, true);
  d2.fill(2, 512); // desert
  put(chunkKey(20, 20, 0, 0x2d), d2);
  put(chunkKey(20, 20, 0, 0x76), Uint8Array.of(7));
  put(chunkKey(20, 20, 0, 0x2f, 0), Uint8Array.of(8, 1, ...blockData(150)));
}
// A chunk that existed once and was deleted, so the database holds deletion markers.
put(chunkKey(40, 40, 0, 0x2c), Uint8Array.of(40));
deletes.push(toHex(chunkKey(40, 40, 0, 0x2c)));

put(utf8('~local_player'), serialize(player([0.5, 70, 0.5], 0, 3, [item(0, 'minecraft:wooden_sword', 1)])));
const people = [
  ['11111111-2222-4333-8444-555555555555', [100, 64, -50], 0, 30, [
    item(0, 'minecraft:netherite_sword', 1, [C('tag', [L('ench', T.Compound, [{ t: T.Compound, v: [Sh('id', 9), Sh('lvl', 5)] }]), C('display', [S('Name', '§bExcalibur')])])]),
    item(9, 'minecraft:tnt', 64), item(10, 'minecraft:tnt', 64),
    book(11, 'Koholint Lore', 'SprowtlingFan', 0, LORE),
  ], [item(0, 'minecraft:elytra', 1)]],
  ['66666666-7777-4888-8999-000000000000', [-20, 40, 10], 1, 5, [item(0, 'minecraft:torch', 20), mapItem(1, -100)], [book(2, 'Koholint Lore', 'SprowtlingFan', 1, LORE), book(3, 'Quest: The Egg', 'SprowtlingFan', 0, ['Climb to the egg.'])]],
];
people[0].push(-8589934001);
people[1].push(-8589934002);
for (const [uuid, pos, dim, lvl, items, ender, uid] of people) {
  put(utf8('player_server_' + uuid), serialize(player(pos, dim, lvl, items, ender, uid)));
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
