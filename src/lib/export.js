// Writes the edited world as a .mcworld, one piece at a time: every original
// file (unchanged ones copied as they are), replaced files such as level.dat,
// then the new database logs holding the changes. Pieces go to sink.write()
// as soon as they're ready, so with a file on disk as the sink, nothing big
// ever has to be held in memory.

import { ZipWriter } from './zip.js';
import { crc32 } from './crc.js';

// source.exportEntry(path, name, onBytes) gives the zip entry for an original
// file. sink.write(part) takes a Uint8Array or Blob and may return a promise.
// progress(fraction, label) is called along the way.
export async function writeWorld(world, source, sink, progress = () => {}) {
  const zw = new ZipWriter();
  const put = async (entry) => { for (const part of zw.add(entry)) await sink.write(part); };
  const stored = (name, bytes) => ({ name, method: 0, crc: crc32(bytes), compSize: bytes.length, size: bytes.length, data: bytes });
  const rel = (p) => p.slice(world.root.length);

  const paths = world.paths.filter((p) => !p.endsWith('/'));
  let editBytes = 0;
  for (const e of world.edits.values()) editBytes += e.key.length + (e.value ? e.value.length : 0) + 8;
  let total = editBytes;
  for (const p of paths) total += source.open(p)?.size ?? 0;
  let done = 0;
  const tick = (n, label) => { done += n; progress(Math.min(done / Math.max(total, 1), 1), label); };

  const replaced = new Map(world.changedFiles().map((f) => [f.path, f.bytes]));
  for (const p of paths) {
    if (replaced.has(p)) await put(stored(rel(p), replaced.get(p)));
    else await put(source.exportEntry(p, rel(p), (n) => tick(n, 'Copying the world')));
  }
  for (const [p, bytes] of replaced) if (!paths.includes(p)) await put(stored(rel(p), bytes));

  let logs = 0;
  for (const f of world.changeLogFiles()) {
    await put(stored(rel(f.path), f.bytes));
    tick(f.bytes.length, 'Writing your changes');
    logs++;
  }
  for (const part of zw.finish()) await sink.write(part);
  progress(1, 'Finishing');
  return { logs, edits: world.edits.size, bytes: zw.offset };
}
