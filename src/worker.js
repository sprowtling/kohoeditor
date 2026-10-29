// Runs in a Web Worker so reading a large world never freezes the page.
// Files are read synchronously with FileReaderSync, which only exists here.

import { World } from './lib/world.js';
import { ZipFiles, dataOffset, buildZip } from './lib/zip.js';
import { crc32 } from './lib/crc.js';

const reader = new FileReaderSync();
const readBlob = (blob, offset, length) => new Uint8Array(reader.readAsArrayBuffer(blob.slice(offset, offset + length)));

function blobFile(blob) {
  return { size: blob.size, read: (offset, length) => readBlob(blob, offset, length) };
}

// A picked folder: [{ path, file }]
function folderSource(list) {
  const byPath = new Map(list.map((e) => [e.path, e.file]));
  return {
    kind: 'folder',
    paths: [...byPath.keys()],
    open(path) { const f = byPath.get(path); return f ? blobFile(f) : null; },
    exportEntry(path, name, progress) {
      const f = byPath.get(path);
      let crc = 0;
      const STEP = 16 << 20;
      for (let o = 0; o < f.size; o += STEP) {
        crc = crc32(readBlob(f, o, Math.min(STEP, f.size - o)), crc);
        progress(Math.min(STEP, f.size - o));
      }
      return { name, method: 0, crc, compSize: f.size, size: f.size, data: f };
    },
  };
}

function zipSource(file) {
  const raw = blobFile(file);
  const zip = new ZipFiles(raw);
  return {
    kind: 'mcworld',
    paths: zip.entries.map((e) => e.name),
    open: (path) => zip.open(path),
    exportEntry(path, name, progress) {
      const e = zip.byName.get(path);
      const start = dataOffset(raw, e);
      progress(e.compSize);
      return { name, method: e.method, crc: e.crc, compSize: e.compSize, size: e.size, data: file.slice(start, start + e.compSize), time: e.time, date: e.date };
    },
  };
}

let source = null;
let world = null;
let input = null;

// Decompresses table files on several threads at once. Returns a Map of
// table number -> key summary, or null when it isn't worth it.
async function parallelSummaries(progress) {
  const jobs = world.tableJobs();
  const cores = Math.max(1, (self.navigator?.hardwareConcurrency ?? 2) - 1);
  const n = Math.min(cores, 8, jobs.length);
  if (n < 2 || world.db.totalTableBytes < (32 << 20) || typeof Worker === 'undefined') return null;
  const total = jobs.reduce((a, j) => a + j.size, 0) || 1;
  const summaries = new Map();
  const stat = { read: 0, work: 0, helpers: n };
  let done = 0;
  const helpers = [];
  try {
    await new Promise((resolve, reject) => {
      let next = 0, finished = 0;
      const give = (w) => {
        if (next >= jobs.length) return;
        const j = jobs[next++];
        w.job = j;
        w.postMessage({ number: j.number, path: j.path });
      };
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./scanworker.js', import.meta.url), { type: 'module' });
        helpers.push(w);
        w.onerror = (e) => reject(new Error(e.message || 'A scan helper stopped unexpectedly.'));
        w.onmessage = (ev) => {
          const m = ev.data;
          if (m.ready) { give(w); return; }
          if (m.error) { reject(new Error(`Could not read ${w.job.path}: ${m.error}`)); return; }
          summaries.set(m.number, m.summary);
          stat.read += m.readMs; stat.work += m.workMs;
          done += w.job.size;
          finished++;
          progress(0.9 * done / total, 'Reading the world');
          if (finished === jobs.length) resolve(); else give(w);
        };
        w.postMessage({ init: input.mcworld ? { mcworld: input.mcworld } : { files: input.files } });
      }
    });
  } finally {
    for (const w of helpers) w.terminate();
  }
  console.info(`Scan helpers: ${n} threads, ${(stat.read / 1000).toFixed(1)} s reading files, ${(stat.work / 1000).toFixed(1)} s decompressing (summed over threads)`);
  return summaries;
}

const methods = {
  open({ files, mcworld, root }) {
    input = { files, mcworld };
    source = mcworld ? zipSource(mcworld) : folderSource(files);
    world = new World(source, root ?? null);
    return { info: world.info(), kind: source.kind };
  },
  async scan(_, progress) {
    const t = performance.now();
    let summaries = null;
    try {
      summaries = await parallelSummaries(progress);
    } catch (e) {
      // Fall back to reading everything on this one thread.
      console.warn('Parallel scan failed, reading on one thread instead:', e);
    }
    const parallel = !!summaries;
    const t2 = performance.now();
    const stats = world.scan((p) => progress(p, 'Reading the world'), summaries);
    return { stats, ms: performance.now() - t, mergeMs: performance.now() - t2, parallel };
  },
  info: () => world.info(),
  players: () => world.players(),
  otherKeys: () => world.otherKeys,
  record: ({ key }) => world.record(key),
  chunkList: ({ dim }) => world.chunkList(dim),
  copyChunks: ({ dim, coords }, progress) => world.copyChunks(dim, coords, (f) => progress(f)),
  clipboardInfo: () => world.clipboardInfo(),
  clipboardFile: () => new Blob([world.clipboardFile()], { type: 'application/octet-stream' }),
  loadClipboard: ({ file }) => world.loadClipboard(new Uint8Array(new FileReaderSync().readAsArrayBuffer(file))),
  pasteChunks: ({ dim, x, z, entities }, progress) => world.pasteChunks(dim, x, z, { entities }, (f) => progress(f)),
  undoOperation: ({ id }) => world.undoOperation(id),
  setItem: ({ key, list, slot, item }) => world.setItem(key, list, slot, item),
  editLevelDat: ({ ops }) => world.editLevelDat(ops),
  chunkDetail: ({ dim, x, z }) => world.chunkDetail(dim, x, z),
  deleteChunks: ({ dim, coords }, progress) => world.deleteChunks(dim, coords, (f) => progress(f)),
  restoreChunks: ({ dim, coords }, progress) => world.restoreChunks(dim, coords, (f) => progress(f)),
  editRecord: ({ key, ops }) => world.editRecord(key, ops),
  deleteRecord: ({ key }) => world.deleteRecord(key),
  revertRecord: ({ key }) => world.revertRecord(key),
  pending: () => world.pending(),
  levelDat: () => ({ tag: world.currentLevelDat(), edited: !!world.levelDatEdit }),

  // Builds the edited world as a new .mcworld. The original files are not touched.
  exportWorld(_, progress) {
    progress(0, 'Writing your changes');
    const log = world.changeLog();
    const paths = world.paths.filter((p) => !p.endsWith('/'));
    let total = 0;
    for (const p of paths) total += source.open(p)?.size ?? 0;
    let done = 0;
    const tick = (n) => { done += n; progress(Math.min(done / Math.max(total, 1), 1), 'Packing the world'); };
    const replaced = new Map(world.changedFiles().map((f) => [f.path, f.bytes]));
    const stored = (name, bytes) => ({ name, method: 0, crc: crc32(bytes), compSize: bytes.length, size: bytes.length, data: bytes });
    const entries = paths.map((p) => (replaced.has(p) ? stored(p.slice(world.root.length), replaced.get(p)) : source.exportEntry(p, p.slice(world.root.length), tick)));
    for (const [p, bytes] of replaced) if (!paths.includes(p)) entries.push(stored(p.slice(world.root.length), bytes));
    if (log.ops) entries.push(stored(log.path.slice(world.root.length), log.bytes));
    const blob = new Blob(buildZip(entries), { type: 'application/octet-stream' });
    return { blob, ops: log.ops, logName: log.path };
  },
};

self.onmessage = async (ev) => {
  const { id, method, args } = ev.data;
  const progress = (value, label) => self.postMessage({ id, progress: value, label });
  try {
    if (!methods[method]) throw new Error(`Unknown method ${method}`);
    if (method !== 'open' && !world) throw new Error('No world is open.');
    const result = await methods[method](args ?? {}, progress);
    const transfer = result && result.list instanceof Int32Array ? [result.list.buffer, result.surface.buffer] : [];
    self.postMessage({ id, result }, transfer);
  } catch (e) {
    console.error(e);
    self.postMessage({ id, error: e.message || String(e) });
  }
};
