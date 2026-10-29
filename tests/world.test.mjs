// Run with: npm test   (or: node --test tests/*.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LevelDB, Table, summarizeTable, readLogRecords, encodeLogRecords, parseWriteBatch, encodeWriteBatch } from '../src/lib/leveldb.js';
import { parseAll, serializeAll, parse, serialize, parseLevelDat, serializeLevelDat, T, toPlain } from '../src/lib/nbt.js';
import { parseChunkKey, chunkKey, describeKey, digpKey } from '../src/lib/keys.js';
import { World } from '../src/lib/world.js';
import { buildZip, ZipFiles } from '../src/lib/zip.js';
import { crc32, crc32c } from '../src/lib/crc.js';
import { toHex, fromHex, utf8, equalBytes, concatBytes } from '../src/lib/bytes.js';
import { readItem, prettyName } from '../src/lib/items.js';
import { snappyDecompress } from '../src/lib/snappy.js';
import { zipSync } from '../vendor/fflate.js';
import { nodeDir } from './nodefs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'world');
const expected = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'expected.json'), 'utf8'));

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base + e.name + '/') : [base + e.name]));
}

function folderFiles(dir) {
  return {
    paths: walk(dir),
    open(p) {
      const f = path.join(dir, p);
      if (!fs.existsSync(f)) return null;
      const b = new Uint8Array(fs.readFileSync(f));
      return { size: b.length, read: (o, l) => b.subarray(o, o + l) };
    },
  };
}

function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koho-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function readAll(db) {
  const out = {};
  db.forEach((k, v) => { out[toHex(k)] = toHex(v); });
  return out;
}

test('reads every key exactly as Mojang\'s LevelDB wrote it', () => {
  const db = new LevelDB(nodeDir(path.join(FIXTURE, 'db')));
  assert.ok(db.tableCount >= 2, 'fixture should have several tables');
  assert.ok(db.mem.length > 0, 'fixture should have writes still in its log');
  assert.deepEqual(readAll(db), expected);
});

test('point lookups agree with a full scan, including deleted and overwritten keys', () => {
  const db = new LevelDB(nodeDir(path.join(FIXTURE, 'db')));
  for (const [k, v] of Object.entries(expected)) assert.equal(toHex(db.get(fromHex(k))), v);
  assert.equal(db.get(chunkKey(40, 40, 0, 0x2c)), null, 'deleted key stays deleted');
  assert.equal(db.get(utf8('no such key')), null);
});

test('forEachKey reports the same keys and value sizes as forEach', () => {
  const db = new LevelDB(nodeDir(path.join(FIXTURE, 'db')));
  const a = [], b = [];
  db.forEach((k, v) => a.push(toHex(k) + ':' + v.length));
  db.forEachKey((k, n) => b.push(toHex(k) + ':' + n));
  assert.deepEqual(a, b);
});

test('NBT records survive a read and write unchanged', () => {
  let n = 0;
  for (const [k, v] of Object.entries(expected)) {
    const d = describeKey(fromHex(k));
    if (d.kind === 'chunk' ? !d.nbt : d.kind === 'digp') continue;
    const bytes = fromHex(v);
    const { roots, rest } = parseAll(bytes);
    assert.ok(equalBytes(serializeAll(roots, rest), bytes), d.label);
    n++;
  }
  assert.ok(n > 50);
  const ld = new Uint8Array(fs.readFileSync(path.join(FIXTURE, 'level.dat')));
  const { version, tag } = parseLevelDat(ld);
  assert.ok(equalBytes(serializeLevelDat(version, tag), ld));
  assert.equal(toPlain(tag).LevelName, 'Fixture World');
});

test('NBT keeps every tag type, including odd strings', () => {
  const tag = { n: 'root', t: T.Compound, v: [
    { n: 'b', t: T.Byte, v: -5 }, { n: 's', t: T.Short, v: -300 }, { n: 'i', t: T.Int, v: 2147483647 },
    { n: 'l', t: T.Long, v: -9007199254740993n }, { n: 'f', t: T.Float, v: Math.fround(1.1) }, { n: 'd', t: T.Double, v: Math.PI },
    { n: 'ba', t: T.ByteArray, v: Int8Array.of(-1, 0, 1) }, { n: 'ia', t: T.IntArray, v: Int32Array.of(-1, 5) },
    { n: 'la', t: T.LongArray, v: BigInt64Array.of(1n, -2n) }, { n: 'str', t: T.String, v: 'héllo §6world ✨' },
    { n: 'empty', t: T.List, et: T.End, v: [] },
  ] };
  const bytes = serialize(tag);
  assert.ok(equalBytes(serialize(parse(bytes)), bytes));
  // Bytes that are not valid UTF-8 come back out exactly as they went in.
  const raw = Uint8Array.of(8, 1, 0, 0x78, 3, 0, 0xff, 0xfe, 0x41);
  assert.ok(equalBytes(serialize(parse(raw)), raw));
});

test('chunk keys are recognised, and text keys are not mistaken for chunks', () => {
  assert.deepEqual(parseChunkKey(chunkKey(-3, 7, 0, 0x2f, -4)), { x: -3, z: 7, dim: 0, tag: 0x2f, sub: -4 });
  assert.deepEqual(parseChunkKey(chunkKey(100000, -100000, 2, 0x31)), { x: 100000, z: -100000, dim: 2, tag: 0x31, sub: null });
  for (const s of ['Overworld', 'mobevents', 'scoreboard', 'BiomeData', '~local_player', 'portals', 'AutonomousEntities', 'dimension0', 'schedulerWT']) {
    assert.equal(parseChunkKey(utf8(s)), null, s);
  }
});

test('the world scan finds chunks, entities and players', () => {
  const w = new World(folderFiles(FIXTURE));
  const stats = w.scan();
  assert.deepEqual(stats.chunks, [145, 36, 16]);
  assert.equal(w.levelName, 'Fixture World');
  const players = w.players();
  assert.equal(players.length, 3);
  const p = players.find((x) => x.id.startsWith('11111111'));
  assert.equal(p.summary.level, 30);
  assert.equal(p.link.msaId, '253511111111');
  const sword = p.summary.inventory.find((i) => i.slot === 0);
  assert.equal(sword.customName, 'Excalibur');
  assert.equal(sword.enchants[0].name, 'Sharpness V');
  assert.equal(p.summary.enderChest[0].name, 'Elytra');
  assert.equal(p.summary.armor.length, 1);
  assert.equal(p.summary.offhand[0].name, 'Shield');
  // Scanning with summaries (the parallel path) gives the same answer.
  const w2 = new World(folderFiles(FIXTURE));
  const sums = new Map(w2.tableJobs().map((j) => [j.number, summarizeTable(new Table(w2.files.open(j.path), j.number))]));
  assert.deepEqual(w2.scan(null, sums), stats);
});

test('deleting chunks removes their data and entities, and the game\'s LevelDB format stays valid', () => {
  const dir = copyFixture();
  const w = new World(folderFiles(dir));
  w.scan();
  const withEntities = w.chunkDetail(0, 0, 0);
  assert.ok(withEntities.entities.length === 2, 'chunk 0,0 has two entities in the fixture');
  const coords = [[0, 0], [1, 1], [-6, -6], [5, 5]];
  assert.equal(w.deleteChunks(0, coords), 4);
  assert.equal(w.deleteChunks(0, coords), 0, 'deleting twice does nothing more');
  assert.equal(w.deleteChunks(0, [[99, 99]]), 0, 'chunks that do not exist are skipped');
  // Undo one of them.
  assert.equal(w.restoreChunks(0, [[5, 5]]), 1);
  // Edit a player: level 30 -> 31 and remove the first stack.
  const pkey = toHex(utf8('player_server_11111111-2222-4333-8444-555555555555'));
  const rec = w.record(pkey);
  const li = rec.nbt[0].v.findIndex((c) => c.n === 'PlayerLevel');
  w.editRecord(pkey, [{ path: [0, li], action: 'set', value: '31' }]);
  assert.throws(() => w.editRecord(pkey, [{ path: [0, li], action: 'set', value: 'lots' }]), /whole number/);

  const log = w.changeLog();
  fs.writeFileSync(path.join(dir, log.path), log.bytes);

  // What we expect to read back.
  const want = { ...expected };
  for (const [h, e] of w.edits) { if (e.value) want[h] = toHex(e.value); else delete want[h]; }
  const db2 = new LevelDB(nodeDir(path.join(dir, 'db')));
  assert.deepEqual(readAll(db2), want);
  const w2 = new World(folderFiles(dir));
  const stats = w2.scan();
  assert.deepEqual(stats.chunks, [142, 36, 16]);
  assert.equal(w2.players().find((x) => x.id.startsWith('11111111')).summary.level, 31);
  assert.equal(w2.get(digpKey(0, 0, 0)), null);
  for (const e of withEntities.entities) assert.equal(w2.get(fromHex(e.key)), null, 'entity removed');
  assert.ok(w2.chunks[0].has('5,5'), 'restored chunk is still there');
  fs.rmSync(dir, { recursive: true });
});

test('log records split across 32 KB blocks read back intact', () => {
  const big = new Uint8Array(100000).map((_, i) => (i * 7) & 0xff);
  const records = [Uint8Array.of(1, 2, 3), big, new Uint8Array(32768 - 14), Uint8Array.of(9)];
  const out = [...readLogRecords(encodeLogRecords(records))];
  assert.equal(out.length, records.length);
  records.forEach((r, i) => assert.ok(equalBytes(out[i], r)));
  const batch = encodeWriteBatch(77, [{ key: utf8('a'), value: utf8('b') }, { key: utf8('c'), value: null }]);
  const parsed = parseWriteBatch(batch);
  assert.equal(parsed.seq, 77);
  assert.equal(parsed.ops[1].value, null);
  assert.equal(parsed.ops[1].seq, 78);
});

test('a .mcworld can be read in place and rebuilt with a new file added', () => {
  const files = walk(FIXTURE);
  const entries = {};
  for (const p of files) entries[p] = [new Uint8Array(fs.readFileSync(path.join(FIXTURE, p))), { level: p.endsWith('.txt') ? 6 : 0 }];
  const zipped = zipSync(entries);
  const asFile = { size: zipped.length, read: (o, l) => zipped.subarray(o, o + l) };
  const zip = new ZipFiles(asFile);
  const w = new World({ paths: zip.entries.map((e) => e.name), open: (p) => zip.open(p) });
  assert.deepEqual(w.scan().chunks, [145, 36, 16]);
  w.deleteChunks(1, [[0, 0]]);
  const log = w.changeLog();
  // Rebuild, copying entries without recompressing them.
  const rebuilt = zip.entries.map((e) => {
    const start = e.localOffset + 30 + e.name.length;
    return { name: e.name, method: e.method, crc: e.crc, compSize: e.compSize, size: e.size, data: zipped.subarray(start, start + e.compSize) };
  });
  rebuilt.push({ name: log.path, method: 0, crc: crc32(log.bytes), compSize: log.bytes.length, size: log.bytes.length, data: log.bytes });
  const out = concatBytes(buildZip(rebuilt));
  const zip2 = new ZipFiles({ size: out.length, read: (o, l) => out.subarray(o, o + l) });
  for (const e of zip2.entries) {
    const f = zip2.open(e.name);
    assert.equal(crc32(f.read(0, f.size)), e.crc, e.name);
  }
  const w2 = new World({ paths: zip2.entries.map((e) => e.name), open: (p) => zip2.open(p) });
  assert.deepEqual(w2.scan().chunks, [145, 35, 16]);
});

test('checksums match their reference values', () => {
  assert.equal(crc32(utf8('123456789')), 0xcbf43926);
  assert.equal(crc32c(utf8('123456789')), 0xe3069283);
  const long = new Uint8Array(1000).map((_, i) => i & 0xff);
  assert.equal(crc32(long.subarray(500), crc32(long.subarray(0, 500))), crc32(long));
});

test('snappy blocks decompress', () => {
  // "abcabcabcabc" as literal "abc" + a copy of 9 bytes from offset 3.
  const comp = Uint8Array.of(12, 0x08, 0x61, 0x62, 0x63, 0x15, 0x03);
  assert.equal(new TextDecoder().decode(snappyDecompress(comp)), 'abcabcabcabc');
});

test('items read nicely', () => {
  assert.equal(prettyName('minecraft:totem_of_undying'), 'Totem of Undying');
  assert.equal(prettyName('minecraft:tnt'), 'TNT');
  assert.equal(prettyName('minecraft:netherite_sword'), 'Netherite Sword');
  assert.equal(readItem({ t: T.Compound, v: [{ n: 'Name', t: T.String, v: '' }, { n: 'Count', t: T.Byte, v: 0 }] }), null);
});
