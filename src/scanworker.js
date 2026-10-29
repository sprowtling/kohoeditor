// A helper worker for scanning: decompresses table files and sends back a
// compact list of their keys. Several of these run at once on a big world.

import { Table, summarizeTable } from './lib/leveldb.js';
import { ZipFiles } from './lib/zip.js';
import { extractSurface } from './lib/biomes.js';

const reader = new FileReaderSync();
const blobFile = (blob) => ({
  size: blob.size,
  read: (offset, length) => new Uint8Array(reader.readAsArrayBuffer(blob.slice(offset, offset + length))),
});

let open = null;

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.init) {
      if (msg.init.mcworld) {
        // Only the table files are needed, so cache little; each is read once.
        const zip = new ZipFiles(blobFile(msg.init.mcworld), 64 << 20);
        open = (path) => zip.open(path);
      } else {
        const byPath = new Map(msg.init.files.map((e) => [e.path, e.file]));
        open = (path) => { const f = byPath.get(path); return f ? blobFile(f) : null; };
      }
      self.postMessage({ ready: true });
      return;
    }
    const file = open(msg.path);
    if (!file) throw new Error(`${msg.path} is missing`);
    const t0 = performance.now();
    const whole = file.read(0, file.size);
    const t1 = performance.now();
    const summary = summarizeTable(new Table({ size: whole.length, read: (o, l) => whole.subarray(o, o + l) }, msg.number), extractSurface);
    self.postMessage({ number: msg.number, summary, readMs: t1 - t0, workMs: performance.now() - t1 }, [summary.buffer]);
  } catch (e) {
    self.postMessage({ number: msg.number, error: e.message || String(e) });
  }
};
