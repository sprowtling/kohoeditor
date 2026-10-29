// Shared bits for the tests: opening world folders from disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = path.join(here, 'fixtures', 'world');

export function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base + e.name + '/') : [base + e.name]));
}

export function folderFiles(dir) {
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

export function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koho-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

// Writes a world's pending changes to its folder, the way a saved .mcworld would hold them.
export function saveInPlace(world, dir) {
  for (const f of world.changeLogFiles()) fs.writeFileSync(path.join(dir, f.path), f.bytes);
  for (const f of world.changedFiles()) fs.writeFileSync(path.join(dir, f.path), f.bytes);
}
