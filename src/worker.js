// Runs in a Web Worker so reading a large world never freezes the page.
// Files are read synchronously with FileReaderSync, which only exists here.

import { World } from './lib/world.js';
import { ZipFiles, dataOffset } from './lib/zip.js';
import { writeWorld } from './lib/export.js';
import { RESULT_BYTES } from './lib/blockmap.js';
import { chunkKey } from './lib/keys.js';
import { compareBytes } from './lib/bytes.js';
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

// Helpers for the block map, kept running while a world is open.
let mapPool = null;
function getMapPool() {
  if (mapPool) return mapPool;
  const cores = Math.max(1, (self.navigator?.hardwareConcurrency ?? 2) - 1);
  const n = typeof Worker === 'undefined' ? 0 : Math.min(cores, 6);
  const helpers = [];
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL('./mapworker.js', import.meta.url), { type: 'module' });
    const h = { w, waiting: new Map(), next: 1, broken: false };
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.ready) return;
      const p = h.waiting.get(m.id);
      h.waiting.delete(m.id);
      if (m.error) p?.reject(new Error(m.error)); else p?.resolve(m);
    };
    w.onerror = () => { h.broken = true; for (const p of h.waiting.values()) p.reject(new Error('A map helper stopped.')); h.waiting.clear(); };
    w.postMessage({ init: { files: input.files, mcworld: input.mcworld, root: world.root } });
    helpers.push(h);
  }
  mapPool = {
    helpers,
    run(h, dim, job) {
      return new Promise((resolve, reject) => {
        const id = h.next++;
        h.waiting.set(id, { resolve, reject });
        h.w.postMessage({ id, dim, job }, [job.buffer]);
      });
    },
    close() { for (const h of helpers) h.w.terminate(); },
  };
  return mapPool;
}

// Draws chunks from above for the block map. Returns { coords, data, ok } with
// RESULT_BYTES bytes per chunk in data, and ok[i] = 0 where nothing could be read.
async function blockMap({ dim, coords }) {
  const n = coords.length;
  const data = new Uint8Array(n * RESULT_BYTES);
  const ok = new Uint8Array(n);
  const viaHelpers = [];
  coords.forEach(([x, z], i) => {
    if (world.chunkFromEdits(dim, x, z) || !world.chunks[dim].has(x + ',' + z)) {
      const r = world.renderBlocks(dim, x, z);
      if (r) { data.set(r, i * RESULT_BYTES); ok[i] = 1; }
    } else viaHelpers.push(i);
  });
  const pool = getMapPool();
  const helpers = pool.helpers.filter((h) => !h.broken);
  if (!helpers.length) {
    for (const i of viaHelpers) {
      const r = world.renderBlocks(dim, coords[i][0], coords[i][1]);
      if (r) { data.set(r, i * RESULT_BYTES); ok[i] = 1; }
    }
    return { data, ok };
  }
  // Share the chunks out between the helpers in database order, so each one
  // reads a run of neighbouring chunks (which mostly sit in the same files).
  const keyOf = (i) => chunkKey(coords[i][0], coords[i][1], dim, 0x2f, 0);
  const keys = new Map(viaHelpers.map((i) => [i, keyOf(i)]));
  viaHelpers.sort((a, b) => compareBytes(keys.get(a), keys.get(b)));
  const per = Math.ceil(viaHelpers.length / helpers.length);
  const groups = helpers.map((_, g) => viaHelpers.slice(g * per, (g + 1) * per));
  await Promise.all(groups.map(async (group, g) => {
    if (!group.length) return;
    const parts = [];
    for (const i of group) {
      const [x, z] = coords[i];
      const subs = world.chunkSubs(dim, x, z);
      parts.push(x, z, subs.length, ...subs);
    }
    const r = await pool.run(helpers[g], dim, Int32Array.from(parts));
    group.forEach((i, k) => { if (r.ok[k]) { data.set(r.data.subarray(k * RESULT_BYTES, (k + 1) * RESULT_BYTES), i * RESULT_BYTES); ok[i] = 1; } });
  }));
  return { data, ok };
}

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
    mapPool?.close();
    mapPool = null;
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
  blockMap: (args) => blockMap(args),
  copyChunks: ({ dim, coords }, progress) => world.copyChunks(dim, coords, (f) => progress(f)),
  clipboardInfo: () => world.clipboardInfo(),
  clipboardFile: () => new Blob(world.clipboardFile(), { type: 'application/octet-stream' }),
  loadClipboard: ({ file }) => world.loadClipboard(blobFile(file)),
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
  // With a file handle (Chrome and Edge), it's written straight to that file as
  // it's made, so even a very large world never has to fit in memory. Without
  // one, it becomes a Blob for the page to download.
  async exportWorld({ handle }, progress) {
    if (handle) {
      const out = await handle.createWritable();
      try {
        const r = await writeWorld(world, source, { write: (part) => out.write(part) }, progress);
        await out.close();
        return { ...r, saved: true };
      } catch (e) {
        await out.abort().catch(() => {});
        throw e;
      }
    }
    const parts = [];
    // Each piece becomes its own small Blob straight away, which the browser may keep on disk.
    const r = await writeWorld(world, source, { write: (part) => { parts.push(part instanceof Uint8Array ? new Blob([part]) : part); } }, progress);
    return { ...r, blob: new Blob(parts, { type: 'application/octet-stream' }) };
  },
};

self.onmessage = async (ev) => {
  const { id, method, args } = ev.data;
  const progress = (value, label) => self.postMessage({ id, progress: value, label });
  try {
    if (!methods[method]) throw new Error(`Unknown method ${method}`);
    if (method !== 'open' && !world) throw new Error('No world is open.');
    const result = await methods[method](args ?? {}, progress);
    const transfer = result && result.list instanceof Int32Array ? [result.list.buffer, result.surface.buffer]
      : result && result.data instanceof Uint8Array && result.ok ? [result.data.buffer, result.ok.buffer] : [];
    self.postMessage({ id, result }, transfer);
  } catch (e) {
    console.error(e);
    self.postMessage({ id, error: e.message || String(e) });
  }
};
