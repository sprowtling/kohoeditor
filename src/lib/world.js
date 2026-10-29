// A Bedrock world: its database, level.dat, and the changes waiting to be saved.
//
// Changes are kept as "operations" (regenerate these chunks, paste here, edit
// this record...). Each operation remembers what it replaced, so it can be
// undone on its own, and the pending list can say what will happen in plain
// words. Nothing touches the files on disk; saving writes all current edits
// into one new database log.

import { LevelDB } from './leveldb.js';
import { parseLevelDat, serializeLevelDat, parseAll, serializeAll, parse, serialize, toPlain, child, val, T } from './nbt.js';
import {
  parseChunkKey, parseDigpKey, isActorKey, chunkKey, digpKey, actorKey, describeKey, TAG_SUBCHUNK, DIMENSIONS,
} from './keys.js';
import { summarizePlayer } from './items.js';
import { extractSurface } from './biomes.js';
import { Reader, Writer, toHex, fromHex, utf8, fromUtf8, printableKey } from './bytes.js';
import { deflateSync, inflateSync } from '../../vendor/fflate.js';

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

const META_DICT_KEY = utf8('LevelChunkMetaDataDictionary');
const TAG_BLOCK_ENTITIES = 0x31, TAG_LEGACY_ENTITIES = 0x32, TAG_PENDING_TICKS = 0x33, TAG_RANDOM_TICKS = 0x3a, TAG_META_HASH = 0x3f;

// Flags in chunkList()
export const CHUNK_DELETED = 1, CHUNK_ENTITIES = 2, CHUNK_BLOCK_ENTITIES = 4, CHUNK_EMPTY = 8, CHUNK_PASTED = 16;

const ITEM_LISTS = { Inventory: 'slot', EnderChestInventory: 'slot', Armor: 'index', Offhand: 'index' };

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
    this.edits = new Map(); // hex key -> { key, value (null = delete), why, op }
    this.ops = new Map(); // id -> operation
    this.nextOp = 1;
    this.deleted = [new Map(), new Map(), new Map()]; // "x,z" -> id of the operation that deleted it
    this.recordOps = new Map(); // hex key -> its edit operation
    this.levelDatEdit = null; // { tag, op } once level.dat has been changed
    this.clipboard = null;
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
  // summaries: optional Map of table number -> summarizeTable(table, extractSurface) output, made in parallel elsewhere.
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
      if (!c) { c = newChunkEntry(x, z); m.set(id, c); }
      return c;
    };
    this.db.forEachKey((k, vlen, extra) => {
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
        if (c.tag === TAG_BLOCK_ENTITIES) ch.blockEntities = true;
        if (c.tag === TAG_LEGACY_ENTITIES && vlen) ch.digp = true;
        // Data3D sorts before Data2D, so a chunk with both keeps the newer one.
        if (extra && !ch.surface) ch.surface = extra.slice();
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
    }, summaries, extractSurface);
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
  // Operations and undo

  newOp(type, label, extra = {}) {
    const op = { id: this.nextOp++, type, label, saved: new Map(), current: new Map(), ...extra };
    this.ops.set(op.id, op);
    return op;
  }

  // Sets one database key as part of an operation, remembering what was there first.
  setEdit(op, key, value, why) {
    const h = toHex(key);
    if (!op.saved.has(h)) op.saved.set(h, this.edits.get(h));
    const e = { key, value, why, op: op.id };
    this.edits.set(h, e);
    op.current.set(h, e);
    return e;
  }

  // Puts back what an operation replaced, for all of its keys or just some.
  // A key is left alone if something later has changed it again.
  undoKeys(op, hexes = [...op.saved.keys()]) {
    for (const h of hexes) {
      if (!op.saved.has(h)) continue;
      if (this.edits.get(h) === op.current.get(h)) {
        const prev = op.saved.get(h);
        if (prev) this.edits.set(h, prev); else this.edits.delete(h);
      }
      op.saved.delete(h);
      op.current.delete(h);
    }
  }

  undoOperation(id) {
    const op = this.ops.get(id);
    if (!op) return false;
    if (op.type === 'delete') {
      const coords = [...op.byChunk.keys()].map((cid) => cid.split(',').map(Number));
      this.restoreChunks(op.dim, coords);
    } else if (op.type === 'paste') {
      this.undoKeys(op);
      for (const [cid, prev] of op.chunkPrev) {
        const m = this.chunks[op.dim];
        if (m.get(cid) !== op.chunkSet.get(cid)) continue;
        if (prev.entry) m.set(cid, prev.entry); else m.delete(cid);
        if (prev.deletedBy) {
          const dop = this.ops.get(prev.deletedBy);
          if (dop) { this.deleted[op.dim].set(cid, dop.id); dop.byChunk.set(cid, prev.deletedHexes); }
        }
      }
    } else if (op.type === 'leveldat') {
      this.levelDatEdit = null;
    } else {
      this.undoKeys(op);
      for (const [h, o] of this.recordOps) if (o === op) this.recordOps.delete(h);
    }
    this.ops.delete(id);
    return true;
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

  // Puts an item in a player's slot, or empties it (item = null).
  // item: { id, count, damage, customName, enchants: [{ id, level }] }
  setItem(keyHex, listName, slot, item) {
    if (!ITEM_LISTS[listName]) throw new Error(`Unknown inventory ${listName}`);
    const key = fromHex(keyHex);
    const value = this.get(key);
    if (!value) throw new Error('That player record no longer exists.');
    const { roots, rest } = parseAll(value);
    const root = roots[0];
    let list = child(root, listName);
    if (!list) { list = { n: listName, t: T.List, et: T.Compound, v: [] }; root.v.push(list); }
    const bySlot = ITEM_LISTS[listName] === 'slot';
    let entry;
    if (bySlot) entry = list.v.find((c) => val(c, 'Slot') === slot);
    else {
      while (list.v.length <= slot) list.v.push(emptyItem(null));
      entry = list.v[slot];
    }
    if (!entry) { entry = emptyItem(slot); list.v.push(entry); }
    if (!item) {
      const fresh = emptyItem(bySlot ? slot : null);
      entry.v = fresh.v;
    } else {
      const id = String(item.id ?? '').trim();
      if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)) throw new Error('Item ids look like minecraft:diamond_sword.');
      const count = Number(item.count);
      if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('The count must be a whole number from 1 to 64.');
      const damage = Number(item.damage ?? 0);
      if (!Number.isInteger(damage) || damage < 0 || damage > 32767) throw new Error('Damage must be a whole number from 0 to 32767.');
      if (val(entry, 'Name') !== id) {
        // A different item: start clean so nothing from the old one carries over.
        entry.v = entry.v.filter((c) => !['tag', 'Block', 'CanPlaceOn', 'CanDestroy'].includes(c.n));
      }
      setChild(entry, 'Name', T.String, id);
      setChild(entry, 'Count', T.Byte, count);
      setChild(entry, 'Damage', T.Short, damage);
      if (bySlot) setChild(entry, 'Slot', T.Byte, slot);
      if (!child(entry, 'WasPickedUp')) setChild(entry, 'WasPickedUp', T.Byte, 0);
      let tag = child(entry, 'tag');
      if (!tag) { tag = { n: 'tag', t: T.Compound, v: [] }; entry.v.push(tag); }
      const enchants = (item.enchants ?? []).filter((e) => e && e.id !== '' && e.id != null);
      tag.v = tag.v.filter((c) => c.n !== 'ench');
      if (enchants.length) {
        tag.v.push({ n: 'ench', t: T.List, et: T.Compound, v: enchants.map((e) => {
          const eid = Number(e.id), lvl = Number(e.level);
          if (!Number.isInteger(eid) || eid < 0 || eid > 255) throw new Error('Unknown enchantment.');
          if (!Number.isInteger(lvl) || lvl < 1 || lvl > 255) throw new Error('Enchantment levels go from 1 to 255.');
          return { t: T.Compound, v: [{ n: 'id', t: T.Short, v: eid }, { n: 'lvl', t: T.Short, v: lvl }] };
        }) });
      }
      let display = child(tag, 'display');
      const name = (item.customName ?? '').trim();
      if (name) {
        if (!display) { display = { n: 'display', t: T.Compound, v: [] }; tag.v.push(display); }
        setChild(display, 'Name', T.String, name);
      } else if (display) {
        display.v = display.v.filter((c) => c.n !== 'Name');
        if (!display.v.length) tag.v = tag.v.filter((c) => c !== display);
      }
      if (!tag.v.length) entry.v = entry.v.filter((c) => c !== tag);
    }
    this.recordChange(keyHex, serializeAll(roots, rest));
  }

  // -------------------------------------------------------------------------
  // Chunks

  // Returns { list: Int32Array of [x, z, bytes, flags] per chunk, surface: Uint8Array of biome samples }.
  chunkList(dim) {
    const m = this.chunks?.[dim];
    if (!m) return { list: new Int32Array(0), surface: new Uint8Array(0) };
    const list = new Int32Array(m.size * 4);
    const surface = new Uint8Array(m.size * 48);
    let i = 0, s = 0;
    const deleted = this.deleted[dim];
    for (const [id, c] of m) {
      list[i++] = c.x;
      list[i++] = c.z;
      list[i++] = c.bytes;
      list[i++] = (deleted.has(id) ? CHUNK_DELETED : 0) | (c.digp ? CHUNK_ENTITIES : 0) | (c.blockEntities ? CHUNK_BLOCK_ENTITIES : 0)
        | (c.parts.length === 0 ? CHUNK_EMPTY : 0) | (c.pasted ? CHUNK_PASTED : 0);
      if (c.surface) surface.set(c.surface, s); else surface.fill(255, s, s + 16);
      s += 48;
    }
    return { list, surface };
  }

  chunkKeys(dim, x, z) {
    const c = this.chunks?.[dim]?.get(x + ',' + z);
    if (!c) return [];
    const keys = c.parts.map((p) => { const { tag, sub } = unpackPart(p); return chunkKey(x, z, dim, tag, sub); });
    if (c.hasDigpKey) keys.push(digpKey(x, z, dim));
    return keys;
  }

  // Database keys of the separately stored entities in a chunk.
  entityKeys(dim, x, z) {
    const c = this.chunks?.[dim]?.get(x + ',' + z);
    if (!c?.hasDigpKey) return [];
    const digp = this.get(digpKey(x, z, dim));
    const out = [];
    if (digp) for (let i = 0; i + 8 <= digp.length; i += 8) out.push(actorKey(digp.subarray(i, i + 8)));
    return out;
  }

  chunkDetail(dim, x, z) {
    const keys = this.chunkKeys(dim, x, z).map((k) => {
      const d = describeKey(k);
      const v = this.get(k);
      return { key: toHex(k), label: d.label.replace(/^Chunk [^·]*· /, ''), tag: d.tag ?? null, sub: d.sub ?? null, size: v ? v.length : 0 };
    });
    const entities = this.entityKeys(dim, x, z).map((k) => {
      const v = this.get(k);
      let identifier = null;
      if (v) { try { identifier = toPlain(parseAll(v).roots[0]).identifier ?? null; } catch { /* leave unnamed */ } }
      return { key: toHex(k), identifier, size: v ? v.length : 0 };
    });
    const c = this.chunks?.[dim]?.get(x + ',' + z);
    return { dim, x, z, keys, entities, deleted: this.deleted[dim].has(x + ',' + z), pasted: !!c?.pasted };
  }

  // Marks chunks for deletion so the game regenerates them from the seed.
  // Removes block data, block entities and the chunk's entities.
  deleteChunks(dim, coords) {
    const op = this.newOp('delete', '', { dim, byChunk: new Map() });
    for (const [x, z] of coords) {
      const id = x + ',' + z;
      if (this.deleted[dim].has(id) || !this.chunks[dim].has(id)) continue;
      const hexes = [];
      for (const k of this.entityKeys(dim, x, z)) { this.setEdit(op, k, null, `entity in chunk ${x}, ${z}`); hexes.push(toHex(k)); }
      for (const k of this.chunkKeys(dim, x, z)) { this.setEdit(op, k, null, `chunk ${x}, ${z}`); hexes.push(toHex(k)); }
      this.deleted[dim].set(id, op.id);
      op.byChunk.set(id, hexes);
    }
    if (!op.byChunk.size) { this.ops.delete(op.id); return 0; }
    return op.byChunk.size;
  }

  restoreChunks(dim, coords) {
    let n = 0;
    for (const [x, z] of coords) {
      const id = x + ',' + z;
      const op = this.ops.get(this.deleted[dim].get(id));
      if (!op) continue;
      this.undoKeys(op, op.byChunk.get(id));
      op.byChunk.delete(id);
      this.deleted[dim].delete(id);
      if (!op.byChunk.size) this.ops.delete(op.id);
      n++;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // Copy and paste

  metaDictionary() {
    const v = this.get(META_DICT_KEY);
    return v ? parseMetaDictionary(v) : new Map();
  }

  // Copies chunks (with their block entities and entities) to the clipboard.
  copyChunks(dim, coords) {
    const dict = this.metaDictionary();
    const chunks = [];
    const meta = new Map();
    let bytes = 0;
    for (const [x, z] of coords) {
      const id = x + ',' + z;
      const c = this.chunks[dim].get(id);
      if (!c || this.deleted[dim].has(id) || !c.parts.length) continue;
      const records = [];
      for (const p of c.parts) {
        const { tag, sub } = unpackPart(p);
        const value = this.get(chunkKey(x, z, dim, tag, sub));
        if (!value) continue;
        records.push({ tag, sub, value });
        bytes += value.length;
        if (tag === TAG_META_HASH && value.length === 8) {
          const h = toHex(value);
          if (dict.has(h)) meta.set(h, dict.get(h));
        }
      }
      const entities = [];
      for (const k of this.entityKeys(dim, x, z)) {
        const v = this.get(k);
        if (v) { entities.push(v); bytes += v.length; }
      }
      chunks.push({ x, z, records, entities });
    }
    if (!chunks.length) throw new Error('None of the selected chunks have anything in them to copy.');
    this.clipboard = makeClipboard({ world: this.levelName, dim, chunks, meta, created: Date.now() });
    return clipboardInfo(this.clipboard, bytes);
  }

  clipboardInfo() { return this.clipboard ? clipboardInfo(this.clipboard) : null; }

  clipboardFile() {
    if (!this.clipboard) throw new Error('Nothing has been copied yet.');
    return encodeClipboard(this.clipboard);
  }

  loadClipboard(bytes) {
    this.clipboard = decodeClipboard(bytes);
    return clipboardInfo(this.clipboard);
  }

  // Pastes the clipboard so its corner chunk (smallest x and z) lands on tx, tz.
  // Destination chunks are replaced completely.
  pasteChunks(dim, tx, tz, { entities = true } = {}) {
    const clip = this.clipboard;
    if (!clip) throw new Error('Nothing has been copied yet.');
    const dx = tx - clip.bounds.x0, dz = tz - clip.bounds.z0;
    const bx = dx * 16, bz = dz * 16;
    const op = this.newOp('paste', '', { dim, chunkPrev: new Map(), chunkSet: new Map(), at: [tx, tz], count: 0, from: clip.world });
    const ids = new EntityIds(this);
    // New ids for every entity first, so references between them can follow along.
    const uidMap = new Map();
    for (const ch of clip.chunks) {
      if (entities) for (const v of ch.entities) noteUid(v, uidMap, ids);
      for (const r of ch.records) if (r.tag === TAG_LEGACY_ENTITIES && entities) for (const root of safeRoots(r.value)) noteUidTag(root, uidMap, ids);
    }
    for (const ch of clip.chunks) {
      const x = ch.x + dx, z = ch.z + dz, cid = x + ',' + z;
      // Clear whatever is at the destination.
      for (const k of this.entityKeys(dim, x, z)) this.setEdit(op, k, null, `replaced by paste at ${x}, ${z}`);
      for (const k of this.chunkKeys(dim, x, z)) this.setEdit(op, k, null, `replaced by paste at ${x}, ${z}`);
      const entry = newChunkEntry(x, z);
      entry.pasted = true;
      for (const r of ch.records) {
        if (r.tag === TAG_LEGACY_ENTITIES && !entities) continue;
        const value = transformRecord(r.tag, r.value, bx, bz, uidMap);
        this.setEdit(op, chunkKey(x, z, dim, r.tag, r.sub), value, `pasted chunk ${x}, ${z}`);
        entry.parts.push(packPart(r.tag, r.sub));
        entry.bytes += value.length;
        if (r.tag === TAG_BLOCK_ENTITIES) entry.blockEntities = true;
        if (r.tag === TAG_LEGACY_ENTITIES && value.length) entry.digp = true;
        if ((r.tag === 0x2b || r.tag === 0x2d) && !entry.surface) entry.surface = extractSurface(chunkKey(x, z, dim, r.tag), value);
      }
      if (entities && ch.entities.length) {
        const keys = [];
        for (const v of ch.entities) {
          const moved = moveEntity(v, bx, bz, uidMap);
          if (!moved) continue;
          this.setEdit(op, actorKey(moved.key8), moved.bytes, `pasted entity at ${x}, ${z}`);
          keys.push(moved.key8);
        }
        const digp = new Uint8Array(keys.length * 8);
        keys.forEach((k, i) => digp.set(k, i * 8));
        this.setEdit(op, digpKey(x, z, dim), digp, `pasted chunk ${x}, ${z}`);
        entry.hasDigpKey = true;
        entry.digp = keys.length > 0;
      }
      const m = this.chunks[dim];
      const deletedBy = this.deleted[dim].get(cid);
      const prev = { entry: m.get(cid), deletedBy };
      if (deletedBy) {
        const dop = this.ops.get(deletedBy);
        prev.deletedHexes = dop.byChunk.get(cid);
        dop.byChunk.delete(cid); // an emptied operation stays, so undoing this paste can bring the mark back
        this.deleted[dim].delete(cid);
      }
      if (!op.chunkPrev.has(cid)) op.chunkPrev.set(cid, prev);
      m.set(cid, entry);
      op.chunkSet.set(cid, entry);
      op.count++;
    }
    // A chunk from another world may point at world settings this one lacks.
    if (clip.meta.size) {
      const dict = this.metaDictionary();
      let added = 0;
      for (const [h, nbt] of clip.meta) if (!dict.has(h)) { dict.set(h, nbt); added++; }
      if (added) this.setEdit(op, META_DICT_KEY, encodeMetaDictionary(dict), 'chunk settings for pasted chunks');
    }
    return { id: op.id, count: op.count };
  }

  // -------------------------------------------------------------------------
  // Editing NBT records

  recordChange(keyHex, value, why = 'edited') {
    let op = this.recordOps.get(keyHex);
    if (!op || !this.ops.has(op.id)) {
      op = this.newOp('record', describeKey(fromHex(keyHex)).label, { key: keyHex });
      this.recordOps.set(keyHex, op);
    }
    this.setEdit(op, fromHex(keyHex), value, why);
  }

  // ops: [{ path: [rootIndex, childIndex, ...], action: 'set' | 'delete', value }]
  editRecord(keyHex, ops) {
    const key = fromHex(keyHex);
    const value = this.get(key);
    if (!value) throw new Error('That record no longer exists.');
    const { roots, rest } = parseAll(value);
    applyTreeOps(roots, ops);
    this.recordChange(keyHex, serializeAll(roots, rest));
    return this.record(keyHex);
  }

  deleteRecord(keyHex) {
    this.recordChange(keyHex, null, 'deleted');
  }

  // Undoes whatever last changed this one key.
  revertRecord(keyHex) {
    const e = this.edits.get(keyHex);
    if (!e) return;
    const op = this.ops.get(e.op);
    if (!op) { this.edits.delete(keyHex); return; }
    if (op.type === 'delete') {
      for (const [cid, hexes] of op.byChunk) {
        const i = hexes.indexOf(keyHex);
        if (i >= 0) hexes.splice(i, 1);
        if (!hexes.length) { op.byChunk.delete(cid); this.deleted[op.dim].delete(cid); }
      }
    }
    this.undoKeys(op, [keyHex]);
    if (!op.saved.size && op.type !== 'paste') this.undoOperation(op.id);
  }

  // -------------------------------------------------------------------------
  // level.dat

  currentLevelDat() {
    return this.levelDatEdit?.tag ?? this.levelDat?.tag ?? null;
  }

  editLevelDat(ops) {
    if (!this.levelDat) throw new Error('This world has no level.dat to edit.');
    const tag = parse(serialize(this.currentLevelDat())); // a fresh copy
    applyTreeOps([tag], ops);
    if (!this.levelDatEdit) this.levelDatEdit = { tag, op: this.newOp('leveldat', 'World settings (level.dat)') };
    else this.levelDatEdit.tag = tag;
    return tag;
  }

  // Files to replace in the saved world: [{ path, bytes }]
  changedFiles() {
    if (!this.levelDatEdit) return [];
    const out = [{ path: this.root + 'level.dat', bytes: serializeLevelDat(this.levelDat.version, this.levelDatEdit.tag) }];
    const before = toPlain(this.levelDat.tag).LevelName;
    const after = val(this.levelDatEdit.tag, 'LevelName');
    if (after !== undefined && after !== before) out.push({ path: this.root + 'levelname.txt', bytes: utf8(after) });
    return out;
  }

  // -------------------------------------------------------------------------
  // What will be saved

  pending() {
    const chunks = this.deleted.map((m) => m.size);
    const pasted = [0, 0, 0];
    const operations = [];
    for (const op of this.ops.values()) {
      if (op.type === 'delete') {
        if (!op.byChunk.size) continue;
        operations.push({ id: op.id, type: op.type, dim: op.dim, count: op.byChunk.size, label: `Regenerate ${op.byChunk.size} chunk${op.byChunk.size === 1 ? '' : 's'} in the ${DIMENSIONS[op.dim]}` });
      } else if (op.type === 'paste') {
        pasted[op.dim] += op.count;
        operations.push({ id: op.id, type: op.type, dim: op.dim, count: op.count, at: op.at, label: `Paste ${op.count} chunk${op.count === 1 ? '' : 's'} at chunk ${op.at[0]}, ${op.at[1]} in the ${DIMENSIONS[op.dim]}${op.from && op.from !== this.levelName ? ` (from ${op.from})` : ''}` });
      } else if (op.type === 'leveldat') {
        operations.push({ id: op.id, type: op.type, label: op.label });
      } else if (op.current.size) {
        const e = [...op.current.values()][0];
        operations.push({ id: op.id, type: op.type, key: op.key, label: `${e.value ? 'Changed' : 'Deleted'}: ${op.label}` });
      }
    }
    const total = this.edits.size + (this.levelDatEdit ? 1 : 0);
    return { total, chunks, pasted, operations, count: operations.length };
  }

  // The new database log holding every pending change, ready to add to db/.
  changeLog() {
    const ops = [...this.edits.values()].map((e) => ({ key: e.key, value: e.value }));
    const log = this.db.buildChangeLog(ops);
    return { path: this.root + 'db/' + log.name, bytes: log.bytes, ops: ops.length };
  }
}

function newChunkEntry(x, z) {
  return { x, z, bytes: 0, parts: [], digp: false, blockEntities: false, hasDigpKey: false, surface: null, pasted: false };
}

function emptyItem(slot) {
  const v = [
    { n: 'Count', t: T.Byte, v: 0 }, { n: 'Damage', t: T.Short, v: 0 }, { n: 'Name', t: T.String, v: '' },
  ];
  if (slot !== null) v.push({ n: 'Slot', t: T.Byte, v: slot });
  v.push({ n: 'WasPickedUp', t: T.Byte, v: 0 });
  return { t: T.Compound, v };
}

function setChild(compound, name, t, v) {
  const c = child(compound, name);
  if (c) { c.t = t; c.v = v; delete c.raw; } else compound.v.push({ n: name, t, v });
}

function applyTreeOps(roots, ops) {
  for (const op of ops) {
    const path = op.path;
    if (op.action === 'delete') {
      const list = path.length === 1 ? roots : resolve(roots, path.slice(0, -1)).v;
      list.splice(path[path.length - 1], 1);
    } else if (op.action === 'set') {
      const tag = resolve(roots, path);
      tag.v = coerce(tag.t, op.value);
      delete tag.raw;
    } else throw new Error(`Unknown edit ${op.action}`);
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

// ---------------------------------------------------------------------------
// The chunk settings dictionary: u32 count, then (8 byte hash, NBT compound) pairs.

export function parseMetaDictionary(v) {
  const r = new Reader(v);
  const count = r.u32();
  const out = new Map();
  for (let i = 0; i < count && r.remaining > 8; i++) {
    const h = toHex(r.bytes(8));
    const start = r.pos;
    const sub = new Reader(v, start);
    skipTag(sub);
    out.set(h, v.slice(start, sub.pos));
    r.pos = sub.pos;
  }
  return out;
}

// Moves a reader past one NBT tag without building it. (Lengths are read into
// a variable first: "r.pos += r.u16()" would lose the bytes the length used.)
function skipTag(r) {
  const t = r.u8_();
  const nameLen = r.u16();
  r.bytes(nameLen);
  skipPayload(r, t);
}

function skipPayload(r, t) {
  const skip = (n) => r.bytes(n);
  switch (t) {
    case T.Byte: skip(1); break;
    case T.Short: skip(2); break;
    case T.Int: case T.Float: skip(4); break;
    case T.Long: case T.Double: skip(8); break;
    case T.ByteArray: { const n = r.i32(); skip(n); break; }
    case T.String: { const n = r.u16(); skip(n); break; }
    case T.List: { const et = r.u8_(); const n = r.i32(); for (let i = 0; i < n; i++) skipPayload(r, et); break; }
    case T.Compound: for (;;) { const ct = r.u8_(); if (!ct) break; const n = r.u16(); skip(n); skipPayload(r, ct); } break;
    case T.IntArray: { const n = r.i32(); skip(n * 4); break; }
    case T.LongArray: { const n = r.i32(); skip(n * 8); break; }
    default: throw new Error('Bad NBT');
  }
}

export function encodeMetaDictionary(map) {
  const w = new Writer(4096);
  w.u32(map.size);
  for (const [h, nbt] of map) { w.bytes(fromHex(h)); w.bytes(nbt); }
  return w.result();
}

// ---------------------------------------------------------------------------
// Moving things to a new position

const SHIFT_INTS = new Set(['x', 'z', 'pairx', 'pairz', 'boundX', 'boundZ']);

// Shifts block positions in NBT: int x/z fields (block entities, ticks,
// double chest partners) and 3-number Pos lists (entities).
function shiftNbt(tag, bx, bz) {
  if (tag.t === T.Compound) {
    for (const c of tag.v) {
      if ((c.t === T.Int) && SHIFT_INTS.has(c.n)) {
        if (c.n === 'x' || c.n === 'pairx' || c.n === 'boundX') c.v += bx; else c.v += bz;
      } else if (c.n === 'Pos' && c.t === T.List && c.v.length === 3 && (c.et === T.Float || c.et === T.Double || c.v[0]?.t === T.Float || c.v[0]?.t === T.Double)) {
        c.v[0].v += bx;
        c.v[2].v += bz;
      } else if (c.t === T.Compound || c.t === T.List) shiftNbt(c, bx, bz);
    }
  } else if (tag.t === T.List) {
    for (const c of tag.v) if (c.t === T.Compound || c.t === T.List) shiftNbt(c, bx, bz);
  }
}

function safeRoots(value) {
  try { return parseAll(value).roots; } catch { return []; }
}

function transformRecord(tag, value, bx, bz, uidMap) {
  if (tag !== TAG_BLOCK_ENTITIES && tag !== TAG_PENDING_TICKS && tag !== TAG_RANDOM_TICKS && tag !== TAG_LEGACY_ENTITIES) return value;
  if (bx === 0 && bz === 0 && tag !== TAG_LEGACY_ENTITIES) return value;
  let parsed;
  try { parsed = parseAll(value); } catch { return value; }
  for (const root of parsed.roots) {
    shiftNbt(root, bx, bz);
    if (tag === TAG_LEGACY_ENTITIES) remapUids(root, uidMap);
  }
  return serializeAll(parsed.roots, parsed.rest);
}

// Entity ids: the game hands out ids whose top half counts game sessions
// (starting near zero). Pasted entities get ids from a range the game will
// not reach, so they can never collide with real ones.
class EntityIds {
  constructor(world) {
    this.world = world;
    this.hi = 2000000000 + Math.floor(Math.random() * 140000000);
    this.lo = 0;
  }
  next() {
    for (;;) {
      this.lo++;
      if (this.lo > 0x7fffffff) { this.hi++; this.lo = 1; }
      const key8 = new Uint8Array(8);
      const dv = new DataView(key8.buffer);
      dv.setUint32(0, this.hi, false);
      dv.setUint32(4, this.lo, false);
      if (this.world.get(actorKey(key8))) continue;
      return { key8, uid: (BigInt(-this.hi) << 32n) + BigInt(this.lo) };
    }
  }
}

function noteUid(value, uidMap, ids) {
  for (const root of safeRoots(value)) noteUidTag(root, uidMap, ids);
}

function noteUidTag(root, uidMap, ids) {
  const uid = val(root, 'UniqueID');
  if (typeof uid === 'bigint' && !uidMap.has(uid)) uidMap.set(uid, ids.next());
}

const UID_REFS = new Set(['UniqueID', 'LeasherID', 'TargetID', 'OwnerNew', 'entityID', 'TrustedPlayer']);

function remapUids(tag, uidMap) {
  if (tag.t === T.Compound || tag.t === T.List) {
    for (const c of tag.v) {
      if (c.t === T.Long && (tag.t === T.Compound ? UID_REFS.has(c.n) : false)) {
        const m = uidMap.get(c.v);
        if (m) c.v = m.uid;
      } else if (c.t === T.Compound || c.t === T.List) remapUids(c, uidMap);
    }
  }
}

function moveEntity(value, bx, bz, uidMap) {
  let root;
  try { root = parse(value); } catch { return null; }
  const uid = val(root, 'UniqueID');
  const ids = uidMap.get(uid);
  if (!ids) return null;
  shiftNbt(root, bx, bz);
  remapUids(root, uidMap);
  const storage = child(child(child(root, 'internalComponents'), 'EntityStorageKeyComponent'), 'StorageKey');
  if (storage && storage.t === T.String) {
    storage.raw = ids.key8.slice();
    storage.v = String.fromCharCode(...ids.key8);
  }
  return { key8: ids.key8, bytes: serialize(root) };
}

// ---------------------------------------------------------------------------
// Clipboard files (.kohochunks): a small header, then the copied records, deflated.

const CLIP_MAGIC = 'KOHOCHUNKS';

function makeClipboard({ world, dim, chunks, meta, created }) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const c of chunks) { x0 = Math.min(x0, c.x); z0 = Math.min(z0, c.z); x1 = Math.max(x1, c.x); z1 = Math.max(z1, c.z); }
  return { world, dim, chunks, meta, created, bounds: { x0, z0, x1, z1 } };
}

function clipboardInfo(clip, bytes) {
  let entities = 0;
  for (const c of clip.chunks) entities += c.entities.length;
  return {
    world: clip.world, dim: clip.dim, count: clip.chunks.length, entities, bounds: clip.bounds, created: clip.created,
    bytes: bytes ?? clip.chunks.reduce((n, c) => n + c.records.reduce((m, r) => m + r.value.length, 0), 0),
    // Which chunks, relative to the corner, so the map can draw the paste outline.
    cells: clip.chunks.map((c) => [c.x - clip.bounds.x0, c.z - clip.bounds.z0]),
  };
}

export function encodeClipboard(clip) {
  const w = new Writer(1 << 20);
  const header = utf8(JSON.stringify({ world: clip.world, dim: clip.dim, created: clip.created, count: clip.chunks.length }));
  w.u32(header.length);
  w.bytes(header);
  w.u32(clip.chunks.length);
  for (const c of clip.chunks) {
    w.i32(c.x); w.i32(c.z);
    w.u32(c.records.length);
    for (const r of c.records) {
      w.u8(r.tag);
      w.u8(r.sub === null ? 0 : 1);
      w.i8(r.sub ?? 0);
      w.u32(r.value.length);
      w.bytes(r.value);
    }
    w.u32(c.entities.length);
    for (const e of c.entities) { w.u32(e.length); w.bytes(e); }
  }
  w.u32(clip.meta.size);
  for (const [h, nbt] of clip.meta) { w.bytes(fromHex(h)); w.u32(nbt.length); w.bytes(nbt); }
  const body = deflateSync(w.result(), { level: 6 });
  const out = new Uint8Array(CLIP_MAGIC.length + 4 + body.length);
  out.set(utf8(CLIP_MAGIC));
  new DataView(out.buffer).setUint32(CLIP_MAGIC.length, 1, true);
  out.set(body, CLIP_MAGIC.length + 4);
  return out;
}

export function decodeClipboard(bytes) {
  if (bytes.length < CLIP_MAGIC.length + 4 || fromUtf8(bytes.subarray(0, CLIP_MAGIC.length)) !== CLIP_MAGIC) {
    throw new Error('That file is not a Koho Editor chunk file (.kohochunks).');
  }
  const version = new DataView(bytes.buffer, bytes.byteOffset).getUint32(CLIP_MAGIC.length, true);
  if (version !== 1) throw new Error('That chunk file was made by a newer version of Koho Editor.');
  const r = new Reader(inflateSync(bytes.subarray(CLIP_MAGIC.length + 4)));
  const header = JSON.parse(fromUtf8(r.bytes(r.u32())));
  const n = r.u32();
  const chunks = [];
  for (let i = 0; i < n; i++) {
    const x = r.i32(), z = r.i32();
    const records = [];
    const rc = r.u32();
    for (let j = 0; j < rc; j++) {
      const tag = r.u8_();
      const hasSub = r.u8_();
      const sub = r.i8();
      records.push({ tag, sub: hasSub ? sub : null, value: r.bytes(r.u32()).slice() });
    }
    const entities = [];
    const ec = r.u32();
    for (let j = 0; j < ec; j++) entities.push(r.bytes(r.u32()).slice());
    chunks.push({ x, z, records, entities });
  }
  const meta = new Map();
  const mc = r.u32();
  for (let i = 0; i < mc; i++) { const h = toHex(r.bytes(8)); meta.set(h, r.bytes(r.u32()).slice()); }
  return makeClipboard({ world: header.world, dim: header.dim, chunks, meta, created: header.created });
}

export { DIMENSIONS, TAG_SUBCHUNK, utf8 };
