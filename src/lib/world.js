// A Bedrock world: its database, level.dat, and the changes waiting to be saved.

import { LevelDB } from './leveldb.js';
import { parseLevelDat, parseAll, serializeAll, toPlain, T } from './nbt.js';
import {
  parseChunkKey, parseDigpKey, isActorKey, chunkKey, digpKey, actorKey, describeKey, TAG_SUBCHUNK, DIMENSIONS,
} from './keys.js';
import { summarizePlayer } from './items.js';
import { toHex, fromHex, utf8, fromUtf8, printableKey } from './bytes.js';

// files: { paths: string[], open(path) -> { size, read(offset, length) } | null }
// Paths use "/" and are relative to the archive or folder that was opened.
export function findWorldRoots(paths) {
  const roots = [];
  for (const p of paths) {
    if (p === 'db/CURRENT' || p.endsWith('/db/CURRENT')) roots.push(p.slice(0, -'db/CURRENT'.length));
  }
  return roots.sort((a, b) => a.length - b.length);
}

const packPart = (tag, sub) => tag + (sub === null ? 0 : (sub + 129) * 256);
const unpackPart = (p) => ({ tag: p & 255, sub: p >> 8 ? (p >> 8) - 129 : null });

export class World {
  constructor(files, root = null) {
    const roots = findWorldRoots(files.paths);
    if (!roots.length) throw new Error('No world found. Choose a .mcworld file, or a world folder that has a db folder and level.dat inside it.');
    this.root = root ?? roots[0];
    this.roots = roots;
    this.files = files;
    this.paths = files.paths.filter((p) => p.startsWith(this.root));
    const dbPrefix = this.root + 'db/';
    this.readBytes = 0;
    const self = this;
    this.db = new LevelDB({
      names: this.paths.filter((p) => p.startsWith(dbPrefix) && !p.slice(dbPrefix.length).includes('/')).map((p) => p.slice(dbPrefix.length)),
      open(name) {
        const f = files.open(dbPrefix + name);
        if (!f) return null;
        return { size: f.size, read(off, len) { self.readBytes += len; return f.read(off, len); } };
      },
    });
    this.levelDat = null;
    const ld = files.open(this.root + 'level.dat');
    if (ld) {
      try { this.levelDat = parseLevelDat(ld.read(0, ld.size)); } catch (e) { this.levelDatError = e.message; }
    }
    const ln = files.open(this.root + 'levelname.txt');
    this.levelName = ln ? fromUtf8(ln.read(0, ln.size)).trim() : null;
    if (!this.levelName && this.levelDat) this.levelName = toPlain(this.levelDat.tag).LevelName ?? null;
    this.edits = new Map(); // hex key -> { key, value (null = delete), why }
    this.deletedChunks = [new Map(), new Map(), new Map()]; // "x,z" -> hex keys
    this.scanned = false;
  }

  info() {
    const ld = this.levelDat ? toPlain(this.levelDat.tag) : {};
    return {
      levelName: this.levelName,
      roots: this.roots,
      root: this.root,
      seed: ld.RandomSeed !== undefined ? String(ld.RandomSeed) : null,
      spawn: ld.SpawnX !== undefined ? [ld.SpawnX, ld.SpawnY, ld.SpawnZ] : null,
      lastPlayed: ld.LastPlayed !== undefined ? Number(ld.LastPlayed) * 1000 : null,
      version: Array.isArray(ld.lastOpenedWithVersion) ? ld.lastOpenedWithVersion.slice(0, 4).join('.') : null,
      gameType: ld.GameType,
      tableCount: this.db.tableCount,
      tableBytes: this.db.totalTableBytes,
      logCount: this.db.logNumbers.length,
      pendingFromLog: this.db.mem.length,
      levelDatError: this.levelDatError ?? null,
    };
  }

  // Reads every key once to learn what is in the world.
  // summaries: optional Map of table number -> summarizeTable() output, made in parallel elsewhere.
  scan(onProgress, summaries = null) {
    const chunks = [new Map(), new Map(), new Map()];
    const players = [];
    const other = [];
    let actors = 0, keys = 0, bytes = 0;
    const total = Math.max(this.db.totalTableBytes, 1);
    const start = this.readBytes;
    let lastReport = 0;
    const chunkAt = (dim, x, z) => {
      const m = chunks[dim] ?? (chunks[dim] = new Map());
      const id = x + ',' + z;
      let c = m.get(id);
      if (!c) { c = { x, z, bytes: 0, parts: [], digp: false, blockEntities: false }; m.set(id, c); }
      return c;
    };
    this.db.forEachKey((k, vlen) => {
      keys++;
      bytes += vlen;
      if (onProgress && !summaries && (keys & 0x3fff) === 0) {
        const done = (this.readBytes - start) / total;
        if (done - lastReport > 0.005) { lastReport = done; onProgress(Math.min(done, 1)); }
      }
      const c = parseChunkKey(k);
      if (c) {
        const ch = chunkAt(c.dim, c.x, c.z);
        ch.bytes += vlen;
        ch.parts.push(packPart(c.tag, c.sub));
        if (c.tag === 0x31) ch.blockEntities = true;
        if (c.tag === 0x32 && vlen) ch.digp = true;
        return;
      }
      const d = parseDigpKey(k);
      if (d) {
        const ch = chunkAt(d.dim, d.x, d.z);
        ch.hasDigpKey = true;
        if (vlen) ch.digp = true;
        return;
      }
      if (isActorKey(k)) { actors++; return; }
      const desc = describeKey(k);
      if (desc.kind === 'player') players.push({ key: toHex(k), text: desc.text, size: vlen });
      other.push({ key: toHex(k), label: desc.label, kind: desc.kind, size: vlen });
    }, summaries);
    this.chunks = chunks;
    this.playerKeys = players;
    this.otherKeys = other;
    this.stats = { keys, bytes, actors, chunks: chunks.map((m) => m.size) };
    this.scanned = true;
    return this.stats;
  }

  // The table files a scan has to read, biggest first (for sharing out between workers).
  tableJobs() {
    const jobs = [];
    for (const list of this.db.files) {
      if (!list) continue;
      for (const f of list) jobs.push({ number: f.number, path: this.root + 'db/' + this.db.fileName(f.number, 'ldb'), size: f.size });
    }
    return jobs.sort((a, b) => b.size - a.size);
  }

  // -------------------------------------------------------------------------
  // Reading, with pending changes applied on top

  get(key) {
    const e = this.edits.get(toHex(key));
    if (e) return e.value;
    return this.db.get(key);
  }

  record(keyHex) {
    const key = fromHex(keyHex);
    const desc = describeKey(key);
    const value = this.get(key);
    const out = { key: keyHex, printable: printableKey(key), desc, size: value ? value.length : 0, deleted: value == null, edited: this.edits.has(keyHex) };
    if (!value) return out;
    const isNbt = desc.kind === 'chunk' ? desc.nbt : desc.kind !== 'digp';
    if (isNbt && value.length) {
      try {
        const { roots, rest } = parseAll(value);
        out.nbt = roots;
        if (rest.length) out.restHex = toHex(rest.subarray(0, 4096));
      } catch (e) {
        out.nbtError = e.message;
      }
    }
    if (desc.kind === 'digp') {
      out.actorIds = [];
      for (let i = 0; i + 8 <= value.length; i += 8) out.actorIds.push(toHex(actorKey(value.subarray(i, i + 8))));
    }
    if (!out.nbt) {
      if (desc.kind === 'text' && value.length < 4096 && value.every((b) => b >= 0x20 || b === 10 || b === 13 || b === 9)) out.text = fromUtf8(value);
      out.hex = toHex(value.subarray(0, 4096));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Players

  players() {
    const links = new Map();
    for (const o of this.otherKeys) {
      if (o.kind !== 'playerid') continue;
      try {
        const v = this.get(fromHex(o.key));
        if (!v) continue;
        const p = toPlain(parseAll(v).roots[0]);
        if (p.ServerId) links.set(p.ServerId, { msaId: p.MsaId ?? null, selfSignedId: p.SelfSignedId ?? null, linkKey: o.text ?? o.label });
      } catch { /* not every link record parses; skip it */ }
    }
    return this.playerKeys.map((p) => {
      const v = this.get(fromHex(p.key));
      let summary = null, error = null;
      if (v) {
        try { summary = summarizePlayer(parseAll(v).roots[0]); } catch (e) { error = e.message; }
      }
      return { ...p, id: p.text === '~local_player' ? 'local' : p.text.replace(/^player_server_/, ''), link: links.get(p.text) ?? null, summary, error, deleted: !v, edited: this.edits.has(p.key) };
    });
  }

  // -------------------------------------------------------------------------
  // Chunks

  chunkList(dim) {
    const m = this.chunks?.[dim];
    if (!m) return new Int32Array(0);
    const out = new Int32Array(m.size * 4);
    let i = 0;
    const deleted = this.deletedChunks[dim];
    for (const [id, c] of m) {
      out[i++] = c.x;
      out[i++] = c.z;
      out[i++] = c.bytes;
      out[i++] = (deleted.has(id) ? 1 : 0) | (c.digp ? 2 : 0) | (c.blockEntities ? 4 : 0) | (c.parts.length === 0 ? 8 : 0);
    }
    return out;
  }

  chunkKeys(dim, x, z) {
    const c = this.chunks?.[dim]?.get(x + ',' + z);
    if (!c) return [];
    const keys = c.parts.map((p) => { const { tag, sub } = unpackPart(p); return chunkKey(x, z, dim, tag, sub); });
    if (c.hasDigpKey) keys.push(digpKey(x, z, dim));
    return keys;
  }

  chunkDetail(dim, x, z) {
    const keys = this.chunkKeys(dim, x, z).map((k) => {
      const d = describeKey(k);
      const v = this.get(k);
      return { key: toHex(k), label: d.label.replace(/^Chunk [^·]*· /, ''), tag: d.tag ?? null, sub: d.sub ?? null, size: v ? v.length : 0 };
    });
    // Entities stored on their own (Bedrock 1.18.30 and later).
    const c = this.chunks?.[dim]?.get(x + ',' + z);
    const digp = c?.hasDigpKey ? this.get(digpKey(x, z, dim)) : null;
    const entities = [];
    if (digp) {
      for (let i = 0; i + 8 <= digp.length; i += 8) {
        const k = actorKey(digp.subarray(i, i + 8));
        const v = this.get(k);
        let identifier = null;
        if (v) { try { identifier = toPlain(parseAll(v).roots[0]).identifier ?? null; } catch { /* leave unnamed */ } }
        entities.push({ key: toHex(k), identifier, size: v ? v.length : 0 });
      }
    }
    return { dim, x, z, keys, entities, deleted: this.deletedChunks[dim].has(x + ',' + z) };
  }

  // Marks chunks for deletion so the game regenerates them from the seed.
  // Removes block data, block entities and the chunk's entities.
  deleteChunks(dim, coords) {
    let n = 0;
    for (const [x, z] of coords) {
      const id = x + ',' + z;
      if (this.deletedChunks[dim].has(id) || !this.chunks[dim].has(id)) continue;
      const hexes = [];
      const del = (k, why) => {
        const h = toHex(k);
        if (this.edits.has(h)) return;
        this.edits.set(h, { key: k, value: null, why });
        hexes.push(h);
      };
      const c = this.chunks[dim].get(id);
      const digp = c.hasDigpKey && c.digp ? this.get(digpKey(x, z, dim)) : null;
      if (digp) for (let i = 0; i + 8 <= digp.length; i += 8) del(actorKey(digp.subarray(i, i + 8)), `entity in chunk ${x}, ${z}`);
      for (const k of this.chunkKeys(dim, x, z)) del(k, `chunk ${x}, ${z}`);
      this.deletedChunks[dim].set(id, hexes);
      n++;
    }
    return n;
  }

  restoreChunks(dim, coords) {
    let n = 0;
    for (const [x, z] of coords) {
      const id = x + ',' + z;
      const hexes = this.deletedChunks[dim].get(id);
      if (!hexes) continue;
      for (const h of hexes) this.edits.delete(h);
      this.deletedChunks[dim].delete(id);
      n++;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // Editing NBT records

  // ops: [{ path: [rootIndex, childIndex, ...], action: 'set' | 'delete', value }]
  editRecord(keyHex, ops) {
    const key = fromHex(keyHex);
    const value = this.get(key);
    if (!value) throw new Error('That record no longer exists.');
    const { roots, rest } = parseAll(value);
    for (const op of ops) {
      const path = op.path;
      if (op.action === 'delete') {
        const parent = resolve(roots, path.slice(0, -1));
        const list = path.length === 1 ? roots : parent.v;
        list.splice(path[path.length - 1], 1);
      } else if (op.action === 'set') {
        const tag = resolve(roots, path);
        tag.v = coerce(tag.t, op.value);
        delete tag.raw;
      } else throw new Error(`Unknown edit ${op.action}`);
    }
    this.edits.set(keyHex, { key, value: serializeAll(roots, rest), why: 'edited' });
    return this.record(keyHex);
  }

  deleteRecord(keyHex) {
    this.edits.set(keyHex, { key: fromHex(keyHex), value: null, why: 'deleted' });
  }

  revertRecord(keyHex) {
    this.edits.delete(keyHex);
    for (const m of this.deletedChunks) {
      for (const [id, hexes] of m) {
        const i = hexes.indexOf(keyHex);
        if (i >= 0) hexes.splice(i, 1);
        if (!hexes.length) m.delete(id);
      }
    }
  }

  pending() {
    const chunks = this.deletedChunks.map((m) => m.size);
    const other = [];
    const inChunks = new Set();
    for (const m of this.deletedChunks) for (const hexes of m.values()) for (const h of hexes) inChunks.add(h);
    for (const [h, e] of this.edits) {
      if (inChunks.has(h)) continue;
      other.push({ key: h, label: describeKey(e.key).label, action: e.value ? 'changed' : 'deleted' });
    }
    return { total: this.edits.size, chunks, other };
  }

  // The new database log holding every pending change, ready to add to db/.
  changeLog() {
    const ops = [...this.edits.values()].map((e) => ({ key: e.key, value: e.value }));
    const log = this.db.buildChangeLog(ops);
    return { path: this.root + 'db/' + log.name, bytes: log.bytes, ops: ops.length };
  }
}

function resolve(roots, path) {
  let cur = roots[path[0]];
  for (let i = 1; i < path.length; i++) {
    if (!cur || (cur.t !== T.Compound && cur.t !== T.List)) throw new Error('Bad path');
    cur = cur.v[path[i]];
  }
  if (!cur) throw new Error('Bad path');
  return cur;
}

const LIMITS = { [T.Byte]: [-128, 127], [T.Short]: [-32768, 32767], [T.Int]: [-2147483648, 2147483647] };

function coerce(t, input) {
  const s = String(input).trim();
  switch (t) {
    case T.Byte: case T.Short: case T.Int: {
      if (!/^-?\d+$/.test(s)) throw new Error('Please enter a whole number.');
      const n = Number(s);
      const [lo, hi] = LIMITS[t];
      if (n < lo || n > hi) throw new Error(`That number must be between ${lo} and ${hi}.`);
      return n;
    }
    case T.Long: {
      if (!/^-?\d+$/.test(s)) throw new Error('Please enter a whole number.');
      const n = BigInt(s);
      if (n < -(2n ** 63n) || n >= 2n ** 63n) throw new Error('That number is too large.');
      return n;
    }
    case T.Float: case T.Double: {
      const n = Number(s);
      if (s === '' || Number.isNaN(n)) throw new Error('Please enter a number.');
      return n;
    }
    case T.String: return String(input);
    default: throw new Error('Only single values can be edited directly.');
  }
}

export { DIMENSIONS, TAG_SUBCHUNK, utf8 };
