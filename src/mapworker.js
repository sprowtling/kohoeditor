// A helper worker for the block map: opens its own copy of the world database
// and draws chunks from above. Several of these run at once.

import { LevelDB } from './lib/leveldb.js';
import { ZipFiles } from './lib/zip.js';
import { chunkKey } from './lib/keys.js';
import { renderChunk, RESULT_BYTES } from './lib/blockmap.js';

const reader = new FileReaderSync();
const blobFile = (blob) => ({
  size: blob.size,
  read: (offset, length) => new Uint8Array(reader.readAsArrayBuffer(blob.slice(offset, offset + length))),
});

let db = null;

// Table files are read whole on first use and kept for a while: one read per
// file is far quicker than one per block when chunks are fetched one by one.
function wholeFileCache(open, limit = 192 << 20) {
  const cache = new Map();
  let bytes = 0;
  return (path) => {
    const f = open(path);
    if (!f || !/\.(ldb|sst)$/.test(path)) return f;
    return {
      size: f.size,
      read(offset, length) {
        let all = cache.get(path);
        if (all) { cache.delete(path); cache.set(path, all); } else {
          all = f.read(0, f.size);
          cache.set(path, all);
          bytes += all.length;
          while (bytes > limit && cache.size > 1) {
            const [k, v] = cache.entries().next().value;
            cache.delete(k);
            bytes -= v.length;
          }
        }
        return all.subarray(offset, offset + length);
      },
    };
  };
}

function openDb({ files, mcworld, root }) {
  let paths, open;
  if (mcworld) {
    const zip = new ZipFiles(blobFile(mcworld), 96 << 20);
    paths = zip.entries.map((e) => e.name);
    open = (p) => zip.open(p);
  } else {
    const byPath = new Map(files.map((e) => [e.path, e.file]));
    paths = [...byPath.keys()];
    open = (p) => { const f = byPath.get(p); return f ? blobFile(f) : null; };
  }
  const prefix = root + 'db/';
  open = wholeFileCache(open);
  db = new LevelDB({
    names: paths.filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map((p) => p.slice(prefix.length)),
    open: (name) => open(prefix + name),
  });
}

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.init) { openDb(msg.init); self.postMessage({ ready: true }); return; }
    // job: Int32Array of [x, z, count, sub, sub, ...] per chunk
    const { id, dim, job } = msg;
    const out = [];
    let i = 0;
    while (i < job.length) {
      const x = job[i], z = job[i + 1], n = job[i + 2];
      const subs = Array.from(job.subarray(i + 3, i + 3 + n));
      i += 3 + n;
      // One unreadable chunk is left blank rather than spoiling the rest.
      try { out.push(renderChunk(subs, (s) => db.get(chunkKey(x, z, dim, 0x2f, s)))); } catch { out.push(null); }
    }
    const data = new Uint8Array(out.length * RESULT_BYTES);
    const ok = new Uint8Array(out.length);
    out.forEach((r, k) => { if (r) { data.set(r, k * RESULT_BYTES); ok[k] = 1; } });
    self.postMessage({ id, data, ok }, [data.buffer, ok.buffer]);
  } catch (e) {
    self.postMessage({ id: msg.id, error: e.message || String(e) });
  }
};
