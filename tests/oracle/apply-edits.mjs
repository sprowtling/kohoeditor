// Applies typical edits to a copy of a world with our code (regenerate some
// chunks, change a player), writes the change log, and records what the
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
  const list = w.chunkList(dim);
  const coords = [];
  for (let i = 0; i < list.length; i += 4 * 3) coords.push([list[i], list[i + 1]]);
  w.deleteChunks(dim, coords);
}
const p = w.players()[0];
if (p) {
  const root = w.record(p.key).nbt[0];
  const i = root.v.findIndex((c) => c.n === 'PlayerLevel');
  if (i >= 0) w.editRecord(p.key, [{ path: [0, i], action: 'set', value: '42' }]);
}
const want = {};
w.db.forEach((k, v) => { want[toHex(k)] = toHex(v); });
for (const [h, e] of w.edits) { if (e.value) want[h] = toHex(e.value); else delete want[h]; }
const log = w.changeLog();
fs.writeFileSync(path.join(dst, log.path), log.bytes);
fs.writeFileSync(expectOut, JSON.stringify(want));
console.log(`${w.pending().chunks.join('/')} chunks regenerated, ${log.ops} changes written to ${log.path}`);
