// Applies typical edits to a copy of a world with our code (regenerate some
// chunks, copy and paste others, change a player), writes the change log, and records what the
// database should now contain. verify.py then checks it with Mojang's LevelDB.
// Usage: node apply-edits.mjs <world dir> <copy dir> expected.json
import fs from 'node:fs';
import path from 'node:path';
import { World } from '../../src/lib/world.js';
import { toHex } from '../../src/lib/bytes.js';

const [src, dst, expectOut] = process.argv.slice(2);
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
const walk = (d, base = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), base + e.name + '/') : [base + e.name]));
const files = {
  paths: walk(dst),
  open(p) {
    const f = path.join(dst, p);
    if (!fs.existsSync(f)) return null;
    const b = new Uint8Array(fs.readFileSync(f));
    return { size: b.length, read: (o, l) => b.subarray(o, o + l) };
  },
};
const w = new World(files);
w.scan();
for (let dim = 0; dim < 3; dim++) {
  const list = w.chunkList(dim).list;
  const coords = [];
  for (let i = 0; i < list.length; i += 4 * 3) coords.push([list[i], list[i + 1]]);
  w.deleteChunks(dim, coords);
}
// Copy a strip of Overworld chunks (with their entities) far away, and onto some existing ones.
const ow = w.chunkList(0).list;
const strip = [];
for (let i = 0; i < ow.length && strip.length < 12; i += 4 * 2) if (!(ow[i + 3] & 1)) strip.push([ow[i], ow[i + 1]]);
if (strip.length) {
  w.copyChunks(0, strip);
  w.pasteChunks(0, 5000, -5000);
  w.pasteChunks(0, strip[0][0] + 1, strip[0][1]);
}
const p = w.players()[0];
if (p) {
  const root = w.record(p.key).nbt[0];
  const i = root.v.findIndex((c) => c.n === 'PlayerLevel');
  if (i >= 0) w.editRecord(p.key, [{ path: [0, i], action: 'set', value: '42' }]);
  w.setItem(p.key, 'Inventory', 7, { id: 'minecraft:diamond_sword', count: 1, damage: 0, customName: 'Test', enchants: [{ id: 9, level: 5 }] });
}
const want = {};
w.db.forEach((k, v) => { want[toHex(k)] = toHex(v); });
for (const [h, e] of w.edits) { if (e.value) want[h] = toHex(e.value); else delete want[h]; }
// Small log files, so the check also covers changes spread over several logs.
const logFiles = w.changeLogs(16 << 10).files;
for (const f of logFiles) fs.writeFileSync(path.join(dst, f.path), f.bytes);
fs.writeFileSync(expectOut, JSON.stringify(want));
const pend = w.pending();
console.log(`${pend.chunks.join('/')} chunks regenerated, ${pend.pasted.join('/')} pasted, ${w.edits.size} changes written to ${logFiles.length} log files`);
