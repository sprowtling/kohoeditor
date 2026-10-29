// A reader (and a small, safe writer) for the LevelDB databases Bedrock uses
// to store worlds. Bedrock uses Mojang's fork of LevelDB, which is the normal
// on-disk format plus zlib compression for table blocks.
//
// Reading follows LevelDB's own rules: CURRENT names the MANIFEST, the MANIFEST
// lists which table files are live, and any newer .log files hold recent writes
// that were never compacted. Every stored key carries a sequence number; the
// highest one wins, and a deletion marker hides older values.
//
// Writing never touches existing files. Changes go into one new .log file,
// exactly the way LevelDB records writes before it compacts them. When the game
// next opens the world, LevelDB replays that log and folds the changes in.

import { inflateSync, unzlibSync } from '../../vendor/fflate.js';
import { snappyDecompress } from './snappy.js';
import { crc32c, maskCrc } from './crc.js';
import { Reader, Writer, compareBytes, equalBytes, fromUtf8 } from './bytes.js';

export const TYPE_DELETION = 0;
export const TYPE_VALUE = 1;

const LOG_BLOCK = 32768;
const LOG_HEADER = 7;
const REC_FULL = 1, REC_FIRST = 2, REC_MIDDLE = 3, REC_LAST = 4;

function decompress(type, data) {
  switch (type) {
    case 0: return data;
    case 1: return snappyDecompress(data);
    case 2: return unzlibSync(data);
    case 4: return inflateSync(data);
    default: throw new Error(`Unknown block compression type ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Log files (used for both .log files and the MANIFEST)

export function* readLogRecords(u8) {
  let pos = 0;
  let parts = null;
  while (pos + LOG_HEADER <= u8.length) {
    const left = LOG_BLOCK - (pos % LOG_BLOCK);
    if (left < LOG_HEADER) { pos += left; continue; }
    const len = u8[pos + 4] | (u8[pos + 5] << 8);
    const type = u8[pos + 6];
    if (type === 0 && len === 0) { pos += left; continue; } // zero padding
    if (pos + LOG_HEADER + len > u8.length) break; // torn write at the end
    const stored = (u8[pos] | (u8[pos + 1] << 8) | (u8[pos + 2] << 16) | (u8[pos + 3] << 24)) >>> 0;
    const data = u8.subarray(pos + LOG_HEADER, pos + LOG_HEADER + len);
    const crc = maskCrc(crc32c(data, crc32c(Uint8Array.of(type))));
    pos += LOG_HEADER + len;
    if (crc !== stored) { parts = null; continue; } // LevelDB skips corrupt records too
    if (type === REC_FULL) { parts = null; yield data; }
    else if (type === REC_FIRST) parts = [data];
    else if (type === REC_MIDDLE) { if (parts) parts.push(data); }
    else if (type === REC_LAST) {
      if (parts) {
        parts.push(data);
        let n = 0;
        for (const p of parts) n += p.length;
        const out = new Uint8Array(n);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        parts = null;
        yield out;
      }
    }
  }
}

export function encodeLogRecords(records) {
  // Sized up front: each 32 KB block adds at most a 7 byte header and 6 bytes of padding.
  let total = 0;
  for (const r of records) total += r.length + LOG_HEADER;
  const w = new Writer(total + Math.ceil(total / (LOG_BLOCK - LOG_HEADER)) * (LOG_HEADER + 6) + 64);
  for (const rec of records) {
    let off = 0;
    let first = true;
    do {
      let left = LOG_BLOCK - (w.pos % LOG_BLOCK);
      if (left < LOG_HEADER) {
        for (let i = 0; i < left; i++) w.u8(0);
        left = LOG_BLOCK;
      }
      const avail = left - LOG_HEADER;
      const n = Math.min(avail, rec.length - off);
      const end = off + n === rec.length;
      const type = first && end ? REC_FULL : first ? REC_FIRST : end ? REC_LAST : REC_MIDDLE;
      const data = rec.subarray(off, off + n);
      w.u32(maskCrc(crc32c(data, crc32c(Uint8Array.of(type)))));
      w.u16(n);
      w.u8(type);
      w.bytes(data);
      off += n;
      first = false;
    } while (off < rec.length);
  }
  return w.result();
}

// WriteBatch: seq (8 bytes), count (4 bytes), then the operations.
export function parseWriteBatch(u8) {
  const r = new Reader(u8);
  const seq = r.u64n();
  const count = r.u32();
  const ops = [];
  for (let i = 0; i < count; i++) {
    const type = r.u8_();
    const key = r.lenPrefixed();
    if (type === TYPE_VALUE) ops.push({ type, key, value: r.lenPrefixed(), seq: seq + i });
    else if (type === TYPE_DELETION) ops.push({ type, key, value: null, seq: seq + i });
    else throw new Error(`Bad write batch op ${type}`);
  }
  return { seq, count, ops };
}

export function encodeWriteBatch(seq, ops) {
  let total = 12;
  for (const op of ops) total += 1 + 10 + op.key.length + (op.value ? 10 + op.value.length : 0);
  const w = new Writer(total);
  w.u64n(seq);
  w.u32(ops.length);
  for (const op of ops) {
    if (op.value == null) { w.u8(TYPE_DELETION); w.lenPrefixed(op.key); }
    else { w.u8(TYPE_VALUE); w.lenPrefixed(op.key); w.lenPrefixed(op.value); }
  }
  return w.result();
}

// ---------------------------------------------------------------------------
// Internal keys: user key + 8 byte trailer of (sequence << 8 | type).

function trailerHi(k) { const n = k.length; return (k[n - 4] | (k[n - 3] << 8) | (k[n - 2] << 16) | (k[n - 1] << 24)) >>> 0; }
function trailerLo(k) { const n = k.length; return (k[n - 8] | (k[n - 7] << 8) | (k[n - 6] << 16) | (k[n - 5] << 24)) >>> 0; }
export function internalSeq(k) { return trailerHi(k) * 0x1000000 + (trailerLo(k) >>> 8); }
export function internalType(k) { return k[k.length - 8]; }

export function compareInternal(a, b) {
  const al = a.length - 8, bl = b.length - 8;
  const n = al < bl ? al : bl;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  if (al !== bl) return al - bl;
  // Same user key: the higher sequence number sorts first.
  const ah = trailerHi(a), bh = trailerHi(b);
  if (ah !== bh) return bh - ah;
  return trailerLo(b) - trailerLo(a);
}

function compareUserToInternal(ukey, ikey) {
  const il = ikey.length - 8;
  const n = ukey.length < il ? ukey.length : il;
  for (let i = 0; i < n; i++) {
    if (ukey[i] !== ikey[i]) return ukey[i] - ikey[i];
  }
  return ukey.length - il;
}

export function makeInternalKey(ukey, seq, type) {
  const k = new Uint8Array(ukey.length + 8);
  k.set(ukey);
  const lo = ((seq % 0x1000000) * 256 + type) >>> 0;
  const hi = Math.floor(seq / 0x1000000) >>> 0;
  const n = ukey.length;
  k[n] = lo & 0xff; k[n + 1] = (lo >>> 8) & 0xff; k[n + 2] = (lo >>> 16) & 0xff; k[n + 3] = lo >>> 24;
  k[n + 4] = hi & 0xff; k[n + 5] = (hi >>> 8) & 0xff; k[n + 6] = (hi >>> 16) & 0xff; k[n + 7] = hi >>> 24;
  return k;
}

// ---------------------------------------------------------------------------
// Tables (.ldb / .sst)

const EMPTY = new Uint8Array(0);

class BlockIter {
  constructor(data) {
    this.data = data;
    const n = data.length;
    const restarts = (data[n - 4] | (data[n - 3] << 8) | (data[n - 2] << 16) | (data[n - 1] << 24)) >>> 0;
    this.limit = n - 4 - restarts * 4;
    this.pos = 0;
    this.key = EMPTY;
    this.value = EMPTY;
    this.valid = false;
  }
  varint() {
    const d = this.data;
    let b = d[this.pos++];
    if (b < 0x80) return b;
    let result = b & 0x7f, shift = 7;
    do {
      b = d[this.pos++];
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b >= 0x80 && shift < 35);
    return result >>> 0;
  }
  // Jumps close to ukey using the block's restart points (entries stored with
  // their whole key), so the following next() calls only walk a few entries.
  seek(ukey) {
    const d = this.data;
    const restartsAt = this.limit;
    const count = (d.length - 4 - restartsAt) / 4;
    const restart = (i) => (d[restartsAt + i * 4] | (d[restartsAt + i * 4 + 1] << 8) | (d[restartsAt + i * 4 + 2] << 16) | (d[restartsAt + i * 4 + 3] << 24)) >>> 0;
    let lo = 0, hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      this.pos = restart(mid);
      this.varint(); // shared: always 0 at a restart point
      const nonShared = this.varint();
      this.varint(); // value length
      // Compare ukey with the user-key part of the stored internal key.
      const ulen = nonShared - 8;
      const n = ukey.length < ulen ? ukey.length : ulen;
      let c = 0;
      for (let i = 0; i < n && c === 0; i++) c = ukey[i] - d[this.pos + i];
      if (c === 0) c = ukey.length - ulen;
      if (c > 0) lo = mid; else hi = mid - 1;
    }
    this.pos = count ? restart(lo) : 0;
    this.key = EMPTY;
    this.valid = false;
  }
  next() {
    if (this.pos >= this.limit) { this.valid = false; return false; }
    const shared = this.varint();
    const nonShared = this.varint();
    const valueLen = this.varint();
    const key = new Uint8Array(shared + nonShared);
    if (shared) key.set(this.key.subarray(0, shared));
    key.set(this.data.subarray(this.pos, this.pos + nonShared), shared);
    this.pos += nonShared;
    this.key = key;
    this.value = this.data.subarray(this.pos, this.pos + valueLen);
    this.pos += valueLen;
    this.valid = true;
    return true;
  }
}

// Decompressed blocks used by point lookups, shared by all tables.
class BlockCache {
  constructor(limit) { this.limit = limit; this.bytes = 0; this.map = new Map(); }
  get(key) {
    const v = this.map.get(key);
    if (v) { this.map.delete(key); this.map.set(key, v); }
    return v;
  }
  set(key, v) {
    this.map.set(key, v);
    this.bytes += v.length;
    while (this.bytes > this.limit && this.map.size > 1) {
      const [k, old] = this.map.entries().next().value;
      this.map.delete(k);
      this.bytes -= old.length;
    }
  }
}

export class Table {
  constructor(file, number, cache = null) {
    this.file = file;
    this.number = number;
    this.cache = cache;
    if (file.size < 48) throw new Error(`Table ${number} is too small`);
    const footer = file.read(file.size - 48, 48);
    const magicLo = (footer[40] | (footer[41] << 8) | (footer[42] << 16) | (footer[43] << 24)) >>> 0;
    const magicHi = (footer[44] | (footer[45] << 8) | (footer[46] << 16) | (footer[47] << 24)) >>> 0;
    if (magicLo !== 0x8b80fb57 || magicHi !== 0xdb477524) throw new Error(`Table ${number} has a bad footer`);
    const r = new Reader(footer);
    r.varint(); r.varint(); // metaindex handle (filters; not needed)
    const indexOff = r.varint(), indexSize = r.varint();
    const it = new BlockIter(this.readBlock(indexOff, indexSize));
    this.indexKeys = [];
    this.indexHandles = [];
    while (it.next()) {
      const hr = new Reader(it.value);
      this.indexKeys.push(it.key);
      this.indexHandles.push([hr.varint(), hr.varint()]);
    }
  }
  readBlock(off, size) {
    const raw = this.file.read(off, size + 5);
    return decompress(raw[size], raw.subarray(0, size));
  }
  // A full pass reads the whole file in one go: far fewer reads than one per block.
  iterator() {
    if (this.file.size <= (64 << 20)) return new TableIter(this, this.file.read(0, this.file.size));
    return new TableIter(this, null);
  }
  // Returns the newest entry for ukey in this table: { seq, type, value } or null.
  get(ukey) {
    const keys = this.indexKeys;
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareUserToInternal(ukey, keys[mid]) > 0) lo = mid + 1; else hi = mid;
    }
    for (let b = lo; b < keys.length; b++) {
      const [off, size] = this.indexHandles[b];
      let data = this.cache?.get(this.number * 1e10 + off);
      if (!data) {
        data = this.readBlock(off, size);
        this.cache?.set(this.number * 1e10 + off, data);
      }
      const it = new BlockIter(data);
      it.seek(ukey);
      while (it.next()) {
        const c = compareUserToInternal(ukey, it.key);
        if (c === 0) return { seq: internalSeq(it.key), type: internalType(it.key), value: it.value };
        if (c < 0) return null;
      }
    }
    return null;
  }
}

class TableIter {
  constructor(table, whole) {
    this.table = table;
    this.whole = whole;
    this.block = -1;
    this.data = null;
    this.key = EMPTY;
    this.value = EMPTY;
    this.valid = false;
    this.next();
  }
  next() {
    for (;;) {
      if (this.data && this.data.next()) {
        this.key = this.data.key; this.value = this.data.value; this.valid = true;
        return true;
      }
      this.block++;
      if (this.block >= this.table.indexHandles.length) { this.valid = false; this.data = null; return false; }
      const [off, size] = this.table.indexHandles[this.block];
      if (this.whole) {
        const raw = this.whole.subarray(off, off + size + 5);
        this.data = new BlockIter(decompress(raw[size], raw.subarray(0, size)));
      } else {
        this.data = new BlockIter(this.table.readBlock(off, size));
      }
    }
  }
}

// Walks a sorted, non-overlapping run of tables (levels 1 and up).
class ConcatIter {
  constructor(openers) {
    this.openers = openers;
    this.i = -1;
    this.cur = null;
    this.valid = false;
    this.key = EMPTY;
    this.value = EMPTY;
    this.next();
  }
  next() {
    for (;;) {
      if (this.cur && (this.cur.valid ? this.cur.next() : false)) {
        this.key = this.cur.key; this.value = this.cur.value; this.extra = this.cur.extra; this.valid = true;
        return true;
      }
      this.i++;
      if (this.i >= this.openers.length) { this.valid = false; this.cur = null; return false; }
      this.cur = this.openers[this.i]().iterator();
      if (this.cur.valid) { this.key = this.cur.key; this.value = this.cur.value; this.extra = this.cur.extra; this.valid = true; return true; }
    }
  }
}

class ArrayIter {
  constructor(entries) {
    this.entries = entries;
    this.i = -1;
    this.valid = false;
    this.next();
  }
  next() {
    this.i++;
    if (this.i >= this.entries.length) { this.valid = false; return false; }
    const e = this.entries[this.i];
    this.key = e.key; this.value = e.value; this.valid = true;
    return true;
  }
}

class MergeIter {
  constructor(children) {
    this.heap = children.filter((c) => c.valid);
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.down(i);
    this.update();
  }
  update() {
    if (this.heap.length) { this.valid = true; this.key = this.heap[0].key; this.value = this.heap[0].value; }
    else this.valid = false;
  }
  down(i) {
    const h = this.heap, n = h.length;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && compareInternal(h[l].key, h[m].key) < 0) m = l;
      if (r < n && compareInternal(h[r].key, h[m].key) < 0) m = r;
      if (m === i) return;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  }
  next() {
    if (!this.heap[0].next()) {
      // The smallest child is used up: move the last one into its place.
      const last = this.heap.pop();
      if (this.heap.length) this.heap[0] = last;
    }
    if (this.heap.length) this.down(0);
    this.update();
    return this.valid;
  }
}

// A compact list of one table's keys and value lengths, in table order.
// extract(userKey, value) may return a few bytes worth keeping about a value
// (a biome sample, say); they ride along in the summary.
export function summarizeTable(table, extract = null) {
  const w = new Writer(1 << 20);
  const it = table.iterator();
  while (it.valid) {
    const k = it.key;
    w.varint(k.length);
    w.bytes(k);
    w.varint(it.value.length);
    const extra = extract && k[k.length - 8] === TYPE_VALUE ? extract(k.subarray(0, k.length - 8), it.value) : null;
    w.varint(extra ? extra.length : 0);
    if (extra) w.bytes(extra);
    it.next();
  }
  return w.result();
}

class SummaryIter {
  constructor(buf) {
    this.buf = buf;
    this.r = new Reader(buf);
    this.valid = false;
    this.next();
  }
  next() {
    if (this.r.pos >= this.buf.length) { this.valid = false; return false; }
    this.key = this.r.lenPrefixed();
    this.value = this.r.varint();
    const n = this.r.varint();
    this.extra = n ? this.r.bytes(n) : null;
    this.valid = true;
    return true;
  }
}

// ---------------------------------------------------------------------------
// MANIFEST

function parseVersionEdit(u8, state) {
  const r = new Reader(u8);
  while (r.remaining > 0) {
    const tag = r.varint();
    switch (tag) {
      case 1: state.comparator = fromUtf8(r.lenPrefixed()); break;
      case 2: state.logNumber = r.varint(); break;
      case 3: state.nextFileNumber = r.varint(); break;
      case 4: state.lastSequence = r.varint(); break;
      case 5: r.varint(); r.lenPrefixed(); break; // compaction pointer
      case 6: {
        const level = r.varint(), number = r.varint();
        state.levels[level]?.delete(number);
        break;
      }
      case 7: {
        const level = r.varint(), number = r.varint(), size = r.varint();
        const smallest = r.lenPrefixed().slice(), largest = r.lenPrefixed().slice();
        state.levels[level] ??= new Map();
        state.levels[level].set(number, { number, size, smallest, largest, level });
        break;
      }
      case 9: state.prevLogNumber = r.varint(); break;
      default: throw new Error(`Unknown MANIFEST entry ${tag}`);
    }
  }
}

export function parseManifest(u8) {
  const state = { comparator: null, logNumber: 0, prevLogNumber: 0, nextFileNumber: 0, lastSequence: 0, levels: [] };
  for (const rec of readLogRecords(u8)) parseVersionEdit(rec, state);
  return state;
}

// ---------------------------------------------------------------------------
// The database

// dir: { names: string[], open(name) -> { size, read(offset, length) -> Uint8Array } }
export class LevelDB {
  constructor(dir) {
    this.dir = dir;
    const names = new Set(dir.names);
    if (!names.has('CURRENT')) throw new Error('This folder has no db/CURRENT file, so it does not look like a world database.');
    const currentFile = dir.open('CURRENT');
    const manifestName = fromUtf8(currentFile.read(0, currentFile.size)).trim();
    if (!names.has(manifestName)) throw new Error(`The database points at ${manifestName}, which is missing.`);
    const mf = dir.open(manifestName);
    this.manifest = parseManifest(mf.read(0, mf.size));
    this.manifestName = manifestName;

    let maxNumber = Math.max(this.manifest.nextFileNumber - 1, 0);
    for (const n of dir.names) {
      const m = /^(?:MANIFEST-)?(\d+)(?:\.(?:log|ldb|sst))?$/.exec(n);
      if (m) maxNumber = Math.max(maxNumber, parseInt(m[1], 10));
    }
    this.maxFileNumber = maxNumber;

    // Table files, by level.
    this.files = [];
    this.manifest.levels.forEach((level, i) => {
      if (!level) return;
      const list = [...level.values()].sort((a, b) => (i === 0 ? b.number - a.number : compareInternal(a.smallest, b.smallest)));
      this.files[i] = list;
    });
    this.tableCache = new Map();
    this.blockCache = new BlockCache(48 << 20);

    // Replay logs that the MANIFEST has not absorbed yet.
    const logs = dir.names
      .map((n) => /^(\d+)\.log$/.exec(n))
      .filter(Boolean)
      .map((m) => parseInt(m[1], 10))
      .filter((num) => num >= this.manifest.logNumber || num === this.manifest.prevLogNumber)
      .sort((a, b) => a - b);
    this.logNumbers = logs;
    let lastSeq = this.manifest.lastSequence;
    const mem = new Map();
    for (const num of logs) {
      const f = dir.open(this.fileName(num, 'log'));
      if (!f) continue;
      for (const rec of readLogRecords(f.read(0, f.size))) {
        if (rec.length < 12) continue;
        const batch = parseWriteBatch(rec);
        for (const op of batch.ops) mem.set(op.key.join(','), op);
        lastSeq = Math.max(lastSeq, batch.seq + batch.count - 1);
      }
    }
    this.lastSequence = lastSeq;
    this.mem = [...mem.values()]
      .map((op) => ({ key: makeInternalKey(op.key, op.seq, op.type), value: op.value ?? EMPTY, ukey: op.key, op }))
      .sort((a, b) => compareInternal(a.key, b.key));
  }

  fileName(number, ext) {
    const base = String(number).padStart(6, '0');
    if (ext !== 'ldb') return `${base}.${ext}`;
    const names = this.dir.names;
    if (names.includes(`${base}.ldb`)) return `${base}.ldb`;
    if (names.includes(`${base}.sst`)) return `${base}.sst`;
    return `${base}.ldb`;
  }

  table(number) {
    let t = this.tableCache.get(number);
    if (!t) {
      const name = this.fileName(number, 'ldb');
      const f = this.dir.open(name);
      if (!f) throw new Error(`Table file ${name} is missing from the database.`);
      t = new Table(f, number, this.blockCache);
      if (this.tableCache.size > 1024) this.tableCache.delete(this.tableCache.keys().next().value);
      this.tableCache.set(number, t);
    }
    return t;
  }

  get tableCount() {
    return this.files.reduce((n, l) => n + (l ? l.length : 0), 0);
  }

  get totalTableBytes() {
    return this.files.reduce((n, l) => n + (l ? l.reduce((m, f) => m + f.size, 0) : 0), 0);
  }

  iterator() {
    const children = [new ArrayIter(this.mem)];
    this.files.forEach((list, level) => {
      if (!list || !list.length) return;
      if (level === 0) for (const f of list) children.push(this.table(f.number).iterator());
      else children.push(new ConcatIter(list.map((f) => () => this.table(f.number))));
    });
    return new MergeIter(children);
  }

  // Calls fn(key, value) for every live key in sorted order.
  // onProgress(bytesDone) is called now and then with the approximate table bytes read.
  forEach(fn, onProgress) {
    const it = this.iterator();
    let last = null;
    let count = 0;
    while (it.valid) {
      const k = it.key;
      const ulen = k.length - 8;
      let same = last !== null && last.length === ulen;
      if (same) {
        for (let i = 0; i < ulen; i++) if (k[i] !== last[i]) { same = false; break; }
      }
      if (!same) {
        last = k.subarray(0, ulen);
        if (k[ulen] === TYPE_VALUE) fn(last, it.value);
      }
      if (onProgress && (++count & 0x3fff) === 0) onProgress(count);
      it.next();
    }
  }

  // Like forEach, but reports each live key with the length of its value and
  // extract(key, value) of it. summaries (optional) maps a table number to
  // summarizeTable() output made elsewhere with the same extract, so the slow
  // part (decompressing tables) can run in parallel.
  forEachKey(fn, summaries = null, extract = null) {
    const children = [new ArrayIter(this.mem)];
    this.files.forEach((list, level) => {
      if (!list || !list.length) return;
      const iterFor = (f) => {
        const s = summaries?.get(f.number);
        return s ? new SummaryIter(s) : this.table(f.number).iterator();
      };
      if (level === 0) for (const f of list) children.push(iterFor(f));
      else children.push(new ConcatIter(list.map((f) => () => ({ iterator: () => iterFor(f) }))));
    });
    const it = new MergeIter(children);
    let last = null;
    while (it.valid) {
      const k = it.key;
      const ulen = k.length - 8;
      let same = last !== null && last.length === ulen;
      if (same) {
        for (let i = 0; i < ulen; i++) if (k[i] !== last[i]) { same = false; break; }
      }
      if (!same) {
        last = k.subarray(0, ulen);
        if (k[ulen] === TYPE_VALUE) {
          const src = it.heap[0];
          if (typeof src.value === 'number') fn(last, src.value, src.extra);
          else fn(last, src.value.length, extract ? extract(last, src.value) : null);
        }
      }
      it.next();
    }
  }

  // Newest value for ukey, or null if it is absent or deleted.
  get(ukey) {
    let best = null;
    // Memtable entries come from logs, which are newer than every table.
    let lo = 0, hi = this.mem.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareUserToInternal(ukey, this.mem[mid].key) > 0) lo = mid + 1; else hi = mid;
    }
    if (lo < this.mem.length && equalBytes(this.mem[lo].ukey, ukey)) {
      const e = this.mem[lo];
      return e.op.type === TYPE_VALUE ? e.value : null;
    }
    for (const list of this.files) {
      if (!list) continue;
      for (const f of list) {
        if (compareUserToInternal(ukey, f.smallest) < 0 || compareUserToInternal(ukey, f.largest) > 0) continue;
        const e = this.table(f.number).get(ukey);
        if (e && (!best || e.seq > best.seq)) best = e;
      }
    }
    return best && best.type === TYPE_VALUE ? best.value : null;
  }

  // Builds a new log file holding the given operations ({ key, value } puts or { key, value: null } deletes).
  // Returns { name, bytes } for a file to add next to the existing ones.
  buildChangeLog(ops) {
    const number = this.maxFileNumber + 1;
    const records = [];
    let seq = this.lastSequence + 1;
    // Keep each batch to a moderate size so the game never has to replay one huge record.
    const MAX_BATCH_BYTES = 4 << 20;
    let batch = [], bytes = 0;
    const flush = () => {
      if (!batch.length) return;
      records.push(encodeWriteBatch(seq, batch));
      seq += batch.length;
      batch = []; bytes = 0;
    };
    for (const op of ops) {
      batch.push(op);
      bytes += op.key.length + (op.value ? op.value.length : 0) + 16;
      if (bytes >= MAX_BATCH_BYTES) flush();
    }
    flush();
    return { name: this.fileName(number, 'log'), bytes: encodeLogRecords(records) };
  }
}

export { compareBytes };
